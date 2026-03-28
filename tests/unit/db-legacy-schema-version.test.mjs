import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LoreDb } from "../../lib/db.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-legacy-schema-"));
}

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
});
