// lore-pi.ts — pi adapter for lore (local-first memory & continuity).
//
// Lore (https://github.com/matt-riley/lore) is written for the Copilot CLI,
// but its lib/ is dependency-free ESM, so this adapter maps its hooks onto pi
// events instead of porting it:
//
//   Copilot onSessionStart        -> lazy runtime init + onboarding seed
//   Copilot onUserPromptSubmitted -> pi before_agent_start (recall -> message)
//   Copilot onSessionEnd          -> pi session_shutdown (close db)
//   Copilot memory_save/_search   -> pi tools lore_save / lore_recall / lore_status
//
// Shared config: ~/.config/lore/lore.json (lore's own documented config path);
// memory lives in ~/.config/lore/lore.db, so installing lore into the Copilot CLI
// later reuses the same store.
//
// Why a server process: pi's extension runtime is bun 1.3.x, which does not
// implement node:sqlite — lore's lib requires it. System node (>=24.0.0) does,
// so lore-server.mjs owns the DB and this adapter is a thin JSON-lines client.
//
// Retrieval notes (default config, no local inference):
//   - lore's lexical search is exact-token AND with no stemming, so
//     conversational prompts mostly miss. The adapter compensates by passing a
//     stopword-cleaned retrievalPrompt, and explicit searches (lore_recall
//     tool, /lore search) fall back to includeTypedFallback so recent memories
//     surface on a miss. Enable localInference/queryExpansion/embeddings in
//     lore.json for true semantic recall.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPiServerClient } from "./lib/pi-server-client.mjs";

type LoreConfig = {
  configPath?: string;
  enabled?: boolean;
  paths?: Record<string, string>;
};

type LoreRuntime = {
  config: LoreConfig;
};

type ServerClient = ReturnType<typeof createPiServerClient>;

let runtime: LoreRuntime | null = null;
let initAttempted = false;
let notifiedReady = false;
let server: ServerClient | null = null;
let initialization: Promise<LoreRuntime | null> | null = null;
let nodeBin: string | null = null;
const repoCache = new Map<string, string | null>();

// Ambient-recall state, reset per session (see session_shutdown).
// recallCache: per-session+repo recall results, keyed by the content terms of
// the prompt that produced them, so identical follow-up prompts skip the server
// roundtrip instead of re-injecting the same memories every turn.
// memoryVersion: bumped when a memory is saved mid-session, forcing a re-recall
// so fresh memories surface on the next prompt.
let recallCache: Map<string, { termKey: string; memoryVersion: number }> | null = null;
let memoryVersion = 0;

// Types recall surfaces in prompt context (see buildPromptSemanticContext).
const RECALL_TYPES = [
  "commitment",
  "open_loop",
  "rejected_approach",
  "blocker",
  "user_preference",
  "assistant_identity",
  "user_identity",
  "assistant_goal",
  "recurring_mistake",
  "interaction_style",
];

// Small stopword list so retrieval queries keep only content-bearing terms.
const STOPWORDS = new Set(
  "a an and are as at be but by for from had has have how i if in is it its just of on or our so that the they this to was we what when where which who why will with would you your".split(" "),
);

