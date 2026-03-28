import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LoreDb } from "../../lib/db.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-legacy-schema-"));
}

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("LoreDb legacy schema version compatibility", () => {
  test("adopts coherence_schema_version into lore_schema_version", () => {
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

      assert.equal(loreDb.getCurrentVersion(), 13);
      const adopted = loreDb.db
        .prepare("SELECT MAX(version) AS version FROM lore_schema_version")
        .get();
      assert.equal(adopted?.version, 13);
      const activityState = loreDb.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lore_activity_state'")
        .get();
      assert.equal(activityState?.name, "lore_activity_state");

      loreDb.close();
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
      });
      assert.equal(loreDb.getCurrentVersion(), 13);

      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
