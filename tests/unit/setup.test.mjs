import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import {
  planSetup,
  applySetup,
  planRemove,
  applyRemove,
  buildLorePathShimScript,
  isLorePathShim,
  formatLorePathExport,
  LORE_PATH_SHIM_MARKER,
} from "../../lib/clients/setup.mjs";
import { fileURLToPath } from "node:url";

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
    assert.ok(existsSync(path.join(target, "lib/clients/setup.mjs")));
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

test("remove uses ownership records, preserves unrelated hooks and memories, and is idempotent", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-remove-"));
  try {
    const env = { HOME: home };
    applySetup(planSetup(["codex", "copilot"], { home, env }));
    const hooksPath = path.join(home, ".codex/hooks.json");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    hooks.hooks.SessionStart.push({ hooks: [{ type: "command", command: "echo unrelated" }] });
    writeFileSync(hooksPath, `${JSON.stringify(hooks)}\n`);
    writeFileSync(path.join(home, ".config/lore/lore.db"), "memories");
    applyRemove(planRemove(["codex", "copilot"], { home, env }));
    const after = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(after.hooks.SessionStart.length, 1);
    assert.equal(after.hooks.SessionStart[0].hooks[0].command, "echo unrelated");
    assert.equal(existsSync(path.join(home, ".copilot/extensions/lore")), false);
    assert.equal(readFileSync(path.join(home, ".config/lore/lore.db"), "utf8"), "memories");
    assert.doesNotThrow(() => applyRemove(planRemove(["codex", "copilot"], { home, env })));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("rollback quarantines an edited runtime instead of deleting the user's change", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-quarantine-"));
  try {
    const target = path.join(home, ".copilot/extensions/lore");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "package.json"), '{"name":"lore"}');
    writeFileSync(path.join(target, "extension.mjs"), "// old\n");
    const plan = planSetup(["copilot", "codex"], { home, env: {} });
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex/hooks.json"), "{}\n");
    const changed = path.join(home, ".codex/hooks.json");
    writeFileSync(changed, "{\"changed\":true}\n");
    assert.throws(() => applySetup(plan, {
      afterApply(change) {
        if (change.type === "directory") writeFileSync(path.join(change.target, "extension.mjs"), "// user edit\n");
      },
    }), /changed during setup/);
    assert.equal(readFileSync(path.join(target, "extension.mjs"), "utf8"), "// old\n");
    const backupRoot = path.join(home, ".config/lore/install-backups");
    const quarantine = readdirSync(backupRoot).flatMap(run => readdirSync(path.join(backupRoot, run)).filter(name => name.startsWith("quarantine-")).map(name => path.join(backupRoot, run, name)))[0];
    assert.ok(quarantine, "edited runtime should be quarantined outside extension discovery");
    assert.equal(readFileSync(path.join(quarantine, "extension.mjs"), "utf8"), "// user edit\n");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("legacy hook removal refuses unrelated commands merely mentioning Lore", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-remove-legacy-"));
  try {
    const target = path.join(home, ".codex/hooks.json");
    mkdirSync(path.dirname(target), { recursive: true });
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "echo 'lore-cli.mjs hook codex Stop'" }] }] } });
    writeFileSync(target, original);
    assert.throws(() => planRemove(["codex"], { home, env: {} }), /ownership/);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("removal refuses runtime edits made after its preview", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-remove-race-"));
  try {
    applySetup(planSetup(["copilot"], { home, env: {} }));
    const plan = planRemove(["copilot"], { home, env: {} });
    const target = path.join(home, ".copilot/extensions/lore/extension.mjs");
    writeFileSync(target, "// concurrent user edit");
    assert.throws(() => applyRemove(plan), /changed during removal/);
    assert.equal(readFileSync(target, "utf8"), "// concurrent user edit");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const client of ["codex", "claude", "antigravity"]) {
  test(`removing ${client} with a deleted hook file clears only its ownership record`, () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lore-remove-missing-"));
    try {
      const env = { HOME: home };
      applySetup(planSetup([client, "pi"], { home, env }));
      const manifestPath = path.join(home, ".config/lore/install-manifest.json");
      const before = JSON.parse(readFileSync(manifestPath, "utf8"));
      const target = before.installs[client].target;
      rmSync(target);
      applyRemove(planRemove([client], { home, env }));
      const after = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(after.installs[client], undefined);
      assert.deepEqual(after.installs.pi, before.installs.pi);
      assert.equal(existsSync(target), false);
      applyRemove(planRemove([client], { home, env }));
      assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), after);
      applySetup(planSetup([client], { home, env }));
      assert.equal(existsSync(target), true);
      applyRemove(planRemove([client], { home, env }));
      assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).installs[client], undefined);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test("malformed ownership manifests fail with an actionable error before setup or removal writes", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-invalid-manifest-"));
  try {
    const options = { home, env: { HOME: home } };
    applySetup(planSetup(["codex"], options));
    const manifestPath = path.join(home, ".config/lore/install-manifest.json");
    const hooksPath = path.join(home, ".codex/hooks.json");
    const configPath = path.join(home, ".config/lore/lore.json");
    const hooks = readFileSync(hooksPath, "utf8");
    const config = readFileSync(configPath, "utf8");
    const expectedMessage = new RegExp(`^Invalid Lore installation manifest at ${manifestPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*restore.*backup`, "is");
    for (const value of [
      "{", "null", "[]", "{}",
      ...[null, [], "broken", 42].map(installs => JSON.stringify({ version: 1, installs })),
      JSON.stringify({ version: 2, installs: {} }),
      JSON.stringify({ version: 1, installs: { codex: null } }),
      JSON.stringify({ version: 1, installs: { codex: { kind: "hooks", target: hooksPath, commands: "broken" } } }),
    ]) {
      writeFileSync(manifestPath, value);
      for (const plan of [planSetup, planRemove]) {
        assert.throws(() => plan(["codex"], options), { message: expectedMessage });
        assert.equal(readFileSync(manifestPath, "utf8"), value);
        assert.equal(readFileSync(hooksPath, "utf8"), hooks);
        assert.equal(readFileSync(configPath, "utf8"), config);
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("setup writes a PATH shim, reruns idempotently, and removes it with the last client", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-shim-"));
  const bin = path.join(home, "bin");
  try {
    mkdirSync(bin, { recursive: true });
    const env = { HOME: home, PATH: bin };
    const first = planSetup(["codex"], { home, env });
    const homeBin = path.join(home, ".config/lore/bin/lore");
    const pathCopy = path.join(bin, "lore");
    assert.equal(first.shim.homeBin, homeBin);
    assert.equal(first.shim.pathCopy, pathCopy);
    assert.equal(first.pathExport, null);
    applySetup(first);
    assert.equal(existsSync(homeBin), true);
    assert.equal(existsSync(pathCopy), true);
    const script = readFileSync(homeBin, "utf8");
    assert.ok(isLorePathShim(script));
    assert.match(script, /command -v node/);
    assert.equal(readFileSync(pathCopy, "utf8"), script);

    const rerun = planSetup(["codex"], { home, env });
    assert.equal(rerun.changes.some((change) => change.target === homeBin || change.target === pathCopy), false);
    applySetup(rerun);
    assert.equal(readFileSync(homeBin, "utf8"), script);

    applyRemove(planRemove(["codex"], { home, env }));
    assert.equal(existsSync(homeBin), false);
    assert.equal(existsSync(pathCopy), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("setup still creates the home shim when PATH is not writable", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-shim-locked-"));
  const locked = path.join(home, "locked");
  try {
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o555);
    const env = { HOME: home, PATH: locked };
    const plan = planSetup(["codex"], { home, env });
    const homeBin = path.join(home, ".config/lore/bin/lore");
    assert.equal(plan.shim.pathCopy, null);
    assert.equal(plan.pathExport, formatLorePathExport(path.join(home, ".config/lore")));
    applySetup(plan);
    assert.equal(existsSync(homeBin), true);
    assert.equal(existsSync(path.join(locked, "lore")), false);
    assert.match(readFileSync(homeBin, "utf8"), new RegExp(LORE_PATH_SHIM_MARKER));
  } finally {
    try { chmodSync(locked, 0o755); } catch { /* cleanup */ }
    rmSync(home, { recursive: true, force: true });
  }
});

test("a later setup failure rolls back a newly written PATH shim", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-setup-shim-rollback-"));
  const bin = path.join(home, "bin");
  try {
    mkdirSync(bin, { recursive: true });
    const env = { HOME: home, PATH: bin };
    const plan = planSetup(["codex"], { home, env });
    assert.throws(() => applySetup(plan, {
      afterApply(change) {
        if (change.type === "file") throw new Error("simulated shim failure");
      },
    }), /simulated shim failure/);
    assert.equal(existsSync(path.join(home, ".config/lore/bin/lore")), false);
    assert.equal(existsSync(path.join(bin, "lore")), false);
    assert.equal(existsSync(path.join(home, ".codex/hooks.json")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("PATH shim re-resolves node when the baked binary is missing", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-shim-resolve-"));
  try {
    const shim = path.join(home, "lore");
    const cliPath = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));
    writeFileSync(shim, buildLorePathShimScript({
      nodePath: path.join(home, "missing-node"),
      cliPath,
    }), { mode: 0o755 });
    const result = spawnSync(shim, [], {
      encoding: "utf8",
      timeout: 3000,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /usage: \/lore <verb>/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