function contentTerms(query: string): string[] {
  return [...new Set(
    String(query || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  )];
}

function resolveNode(): string | null {
  if (nodeBin) {
    return nodeBin;
  }
  if (process.env.LORE_NODE) {
    nodeBin = process.env.LORE_NODE;
    return nodeBin;
  }
  try {
    nodeBin = execSync("which node", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    nodeBin = null;
  }
  return nodeBin;
}

function request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
  if (!server) {
    return Promise.reject(new Error("lore server not running"));
  }
  return server.request(method, params, timeoutMs) as Promise<T>;
}

async function stopServer(): Promise<void> {
  const s = server;
  if (!s) {
    return;
  }
  try {
    await s.close();
  } catch {
    // ignore
  }
  if (server === s) {
    server = null;
  }
}

async function ensureRuntime(ctx: {
  ui?: { notify: (t: string, m?: string, l?: string) => void };
  sessionManager: { getSessionId(): string | null };
}): Promise<LoreRuntime | null> {
  if (runtime && server?.isAlive()) {
    return runtime;
  }
  if (runtime && !server?.isAlive()) {
    // A child can die after a successful handshake. Drop the stale runtime so
    // the next hook can establish a fresh client instead of caching failure.
    runtime = null;
    initAttempted = false;
  }
  if (initialization) {
    return initialization;
  }
  if (initAttempted) {
    return runtime;
  }
  initAttempted = true;
  initialization = (async () => {
    try {
      // config.mjs uses only node os/path/fs, so it's safe to load in-process.
      const { loadConfig } = await import("./lib/config.mjs");
      const config = (await loadConfig()) as LoreConfig;
      if (config?.enabled !== true) {
        ctx.ui?.notify(`lore: disabled — set "enabled": true in ${config.configPath}`, "warning");
        return null;
      }

      const node = resolveNode();
      if (!node) {
        ctx.ui?.notify("lore: node (>=24.0.0) not found on PATH; cannot start lore server", "error");
        return null;
      }

      const serverPath = fileURLToPath(new URL("./lore-server.mjs", import.meta.url));
      const client = createPiServerClient({ command: node, args: [serverPath] });
      server = client;
      // Ping to confirm the server initialized before returning.
      await client.start();
      runtime = { config };
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[lore-pi] init failed:", error);
      ctx.ui?.notify(`lore: unavailable: ${message}`, "error");
      await stopServer();
      // Permit a later hook to recover from a transient startup failure.
      initAttempted = false;
      return null;
    }
  })();
  try {
    return await initialization;
  } finally {
    initialization = null;
  }
}

function notify(
  ctx: { hasUI?: boolean; ui?: { notify: (t: string, l?: string) => void } },
  title: string,
  message: string,
  level = "info",
) {
  if (ctx.hasUI) {
    // pi's ctx.ui.notify takes (title, level) — there is no separate message
    // argument, so flatten the title/message pair into the title.
    ctx.ui?.notify(message ? `${title}: ${message}` : title, level);
  }
}

/** Best-effort repository slug ("owner/name") from the git remote, else the toplevel dir name. */
function deriveRepository(cwd: string): string | null {
  if (repoCache.has(cwd)) {
    return repoCache.get(cwd)!;
  }
  let repo: string | null = null;
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/[:/]([^/:]+)\/([^/.]+?)(?:\.git)?$/);
    if (match) {
      repo = `${match[1]}/${match[2]}`;
    }
  } catch {
    try {
      const top = execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (top) {
        repo = path.basename(top);
      }
    } catch {
      repo = null;
    }
  }
  repoCache.set(cwd, repo);
  return repo;
}

