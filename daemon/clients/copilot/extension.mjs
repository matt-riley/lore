// Lore v2 Copilot extension: a small ESM socket adapter.
//
// Copilot loads the default export, reads `tools` and `hooks`, and this
// adapter forwards every call to the Rust daemon over the v2 Unix socket.
// It never opens SQLite and never starts a worker.

import { MODEL_TOOLS } from "../js/model-tools.mjs";
import { createHostSession, renderToolCall } from "../js/host-session.mjs";
import { createInjection } from "../js/injection.mjs";
import { resolveJournalPath, resolveSocketPath } from "../js/endpoint.mjs";
import { argsFromRest, parseSlashArgs, retriesResponse } from "../pi/register.mjs";

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

export function createCopilotLore(options = {}) {
  const env = options.env ?? process.env;
  return createHostSession({
    socketPath: options.socketPath ?? resolveSocketPath(env),
    clientId: options.clientId ?? "copilot",
    journalPath: options.journalPath ?? resolveJournalPath(env),
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

export function buildCopilotHooks(session, { injection = null } = {}) {
  return {
    onSessionStart: async (input, invocation) => {
      const sessionId = invocation?.sessionId ?? "session";
      session.startSession(sessionId);
      if (!injection) return undefined;
      // The host's own sessionId must not override the one the session was started with.
      const capsule = await injection.sessionStart(input, {
        ...(input ?? {}),
        sessionId,
        cwd: input?.cwd ?? invocation?.cwd ?? process.cwd(),
      });
      return capsule?.message?.content
        ? { additionalContext: capsule.message.content }
        : undefined;
    },
    onUserPromptSubmitted: async (input, invocation) => {
      const prompt = String(input?.prompt ?? "");
      // Only the `/lore` command itself, so `/loremaster` reaches the model.
      if (!/^\/lore(\s|$)/.test(prompt)) {
        if (!injection) return undefined;
        const recalled = await injection.beforeAgentStart(input, {
          ...(input ?? {}),
          sessionId: invocation?.sessionId ?? "session",
          cwd: input?.cwd ?? invocation?.cwd ?? process.cwd(),
        });
        return recalled?.message?.content
          ? { additionalContext: recalled.message.content }
          : undefined;
      }
      const { verb, rest } = parseSlashArgs(prompt.replace(/^\/lore\s*/, ""));
      const sessionId = invocation?.sessionId ?? "session";
      if (verb === "retries") return { response: retriesResponse(session, rest) };
      const tool = VERB_TO_TOOL.get(verb);
      if (!tool) return { response: USAGE };
      let args;
      try {
        args = argsFromRest(tool, rest);
      } catch (error) {
        return { response: `lore: ${error.message}` };
      }
      if (tool === "lore_forget" && !args.memoryId) return { response: USAGE };
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
  const env = options.env ?? process.env;
  if (!(options.socketPath ?? resolveSocketPath(env))) {
    // No socket: register nothing rather than dialing a guessed endpoint, as the Pi entrypoint does.
    return { tools: [], hooks: {}, session: null };
  }
  const session = createCopilotLore(options);
  const injection = env.LORE_V2_INJECT === "0" ? null : createInjection({ session });
  return {
    tools: buildCopilotTools(session),
    hooks: buildCopilotHooks(session, { injection }),
    session,
  };
}
