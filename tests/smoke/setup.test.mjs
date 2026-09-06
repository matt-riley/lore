import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/setup.mjs", import.meta.url));
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  for (const name of ["copilot", "pi", "codex", "claude", "agy"]) writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = { ...process.env, HOME: home, PATH: bin };
  for (const key of ["LORE_HOME", "LORE_CONFIG", "LORE_ENABLED", "LORE_COPILOT_HOME", "XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) delete env[key];
  return { home, env, run: (args = [], input = "") => spawnSync(process.execPath, [script, ...args], { env, input, encoding: "utf8", timeout: 15000 }), close: () => rmSync(home, { recursive: true, force: true }) };
}

test("setup detects clients and installs only the interactive selection with shared memory enabled", () => {
  const f = fixture();
  try {
    const result = f.run([], "codex,claude\ny\n");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Copilot/);
    assert.match(result.stdout, /Antigravity/);
    assert.equal(JSON.parse(readFileSync(path.join(f.home, ".config/lore/lore.json"))).enabled, true);
    assert.ok(JSON.parse(readFileSync(path.join(f.home, ".codex/hooks.json"))).hooks.UserPromptSubmit);
    assert.ok(JSON.parse(readFileSync(path.join(f.home, ".claude/settings.json"))).hooks.Stop);
    assert.equal(existsSync(path.join(f.home, ".pi")), false);
    assert.equal(existsSync(path.join(f.home, ".gemini")), false);
  } finally { f.close(); }
});

test("all clients install and rerun without duplicate hooks or losing settings", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.home, ".claude"));
    writeFileSync(path.join(f.home, ".claude/settings.json"), JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }] } }));
    for (let i = 0; i < 2; i++) {
      const result = f.run(["--clients", "all", "--yes"]);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.ok(existsSync(path.join(f.home, ".copilot/extensions/lore/extension.mjs")));
    assert.ok(existsSync(path.join(f.home, ".pi/agent/extensions/lore/lore-pi.ts")));
    assert.ok(JSON.parse(readFileSync(path.join(f.home, ".gemini/config/hooks.json"))).lore.PreInvocation);
    const settings = JSON.parse(readFileSync(path.join(f.home, ".claude/settings.json")));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.hooks.Stop.length, 2);
    const backups = path.join(f.home, ".config/lore/install-backups");
    const runs = readdirSync(backups);
    assert.ok(runs.length);
    const manifests = runs.map((run) => JSON.parse(readFileSync(path.join(backups, run, "manifest.json"))));
    assert.ok(manifests.flat().some((entry) => entry.target === path.join(f.home, ".claude/settings.json") && entry.existed));
    const copied = spawnSync(process.execPath, [path.join(f.home, ".copilot/extensions/lore/lore-cli.mjs"), "tool", "memory_status"], { env: f.env, input: "{}", encoding: "utf8" });
    assert.equal(copied.status, 0, copied.stderr);
    assert.ok(existsSync(path.join(f.home, ".config/lore/lore.db")));
    const codexHooks = JSON.parse(readFileSync(path.join(f.home, ".codex/hooks.json"))).hooks;
    const hook = spawnSync("/bin/sh", ["-c", codexHooks.SessionStart[0].hooks[0].command], {
      env: f.env, input: JSON.stringify({ session_id: "setup-verification", cwd: f.home }), encoding: "utf8",
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /lore_context/);
  } finally { f.close(); }
});

test("custom homes and numbered selection install to the resolved targets", () => {
  const f = fixture();
  try {
    f.env.LORE_HOME = path.join(f.home, "memory");
    f.env.CODEX_HOME = path.join(f.home, "custom-codex");
    f.env.CLAUDE_CONFIG_DIR = path.join(f.home, "custom-claude");
    f.env.PI_CODING_AGENT_DIR = path.join(f.home, "custom-pi");
    f.env.LORE_COPILOT_HOME = path.join(f.home, "custom-copilot");
    const result = f.run([], "1,2,3,4\nyes\n");
    assert.equal(result.status, 0, result.stderr);
    for (const file of ["memory/lore.json", "custom-codex/hooks.json", "custom-claude/settings.json", "custom-pi/extensions/lore/lore-pi.ts", "custom-copilot/extensions/lore/extension.mjs"]) assert.ok(existsSync(path.join(f.home, file)), file);
  } finally { f.close(); }
});

test("unrelated and dangling symlink extension targets are never replaced", () => {
  const f = fixture();
  try {
    const parent = path.join(f.home, ".copilot/extensions");
    mkdirSync(parent, { recursive: true });
    const target = path.join(parent, "lore");
    symlinkSync(path.join(f.home, "missing"), target);
    assert.notEqual(f.run(["--clients", "copilot", "--yes"]).status, 0);
    assert.equal(existsSync(path.join(f.home, ".config/lore/lore.json")), false);
    rmSync(target);
    mkdirSync(target);
    writeFileSync(path.join(target, "user.txt"), "keep");
    assert.notEqual(f.run(["--clients", "copilot", "--yes"]).status, 0);
    assert.equal(readFileSync(path.join(target, "user.txt"), "utf8"), "keep");
  } finally { f.close(); }
});

test("no detected clients and an environment disabling Lore fail without writes", () => {
  const f = fixture();
  try {
    f.env.LORE_ENABLED = "false";
    assert.notEqual(f.run(["--clients", "codex", "--yes"]).status, 0);
    delete f.env.LORE_ENABLED;
    f.env.PATH = "";
    const result = f.run(["--clients", "all", "--yes"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No supported CLIs/);
    assert.deepEqual(readdirSync(f.home), ["bin"]);
  } finally { f.close(); }
});

test("cancel, dry run, unavailable clients, and missing noninteractive selection make no changes", () => {
  const f = fixture();
  try {
    assert.equal(f.run([], "codex\nn\n").status, 0);
    assert.equal(f.run(["--clients", "all", "--dry-run"]).status, 0);
    assert.notEqual(f.run(["--yes"]).status, 0);
    rmSync(path.join(f.home, "bin/codex"));
    assert.notEqual(f.run(["--clients", "codex", "--yes"]).status, 0);
    assert.deepEqual(readdirSync(f.home), ["bin"]);
  } finally { f.close(); }
});

test("setup preserves legacy config and refuses malformed selected settings before any writes", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.home, ".copilot"));
    const config = path.join(f.home, ".copilot/lore.json");
    writeFileSync(config, '{"enabled":false,"limits":{"promptContextLimit":123}}');
    mkdirSync(path.join(f.home, ".claude"));
    writeFileSync(path.join(f.home, ".claude/settings.json"), "broken");
    assert.notEqual(f.run(["--clients", "codex,claude", "--yes"]).status, 0);
    assert.equal(JSON.parse(readFileSync(config)).enabled, false);
    assert.equal(existsSync(path.join(f.home, ".codex")), false);
    const result = f.run(["--clients", "codex", "--yes"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(config)), { enabled: true, limits: { promptContextLimit: 123 } });
    assert.equal(existsSync(path.join(f.home, ".config/lore")), false);
  } finally { f.close(); }
});