// recallMemory with a stopword-cleaned retrieval query, plus semantic rescue
// (ambient) and a recent-memory fallback when the lexical lookup misses
// (lore's search is exact-token AND with no stemming in default config).
//
// opts:
//   semantic   - try vector search on a lexical miss (ambient path)
//   expansion  - try query expansion on a miss (explicit path; needs a chat
//                model, parked unless localInference.queryExpansion is enabled)
//   skipFallback - don't append the recency fallback (explicit search already
//                produced semantically-ranked results)
async function recallWithFallback(
  rt: LoreRuntime,
  query: string,
  repository: string | null,
  limit = 6,
  opts: { semantic?: boolean; expansion?: boolean; skipFallback?: boolean } = {},
): Promise<string> {
  const terms = contentTerms(query);
  const deterministicQuery = terms.length > 0 ? terms.join(" ") : null;

  const runRecall = (retrievalQuery: string | null) =>
    request<{ text: string; includedRows: number; memoryCount: number }>("recall", {
      prompt: query,
      retrievalPrompt: retrievalQuery,
      repository,
      limit,
    });

  // Fast path first: deterministic lexical recall, no model calls.
  let recall = await runRecall(deterministicQuery);
  let retrievalQuery = deterministicQuery;
  let text = recall.text.trim();

  // "Hit" = semantic memories, episodes, or standing directives were found.
  const hasUsefulContent = recall.includedRows > 0
    || text.includes("Relevant Prior Work")
    || text.includes("Standing Directives");

  if (!hasUsefulContent) {
    // Semantic rescue: vector search is cheap once vectors are cached and
    // strictly better than lexical, so it runs on any miss when configured.
    if (opts.semantic && (recall.memoryCount ?? 0) > 2) {
      const rows = await semanticSearch(rt, query, repository, limit);
      if (rows.length > 0) {
        text += ["", renderSemanticSection(rows)].join("\n");
        opts.skipFallback = true;
      }
    }

    // Query expansion (chat-model based) is parked by default — it needs a
    // local chat model and FTS-AND semantics make it a coin flip.
    const expansionEnabled = rt.config?.localInference?.queryExpansion?.enabled === true;
    if (!opts.skipFallback && opts.expansion && expansionEnabled && deterministicQuery) {
      try {
        const expanded = await request<{ query?: string; used?: boolean }>(
          "expand",
          { prompt: query, query: deterministicQuery },
          4000,
        );
        if (expanded?.used && expanded.query && expanded.query !== deterministicQuery) {
          retrievalQuery = expanded.query;
          recall = await runRecall(retrievalQuery);
          text = recall.text.trim();
        }
      } catch {
        // fail open to the deterministic query
      }
    }
  }

  if (recall.includedRows === 0 && !opts.skipFallback) {
    const rows = await request<Array<{ type: string; content: string }>>("search", {
      query: retrievalQuery || query,
      repository,
      types: RECALL_TYPES,
      includeTypedFallback: true,
      limit: 6,
    });
    if (rows.length > 0) {
      text += ["", "## Related memories", ...rows.map((r) => `- [${r.type}] ${r.content}`)].join("\n");
    }
  }
  return text.trim();
}

type SemanticRow = { id: string; type: string; content: string; score: number };

type SemanticSearchResult = {
  enabled: boolean;
  rows: SemanticRow[];
};

async function semanticSearch(
  rt: LoreRuntime,
  query: string,
  repository: string | null,
  limit = 6,
): Promise<SemanticRow[]> {
  if (rt.config?.localInference?.embeddings?.enabled !== true) {
    return [];
  }
  try {
    const result = await request<SemanticSearchResult>("semantic_search", {
      query,
      repository,
      limit,
    });
    return result?.enabled ? (result.rows ?? []) : [];
  } catch {
    return []; // embedding path unavailable — callers fall back to lexical
  }
}

function renderSemanticSection(rows: SemanticRow[]): string {
  return [
    "## Semantic matches",
    ...rows.map((r) => `- [${r.type}] ${r.content} (${r.score})`),
  ].join("\n");
}

