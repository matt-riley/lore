import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LoreDb } from "../../lib/db.mjs";
import { SCHEMA_VERSION } from "../../lib/schema.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "released-upgrades");
const FIXTURES = [
  { file: "v13-lore-v0.2.0.sql", version: 13, versionTable: "coherence_schema_version", expectsBackup: true },
  { file: "v15-lore-v0.3.0.sql", version: 15, versionTable: "lore_schema_version", expectsBackup: true },
  { file: "v18-lore-v0.10.0.sql", version: 18, versionTable: "lore_schema_version", expectsBackup: false },
];

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-released-schema-"));
}

describe("released Lore schema fixtures", () => {
  test("fixtures are committed SQL snapshots with tag and commit provenance", () => {
    assert.deepEqual(
      readdirSync(FIXTURE_DIR).sort(),
      FIXTURES.map(({ file }) => file).sort(),
    );
    for (const fixture of FIXTURES) {
      const sql = readFileSync(path.join(FIXTURE_DIR, fixture.file), "utf8");
      assert.match(sql, new RegExp(`SCHEMA_VERSION ${fixture.version}`));
      assert.match(sql, /Source commit: [0-9a-f]{40}/);
      assert.match(sql, new RegExp(`INSERT INTO ${fixture.versionTable} \\(version\\) VALUES \\(${fixture.version}\\)`));
    }
  });

  test("upgrades every distinct released schema and preserves memory fields", { skip: SKIP_NO_FTS5 }, () => {
    const root = tempDir();
    try {
      for (const fixture of FIXTURES) {
        const dbPath = path.join(root, `${fixture.version}.db`);
        const backupDir = path.join(root, `${fixture.version}-backups`);
        const raw = new DatabaseSync(dbPath);
        raw.exec(readFileSync(path.join(FIXTURE_DIR, fixture.file), "utf8"));
        raw.prepare(`
          INSERT INTO semantic_memory
            (id, type, content, confidence, source_session_id, source_turn_index,
             scope, scope_source, repository, tags, created_at, updated_at,
             superseded_by, metadata_json)
          VALUES (?, 'fact', ?, 0.91, ?, 4, ?, ?, ?, 'released-fixture',
                  '2026-01-02T03:04:05.000Z', '2026-01-03T04:05:06.000Z', ?, ?)
        `).run(
          `released-${fixture.version}`,
          `Released schema ${fixture.version} retains this content.`,
          `session-${fixture.version}`,
          "global",
          "manual",
          "fixture-repository",
          `replacement-${fixture.version}`,
          JSON.stringify({ provenance: `release-${fixture.version}`, explicit: true }),
        );
        raw.close();

        const loreDb = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
        loreDb.initialize();
        const row = loreDb.db.prepare(`
          SELECT id, content, scope, scope_source, repository, source_session_id,
                 source_turn_index, superseded_by, metadata_json
          FROM semantic_memory WHERE id = ?
        `).get(`released-${fixture.version}`);
        assert.deepEqual({ ...row }, {
          id: `released-${fixture.version}`,
          content: `Released schema ${fixture.version} retains this content.`,
          scope: "global",
          scope_source: "manual",
          repository: "fixture-repository",
          source_session_id: `session-${fixture.version}`,
          source_turn_index: 4,
          superseded_by: `replacement-${fixture.version}`,
          metadata_json: JSON.stringify({ provenance: `release-${fixture.version}`, explicit: true }),
        });
        assert.equal(loreDb.getCurrentVersion(), SCHEMA_VERSION);
        if (fixture.expectsBackup) {
          assert.ok(loreDb.lastBackupPath, `v${fixture.version} upgrade should create a backup`);
        } else {
          assert.equal(loreDb.lastBackupPath, null, `v${fixture.version} current-schema reopen needs no backup`);
        }
        loreDb.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
