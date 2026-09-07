import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applySessionExtraction } from "../../lib/sessions/backfill.mjs";
import { SCHEMA_VERSION } from "../../lib/db/schema.mjs";
import { createRecoverySnapshot, restoreRecoverySnapshot } from "../../lib/maintenance/recovery.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function extraction(sessionId, repository, memories) {
  return {
    episodeDigest: {
      id: `episode-${sessionId}`,
      sessionId,
      repository,
      summary: "Fixture summary",
      dateKey: "2026-09-07",
      actions: [],
      decisions: [],
      learnings: [],
      filesChanged: [],
      refs: [],
      significance: 5,
      themes: ["fixture"],
      openItems: [],
      source: "rule",
    },
    semanticMemories: memories,
  };
}

describe("database reliability foundation", () => {
  test("fresh schema is v20 and contains lifecycle tables", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      assert.equal(db.getCurrentVersion(), 20);
      assert.equal(SCHEMA_VERSION, 20);
      for (const table of [
        "session_evidence",
        "memory_evidence",
        "memory_suppression",
        "ingestion_checkpoint",
        "repository_identity_mapping",
      ]) {
        assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
      }
      assert.ok(db.tableHasColumn("improvement_backlog", "repository"));
    } finally {
      cleanup();
    }
  });

  test("checkpoint and capture health APIs return JSON serializable state", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const state = {
        sourceIdentity: "fixture-source",
        offset: 42,
        partialRecord: { text: "partial" },
        adapterState: { branch: "main" },
        revision: "r2",
        health: { lastSuccessAt: "2026-09-07T10:00:00.000Z", pendingBytes: 3, failureCode: null },
      };
      const expected = {
        client: "codex",
        sessionId: "session-1",
        repository: null,
        ...state,
        branchState: {},
        checkpointRevision: 1,
      };
      const saved = db.saveIngestionCheckpoint("codex", "session-1", state);
      assert.deepEqual({ ...saved, updatedAt: undefined }, { ...expected, updatedAt: undefined });
      const loaded = db.getIngestionCheckpoint("codex", "session-1");
      assert.deepEqual({ ...loaded, updatedAt: undefined }, { ...expected, updatedAt: undefined });
      assert.doesNotThrow(() => JSON.stringify(db.listCaptureHealth()));
      assert.deepEqual(db.listCaptureHealth({ repository: "fixture-repo" }), []);
    } finally {
      cleanup();
    }
  });

  test("reconciliation retains evidence outside the current bounded extraction window", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const first = {
        type: "user_preference",
        content: "Preserve the first preference.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-long",
        sourceTurnIndex: 1,
        evidence: { key: "evidence:first", sourceRecordId: "1", sourceKind: "preference", revision: "1", contentHash: "a" },
        metadata: { sourceAttribution: { role: "user", recordId: "1" }, confidenceBasis: "explicit_preference" },
      };
      const second = {
        type: "user_preference",
        content: "Preserve the second preference.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-long",
        sourceTurnIndex: 20,
        evidence: { key: "evidence:second", sourceRecordId: "20", sourceKind: "preference", revision: "1", contentHash: "b" },
      };
      applySessionExtraction({ db, sessionId: "session-long", repository: "fixture-repo", extraction: extraction("session-long", "fixture-repo", [first, second]) });
      applySessionExtraction({ db, sessionId: "session-long", repository: "fixture-repo", extraction: extraction("session-long", "fixture-repo", [second]) });
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM semantic_memory WHERE source_session_id = ?").get("session-long").count, 2);
      const firstEvidence = db.listSemanticEvidence(db.db.prepare("SELECT id FROM semantic_memory WHERE content = ?").get(first.content).id);
      assert.equal(firstEvidence.length, 1);
      assert.equal(firstEvidence[0].repository, "fixture-repo");
      assert.deepEqual(firstEvidence[0].metadata.sourceAttribution, { role: "user", recordId: "1" });
    } finally {
      cleanup();
    }
  });

  test("reconciliation is replay idempotent and does not reinforce identical evidence", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const memory = {
        type: "user_preference",
        content: "Replay should be idempotent.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-replay",
        sourceTurnIndex: 1,
        evidence: { key: "evidence:replay", sourceRecordId: "1", sourceKind: "preference", revision: "1", contentHash: "same" },
      };
      const result = extraction("session-replay", "fixture-repo", [memory]);
      applySessionExtraction({ db, sessionId: "session-replay", repository: "fixture-repo", extraction: result });
      applySessionExtraction({ db, sessionId: "session-replay", repository: "fixture-repo", extraction: result });
      const row = db.db.prepare("SELECT reinforcement_count FROM semantic_memory WHERE source_session_id = ?").get("session-replay");
      assert.equal(row.reinforcement_count, 1);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM session_evidence WHERE evidence_key = ?").get("evidence:replay").count, 1);
    } finally {
      cleanup();
    }
  });

  test("different source evidence links to one canonical memory", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const memories = [1, 2].map((sourceTurnIndex) => ({
        type: "user_preference",
        content: "Use the stable API shape.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-sources",
        sourceTurnIndex,
        evidence: {
          key: `source-evidence:${sourceTurnIndex}`,
          sourceRecordId: String(sourceTurnIndex),
          sourceKind: "preference",
          revision: "1",
          contentHash: "same-proposition",
        },
      }));
      const ids = db.reconcileGeneratedMemories({ sessionId: "session-sources", repository: "fixture-repo", memories });
      assert.equal(ids[0], ids[1]);
      assert.equal(db.listSemanticEvidence(ids[0]).length, 2);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM semantic_memory WHERE source_session_id = ?").get("session-sources").count, 1);
    } finally {
      cleanup();
    }
  });

  test("manual canonical matches remain isolated to their scope and repository", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const manualId = db.insertSemanticMemory({
        type: "user_preference",
        content: "Use the repository local convention.",
        repository: "repo-a",
        scope: "repo",
        metadata: { source: "memory_save" },
      });
      const inferredId = db.insertSemanticMemory({
        type: "user_preference",
        content: "Use the repository local convention.",
        repository: "repo-b",
        scope: "repo",
        sourceSessionId: "session-repo-b",
        sourceTurnIndex: 1,
        metadata: { source: "rule_extractor" },
      });
      assert.ok(inferredId);
      assert.notEqual(inferredId, manualId);
      assert.equal(db.db.prepare("SELECT repository, scope_source FROM semantic_memory WHERE id = ?").get(inferredId).repository, "repo-b");
    } finally {
      cleanup();
    }
  });

  test("forget records durable suppression and rejects unknown memory ids", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const id = db.insertSemanticMemory({ type: "user_preference", content: "Never resurrect this generated preference.", repository: "fixture-repo", scope: "repo", sourceSessionId: "session-forget", sourceTurnIndex: 1, metadata: { source: "rule_extractor" } });
      db.forgetMemory({ id });
      assert.equal(db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id = ?").get(id).superseded_by?.startsWith("manual:"), true);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM memory_suppression WHERE memory_id = ?").get(id).count, 1);
      assert.throws(() => db.forgetMemory({ id: "missing-memory" }), /not found/iu);
    } finally {
      cleanup();
    }
  });

  test("suppression is nonplaintext and blocks generated replay while allowing manual correction", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const id = db.insertSemanticMemory({
        type: "user_preference",
        content: "Keep generated preference suppressed.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-suppress",
        sourceTurnIndex: 1,
        metadata: { source: "rule_extractor" },
        evidence: { key: "suppression-evidence", contentHash: "hashed-content" },
      });
      db.forgetMemory({ id });
      const suppression = db.db.prepare("SELECT * FROM memory_suppression WHERE memory_id = ?").get(id);
      assert.equal(Object.hasOwn(suppression, "canonical_key"), false);
      assert.equal(suppression.canonical_fingerprint, null);
      assert.doesNotMatch(suppression.evidence_fingerprint, /Keep generated/iu);
      const generated = db.insertSemanticMemory({
        type: "user_preference",
        content: "Keep generated preference suppressed.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-suppress-refresh",
        sourceTurnIndex: 2,
        metadata: { source: "rule_extractor" },
      });
      assert.equal(generated, null);
      assert.deepEqual(db.reconcileGeneratedMemories({
        sessionId: "session-suppress-refresh",
        repository: "fixture-repo",
        memories: [{
          type: "user_preference",
          content: "Keep generated preference suppressed.",
          repository: "fixture-repo",
          scope: "repo",
          sourceTurnIndex: 2,
          evidence: { key: "suppression-evidence", contentHash: "hashed-content" },
          metadata: { source: "rule_extractor" },
        }],
      }), [null]);
      const manual = db.insertSemanticMemory({
        type: "user_preference",
        content: "Keep generated preference suppressed.",
        repository: "fixture-repo",
        scope: "repo",
        metadata: { source: "memory_save" },
      });
      assert.ok(manual);
      assert.notEqual(manual, id);
      assert.equal(db.searchSemantic({ query: "Keep generated", repository: "fixture-repo" }).some((row) => row.id === manual), true);
      assert.equal(db.searchSemantic({ query: "Keep generated", repository: "fixture-repo" }).some((row) => row.id === id), false);
    } finally {
      cleanup();
    }
  });

  test("recovery restore preserves current suppressions by default", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb();
    try {
      const id = db.insertSemanticMemory({
        type: "user_preference",
        content: "Preserve suppression during restore.",
        repository: "fixture-repo",
        scope: "repo",
        metadata: { source: "rule_extractor" },
      });
      const snapshot = createRecoverySnapshot({ derivedStorePath: config.paths.derivedStorePath, backupDir: config.paths.backupDir }).snapshotPath;
      db.forgetMemory({ id });
      restoreRecoverySnapshot({ derivedStorePath: config.paths.derivedStorePath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => [] });
      const restored = db.db.prepare("SELECT COUNT(*) AS count FROM memory_suppression WHERE memory_id = ?").get(id).count;
      assert.equal(restored, 1);
    } finally {
      cleanup();
    }
  });

  test("LoreDb.restoreFromBackup atomically restores and preserves current suppressions", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const id = db.insertSemanticMemory({
        type: "user_preference",
        content: "Preserve direct restore suppression.",
        repository: "fixture-repo",
        scope: "repo",
        metadata: { source: "rule_extractor" },
      });
      const backupPath = db.backupDatabase();
      db.forgetMemory({ id });
      const restored = db.restoreFromBackup(backupPath);
      assert.equal(restored.schemaVersion, SCHEMA_VERSION);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM memory_suppression WHERE memory_id = ?").get(id).count, 1);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM semantic_memory WHERE id = ?").get(id).count, 1);
    } finally {
      cleanup();
    }
  });

  test("mapping APIs preserve explicit legacy to canonical associations", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      assert.deepEqual(db.setRepositoryMapping({ legacy: "legacy/path", canonical: "github.com/acme/repo" }), {
        legacy: "legacy/path",
        canonical: "github.com/acme/repo",
      });
      assert.deepEqual(db.getRepositoryMappings(), [{ legacy: "legacy/path", canonical: "github.com/acme/repo" }]);
    } finally {
      cleanup();
    }
  });

  test("forgetting a null-canonical proposition does not suppress another proposition", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const forgotten = db.insertSemanticMemory({
        type: "user_preference",
        content: "Prefer kiwi fixtures.",
        repository: "repo-a",
        scope: "repo",
        metadata: { source: "rule_extractor" },
      });
      db.forgetMemory({ id: forgotten });
      const unrelated = db.insertSemanticMemory({
        type: "user_preference",
        content: "Prefer citrus summaries.",
        repository: "repo-a",
        scope: "repo",
        metadata: { source: "rule_extractor" },
      });
      assert.ok(unrelated);
      const foreign = db.insertSemanticMemory({
        type: "user_preference",
        content: "Prefer kiwi fixtures.",
        repository: "repo-b",
        scope: "repo",
        metadata: { source: "rule_extractor" },
      });
      assert.ok(foreign);
      const suppression = db.db.prepare("SELECT canonical_fingerprint, evidence_fingerprint FROM memory_suppression WHERE memory_id = ?").get(forgotten);
      assert.equal(suppression.canonical_fingerprint, null);
      assert.match(suppression.evidence_fingerprint, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(suppression), /Prefer kiwi fixtures/iu);
    } finally {
      cleanup();
    }
  });

  test("retired evidence is ineligible and replaying the same revision stays retired", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const memory = {
        type: "user_preference",
        content: "Retire this evidence.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-retire",
        sourceTurnIndex: 1,
        evidence: { key: "evidence:retire", sourceRecordId: "1", sourceKind: "preference", revision: "opaque-a", contentHash: "retire-hash" },
      };
      db.reconcileGeneratedMemories({ sessionId: "session-retire", repository: "fixture-repo", memories: [memory] });
      db.reconcileGeneratedMemories({ sessionId: "session-retire", repository: "fixture-repo", memories: [], retiredEvidenceKeys: ["evidence:retire"] });
      assert.deepEqual(db.searchSemantic({ query: "Retire", repository: "fixture-repo" }), []);
      db.reconcileGeneratedMemories({ sessionId: "session-retire", repository: "fixture-repo", memories: [memory] });
      const evidence = db.listSemanticEvidence(db.db.prepare("SELECT id FROM semantic_memory WHERE content = ?").get(memory.content).id);
      assert.equal(evidence[0].retiredAt !== null, true);
      assert.deepEqual(db.searchSemantic({ query: "Retire", repository: "fixture-repo" }), []);
    } finally {
      cleanup();
    }
  });

  test("applySessionExtraction durably carries evidence and retirement output", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const original = {
        type: "decision",
        content: "Use the original deployment path.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-apply-evidence",
        sourceTurnIndex: 1,
        metadata: { source: "rule_extractor", sourceAttribution: { role: "user", recordId: "turn-1" } },
        evidence: { key: "evidence:apply-original", sourceRecordId: "turn-1", sourceKind: "decision", revision: "rev-1", contentHash: "hash-1" },
      };
      const replacement = {
        ...original,
        content: "Use the replacement deployment path.",
        sourceTurnIndex: 2,
        evidence: { key: "evidence:apply-replacement", sourceRecordId: "turn-2", sourceKind: "decision", revision: "rev-2", contentHash: "hash-2" },
      };
      const first = extraction("session-apply-evidence", "fixture-repo", [original]);
      applySessionExtraction({ db, sessionId: "session-apply-evidence", repository: "fixture-repo", extraction: first });
      const second = extraction("session-apply-evidence", "fixture-repo", [replacement]);
      second.retiredEvidenceKeys = ["evidence:apply-original"];
      applySessionExtraction({ db, sessionId: "session-apply-evidence", repository: "fixture-repo", extraction: second });
      const originalId = db.db.prepare("SELECT id FROM semantic_memory WHERE content = ?").get(original.content).id;
      const originalEvidence = db.listSemanticEvidence(originalId)[0];
      assert.equal(originalEvidence.retiredAt !== null, true);
      assert.deepEqual(originalEvidence.metadata.sourceAttribution, { role: "user", recordId: "turn-1" });
      assert.deepEqual(db.searchSemantic({ query: "original deployment", repository: "fixture-repo" }), []);
      assert.equal(db.searchSemantic({ query: "replacement deployment", repository: "fixture-repo" }).length, 1);
    } finally {
      cleanup();
    }
  });

  test("applySessionExtraction rolls back all writes when an improvement write fails", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb({
      configOverrides: { rollout: { autoWriteImprovementGoals: true } },
    });
    try {
      const valid = {
        type: "assistant_goal",
        content: "Keep extraction atomic.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-atomic",
        sourceTurnIndex: 1,
        metadata: { source: "rule_extractor", goal: "Keep extraction atomic." },
        evidence: { key: "evidence:atomic", sourceRecordId: "1", sourceKind: "goal", revision: "opaque-a", contentHash: "atomic-hash" },
      };
      const original = db.upsertImprovementArtifact.bind(db);
      db.upsertImprovementArtifact = () => { throw new Error("injected improvement failure"); };
      assert.throws(() => applySessionExtraction({ db, sessionId: "session-atomic", repository: "fixture-repo", extraction: extraction("session-atomic", "fixture-repo", [valid]) }), /injected improvement failure/);
      db.upsertImprovementArtifact = original;
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM episode_digest WHERE session_id = ?").get("session-atomic").count, 0);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM semantic_memory WHERE source_session_id = ?").get("session-atomic").count, 0);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM session_evidence WHERE session_id = ?").get("session-atomic").count, 0);
    } finally {
      cleanup();
    }
  });

  test("lore_retain and onboarding rows resist inferred replacement", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const retained = db.insertSemanticMemory({
        type: "assistant_goal",
        content: "Keep this stable goal.",
        repository: "fixture-repo",
        scope: "repo",
        metadata: { source: "lore_retain", goal: "stable-goal" },
      });
      const inferred = db.insertSemanticMemory({
        type: "assistant_goal",
        content: "Keep this stable goal.",
        repository: "fixture-repo",
        scope: "repo",
        sourceSessionId: "session-inferred",
        metadata: { source: "rule_extractor", goal: "stable-goal" },
      });
      assert.equal(inferred, retained);
      const row = db.db.prepare("SELECT metadata_json, reinforcement_count FROM semantic_memory WHERE id = ?").get(retained);
      assert.equal(JSON.parse(row.metadata_json).source, "lore_retain");
      assert.equal(row.reinforcement_count, 1);
    } finally {
      cleanup();
    }
  });

  test("checkpoint save uses expectedRevision CAS and preserves opaque revisions", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const first = db.saveIngestionCheckpoint("codex", "session-cas", { repository: "repo-a", sourceIdentity: "transcript:/tmp/a", revision: "opaque-a", offset: 10 });
      assert.equal(first.revision, "opaque-a");
      const second = db.saveIngestionCheckpoint("codex", "session-cas", { repository: "repo-a", sourceIdentity: "transcript:/tmp/a", revision: "opaque-b", expectedRevision: "opaque-a", offset: 20 });
      assert.equal(second.revision, "opaque-b");
      assert.throws(() => db.saveIngestionCheckpoint("codex", "session-cas", { repository: "repo-a", sourceIdentity: "transcript:/tmp/a", revision: "opaque-c", expectedRevision: "opaque-a", offset: 30 }), (error) => error.code === "CHECKPOINT_REVISION_CONFLICT");
      assert.equal(db.getIngestionCheckpoint("codex", "session-cas").offset, 20);
      assert.equal(db.getIngestionCheckpoint("codex", "session-cas").checkpointRevision, 2);
      assert.throws(() => db.saveIngestionCheckpoint("codex", "session-cas", { repository: "repo-a", sourceIdentity: "transcript:/tmp/a", revision: "opaque-c", expectedCheckpointRevision: 1, offset: 30 }), (error) => error.code === "CHECKPOINT_REVISION_CONFLICT");
      assert.throws(() => db.saveIngestionCheckpoint("codex", "session-cas", { repository: "repo-a", sourceIdentity: "transcript:/tmp/a", revision: "opaque-c", expectedCheckpointRevision: 9, offset: 30 }), (error) => error.code === "CHECKPOINT_REVISION_CONFLICT");
      assert.equal(db.listCaptureHealth({ repository: "repo-a" })[0].sourceIdentity, "transcript:/tmp/a");
    } finally {
      cleanup();
    }
  });
});