// Explicit search: true semantic (vector) matches first, then lexical recall
// with episodes/directives. The recency fallback is skipped when semantic
// already produced ranked results — semantically-ranked rows beat recency.
async function explicitSearch(
  rt: LoreRuntime,
  query: string,
  repository: string | null,
  limit = 6,
): Promise<string> {
  const rows = await semanticSearch(rt, query, repository, limit);
  const parts: string[] = [];
  if (rows.length > 0) {
    parts.push(renderSemanticSection(rows));
  }
  const text = await recallWithFallback(rt, query, repository, limit, {
    expansion: true,
    skipFallback: rows.length > 0,
  });
  if (text) {
    parts.push(text);
  }
  return parts.join("\n\n").trim() || "(no memories found)";
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const rt = await ensureRuntime(ctx as never);
    if (rt && !notifiedReady) {
      notifiedReady = true;
      notify(ctx as never, "lore", "memory ready", "info");
    }
    // Bounded backfill: quietly import past pi sessions, a few per session start.
    if (rt) {
      request("backfill", {
        currentSessionId: ctx.sessionManager.getSessionId() ?? null,
        max: 5,
      })
        .then((result) => {
          const queued = (result as { queued?: number })?.queued ?? 0;
          if (queued > 0) {
            notify(ctx as never, "lore", `queued ${queued} past session(s) for import`, "info");
          }
        })
        .catch(() => {
          // backfill must never break startup
        });
    }
  });

  // Per-prompt recall: the pi analog of Copilot's onUserPromptSubmitted
  // additionalContext. Injected as a session message so it survives compaction.
  pi.on("before_agent_start", async (event, ctx) => {
    const rt = await ensureRuntime(ctx as never);
    if (!rt || !event.prompt?.trim()) {
      return;
    }
    try {
      const sessionId = ctx.sessionManager.getSessionId() ?? "anon";
      const repo = deriveRepository(ctx.cwd);
      const terms = contentTerms(event.prompt);
      // Trivial prompts with no content-bearing terms skip ambient recall.
      if (terms.length === 0) {
        return;
      }
      const cacheKey = `${sessionId}|${repo}`;
      const termKey = [...terms].sort().join(" ");
      const cached = recallCache?.get(cacheKey);
      if (cached && cached.termKey === termKey && cached.memoryVersion === memoryVersion) {
        return; // already injected for this query this session; the context prune keeps it visible
      }
      const text = await recallWithFallback(rt, event.prompt, repo, 6, { semantic: true });
      if (text) {
        if (!recallCache) {
          recallCache = new Map();
        }
        recallCache.set(cacheKey, { termKey, memoryVersion });
        return {
          message: { customType: "lore", content: text, display: false },
        };
      }
    } catch (error) {
      console.error("[lore-pi] recall failed:", error);
    }
  });

  // Keep only the most recent ambient recall message in context: lore messages
  // accumulate one per turn in the session, but only the latest is needed.
  pi.on("context", async (event) => {
    let lastLore = -1;
    for (let i = 0; i < event.messages.length; i++) {
      if ((event.messages[i] as { customType?: string }).customType === "lore") {
        lastLore = i;
      }
    }
    if (lastLore === -1) {
      return;
    }
    const filtered = event.messages.filter(
      (m, i) => i === lastLore || (m as { customType?: string }).customType !== "lore",
    );
    return { messages: filtered };
  });

  // Compaction and tree navigation can drop or summarise the injected recall,
  // so re-recall on the next prompt instead of trusting the stale cache.
  pi.on("session_compact", async () => {
    recallCache?.clear();
  });
  pi.on("session_tree", async () => {
    recallCache?.clear();
  });

  // onPreToolUse -> tool_call: lore's guardrail is default-off, observe-only,
  // and allowlists Copilot memory tool names, so this is mostly inert until
  // rollout.preToolUseGuardrail is enabled.
  pi.on("tool_call", async (event, ctx) => {
    const rt = await ensureRuntime(ctx as never);
    if (!rt) {
      return;
    }
    request<{ additionalContext?: string | null }>("guardrail", {
      toolName: event.toolName,
    })
      .then((result) => {
        if (result?.additionalContext) {
          console.debug("[lore-pi] guardrail:", result.additionalContext);
        }
      })
      .catch(() => {
        // guardrail must never block tool execution
      });
  });

  // onPostToolUse -> tool_result: privacy-minimised trajectory observations,
  // gated by rollout.postToolUse (default off). Failed results also feed the
  // error-telemetry path (onErrorOccurred approximation).
  pi.on("tool_result", async (event, ctx) => {
    const rt = await ensureRuntime(ctx as never);
    if (!rt) {
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId() ?? null;
    request("post_tool", {
      payload: {
        toolName: event.toolName,
        success: event.isError !== true,
        args: event.input,
      },
    }).catch(() => {});
    if (event.isError) {
      request("error", {
        payload: { context: "tool", error: { name: "ToolError" } },
        sessionId,
      }).catch(() => {});
    }
  });

  // onErrorOccurred approximation: pi has no error hook, so failed agent runs
  // are detected from assistant stopReason/errorMessage at agent_end.
  pi.on("agent_end", async (event, ctx) => {
    const rt = await ensureRuntime(ctx as never);
    if (!rt) {
      return;
    }
    const messages = (event.messages ?? []) as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
    const errored = messages.find(
      (m) => m.role === "assistant" && (m.stopReason === "error" || m.errorMessage),
    );
    if (!errored) {
      return;
    }
    request("error", {
      payload: { context: "agent", error: { name: errored.errorMessage ? "AgentError" : "StopReasonError" } },
      sessionId: ctx.sessionManager.getSessionId() ?? null,
    }).catch(() => {});
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // onSessionEnd: extract the current session before the db closes.
    const file = (ctx.sessionManager as { getSessionFile?(): string | undefined }).getSessionFile?.();
    if (file && runtime) {
      try {
        await request("extract", { path: file, repository: deriveRepository(ctx.cwd) }, 10000);
      } catch {
        // extraction must never break shutdown
      }
    }
    await stopServer();
    runtime = null;
    initAttempted = false;
    recallCache = null;
    memoryVersion = 0;
  });

  pi.registerTool({
    name: "lore_save",
    label: "Lore Save",
    description:
      "Persist a memory (decision, pattern, preference, gotcha) into the local lore store so future sessions recall it. " +
      "Use a recallable type: user_preference, commitment, recurring_mistake, rejected_approach, blocker, or open_loop.",
    parameters: Type.Object({
      content: Type.String({ description: "Memory content to persist" }),
      type: Type.Optional(
        Type.String({ description: "Memory type (see description)", default: "user_preference" }),
      ),
      repository: Type.Optional(Type.String({ description: "Optional explicit repository scope" })),
      scope: Type.Optional(Type.String({ description: "Scope: global, transferable, or repo" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rt = await ensureRuntime(ctx as never);
      if (!rt) {
        return { content: [{ type: "text", text: "lore unavailable" }], details: {} };
      }
      const type = params.type ?? "user_preference";
      const result = await request<{ id: string | null }>("save", {
        type,
        content: params.content,
        repository: params.repository ?? deriveRepository(ctx.cwd),
        scope: params.scope,
        sourceSessionId: ctx.sessionManager.getSessionId() ?? null,
        tags: [type, "manual"],
        metadata: { source: "pi" },
      });
      if (result?.id) {
        memoryVersion++; // force ambient recall to refresh on the next prompt
      }
      const text = result?.id
        ? `Saved memory ${result.id} (${type})`
        : "Save skipped: empty after sanitization.";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "lore_onboard",
    label: "Lore Onboard",
    description:
      "Record or update lore's personality: the user's preferred name, the assistant's name, and interaction-style profile fields. " +
      "All fields are optional; omitted fields keep their current values.",
    parameters: Type.Object({
      userName: Type.Optional(Type.String({ description: "The user's preferred name (required until lore knows it)" })),
      assistantName: Type.Optional(Type.String({ description: "Optional assistant self-name; omitted means lore keeps or chooses one" })),
      voice: Type.Optional(Type.Union([Type.Literal("colleague"), Type.Literal("collaborative"), Type.Literal("friendly")], { description: "Preferred assistant voice" })),
      warmth: Type.Optional(Type.Union([Type.Literal("warm"), Type.Literal("balanced")], { description: "Preferred assistant warmth" })),
      humor: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("none")], { description: "Whether lore uses humor by default" })),
      humorFrequency: Type.Optional(Type.Union([Type.Literal("frequent"), Type.Literal("occasional"), Type.Literal("never")], { description: "How often humor is welcome" })),
      collaborative: Type.Optional(Type.Boolean({ description: "Default to a collaborative teammate posture" })),
      useNameNaturally: Type.Optional(Type.Boolean({ description: "Use the user's preferred name naturally when helpful" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rt = await ensureRuntime(ctx as never);
      if (!rt) {
        return { content: [{ type: "text", text: "lore unavailable" }], details: {} };
      }
      const result = await request<{
        assistantName: string;
        userName: string | null;
        profile: { voice: string; warmth: string; humor: string; humorFrequency: string; useNameNaturally: boolean };
      }>("onboard", {
        userName: params.userName,
        assistantName: params.assistantName,
        voice: params.voice,
        warmth: params.warmth,
        humor: params.humor,
        humorFrequency: params.humorFrequency,
        collaborative: params.collaborative,
        useNameNaturally: params.useNameNaturally,
        sourceSessionId: ctx.sessionManager.getSessionId() ?? null,
      });
      if (result?.assistantName) {
        memoryVersion++;
      }
      const text = result?.assistantName
        ? [
            `Onboarding saved. You can call lore ${result.assistantName}.`,
            `userName=${result.userName ?? "(unset)"}`,
            `voice=${result.profile?.voice}`,
            `warmth=${result.profile?.warmth}`,
            `humor=${result.profile?.humor}`,
            `humorFrequency=${result.profile?.humorFrequency}`,
            `useNameNaturally=${result.profile?.useNameNaturally === true ? "true" : "false"}`,
          ].join(" ")
        : "Onboarding skipped.";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "lore_recall",
    label: "Lore Recall",
    description:
      "Search the local lore memory store for memories relevant to a query. Uses semantic (vector) search via the local embeddings model when configured, plus lexical recall.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      repository: Type.Optional(Type.String({ description: "Optional repository scope" })),
      limit: Type.Optional(Type.Number({ description: "Max results", default: 6 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rt = await ensureRuntime(ctx as never);
      if (!rt) {
        return { content: [{ type: "text", text: "lore unavailable" }], details: {} };
      }
      const text = await explicitSearch(
        rt,
        params.query,
        params.repository ?? deriveRepository(ctx.cwd),
        params.limit ?? 6,
      );
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "lore_status",
    label: "Lore Status",
    description: "Show lore store statistics (memory counts, db path, schema version).",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const rt = await ensureRuntime(ctx as never);
      if (!rt) {
        return { content: [{ type: "text", text: "lore unavailable" }], details: {} };
      }
      const s = await request<{
        semanticCount: number;
        episodeCount: number;
        domainCount: number;
        observationCount: number;
        schemaVersion: number | string;
        dbPath: string | null;
      }>("status");
      const text = [
        `semantic memories: ${s.semanticCount ?? 0}`,
        `episodes: ${s.episodeCount ?? 0}`,
        `domains: ${s.domainCount ?? 0}`,
        `observations: ${s.observationCount ?? 0}`,
        `schema: ${s.schemaVersion ?? "?"}`,
        `db: ${s.dbPath ?? "?"}`,
      ].join("\n");
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerCommand("lore", {
    description: "Inspect lore memory: status | search <query> | save <text>",
    handler: async (args, ctx) => {
      const rt = await ensureRuntime(ctx as never);
      if (!rt) {
        return;
      }
      const [cmd, ...rest] = (args ?? "").trim().split(/\s+/);
      const argText = rest.join(" ").trim();

      if (cmd === "search" && argText) {
        const text = await explicitSearch(rt, argText, deriveRepository(ctx.cwd));
        notify(ctx as never, "lore search", text);
        return;
      }

      if (cmd === "save" && argText) {
        const result = await request<{ id: string | null }>("save", {
          type: "user_preference",
          content: argText,
          repository: deriveRepository(ctx.cwd),
          sourceSessionId: ctx.sessionManager.getSessionId() ?? null,
          tags: ["user_preference", "manual"],
          metadata: { source: "pi:command" },
        });
        if (result?.id) {
          memoryVersion++;
        }
        notify(ctx as never, "lore save", result?.id ? `Saved memory ${result.id}` : "Save skipped.");
        return;
      }

      const s = await request<{
        semanticCount: number;
        episodeCount: number;
        domainCount: number;
        observationCount: number;
        schemaVersion: number | string;
        dbPath: string | null;
      }>("status");
      notify(
        ctx as never,
        "lore",
        [
          `semantic: ${s.semanticCount ?? 0} | episodes: ${s.episodeCount ?? 0} | domains: ${s.domainCount ?? 0} | observations: ${s.observationCount ?? 0}`,
          `schema ${s.schemaVersion ?? "?"} | db: ${s.dbPath ?? "?"}`,
          "",
          "usage: /lore status | search <query> | save <text>",
        ].join("\n"),
      );
    },
  });
}
