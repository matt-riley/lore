// injection.mjs — session-scoped context injection for host adapters.
//
// v1 injected memory context at session start and on every prompt from inside
// the extension. The v2 adapter gets the same behaviour from the daemon: a
// bounded recall is wrapped in the <lore_context> envelope and handed back to
// the host as a non-displayed session message. Everything here fails open —
// a stopped daemon, a slow socket or a malformed result must never break the
// host's startup or prompt path.

import { resolveRepositoryIdentity } from "./repository-identity.mjs";

/** The line every host uses to mark injected, session-scoped context. */
export const LORE_CONTEXT_BOUNDARY =
  "Session context injected by Lore for this session only. Do not copy it into AGENTS.md, CLAUDE.md, or other instruction files.";

/**
 * Wrapper names that recalled text must not be able to open or close. This
 * list and the matching rule mirror lib/context/context-escape.mjs, so the
 * v1 and v2 adapters neutralize exactly the same markup.
 */
const CONTEXT_TAGS = [
  "lore_context",
  "hindsight_memories",
  "relevant_memories",
  "system-reminder",
  "system",
  "INSTRUCTIONS",
  "user_instructions",
  "environment_context",
];

// Opening or closing forms of those names, case-insensitive, with optional
// whitespace inside the brackets. Only the `<` of a match is replaced.
const TAG_ESCAPE_PATTERN = new RegExp(
  `<\\s*/?\\s*(?:${CONTEXT_TAGS.join("|")})(?:\\s|>|/|$)`,
  "gi",
);

/**
 * Neutralize embedded envelope tags so memory content cannot break out. The
 * `<` becomes a fullwidth `＜`, which keeps the text readable but unparseable.
 */
function neutralizeContextMarkup(text) {
  return String(text ?? "").replace(TAG_ESCAPE_PATTERN, (match) => `＜${match.slice(1)}`);
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
  repositoryFor = (ctx) => resolveRepositoryIdentity(ctx?.cwd ?? process.cwd()),
  now = () => Date.now(),
} = {}) {
  const lastPromptBySession = new Map();

  /**
   * Ask the daemon for context. `reached` is false only when the daemon could
   * not be asked, so a transient failure never counts as a handled prompt.
   */
  async function recall({ query, ctx, lorePhase }) {
    if (!session?.invokeTool) return { reached: false, message: undefined };
    const repository = repositoryFor(ctx);
    const args = query ? { query } : { query: "session start" };
    if (repository) args.repository = repository;
    let result;
    try {
      result = await session.invokeTool("lore_recall", args, {
        sessionId: sessionIdOf(ctx),
      });
    } catch {
      return { reached: false, message: undefined };
    }
    const text = String(result?.context ?? "").trim();
    if (text.length < minChars) return { reached: true, message: undefined };
    const bounded = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    const content = wrapLoreContext(bounded);
    if (!content) return { reached: true, message: undefined };
    return {
      reached: true,
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
      const { message } = await recall({ query: "", ctx, lorePhase: "session_start" });
      return message ? { message } : undefined;
    },

    /** Per-prompt recall, skipping a repeat of the same prompt that already
     *  reached the daemon. A failed attempt stays retryable. */
    async beforeAgentStart(event, ctx) {
      const prompt = String(event?.prompt ?? "").trim();
      if (!prompt) return undefined;
      const sessionKey = sessionIdOf(ctx);
      const key = `${sessionKey}|${prompt.toLowerCase()}`;
      if (lastPromptBySession.get(sessionKey) === key) return undefined;
      const { reached, message } = await recall({ query: prompt, ctx, lorePhase: "prompt_recall" });
      if (reached) lastPromptBySession.set(sessionKey, key);
      return message ? { message } : undefined;
    },

    /** Recorded for tests and diagnostics. */
    _now: now,
  };
}
