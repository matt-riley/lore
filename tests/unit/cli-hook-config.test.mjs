import assert from "node:assert/strict";
import { test } from "node:test";
import { shellQuote, buildCliHookConfig, mergeCliHookConfig } from "../../lib/clients/cli-hook-config.mjs";

test("shellQuote quotes and escapes strings for POSIX platforms", () => {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    assert.equal(shellQuote("simple"), "'simple'");
    assert.equal(shellQuote("with spaces"), "'with spaces'");
    assert.equal(shellQuote("can't stop"), "'can'\\''t stop'");
    assert.equal(shellQuote("path/to/\"quoted\"/file"), "'path/to/\"quoted\"/file'");
    assert.equal(shellQuote(123), "'123'");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("shellQuote quotes and escapes strings for Windows (win32)", () => {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.equal(shellQuote("simple"), '"simple"');
    assert.equal(shellQuote("with spaces"), '"with spaces"');
    assert.equal(shellQuote('has "quotes" inside'), '"has ""quotes"" inside"');
    assert.equal(shellQuote("can't stop"), '"can\'t stop"');
    assert.equal(shellQuote(456), '"456"');
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("buildCliHookConfig constructs expected hook structure", () => {
  const config = buildCliHookConfig("codex", { nodePath: "/bin/node", entryPath: "/app/lore-cli.mjs" });
  assert.ok(config.hooks);
  assert.ok(config.hooks.SessionStart);
  assert.equal(config.hooks.SessionStart[0].hooks[0].type, "command");
});
