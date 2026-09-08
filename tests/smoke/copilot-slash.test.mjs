import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  buildLoreSlashCommand,
  interceptLoreSlashPrompt,
  matchLoreSlashPrompt,
} from "../../lib/runtime/slash-dispatch.mjs";
import {
  COPILOT_MODEL_LIST_SHRINK_READY,
  DEFAULT_MODEL_TOOL_NAMES,
  listCopilotJoinTools,
  listModelTools,
} from "../../lib/runtime/tool-registry.mjs";

const EXTENSION_SOURCE = readFileSync(new URL("../../extension.mjs", import.meta.url), "utf8");

describe("mocked Copilot joinSession /lore wiring", () => {
  test("joinSession options always include a lore command and keep extra tools", async () => {
    const dispatched = [];
    const logs = [];
    async function joinSession(options) {
      return options;
    }

    const joined = await joinSession({
      commands: [
        buildLoreSlashCommand({
          dispatchSlash: async (args, extra) => {
            dispatched.push({ args, extra });
            return "semantic memories: 0";
          },
          log: async (text, options) => {
            logs.push({ text, options });
          },
        }),
      ],
      tools: listCopilotJoinTools({
        getRuntime: async () => ({ initialized: false, lastError: new Error("stub") }),
      }),
    });

    assert.equal(joined.commands.length, 1);
    assert.equal(joined.commands[0].name, "lore");
    assert.ok(joined.tools.length > DEFAULT_MODEL_TOOL_NAMES.length, "extras stay registered until the TUI gate");
    assert.equal(COPILOT_MODEL_LIST_SHRINK_READY, false);
    assert.equal(listModelTools({ getRuntime: async () => ({}) }).length, 9);

    await joined.commands[0].handler({ args: "status", sessionId: "copilot-session" });
    assert.deepEqual(dispatched, [{
      args: "status",
      extra: { sessionId: "copilot-session", surface: "slash" },
    }]);
    assert.equal(logs[0].text, "semantic memories: 0");
    assert.equal(logs[0].options.ephemeral, true);
  });

  test("onUserPromptSubmitted intercept consumes /lore and skips recall injection", async () => {
    const logs = [];
    const intercepted = await interceptLoreSlashPrompt({
      prompt: "/lore doctor",
      sessionId: "copilot-session",
      dispatchSlash: async (argsText, extra) => {
        assert.equal(argsText, "doctor");
        assert.equal(extra.surface, "slash");
        return "doctor report";
      },
      log: async (text, options) => {
        logs.push({ text, options });
      },
    });
    assert.equal(intercepted.handled, true);
    assert.equal(intercepted.text, "doctor report");
    assert.equal(logs[0].text, "doctor report");

    const hookResult = intercepted ? undefined : { additionalContext: "should not inject" };
    assert.equal(hookResult, undefined);
    assert.equal(matchLoreSlashPrompt("remember this"), null);
  });
});

describe("extension.mjs Copilot transport", () => {
  test("always registers /lore commands, intercepts /^\\/lore\\b/, and does not shrink extras", () => {
    assert.match(EXTENSION_SOURCE, /createLoreSession\(/);
    assert.match(EXTENSION_SOURCE, /client:\s*"copilot"/);
    assert.match(EXTENSION_SOURCE, /commands:\s*\[/);
    assert.match(EXTENSION_SOURCE, /buildLoreSlashCommand\(/);
    assert.match(EXTENSION_SOURCE, /interceptLoreSlashPrompt\(/);
    assert.match(EXTENSION_SOURCE, /matchLoreSlashPrompt\(/);
    assert.match(EXTENSION_SOURCE, /listCopilotJoinTools\(/);
    assert.match(EXTENSION_SOURCE, /LORE_SLASH_ADVERTISEMENT/);
    assert.equal(EXTENSION_SOURCE.includes("tools: listModelTools"), false);
    assert.equal(EXTENSION_SOURCE.includes("createMemoryTools"), false);
  });
});
