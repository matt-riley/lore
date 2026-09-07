import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-admin-cli-"));
  const env = { ...process.env, HOME: home, LORE_HOME: home, LORE_CONFIG: path.join(home, "lore.json"), LORE_ENABLED: "true", LORE_REPOSITORY: "example/cli" };
  writeFileSync(env.LORE_CONFIG, JSON.stringify({ enabled: true }));
  return {
    home, env,
    run(name, input, extraEnv = {}) {
      return spawnSync(process.execPath, [entry, "tool", name], { cwd: home, env: { ...env, ...extraEnv }, input: JSON.stringify(input), encoding: "utf8", timeout: 10000 });
    },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

test("native administration preview preserves database bytes, configuration, and application files", () => {
  const f = fixture();
  try {
    const saved = f.run("memory_save", { content: "Prefer quartzanchor fixtures.", type: "user_preference" });
    assert.equal(saved.status, 0, saved.stderr);
    const memoryId = saved.stdout.trim().split(" ").at(-1);
    const dbPath = path.join(f.home, "lore.db");
    const before = readFileSync(dbPath);
    const configBefore = readFileSync(f.env.LORE_CONFIG);
    const appFiles = () => readdirSync(f.home).filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm")).sort();
    const filesBefore = appFiles();
    for (const [name, input] of [
      ["memory_correct", { memoryId, content: "Prefer reviewed quartzanchor fixtures." }],
      ["memory_purge", { memoryIds: [memoryId] }],
      ["memory_repair", { memoryIds: [memoryId] }],
    ]) {
      const result = f.run(name, input);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.action, "preview");
      assert.equal(report.applied, undefined);
      assert.equal(report.selectors.repository, null, "environment repository must not become an explicit selector");
      assert.deepEqual(readFileSync(dbPath), before);
      assert.deepEqual(readFileSync(f.env.LORE_CONFIG), configBefore);
      assert.deepEqual(appFiles(), filesBefore);
    }
  } finally { f.cleanup(); }
});

test("native missing and legacy previews cannot initialize or migrate a database", () => {
  const f = fixture();
  try {
    const missing = path.join(f.home, "missing", "store");
    const unavailable = f.run("memory_purge", { repository: "example/cli" }, { LORE_HOME: missing });
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /unavailable/i);
    assert.equal(existsSync(missing), false);
    const oldHome = path.join(f.home, "old");
    mkdirSync(oldHome);
    const oldPath = path.join(oldHome, "lore.db");
    const old = new DatabaseSync(oldPath);
    old.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO schema_version VALUES(18,'2026-01-01');");
    old.close();
    const before = readFileSync(oldPath);
    const upgrade = f.run("memory_purge", { repository: "example/cli" }, { LORE_HOME: oldHome });
    assert.notEqual(upgrade.status, 0);
    assert.match(upgrade.stderr, /schema upgrade required/i);
    assert.deepEqual(readFileSync(oldPath), before);
    assert.deepEqual(readdirSync(oldHome), ["lore.db"]);
  } finally { f.cleanup(); }
});

test("native invalid administration action is rejected before creating a store", () => {
  const f = fixture();
  try {
    const result = f.run("memory_purge", { action: "delete", repository: "example/cli" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /action must be preview or apply/);
    assert.equal(existsSync(path.join(f.home, "lore.db")), false);
  } finally { f.cleanup(); }
});
