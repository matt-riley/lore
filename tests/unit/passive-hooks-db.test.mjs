/**
 * tests/unit/passive-hooks-db.test.mjs
 *
 * Tests for the error_telemetry DB table: schema/migration, insertErrorTelemetry,
 * pruneErrorTelemetry, and no raw-message/stack persistence.
 *
 * Covers:
 *   - fresh install creates error_telemetry with the expected columns
 *   - v16→v17 upgrade (schema-statements) creates the table on existing DB
 *   - insertErrorTelemetry persists categorical fields, returns an ID
 *   - no raw message/stack columns in the table
 *   - category/recoverability/fingerprint fields are persisted correctly
 *   - pruneErrorTelemetry trims by age and by global row limit
 *   - migration plan for v16 includes schema-statements (which creates the table)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LoreDb } from "../../lib/db.mjs";
import { SCHEMA_VERSION } from "../../lib/schema.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";
import { buildErrorTelemetryRecord } from "../../lib/passive-hooks.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-passive-hooks-db-"));
}

// ---------------------------------------------------------------------------
// Fresh install: error_telemetry table exists with correct columns
// ---------------------------------------------------------------------------

describe("error_telemetry schema — fresh install", () => {
  test("fresh DB has error_telemetry table", { skip: SKIP_NO_FTS5 }, () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "lore.db");
    const backupDir = path.join(tempDir, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();

      assert.strictEqual(db.getCurrentVersion(), SCHEMA_VERSION);

      // Table exists
      const table = db.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='error_telemetry'`)
        .get();
      assert.ok(table, "error_telemetry table must exist after fresh init");

      // Expected columns
      const cols = db.db.prepare(`PRAGMA table_info(error_telemetry)`).all();
      const colNames = new Set(cols.map((c) => c.name));
      for (const expected of ["id", "session_id", "context_category", "recoverability", "fingerprint", "created_at"]) {
        assert.ok(colNames.has(expected), `error_telemetry must have column ${expected}`);
      }

      // Forbidden columns
      for (const forbidden of ["message", "stack", "raw_payload", "error_message", "error_stack"]) {
        assert.ok(!colNames.has(forbidden), `error_telemetry must NOT have column ${forbidden}`);
      }

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("fresh install migration plan includes schema-statements step", () => {
    const db = new LoreDb({
      paths: { derivedStorePath: "ignored.db", backupDir: "ignored-backups" },
    });
    const labels = db.buildMigrationPlan(0).map((s) => s.label);
    assert.ok(labels.includes("schema-statements"), "migration plan must include schema-statements");
  });
});

// ---------------------------------------------------------------------------
// Upgrade v16 → v17: schema-statements creates error_telemetry
// ---------------------------------------------------------------------------

describe("error_telemetry migration — v16 → v17 upgrade", () => {
  test("upgrading a v16 DB creates the error_telemetry table", { skip: SKIP_NO_FTS5 }, () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "lore.db");
    const backupDir = path.join(tempDir, "backups");
    try {
      // Simulate an existing v16 database without error_telemetry.
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        CREATE TABLE lore_schema_version (version INTEGER NOT NULL);
        INSERT INTO lore_schema_version (version) VALUES (16);
        CREATE TABLE deferred_extraction (
          session_id TEXT PRIMARY KEY,
          repository TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          priority INTEGER NOT NULL DEFAULT 0,
          reason TEXT NOT NULL DEFAULT 'manual',
          queued_at TEXT NOT NULL,
          available_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          owner_token TEXT,
          lease_expires_at TEXT,
          heartbeat_at TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
      `);
      raw.close();

      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();

      assert.strictEqual(db.getCurrentVersion(), SCHEMA_VERSION);

      const table = db.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='error_telemetry'`)
        .get();
      assert.ok(table, "error_telemetry table must exist after v16 → v17 upgrade");

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("v16 migration plan includes schema-statements step", () => {
    const db = new LoreDb({
      paths: { derivedStorePath: "ignored.db", backupDir: "ignored-backups" },
    });
    const labels = db.buildMigrationPlan(16).map((s) => s.label);
    assert.ok(labels.includes("schema-statements"), "plan for v16 must include schema-statements");
  });
});

// ---------------------------------------------------------------------------
// insertErrorTelemetry — categorical persistence, no raw text
// ---------------------------------------------------------------------------

describe("LoreDb.insertErrorTelemetry", () => {
  test("persists categorical fields and returns a non-empty ID", { skip: SKIP_NO_FTS5 }, () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "lore.db");
    const backupDir = path.join(tempDir, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();

      const record = buildErrorTelemetryRecord(
        { error: { code: "EACCES", name: "Error" } },
        "test-session-1",
      );
      assert.ok(record, "buildErrorTelemetryRecord should return a record");
      const id = db.insertErrorTelemetry(record);

      assert.ok(typeof id === "string" && id.length > 0, "insertErrorTelemetry must return an ID");

      const row = db.db.prepare(
        `SELECT * FROM error_telemetry WHERE id = ?`,
      ).get(id);
      assert.ok(row, "row must exist after insert");

      // Categorical fields persisted correctly
      assert.strictEqual(row.session_id, "test-session-1");
      assert.strictEqual(row.context_category, "permission");
      assert.strictEqual(row.recoverability, "unrecoverable");
      assert.ok(typeof row.fingerprint === "string" && row.fingerprint.length === 16);
      assert.ok(typeof row.created_at === "string" && row.created_at.length > 0);

      // Raw message/stack must not be in any column
      const colNames = Object.keys(row);
      assert.ok(!colNames.includes("message"), "message must not be a column");
      assert.ok(!colNames.includes("stack"), "stack must not be a column");
      assert.ok(!colNames.includes("raw_payload"), "raw_payload must not be a column");

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("null session ID stored as NULL", { skip: SKIP_NO_FTS5 }, () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "lore.db");
    const backupDir = path.join(tempDir, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();

      const record = buildErrorTelemetryRecord({}, null);
      const id = db.insertErrorTelemetry(record);
      const row = db.db.prepare(`SELECT session_id FROM error_telemetry WHERE id = ?`).get(id);
      assert.strictEqual(row.session_id, null, "null session_id should be stored as NULL");

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pruneErrorTelemetry — retention compliance
// ---------------------------------------------------------------------------

describe("LoreDb.pruneErrorTelemetry — retention/compaction", () => {
  test("deletes rows older than maxAgeMs", { skip: SKIP_NO_FTS5 }, () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "lore.db");
    const backupDir = path.join(tempDir, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();

      // Insert a row with an old timestamp via direct SQL (simulating an old record)
      db.db.prepare(`
        INSERT INTO error_telemetry (id, session_id, context_category, recoverability, fingerprint, created_at)
        VALUES ('old-row', NULL, 'unknown', 'unknown', 'abc1234567890123', '2020-01-01T00:00:00.000Z')
      `).run();
      db.db.prepare(`
        INSERT INTO error_telemetry (id, session_id, context_category, recoverability, fingerprint, created_at)
        VALUES ('new-row', NULL, 'unknown', 'unknown', 'def1234567890123', datetime('now'))
      `).run();

      const countBefore = db.db.prepare(`SELECT COUNT(*) AS n FROM error_telemetry`).get().n;
      assert.strictEqual(countBefore, 2);

      const result = db.pruneErrorTelemetry({ maxRowsGlobal: 500, maxAgeMs: 1 });
      // maxAgeMs=1 means anything older than 1ms is eligible; both rows survive since 'now'
      // is after the cutoff. But 'old-row' (2020) must be deleted.
      assert.ok(result.deletedByAge >= 1, `should have deleted at least 1 old row, got ${result.deletedByAge}`);

      const remaining = db.db.prepare(`SELECT id FROM error_telemetry`).all();
      const ids = remaining.map((r) => r.id);
      assert.ok(!ids.includes("old-row"), "old row must be pruned by age");

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("trims to maxRowsGlobal", { skip: SKIP_NO_FTS5 }, () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "lore.db");
    const backupDir = path.join(tempDir, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();

      // Insert 5 rows
      for (let i = 0; i < 5; i++) {
        db.db.prepare(`
          INSERT INTO error_telemetry (id, session_id, context_category, recoverability, fingerprint, created_at)
          VALUES (?, NULL, 'unknown', 'unknown', 'fp0000000000000' || ?, datetime('now'))
        `).run(`row-${i}`, String(i));
      }

      // Prune to 3 rows global limit (no age pruning — maxAgeMs large)
      const result = db.pruneErrorTelemetry({ maxRowsGlobal: 3, maxAgeMs: 999999999999 });
      assert.ok(result.deletedByLimit >= 2, "should delete at least 2 rows to reach limit of 3");

      const count = db.db.prepare(`SELECT COUNT(*) AS n FROM error_telemetry`).get().n;
      assert.strictEqual(count, 3);

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("no-op on empty table", { skip: SKIP_NO_FTS5 }, () => {
    const tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "lore.db");
    const backupDir = path.join(tempDir, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();

      const result = db.pruneErrorTelemetry({});
      assert.strictEqual(result.deletedByAge, 0);
      assert.strictEqual(result.deletedByLimit, 0);

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
