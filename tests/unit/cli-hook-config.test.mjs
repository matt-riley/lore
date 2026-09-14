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

test("antigravity install never overwrites an unowned or modified lore group", () => {
  const fragment = buildCliHookConfig("antigravity", { nodePath: "/bin/node", entryPath: "/app/lore-cli.mjs" });
  const ownedCommands = Object.values(fragment.lore).flatMap((value) => value.flatMap((hook) => hook.command || hook.hooks?.[0]?.command));

  // Absent group installs normally.
  assert.deepEqual(mergeCliHookConfig({}, fragment, "antigravity"), { lore: fragment.lore });

  // An exact owned rerun is idempotent.
  const installed = mergeCliHookConfig({}, fragment, "antigravity");
  assert.deepEqual(mergeCliHookConfig(installed, fragment, "antigravity", { ownedCommands }), installed);

  // An unrelated first-time group is refused rather than overwritten.
  const unrelated = { lore: { Stop: [{ type: "command", command: "echo keep-my-hook" }] } };
  assert.throws(
    () => mergeCliHookConfig(unrelated, fragment, "antigravity"),
    /unrelated or modified 'lore' hook group/,
  );

  // A modified owned group is also refused, on install and on removal.
  const modified = { lore: { Stop: [...fragment.lore.Stop, { type: "command", command: "echo keep-my-hook" }] } };
  assert.throws(() => mergeCliHookConfig(modified, fragment, "antigravity", { ownedCommands }), /unrelated or modified/);
  assert.throws(() => mergeCliHookConfig(modified, fragment, "antigravity", { remove: true, ownedCommands }), /unrelated or modified/);

  // Removal only deletes a fully owned group.
  assert.deepEqual(mergeCliHookConfig(installed, fragment, "antigravity", { remove: true, ownedCommands }), {});
});
