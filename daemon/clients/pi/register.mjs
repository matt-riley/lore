// register.mjs — Pi host registration for the Lore v2 daemon.
//
// The Pi extension entrypoint imports this module, passes the Pi API and a
// resolved socket path, and gets back tool registrations, the /lore command
// and lifecycle hooks. All behavior lives in host-session.mjs.

import { MODEL_TOOLS } from "../js/model-tools.mjs";
import { createHostSession, renderToolCall } from "../js/host-session.mjs";
import { createInjection } from "../js/injection.mjs";

const VERB_TO_TOOL = new Map([
  ["recall", "lore_recall"],
  ["retain", "lore_retain"],
  ["save", "lore_retain"],
  ["onboard", "lore_onboard"],
  ["search", "lore_search"],
  ["find", "lore_search"],
  ["forget", "lore_forget"],
  ["status", "lore_status"],
  ["explain", "lore_explain"],
  ["why", "lore_explain"],
  ["validate", "lore_validate"],
  ["doctor", "lore_validate"],
  ["correct", "lore_correct"],
]);

const USAGE =
  "lore: verbs are recall <query>, retain <text>, search <query>, forget <id>, " +
  "status, explain <query>, validate, correct <json>, onboard <json>, retries.";

function sessionIdOf(ctx) {
  return ctx?.sessionId ?? ctx?.session?.id ?? "session";
}

/** Parse `/lore <verb> [text|json]` without executing anything. */
export function parseSlashArgs(argsText) {
  const text = String(argsText ?? "").trim();
  if (text === "") return { verb: "status", rest: "" };
  const separator = text.search(/\s/);
  if (separator === -1) return { verb: text.toLowerCase(), rest: "" };
  return { verb: text.slice(0, separator).toLowerCase(), rest: text.slice(separator + 1).trim() };
}

function argsFromRest(tool, rest) {
  if (rest === "") return {};
  if (rest.startsWith("{")) {
    try {
      return JSON.parse(rest);
    } catch (error) {
      const failure = new Error(`invalid JSON for /lore: ${error.message}`);
      failure.reason = "ADMIN_ARGUMENT_INVALID";
      throw failure;
    }
  }
  const keyed = MODEL_TOOLS.find((entry) => entry.name === tool);
  if (keyed?.name === "lore_status" || keyed?.name === "lore_validate") return {};
  return { query: rest, content: rest };
}

export function createPiLore(options = {}) {
  const session = createHostSession({
    socketPath: options.socketPath,
    clientId: options.clientId ?? "pi",
    journalPath: options.journalPath,
    notify: options.notify,
  });
  return session;
}

/**
 * Register the nine canonical model tools, the /lore command and lifecycle
 * cancellation on a Pi extension API.
 */
export function registerPiV2(pi, options = {}) {
  const session = createPiLore(options);

  for (const tool of MODEL_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId, params, hostSignal, _onUpdate, ctx) {
        return renderToolCall(session, tool.name, params ?? {}, {
          sessionId: sessionIdOf(ctx),
          signal: hostSignal,
        });
      },
    });
  }

  pi.registerCommand?.("lore", {
    description: "Lore memory commands",
    handler: async (argsText, ctx) => {
      const { verb, rest } = parseSlashArgs(argsText);
      const sessionId = sessionIdOf(ctx);
      if (verb === "retries") {
        const entries = session.retries();
        if (entries.length === 0) return "lore: no uncertain writes pending.";
        return entries
          .map((entry) => `- ${entry.operation} ${entry.key} (${entry.hasPayload ? "payload kept" : "no payload"})`)
          .join("\n");
      }
      const tool = VERB_TO_TOOL.get(verb);
      if (!tool) return USAGE;
      let args;
      try {
        args = argsFromRest(tool, rest);
      } catch (error) {
        return `lore: ${error.message}`;
      }
      if ((tool === "lore_recall" || tool === "lore_search" || tool === "lore_explain") && !args.query) {
        return USAGE;
      }
      return renderToolCall(session, tool, args, { sessionId });
    },
  });

  // Prompt-time context injection, unless the operator opts out. The host
  // calls these handlers per session and per prompt; both fail open.
  const injection =
    process.env.LORE_V2_INJECT === "0" ? null : createInjection({ session });

  pi.on?.("session_start", async (event, ctx) => {
    session.startSession(sessionIdOf(ctx));
    return injection ? await injection.sessionStart(event, ctx) : undefined;
  });
  pi.on?.("before_agent_start", async (event, ctx) =>
    injection ? await injection.beforeAgentStart(event, ctx) : undefined,
  );
  pi.on?.("session_shutdown", async () => {
    await session.shutdownAll();
  });

  return session;
}
