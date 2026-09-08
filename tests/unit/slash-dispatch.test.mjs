import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  buildLoreSlashCommand,
  dispatchSlash,
  interceptLoreSlashPrompt,
  loreSlashPromptHookOutput,
  matchLoreSlashPrompt,
  parseLoreArgv,
  resetLoreSlashDispatchClaims,
  tokenizeLoreArgv,
  LORE_SLASH_ADVERTISEMENT,
  LORE_SLASH_DESCRIPTION,
  LORE_SLASH_USAGE,
} from "../../lib/runtime/slash-dispatch.mjs";

beforeEach(() => {
  resetLoreSlashDispatchClaims();
});

describe("parseLoreArgv", () => {
  test("maps forget <id> to lore_forget", () => {
    assert.deepEqual(parseLoreArgv("forget abc"), {
      name: "lore_forget",
      args: { id: "abc" },
      verb: "forget",
    });
  });

  test("treats /lore forget id, lore forget id, and forget id as the same call", () => {
    const expected = { name: "lore_forget", args: { id: "mem-1" } };
    for (const input of ["/lore forget mem-1", "lore forget mem-1", "forget mem-1", ["forget", "mem-1"]]) {
      const parsed = parseLoreArgv(input);
      assert.equal(parsed.name, expected.name, String(input));
      assert.deepEqual(parsed.args, expected.args, String(input));
    }
  });

  test("maps save and retain flags onto lore_retain", () => {
    assert.deepEqual(parseLoreArgv("save remember bun"), {
      name: "lore_retain",
      args: { content: "remember bun" },
      verb: "save",
    });
    assert.deepEqual(parseLoreArgv("retain --type decision --scope repo prefer bun"), {
      name: "lore_retain",
      args: { type: "decision", scope: "repo", content: "prefer bun" },
      verb: "retain",
    });
  });

  test("maps recall and search positional text onto the canonical fields", () => {
    assert.equal(parseLoreArgv("recall what did we decide").name, "lore_recall");
    assert.equal(parseLoreArgv("recall what did we decide").args.prompt, "what did we decide");
    assert.equal(parseLoreArgv("search bun").name, "lore_search");
    assert.equal(parseLoreArgv("search bun").args.query, "bun");
  });

  test("resolves aliases and extra slash names", () => {
    assert.equal(parseLoreArgv("memory_forget id-9").name, "lore_forget");
    assert.equal(parseLoreArgv("doctor").name, "lore_doctor");
    assert.equal(parseLoreArgv("status").name, "lore_status");
  });

  test("requires --json for high-arity admin verbs", () => {
    const parsed = parseLoreArgv("repair");
    assert.match(parsed.error, /requires --json/);
    const payload = JSON.stringify({ action: "preview" });
    const withJson = parseLoreArgv(`repair --json '${payload}'`);
    assert.equal(withJson.name, "lore_repair");
    assert.equal(withJson.args.action, "preview");
  });

  test("does not steal quoted or unquoted retain text that mentions --json", () => {
    const quoted = parseLoreArgv(`retain "we should require --json for admin tools"`);
    assert.equal(quoted.name, "lore_retain");
    assert.equal(quoted.args.content, "we should require --json for admin tools");
    const unquoted = parseLoreArgv("retain we should require --json for admin tools");
    assert.equal(unquoted.name, "lore_retain");
    assert.equal(unquoted.args.content, "we should require --json for admin tools");
  });

  test("accepts /lore correct <memoryId> without requiring --json", () => {
    assert.deepEqual(parseLoreArgv("correct mem-9").args, { memoryId: "mem-9" });
    assert.equal(parseLoreArgv("correct --memory-id mem-9").args.memoryId, "mem-9");
    const withJson = parseLoreArgv(`correct --json '{"memoryId":"mem-9","action":"preview"}'`);
    assert.equal(withJson.args.memoryId, "mem-9");
    assert.equal(withJson.args.action, "preview");
  });

  test("returns usage for empty input and unknown verbs", () => {
    assert.equal(parseLoreArgv("").error, LORE_SLASH_USAGE);
    assert.match(parseLoreArgv("nope").error, /unknown verb nope/);
  });

  test("tokenizes quoted arguments", () => {
    assert.deepEqual(tokenizeLoreArgv(`retain --type decision "we decided to use bun"`), [
      "retain",
      "--type",
      "decision",
      "we decided to use bun",
    ]);
  });
});

