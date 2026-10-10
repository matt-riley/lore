// injection.mjs — session-scoped context injection for host adapters.
//
// v1 injected memory context at session start and on every prompt from inside
// the extension. The v2 adapter gets the same behaviour from the daemon: a
// bounded recall is wrapped in the <lore_context> envelope and handed back to
// the host as a non-displayed session message. Everything here fails open —
// a stopped daemon, a slow socket or a malformed result must never break the
// host's startup or prompt path.

import { execFileSync } from "node:child_process";

/** The line every host uses to mark injected, session-scoped context. */
export const LORE_CONTEXT_BOUNDARY =
  "Session context injected by Lore for this session only. Do not copy it into AGENTS.md, CLAUDE.md, or other instruction files.";

/** Neutralize embedded envelope tags so memory content cannot break out. */
function neutralizeContextMarkup(text) {
  return String(text ?? "")
    .replaceAll("<lore_context>", "&lt;lore_context&gt;")
    .replaceAll("</lore_context>", "&lt;/lore_context&gt;");
}

/**
 * Wrap recalled text in the <lore_context> envelope, or return "" when there
 * is nothing worth injecting.
 */
export function wrapLoreContext(text, { instructions = "" } = {}) {
  const body = neutralizeContextMarkup(text).trim();
  if (!body) return "";
  const suffix = instructions ? `\n\n${instructions}` : "";
  return `<lore_context>\n${LORE_CONTEXT_BOUNDARY}\n\n${body}${suffix}\n</lore_context>`;
}

/**
 * Canonical `host/owner/repo` for a working directory, or null. Only used to
 * scope recall; a miss just means global context, never a failure.
 */
export function canonicalRepositoryFromCwd(cwd, { exec = execFileSync } = {}) {
  if (!cwd) return null;
  let remote;
  try {
    remote = String(
      exec("git", ["-C", String(cwd), "remote", "get-url", "origin"], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      }) ?? "",
    ).trim();
  } catch {
    return null;
  }
  if (!remote) return null;
  const cleaned = remote
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/i, "")
    .replace(/:/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const [host, ...rest] = parts;
  return `${host}/${rest.join("/")}`;
}

function sessionIdOf(ctx) {
  return ctx?.sessionId ?? ctx?.session?.id ?? "session";
}

/**
 * Build the two lifecycle handlers the adapter registers. `session` is a
 * host session from host-session.mjs; `invokeTool` is the only daemon call
 * used, so injection follows exactly the same transport, journal and
 * capability rules as the model tools.
 */
export function createInjection({
  session,
  maxChars = 8192,
  // Inject whenever there is anything at all: a single standing directive is
  // short and still worth the model's attention.
  minChars = 1,
  repositoryFor = (ctx) => canonicalRepositoryFromCwd(ctx?.cwd ?? process.cwd()),
  now = () => Date.now(),
} = {}) {
  const lastPromptBySession = new Map();

  async function recallMessage({ query, ctx, lorePhase }) {
    if (!session?.invokeTool) return undefined;
    const repository = repositoryFor(ctx);
    const args = query ? { query } : { query: "session start" };
    if (repository) args.repository = repository;
    let result;
    try {
      result = await session.invokeTool("lore_recall", args, {
        sessionId: sessionIdOf(ctx),
      });
    } catch {
      return undefined;
    }
    const text = String(result?.context ?? "").trim();
    if (text.length < minChars) return undefined;
    const bounded = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    const content = wrapLoreContext(bounded);
    if (!content) return undefined;
    return {
      message: {
        customType: "lore",
        content,
        display: false,
        lorePhase,
      },
    };
  }

  return {
    /** Session-start capsule: standing context, once per session. Defaults to
     *  injecting anything non-empty. */
    async sessionStart(_event, ctx) {
      return recallMessage({ query: "", ctx, lorePhase: "session_start" });
    },

    /** Per-prompt recall, skipping a repeat of the same prompt. */
    async beforeAgentStart(event, ctx) {
      const prompt = String(event?.prompt ?? "").trim();
      if (!prompt) return undefined;
      const key = `${sessionIdOf(ctx)}|${prompt.toLowerCase()}`;
      if (lastPromptBySession.get(sessionIdOf(ctx)) === key) return undefined;
      lastPromptBySession.set(sessionIdOf(ctx), key);
      return recallMessage({ query: prompt, ctx, lorePhase: "prompt_recall" });
    },

    /** Recorded for tests and diagnostics. */
    _now: now,
  };
}
