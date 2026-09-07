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
  test("fresh schema is v19 and contains lifecycle tables", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      assert.equal(db.getCurrentVersion(), 19);
      assert.equal(SCHEMA_VERSION, 19);
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
        ...state,
        branchState: {},
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
      assert.equal(db.listSemanticEvidence(db.db.prepare("SELECT id FROM semantic_memory WHERE content = ?").get(first.content).id).length, 1);
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
      assert.equal(suppression.canonical_fingerprint.includes("Keep generated"), false);
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
});
