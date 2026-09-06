import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { planSetup, applySetup } from "../../lib/setup.mjs";

test("failed installation restores config instead of leaving Lore partially enabled", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-rollback-"));
  try {
    const config = path.join(home, ".config/lore/lore.json");
    mkdirSync(path.dirname(config), { recursive: true });
    const original = '{"enabled":false,"custom":"keep"}\n';
    writeFileSync(config, original);
    const plan = planSetup(["copilot"], { home, env: {}, source: path.join(home, "missing-source") });
    assert.throws(() => applySetup(plan), /ENOENT/);
    assert.equal(readFileSync(config, "utf8"), original);
    assert.equal(existsSync(path.join(home, ".copilot/extensions/lore")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("setup refuses concurrent configuration edits and overlapping targets", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-conflict-"));
  try {
    const plan = planSetup(["codex"], { home, env: {} });
    mkdirSync(path.dirname(plan.paths.configPath), { recursive: true });
    writeFileSync(plan.paths.configPath, '{"changed":true}');
    assert.throws(() => applySetup(plan), /changed during setup/);
    assert.equal(readFileSync(plan.paths.configPath, "utf8"), '{"changed":true}');
    assert.throws(() => planSetup(["codex"], { home, env: { LORE_CONFIG: path.join(home, ".codex/hooks.json") } }), /overlap/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a later config conflict restores a replaced extension including user files", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-restore-"));
  try {
    const target = path.join(home, ".copilot/extensions/lore");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "package.json"), '{"name":"lore"}');
    writeFileSync(path.join(target, "extension.mjs"), "// original\n");
    writeFileSync(path.join(target, "local-notes.txt"), "preserve user work");
    const plan = planSetup(["copilot", "codex"], { home, env: {} });
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex/hooks.json"), '{"other":true}');
    assert.throws(() => applySetup(plan), /changed during setup/);
    assert.equal(readFileSync(path.join(target, "extension.mjs"), "utf8"), "// original\n");
    assert.equal(readFileSync(path.join(target, "local-notes.txt"), "utf8"), "preserve user work");
    assert.equal(existsSync(path.join(target, "lib")), false);
    assert.equal(existsSync(plan.paths.configPath), false);
    assert.equal(readFileSync(path.join(home, ".codex/hooks.json"), "utf8"), '{"other":true}');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("cross-volume backups support extension updates and rollback", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-cross-device-"));
  const rename = fs.renameSync;
  try {
    // Model the OS boundary only; all copying, installation, and recovery still
    // operate on real files. Removing the EXDEV fallback must fail this test.
    fs.renameSync = (from, to) => {
      if (String(to).includes("install-backups") || String(from).includes("install-backups")) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const target = path.join(home, ".copilot/extensions/lore");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "package.json"), '{"name":"lore"}');
    writeFileSync(path.join(target, "extension.mjs"), "// original\n");
    writeFileSync(path.join(target, "local.txt"), "keep");
    const failing = planSetup(["copilot", "codex"], { home, env: {} });
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex/hooks.json"), '{"changed":true}');
    assert.throws(() => applySetup(failing), /changed during setup/);
    assert.equal(readFileSync(path.join(target, "local.txt"), "utf8"), "keep");
    const backup = applySetup(planSetup(["copilot"], { home, env: {} }));
    assert.ok(existsSync(path.join(target, "lib/setup.mjs")));
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["lore"]);
    const manifest = JSON.parse(readFileSync(path.join(backup, "manifest.json")));
    const saved = manifest.find((entry) => entry.target === target);
    assert.equal(readFileSync(path.join(backup, saved.backup, "local.txt"), "utf8"), "keep");
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
    rmSync(home, { recursive: true, force: true });
  }
});
