import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { restoreRecoverySnapshot } from "../../lib/maintenance/recovery.mjs";
import { memoryPurge } from "../../lib/memory/memory-administration.mjs";

const repository = "github.com/example/restore";
const manual = (id) => ({ id, type: "user_preference", content: "Prefer tungsten fixtures.", scope: "repo", repository, metadata: { source: "memory_save" } });
const search = (db) => db.searchSemantic({ query: "tungsten", repository }).map((row) => row.id);
function restore(f, snapshot, route, extra = {}) {
  f.db.close();
  if (route === "direct") f.db.restoreFromBackup(snapshot);
  else {
    restoreRecoverySnapshot({ derivedStorePath: f.config.paths.derivedStorePath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => [], ...extra });
    f.db.initialize();
  }
}

for (const route of ["direct", "recovery"]) for (const removal of ["forget", "purge"]) {
  test(`${route} snapshot restore cannot resurrect a ${removal} manual memory`, async () => {
    const f = await withFixtureDb();
    try {
      const id = f.db.insertSemanticMemory(manual("original"));
      const snapshot = f.db.backupDatabase();
      const snapshotBytes = readFileSync(snapshot);
      if (removal === "forget") f.db.forgetMemory({ id });
      else {
        const request = { memoryIds: [id] };
        const plan = memoryPurge(f.db, request);
        memoryPurge(f.db, { ...request, action: "apply", planFingerprint: plan.planFingerprint });
      }
      assert.deepEqual(search(f.db), []);
      for (let replay = 0; replay < 2; replay++) {
        restore(f, snapshot, route);
        assert.equal(f.db.isMemorySuppressed(id), true);
        assert.deepEqual(search(f.db), [], "original manual ID must stay excluded");
        assert.ok(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id=?").get(id).superseded_by);
        assert.deepEqual(f.db.reconcileGeneratedMemories({ sessionId: "replay", repository, memories: [{ ...manual(undefined), metadata: { source: "rule_extractor" } }] }), [null]);
      }
      assert.deepEqual(readFileSync(snapshot), snapshotBytes);
    } finally { f.cleanup(); }
  });
}

for (const route of ["direct", "recovery"]) {
  test(`${route} restore preserves a fresh explicit manual ID for the same proposition`, async () => {
    const f = await withFixtureDb();
    try {
      f.db.insertSemanticMemory(manual("original"));
      f.db.forgetMemory({ id: "original" });
      const fresh = f.db.insertSemanticMemory(manual("fresh"));
      assert.equal(fresh, "fresh");
      const snapshot = f.db.backupDatabase();
      restore(f, snapshot, route);
      assert.deepEqual(search(f.db), [fresh]);
      assert.equal(f.db.isMemorySuppressed("original"), true);
      assert.equal(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id=?").get(fresh).superseded_by, null);
    } finally { f.cleanup(); }
  });
}

test("stage enforces its own active ledger even without incoming current suppressions", async () => {
  const f = await withFixtureDb();
  try {
    f.db.insertSemanticMemory(manual("original"));
    f.db.forgetMemory({ id: "original" });
    f.db.db.prepare("UPDATE semantic_memory SET superseded_by=NULL WHERE id='original'").run();
    const snapshot = f.db.backupDatabase();
    restore(f, snapshot, "recovery", { preserveCurrentSuppressions: false });
    assert.deepEqual(search(f.db), []);
  } finally { f.cleanup(); }
});

for (const column of ["superseded_at", "repair_candidate"]) {
  test(`restore does not apply inactive or ambiguous suppression (${column})`, async () => {
    const f = await withFixtureDb();
    try {
      f.db.insertSemanticMemory(manual("original"));
      const snapshot = f.db.backupDatabase();
      f.db.forgetMemory({ id: "original" });
      f.db.db.prepare(`UPDATE memory_suppression SET ${column}=?`).run(column === "repair_candidate" ? 1 : "2026-01-01T00:00:00Z");
      restore(f, snapshot, "direct");
      assert.deepEqual(search(f.db), ["original"]);
    } finally { f.cleanup(); }
  });
}

test("failed recovery replacement rolls back without losing manual suppression", async () => {
  const f = await withFixtureDb();
  try {
    f.db.insertSemanticMemory(manual("original"));
    const snapshot = f.db.backupDatabase();
    f.db.forgetMemory({ id: "original" });
    f.db.close();
    const before = readFileSync(f.config.paths.derivedStorePath);
    assert.throws(() => restore(f, snapshot, "recovery", { fsOps: { renameSync(from, to) {
      if (from.includes(".restore-")) throw new Error("injected installation failure");
      renameSync(from, to);
    } } }), /injected installation failure/);
    assert.deepEqual(readFileSync(f.config.paths.derivedStorePath), before);
    f.db.initialize();
    assert.deepEqual(search(f.db), []);
    assert.equal(f.db.isMemorySuppressed("original"), true);
  } finally { f.cleanup(); }
});

test("failed stage suppression transaction leaves the current database unchanged", async () => {
  const f = await withFixtureDb();
  try {
    f.db.insertSemanticMemory(manual("original"));
    f.db.db.exec("CREATE TRIGGER fail_restore_suppression BEFORE UPDATE OF superseded_by ON semantic_memory WHEN NEW.superseded_by LIKE 'suppressed:%' BEGIN SELECT RAISE(ABORT, 'injected stage failure'); END;");
    const snapshot = f.db.backupDatabase();
    f.db.forgetMemory({ id: "original" });
    f.db.close();
    const before = readFileSync(f.config.paths.derivedStorePath);
    assert.throws(() => restore(f, snapshot, "direct"), /injected stage failure/);
    assert.deepEqual(readFileSync(f.config.paths.derivedStorePath), before);
    assert.equal(readdirSync(path.dirname(f.config.paths.derivedStorePath)).some((name) => name.includes(".restore-")), false);
    f.db.initialize();
    assert.deepEqual(search(f.db), []);
  } finally { f.cleanup(); }
});
