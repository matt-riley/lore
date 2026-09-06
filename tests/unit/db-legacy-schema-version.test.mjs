import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LoreDb } from "../../lib/db.mjs";
import { SCHEMA_VERSION } from "../../lib/schema.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-legacy-schema-"));
}

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("LoreDb legacy schema version compatibility", () => {
  test("fresh-install migration plans skip legacy pre-schema upgrade steps", () => {
    const loreDb = new LoreDb({
      paths: {
        derivedStorePath: "ignored.db",
        backupDir: "ignored-backups",
      },
    });

    assert.deepEqual(
      loreDb.buildMigrationPlan(0).map((step) => step.label),
      [
        "schema-statements",
        "scope-migration",
        "scope-governance",
        "growth-memory",
        "improvement-backlog",
        "lore-visibility-substrate",
        "memory-domain-observation",
      ],
    );
  });

  test("adopts coherence_schema_version into lore_schema_version", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const dbPath = path.join(tempHome, "coherence.db");
    const backupDir = path.join(tempHome, "backups");
    try {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE coherence_schema_version (version INTEGER NOT NULL);
        INSERT INTO coherence_schema_version (version) VALUES (13);
        CREATE TABLE coherence_activity_state (
          scope_key TEXT PRIMARY KEY,
          scope_type TEXT NOT NULL,
          repository TEXT
        );
      `);
      rawDb.close();

      const loreDb = new LoreDb({
        paths: {
          derivedStorePath: dbPath,
          backupDir,
        },
      });
      loreDb.initialize();

      assert.ok(loreDb.lastBackupPath, "legacy adoption should snapshot before changing schema names");
      const snapshot = new DatabaseSync(loreDb.lastBackupPath, { readOnly: true });
      assert.ok(snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coherence_schema_version'").get());
      assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lore_schema_version'").get(), undefined);
      snapshot.close();

      assert.equal(loreDb.getCurrentVersion(), SCHEMA_VERSION);
      const adopted = loreDb.db
        .prepare("SELECT MAX(version) AS version FROM lore_schema_version")
        .get();
      assert.equal(adopted?.version, SCHEMA_VERSION);
      const activityState = loreDb.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lore_activity_state'")
        .get();
      assert.equal(activityState?.name, "lore_activity_state");
      const memoryDomain = loreDb.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_domain'")
        .get();
      assert.equal(memoryDomain?.name, "memory_domain");

      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("rejects a future schema before opening or creating Lore paths", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const dbPath = path.join(tempHome, "future.db");
    const backupDir = path.join(tempHome, "backups");
    try {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`CREATE TABLE lore_schema_version (version INTEGER NOT NULL); INSERT INTO lore_schema_version VALUES (${SCHEMA_VERSION + 1});`);
      rawDb.close();

      const loreDb = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      assert.throws(
        () => loreDb.initialize(),
        new RegExp(`unsupported future Lore schema version ${SCHEMA_VERSION + 1}.*${dbPath.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`),
      );
      assert.equal(loreDb.db, null, "future-schema rejection must happen before opening the database");
      assert.equal(loreDb.lastBackupPath, null);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("runs phase-5 follow-on migrations once when upgrading an existing v9 database", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const dbPath = path.join(tempHome, "lore.db");
    const backupDir = path.join(tempHome, "backups");

    class CountingLoreDb extends LoreDb {
      constructor(config) {
        super(config);
        this.calls = {
          phase5: 0,
          trajectory: 0,
          intent: 0,
          domains: 0,
        };
      }

      applyPhase5ImprovementLoopMigration() {
        this.calls.phase5 += 1;
        super.applyPhase5ImprovementLoopMigration();
      }

      applyTrajectoryArtifactsMigration() {
        this.calls.trajectory += 1;
        super.applyTrajectoryArtifactsMigration();
      }

      applyIntentJournalMigration() {
        this.calls.intent += 1;
        super.applyIntentJournalMigration();
      }

      applyMemoryDomainObservationMigration() {
        this.calls.domains += 1;
        super.applyMemoryDomainObservationMigration();
      }
    }

    try {
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE lore_schema_version (version INTEGER NOT NULL);
        INSERT INTO lore_schema_version (version) VALUES (9);
        CREATE TABLE improvement_backlog (
          id TEXT PRIMARY KEY,
          source_case_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          trace_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT
        );
      `);
      rawDb.close();

      const loreDb = new CountingLoreDb({
        paths: {
          derivedStorePath: dbPath,
          backupDir,
        },
      });
      loreDb.initialize();

      assert.deepEqual(loreDb.calls, {
        phase5: 1,
        trajectory: 1,
        intent: 1,
        domains: 1,
      });
      assert.equal(loreDb.getCurrentVersion(), SCHEMA_VERSION);

      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("v15→v16 migration adds lease columns to deferred_extraction", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const dbPath = path.join(tempHome, "lore.db");
    const backupDir = path.join(tempHome, "backups");

    try {
      // Create a minimal v15 database that has deferred_extraction without the
      // new lease columns. The migration runner must add them on upgrade.
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE lore_schema_version (version INTEGER NOT NULL);
        INSERT INTO lore_schema_version (version) VALUES (15);
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
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        INSERT INTO deferred_extraction (session_id, queued_at, available_at)
          VALUES ('test-sess', datetime('now'), datetime('now'));
      `);
      rawDb.close();

      const loreDb = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      loreDb.initialize();

      assert.equal(loreDb.getCurrentVersion(), SCHEMA_VERSION);

      // Verify the new columns exist and are accessible
      const row = loreDb.db.prepare(`
        SELECT session_id, owner_token, lease_expires_at, heartbeat_at
        FROM deferred_extraction WHERE session_id = 'test-sess'
      `).get();
      assert.ok(row, "deferred_extraction row should be readable after migration");
      assert.equal(row.owner_token, null, "owner_token should default to null");
      assert.equal(row.lease_expires_at, null, "lease_expires_at should default to null");
      assert.equal(row.heartbeat_at, null, "heartbeat_at should default to null");

      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("fresh install has lease columns in deferred_extraction", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const dbPath = path.join(tempHome, "lore.db");
    const backupDir = path.join(tempHome, "backups");

    try {
      const loreDb = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      loreDb.initialize();

      assert.equal(loreDb.getCurrentVersion(), SCHEMA_VERSION);

      // Verify that a fresh schema has all three lease columns.
      // We insert a row and read back the new nullable columns.
      loreDb.db.prepare(`
        INSERT INTO deferred_extraction (session_id, queued_at, available_at)
        VALUES ('fresh-sess', datetime('now'), datetime('now'))
      `).run();
      const row = loreDb.db.prepare(`
        SELECT session_id, owner_token, lease_expires_at, heartbeat_at
        FROM deferred_extraction WHERE session_id = 'fresh-sess'
      `).get();
      assert.ok(row, "deferred_extraction row should be readable");
      assert.equal(row.owner_token, null);
      assert.equal(row.lease_expires_at, null);
      assert.equal(row.heartbeat_at, null);

      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("v15 migration plan includes deferred-extraction-lease step", () => {
    const loreDb = new LoreDb({
      paths: { derivedStorePath: "ignored.db", backupDir: "ignored-backups" },
    });

    const plan = loreDb.buildMigrationPlan(15).map((step) => step.label);
    assert.ok(plan.includes("deferred-extraction-lease"), `plan ${JSON.stringify(plan)} should include deferred-extraction-lease`);
    assert.ok(plan.includes("schema-statements"), "plan should include schema-statements");
  });

  test("v16 migration plan includes schema-statements (creates error_telemetry)", () => {
    const loreDb = new LoreDb({
      paths: { derivedStorePath: "ignored.db", backupDir: "ignored-backups" },
    });

    const plan = loreDb.buildMigrationPlan(16).map((step) => step.label);
    assert.ok(plan.includes("schema-statements"), "plan for v16 must include schema-statements to create error_telemetry");
    // No dedicated pre-schema step for error_telemetry; the table is added via schema-statements
    assert.ok(!plan.includes("error-telemetry"), "no separate error-telemetry migration step needed");
  });

  test("upgrading a v16 DB creates error_telemetry table", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    const dbPath = path.join(tempHome, "lore.db");
    const backupDir = path.join(tempHome, "backups");

    try {
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

      const loreDb = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      loreDb.initialize();

      assert.equal(loreDb.getCurrentVersion(), SCHEMA_VERSION);

      const table = loreDb.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='error_telemetry'`)
        .get();
      assert.ok(table, "error_telemetry table must exist after v16 upgrade");

      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
