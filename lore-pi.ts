// lore-pi.ts — pi adapter for lore (local-first memory & continuity).
//
// Lore (https://github.com/matt-riley/lore) is written for the Copilot CLI,
// but its lib/ is dependency-free ESM, so this adapter maps its hooks onto pi
// events instead of porting it:
//
//   Copilot onSessionStart        -> lazy runtime init + onboarding seed
//   Copilot onUserPromptSubmitted -> pi before_agent_start (recall -> message)
//   Copilot onSessionEnd          -> pi session_shutdown (close db)
//   Copilot memory_* tools        -> nine model tools + /lore <verb> (lore_save aliases retain)
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
//   - lore's lexical search is AND-first with a shared OR-retry in
//     assembleRecall. This adapter does not keep a private stopword list or
//     typed fallback. Enable localInference/queryExpansion/embeddings in
//     lore.json for vector recall.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRepositoryIdentity } from "./lib/utils/repository-identity.mjs";
import { createPiServerClient } from "./lib/clients/pi-server-client.mjs";
import { getLoreCapabilitySpec, LORE_CAPABILITY_SPECS } from "./lib/capabilities/capability-manifest.mjs";
import { jsonSchemaToTypeBox } from "./lib/runtime/json-schema-to-typebox.mjs";
import { dispatchSlash, LORE_SLASH_DESCRIPTION, parseLoreArgv } from "./lib/runtime/slash-dispatch.mjs";

const PI_MODEL_TOOL_NAMES = LORE_CAPABILITY_SPECS
  .filter((spec: { surfaces: { model: boolean } }) => spec.surfaces.model === true)
  .map((spec: { name: string }) => spec.name);

const MUTATING_TOOL_NAMES = new Set([
  "lore_retain",
  "lore_save",
  "memory_save",
  "lore_forget",
  "memory_forget",
  "lore_onboard",
  "lore_correct",
  "memory_correct",
  "lore_repair",
  "memory_repair",
  "lore_purge",
  "memory_purge",
  "lore_backfill",
  "memory_backfill",
]);

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
// recallCache: per-session+repo recall results, keyed by the prompt that
// produced them, so identical follow-up prompts skip the server roundtrip.
// memoryVersion: bumped when a memory is saved mid-session, forcing a re-recall
// so fresh memories surface on the next prompt.
let recallCache: Map<string, { termKey: string; memoryVersion: number }> | null = null;
let memoryVersion = 0;

function resolveNode(): string | null {
  if (nodeBin) {
    return nodeBin;
  }
  if (process.env.LORE_NODE) {
    nodeBin = process.env.LORE_NODE;
    return nodeBin;
  }
  if (process.execPath) {
    nodeBin = process.execPath;
    return nodeBin;
  }
  try {
    const cmd = process.platform === "win32" ? "where node" : "which node";
    nodeBin = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/)[0] || null;
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
      const { loadConfig } = await import("./lib/core/config.mjs");
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

function toolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object" && typeof (result as { text?: unknown }).text === "string") {
    return (result as { text: string }).text;
  }
  if (result == null) {
    return "";
  }
  return JSON.stringify(result);
}

