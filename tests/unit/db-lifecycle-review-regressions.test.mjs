import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { restoreRecoverySnapshot } from "../../lib/maintenance/recovery.mjs";

const repo = "fixture/review";
function generated(content, key = "k", revision = "a") {
  return { type: "user_preference", content, scope: "repo", repository: repo,
    metadata: { source: "rule_extractor" }, evidence: { key, revision, contentHash: content } };
}
function reconcile(db, memories, retiredEvidenceKeys = []) {
  return db.reconcileGeneratedMemories({ sessionId: "review-session", repository: repo, memories, retiredEvidenceKeys });
}

test("accepted changed evidence updates its proposition while preserving independent support", async () => {
  const { db, cleanup } = await withFixtureDb();
  try {
    const [oldId] = reconcile(db, [generated("Prefer kiwi fixtures.")]);
    reconcile(db, [generated("Prefer kiwi fixtures.", "independent")]);
    const [nextId] = reconcile(db, [generated("Prefer citrus fixtures.", "k", "b")]);
    assert.notEqual(nextId, oldId);
    assert.equal(db.searchSemantic({ query: "citrus", repository: repo }).length, 1);
    assert.equal(db.searchSemantic({ query: "kiwi", repository: repo }).length, 1);
    reconcile(db, [], ["independent"]);
    assert.equal(db.searchSemantic({ query: "kiwi", repository: repo }).length, 0);
    assert.equal(db.searchSemantic({ query: "citrus", repository: repo }).length, 1);
  } finally { cleanup(); }
});

test("unchanged proposition revision refreshes evidence metadata without reinforcing replay", async () => {
  const { db, cleanup } = await withFixtureDb();
  try {
    const [id] = reconcile(db, [generated("Prefer kiwi fixtures.")]);
    const before = db.db.prepare("SELECT reinforcement_count FROM semantic_memory WHERE id=?").get(id);
    reconcile(db, [generated("Prefer kiwi fixtures.", "k", "b")]);
    const after = db.db.prepare("SELECT reinforcement_count, metadata_json FROM semantic_memory WHERE id=?").get(id);
    assert.equal(after.reinforcement_count, before.reinforcement_count);
    assert.equal(JSON.parse(after.metadata_json).evidence.revision, "b");
  } finally { cleanup(); }
});

test("manual scope authority survives inferred replay and retirement", async () => {
  const { db, cleanup } = await withFixtureDb();
  try {
    const id = db.insertSemanticMemory({ ...generated("Prefer kiwi fixtures."), confidence: 0.7, metadata: { source: "memory_save" } });
    db.applyScopeChanges({ targetType: "semantic", ids: [id], scope: "repo", repository: repo, actor: "user", reason: "fixture", source: "memory_scope" });
    const before = db.db.prepare("SELECT confidence, reinforcement_count, metadata_json FROM semantic_memory WHERE id=?").get(id);
    reconcile(db, [{ ...generated("Prefer kiwi fixtures."), confidence: 0.95 }]);
    assert.deepEqual(db.db.prepare("SELECT confidence, reinforcement_count, metadata_json FROM semantic_memory WHERE id=?").get(id), before);
    reconcile(db, [], ["k"]);
    assert.equal(db.searchSemantic({ query: "kiwi", repository: repo })[0]?.id, id);
  } finally { cleanup(); }
});

test("missing checkpoint returns the stable CAS conflict category", async () => {
  const { db, cleanup } = await withFixtureDb();
  try {
    assert.throws(() => db.saveIngestionCheckpoint("codex", "missing", { expectedCheckpointRevision: 1, revision: "opaque", offset: 1 }),
      (error) => error.code === "CHECKPOINT_REVISION_CONFLICT" && error.currentRevision === 0);
  } finally { cleanup(); }
});

test("direct restore rejects unrelated SQLite and preserves target", async () => {
  const { db, cleanup, config } = await withFixtureDb();
  try {
    const id = db.insertSemanticMemory(generated("Prefer kiwi fixtures."));
    const invalid = path.join(path.dirname(config.paths.derivedStorePath), "unrelated.db");
    const source = new DatabaseSync(invalid);
    source.exec("CREATE TABLE unrelated (id INTEGER)"); source.close();
    assert.throws(() => db.restoreFromBackup(invalid), /recognized Lore|complete Lore/);
    assert.equal(db.db.prepare("SELECT id FROM semantic_memory WHERE id=?").get(id)?.id, id);
  } finally { cleanup(); }
});

test("closed-facade direct restore preserves current suppressions", async () => {
  const { db, cleanup } = await withFixtureDb();
  try {
    const id = db.insertSemanticMemory(generated("Prefer kiwi fixtures."));
    const snapshot = db.backupDatabase();
    db.forgetMemory({ id }); db.close();
    db.restoreFromBackup(snapshot);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM memory_suppression").get().n, 1);
  } finally { cleanup(); }
});

for (const version of ["v13-lore-v0.2.0", "v15-lore-v0.3.0", "v18-lore-v0.10.0"]) {
  test(`released ${version} recovery migrates the installed stage before merging suppression`, async () => {
    const { db, cleanup, config } = await withFixtureDb();
    try {
      const source = path.join(path.dirname(config.paths.derivedStorePath), "old.db");
      const snapshot = new DatabaseSync(source);
      snapshot.exec(readFileSync(new URL(`../fixtures/released-upgrades/${version}.sql`, import.meta.url), "utf8")); snapshot.close();
      const id = db.insertSemanticMemory(generated("Prefer kiwi fixtures.")); db.forgetMemory({ id }); db.close();
      restoreRecoverySnapshot({ derivedStorePath: config.paths.derivedStorePath, snapshotPath: source, write: true, clientsStopped: true, detectActiveUsers: () => [] });
      const installed = new DatabaseSync(config.paths.derivedStorePath, { readOnly: true });
      try {
        assert.equal(installed.prepare("SELECT count(*) AS n FROM memory_suppression").get().n, 1);
        const columns = installed.prepare("PRAGMA table_info(memory_embedding)").all().map((row) => row.name);
        for (const column of ["content_hash", "provider", "model", "dimensions"]) assert.ok(columns.includes(column));
      } finally { installed.close(); }
    } finally { cleanup(); }
  });
}

test("revised canonical goals preserve independently supported prior wording", async () => {
  const { db, cleanup } = await withFixtureDb();
  const goal = (content, key, revision = "a") => ({ ...generated(content, key, revision), type: "assistant_goal", metadata: { source: "rule_extractor", goal: "fixture-goal" } });
  try {
    const [oldId] = reconcile(db, [goal("Keep kiwi work bounded.", "goal")]);
    reconcile(db, [goal("Keep kiwi work bounded.", "goal-independent")]);
    const [newId] = reconcile(db, [goal("Keep citrus work bounded.", "goal", "b")]);
    assert.notEqual(oldId, newId);
    assert.equal(db.db.prepare("SELECT content FROM semantic_memory WHERE id=?").get(oldId).content, "Keep kiwi work bounded.");
    assert.equal(db.db.prepare("SELECT content FROM semantic_memory WHERE id=?").get(newId).content, "Keep citrus work bounded.");
  } finally { cleanup(); }
});
