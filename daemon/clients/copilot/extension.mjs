// Lore v2 Copilot extension: a small ESM socket adapter.
//
// Copilot loads the default export, reads `tools` and `hooks`, and this
// adapter forwards every call to the Rust daemon over the v2 Unix socket.
// It never opens SQLite and never starts a worker.

import { MODEL_TOOLS } from "../js/model-tools.mjs";
import { createHostSession, renderToolCall } from "../js/host-session.mjs";
import { parseSlashArgs } from "../pi/register.mjs";

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

function argsFromRest(tool, rest) {
  if (rest === "") return {};
  if (rest.startsWith("{")) return JSON.parse(rest);
  if (tool === "lore_status" || tool === "lore_validate") return {};
  return { query: rest, content: rest };
}

export function createCopilotLore(options = {}) {
  return createHostSession({
    socketPath: options.socketPath,
    clientId: options.clientId ?? "copilot",
    journalPath: options.journalPath,
    notify: options.notify,
  });
}

export function buildCopilotTools(session) {
  return MODEL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async handler(args, invocation) {
      return renderToolCall(session, tool.name, args ?? {}, {
        sessionId: invocation?.sessionId ?? "session",
      });
    },
  }));
}

export function buildCopilotHooks(session) {
  return {
    onSessionStart: async (_input, invocation) => {
      session.startSession(invocation?.sessionId ?? "session");
      return undefined;
    },
    onUserPromptSubmitted: async (input, invocation) => {
      const prompt = String(input?.prompt ?? "");
      if (!prompt.startsWith("/lore")) return undefined;
      const { verb, rest } = parseSlashArgs(prompt.replace(/^\/lore\s*/, ""));
      const sessionId = invocation?.sessionId ?? "session";
      if (verb === "retries") {
        const entries = session.retries();
        return {
          response: entries.length
            ? entries.map((entry) => `- ${entry.operation} ${entry.key}`).join("\n")
            : "lore: no uncertain writes pending.",
        };
      }
      const tool = VERB_TO_TOOL.get(verb);
      if (!tool) return { response: USAGE };
      let args;
      try {
        args = argsFromRest(tool, rest);
      } catch (error) {
        return { response: `lore: ${error.message}` };
      }
      return {
        response: await renderToolCall(session, tool, args, { sessionId }),
      };
    },
    onSessionEnd: async (_input, invocation) => {
      await session.shutdownSession(invocation?.sessionId ?? "session");
      return undefined;
    },
  };
}

export default function createLoreV2Extension(options = {}) {
  const session = createCopilotLore(options);
  return {
    tools: buildCopilotTools(session),
    hooks: buildCopilotHooks(session),
    session,
  };
}