describe("dispatchSlash", () => {
  test("/lore forget id and forget id dispatch the same lore_forget call", async () => {
    const calls = [];
    const dispatch = async (name, args, extra) => {
      calls.push({ name, args, extra });
      return "ok";
    };
    await dispatchSlash("/lore forget mem-1", dispatch, { sessionId: "s-shared" });
    await dispatchSlash("forget mem-1", dispatch, { sessionId: "s-shared" });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0].name, "lore_forget");
    assert.deepEqual(calls[0].args, { id: "mem-1" });
  });

  test("forwards parsed argv to dispatchTool with surface slash", async () => {
    const calls = [];
    const result = await dispatchSlash("forget mem-1", async (name, args, extra) => {
      calls.push({ name, args, extra });
      return "ok";
    }, { sessionId: "s1" });
    assert.equal(result, "ok");
    assert.deepEqual(calls, [{
      name: "lore_forget",
      args: { id: "mem-1" },
      extra: { sessionId: "s1", surface: "slash" },
    }]);
  });

  test("does not call dispatchTool when parse fails", async () => {
    let called = false;
    const result = await dispatchSlash("not-a-verb", async () => {
      called = true;
      return "nope";
    });
    assert.equal(called, false);
    assert.match(result, /unknown verb/);
  });
});

describe("Copilot /lore intercept", () => {
  test("matchLoreSlashPrompt only matches a leading /lore word", () => {
    assert.equal(matchLoreSlashPrompt("/lore status"), "status");
    assert.equal(matchLoreSlashPrompt("  /lore forget id-1"), "forget id-1");
    assert.equal(matchLoreSlashPrompt("/lore"), "");
    assert.equal(matchLoreSlashPrompt("/lorestatus"), null);
    assert.equal(matchLoreSlashPrompt("please /lore status"), null);
    assert.equal(matchLoreSlashPrompt("status"), null);
  });

  test("interceptLoreSlashPrompt dispatches and logs, otherwise returns null", async () => {
    const logs = [];
    const calls = [];
    const handled = await interceptLoreSlashPrompt({
      prompt: "/lore status",
      sessionId: "sess-1",
      dispatchSlash: async (argsText, extra) => {
        calls.push({ argsText, extra });
        return "status ok";
      },
      log: async (text, options) => {
        logs.push({ text, options });
      },
    });
    assert.equal(handled.handled, true);
    assert.equal(handled.dispatched, true);
    assert.equal(handled.text, "status ok");
    assert.deepEqual(handled.hookOutput, loreSlashPromptHookOutput());
    assert.equal(handled.hookOutput.modifiedPrompt, "");
    assert.equal(handled.hookOutput.suppressOutput, true);
    assert.deepEqual(calls, [{ argsText: "status", extra: { sessionId: "sess-1", surface: "slash" } }]);
    assert.deepEqual(logs, [{ text: "status ok", options: { ephemeral: true } }]);

    const skipped = await interceptLoreSlashPrompt({
      prompt: "what did we decide?",
      dispatchSlash: async () => "nope",
    });
    assert.equal(skipped, null);
  });

  test("buildLoreSlashCommand is the joinSession commands entry", async () => {
    const calls = [];
    const logs = [];
    const command = buildLoreSlashCommand({
      dispatchSlash: async (args, extra) => {
        calls.push({ args, extra });
        return "from slash";
      },
      log: async (text, options) => {
        logs.push({ text, options });
      },
    });
    assert.equal(command.name, "lore");
    assert.equal(command.description, LORE_SLASH_DESCRIPTION);
    const text = await command.handler({ args: "forget id-2", sessionId: "s2" });
    assert.equal(text, "from slash");
    assert.deepEqual(calls[0], { args: "forget id-2", extra: { sessionId: "s2", surface: "slash" } });
    assert.equal(logs[0].options.ephemeral, true);
    assert.match(LORE_SLASH_ADVERTISEMENT, /\/lore/);
    assert.match(LORE_SLASH_ADVERTISEMENT, /remain registered until the Copilot \/lore TUI gate/);
    assert.match(LORE_SLASH_USAGE, /correct <memoryId>/);
    assert.match(LORE_SLASH_USAGE, /--json/);
  });

  test("command handler and intercept share a once-token so mutating verbs do not double-apply", async () => {
    const calls = [];
    const command = buildLoreSlashCommand({
      dispatchSlash: async (args) => {
        calls.push(`command:${args}`);
        return "once";
      },
    });
    await command.handler({ args: "forget id-9", sessionId: "same-session" });
    const intercepted = await interceptLoreSlashPrompt({
      prompt: "/lore forget id-9",
      sessionId: "same-session",
      dispatchSlash: async (args) => {
        calls.push(`intercept:${args}`);
        return "twice";
      },
    });
    assert.deepEqual(calls, ["command:forget id-9"]);
    assert.equal(intercepted.dispatched, false);
    assert.deepEqual(intercepted.hookOutput, loreSlashPromptHookOutput());
  });
});