function toolLabel(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function maybeBumpMemoryVersion(name: string | undefined, text: string): void {
  if (!name || !MUTATING_TOOL_NAMES.has(name)) {
    return;
  }
  if (/unavailable|skipped|unknown (?:tool|verb)|requires --json|^usage:/i.test(text)) {
    return;
  }
  memoryVersion++;
}

function loreUnavailableResult() {
  return { content: [{ type: "text" as const, text: "lore unavailable" }], details: {} };
}

function deriveRepository(cwd: string): string | null {
  const explicit = process.env.LORE_REPOSITORY?.trim();
  if (explicit) return resolveRepositoryIdentity({ cwd, explicit });
  if (!repoCache.has(cwd)) repoCache.set(cwd, resolveRepositoryIdentity({ cwd }));
  return repoCache.get(cwd) ?? null;
}

// The server owns assembleRecall, including AND-then-OR retry and fusion.
async function recallWithFallback(
  _rt: LoreRuntime,
  query: string,
  repository: string | null,
  limit = 6,
): Promise<string> {
  const recall = await request<{ text: string; includedRows: number; memoryCount: number }>("recall", {
    prompt: query,
    repository,
    limit,
  });
  return (recall.text ?? "").trim();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const rt = await ensureRuntime(ctx as never);
    if (rt && !notifiedReady) {
      notifiedReady = true;
      notify(ctx as never, "lore", "memory ready", "info");
    }
    if (!rt) {
      return;
    }
    // Bounded backfill: quietly import past pi sessions, a few per session start.
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
    try {
      const capsule = await request<{ text?: string }>("lifecycle", {
        event: "session_start",
        prompt: "",
        repository: deriveRepository(ctx.cwd),
        sessionId: ctx.sessionManager.getSessionId() ?? null,
      });
      const text = toolResultText(capsule).trim();
      if (text) {
        return {
          message: { customType: "lore", content: text, display: false, lorePhase: "session_start" },
        };
      }
    } catch {
      // session-start capsule must never break startup
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
      const cacheKey = `${sessionId}|${repo}`;
      const termKey = String(event.prompt).trim().toLowerCase();
      const cached = recallCache?.get(cacheKey);
      if (cached && cached.termKey === termKey && cached.memoryVersion === memoryVersion) {
        return; // already injected for this query this session; the context prune keeps it visible
      }
      const text = await recallWithFallback(rt, event.prompt, repo, 6);
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

  // Keep the session-start capsule plus the most recent prompt recall. Prompt
  // lore messages accumulate one per turn; only the latest of those is needed.
  pi.on("context", async (event) => {
    let lastSessionStart = -1;
    let lastPromptLore = -1;
    for (let i = 0; i < event.messages.length; i++) {
      const message = event.messages[i] as { customType?: string; lorePhase?: string };
      if (message.customType !== "lore") {
        continue;
      }
      if (message.lorePhase === "session_start") {
        lastSessionStart = i;
      } else {
        lastPromptLore = i;
      }
    }
    if (lastSessionStart === -1 && lastPromptLore === -1) {
      return;
    }
    const keep = new Set([lastSessionStart, lastPromptLore].filter((index) => index >= 0));
    const filtered = event.messages.filter((m, i) => {
      return (m as { customType?: string }).customType !== "lore" || keep.has(i);
    });
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

  function withToolArgs(spec: { parameters?: { properties?: Record<string, unknown> } } | undefined, params: Record<string, unknown>, ctx: { cwd: string }) {
    const args: Record<string, unknown> = { ...params };
    if (spec?.parameters?.properties?.repository && args.repository == null) {
      args.repository = deriveRepository(ctx.cwd);
    }
    if (spec?.name === "lore_recall" && args.prompt == null && typeof args.query === "string") {
      args.prompt = args.query;
    }
    return args;
  }

  async function executeManifestTool(name: string, params: Record<string, unknown>, ctx: {
    cwd: string;
    sessionManager: { getSessionId(): string | null };
  }) {
    const rt = await ensureRuntime(ctx as never);
    if (!rt) {
      return loreUnavailableResult();
    }
    const spec = getLoreCapabilitySpec(name);
    const text = toolResultText(await request("tool", {
      name,
      args: withToolArgs(spec, params, ctx),
      sessionId: ctx.sessionManager.getSessionId() ?? null,
      surface: "tool",
      repository: deriveRepository(ctx.cwd),
    }));
    maybeBumpMemoryVersion(spec?.name ?? name, text);
    return { content: [{ type: "text" as const, text }], details: {} };
  }

  function registerManifestTool(canonicalName: string, registeredName = canonicalName) {
    const spec = getLoreCapabilitySpec(canonicalName);
    if (!spec) {
      console.error(`[lore-pi] skipping tool ${canonicalName}: no capability spec`);
      return;
    }
    let parameters;
    try {
      parameters = jsonSchemaToTypeBox(spec.parameters, Type);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[lore-pi] skipping tool ${registeredName}: ${message}`);
      return;
    }
    pi.registerTool({
      name: registeredName,
      label: toolLabel(registeredName),
      description: spec.description,
      parameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return executeManifestTool(registeredName, (params ?? {}) as Record<string, unknown>, ctx as never);
      },
    });
  }

  for (const name of PI_MODEL_TOOL_NAMES) {
    registerManifestTool(name);
  }
  // lore_save is the Pi-legacy retain alias, not an extra canonical model verb.
  registerManifestTool("lore_retain", "lore_save");

  pi.registerCommand("lore", {
    description: LORE_SLASH_DESCRIPTION,
    handler: async (args, ctx) => {
      const rt = await ensureRuntime(ctx as never);
      if (!rt) {
        return;
      }
      const argsText = String(args ?? "");
      const text = await dispatchSlash(
        argsText,
        async (name: string, toolArgs: Record<string, unknown>, extra: { sessionId?: string | null; surface?: string }) => {
          const spec = getLoreCapabilitySpec(name);
          const result = await request("tool", {
            name,
            args: withToolArgs(spec, toolArgs ?? {}, ctx),
            sessionId: extra?.sessionId ?? ctx.sessionManager.getSessionId() ?? null,
            surface: extra?.surface ?? "slash",
            repository: deriveRepository(ctx.cwd),
          });
          return toolResultText(result);
        },
        { sessionId: ctx.sessionManager.getSessionId() ?? null, surface: "slash" },
      );
      const parsed = parseLoreArgv(argsText);
      maybeBumpMemoryVersion(parsed?.name, String(text ?? ""));
      notify(ctx as never, "lore", String(text ?? ""));
    },
  });
}
