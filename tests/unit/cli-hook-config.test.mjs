import assert from "node:assert/strict";
import { test } from "node:test";
import { shellQuote, buildCliHookConfig, mergeCliHookConfig } from "../../lib/clients/cli-hook-config.mjs";

test("shellQuote quotes and escapes strings for POSIX platforms", () => {
  assert.equal(shellQuote("simple", "darwin"), "'simple'");
  assert.equal(shellQuote("with spaces", "linux"), "'with spaces'");
  assert.equal(shellQuote("can't stop", "linux"), "'can'\\''t stop'");
  assert.equal(shellQuote("path/to/\"quoted\"/file", "darwin"), "'path/to/\"quoted\"/file'");
  assert.equal(shellQuote(123, "linux"), "'123'");
});

test("shellQuote quotes and escapes strings for Windows (win32)", () => {
  assert.equal(shellQuote("simple", "win32"), '"simple"');
  assert.equal(shellQuote("with spaces", "win32"), '"with spaces"');
  assert.equal(shellQuote('has "quotes" inside', "win32"), '"has ""quotes"" inside"');
  assert.equal(shellQuote("can't stop", "win32"), '"can\'t stop"');
  assert.equal(shellQuote(456, "win32"), '"456"');
});

test("buildCliHookConfig constructs expected hook structure", () => {
  const config = buildCliHookConfig("codex", { nodePath: "/bin/node", entryPath: "/app/lore-cli.mjs" });
  assert.ok(config.hooks);
  assert.ok(config.hooks.SessionStart);
  assert.equal(config.hooks.SessionStart[0].hooks[0].type, "command");
});

test("Codex SessionEnd uses a 10s timeout like other capture hooks", () => {
  const codex = buildCliHookConfig("codex", { nodePath: "/bin/node", entryPath: "/app/lore-cli.mjs" });
  assert.equal(codex.hooks.SessionEnd[0].hooks[0].timeout, 10);
  assert.equal(codex.hooks.Stop[0].hooks[0].timeout, 10);
  const claude = buildCliHookConfig("claude", { nodePath: "/bin/node", entryPath: "/app/lore-cli.mjs" });
  assert.equal(claude.hooks.SessionEnd[0].hooks[0].timeout, 10);
});
