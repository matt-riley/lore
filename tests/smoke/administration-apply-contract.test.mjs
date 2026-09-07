import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));

test("native correction moves an explicit destination and purge preserves suppression and snapshots", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-admin-apply-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("LORE_")) delete env[key];
  Object.assign(env, { HOME: home, LORE_HOME: home, LORE_CONFIG: path.join(home, "lore.json") });
  writeFileSync(env.LORE_CONFIG, JSON.stringify({ enabled: true }));
  const run = (tool, input) => spawnSync(process.execPath, [entry, "tool", tool], {
    cwd: home, env, input: JSON.stringify(input), encoding: "utf8", timeout: 10000,
  });
  const report = (tool, input) => {
    const result = run(tool, input);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const rows = (sql, ...args) => {
    const connection = new DatabaseSync(path.join(home, "lore.db"), { readOnly: true });
    try { return connection.prepare(sql).all(...args); } finally { connection.close(); }
  };
  try {
    const saved = run("memory_save", { content: "Prefer quartzanchor fixtures.", type: "user_preference", repository: "fixture/source", scope: "repo" });
    assert.equal(saved.status, 0, saved.stderr);
    const [old] = rows("SELECT id FROM semantic_memory WHERE content = ?", "Prefer quartzanchor fixtures.");
    assert.ok(old);
    const correction = { memoryId: old.id, repository: "fixture/destination", content: "Prefer reviewed quartzanchor fixtures.", reason: "Move the preference to its correct project." };
    const preview = report("memory_correct", correction);
    assert.deepEqual(preview.unresolvedCandidates, []);
    const applied = report("memory_correct", { ...correction, action: "apply", planFingerprint: preview.planFingerprint });
    assert.equal(applied.applied, true);
    assert.equal(applied.integrity, "ok");
    const [replacement] = rows("SELECT * FROM semantic_memory WHERE id = ?", applied.replacementId);
    assert.equal(replacement.repository, "fixture/destination");
    assert.equal(replacement.scope_source, "manual");
    assert.equal(JSON.parse(replacement.metadata_json).source, "memory_save");
    assert.equal(rows("SELECT superseded_by FROM semantic_memory WHERE id = ?", old.id)[0].superseded_by, replacement.id);
    assert.notEqual(run("memory_correct", { ...correction, action: "apply", planFingerprint: preview.planFingerprint }).status, 0);
    const purge = { memoryIds: [replacement.id] };
    const purgePreview = report("memory_purge", purge);
    assert.deepEqual(purgePreview.unresolvedCandidates, []);
    const purged = report("memory_purge", { ...purge, action: "apply", planFingerprint: purgePreview.planFingerprint });
    assert.equal(purged.applied, true);
    assert.equal(purged.integrity, "ok");
    assert.equal(rows("SELECT id FROM semantic_memory WHERE id = ?", replacement.id).length, 0);
    assert.ok(rows("SELECT suppression_key FROM memory_suppression WHERE memory_id = ?", replacement.id).length > 0);
    assert.equal(purged.retention.rawSources, "retained");
    assert.equal(purged.retention.secureErasure, false);
    assert.ok(existsSync(purged.backup.snapshotPath));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
