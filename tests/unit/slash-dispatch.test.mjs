import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildLoreSlashCommand,
  dispatchSlash,
  interceptLoreSlashPrompt,
  matchLoreSlashPrompt,
  parseLoreArgv,
  tokenizeLoreArgv,
  LORE_SLASH_ADVERTISEMENT,
  LORE_SLASH_DESCRIPTION,
  LORE_SLASH_USAGE,
} from "../../lib/runtime/slash-dispatch.mjs";

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
    const withJson = parseLoreArgv(`repair --json ${JSON.stringify({ action: "preview" })}`);
    assert.equal(withJson.name, "lore_repair");
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
    assert.deepEqual(handled, { handled: true, text: "status ok" });
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
  });
});
