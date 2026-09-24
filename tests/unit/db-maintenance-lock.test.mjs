import assert from "node:assert/strict";
import { describe, test } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LoreDb } from "../../lib/db/db.mjs";
import { SCHEMA_VERSION } from "../../lib/db/schema.mjs";
import { withFixtureDb, FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "released-upgrades");

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-maintenance-lock-"));
}

function tableExists(db, name) {
  return db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

describe("maintenance background lock", () => {
  test("acquires when unheld, blocks a second owner, then re-acquires after release", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const first = db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-a", leaseDurationMs: 60_000 });
      assert.equal(first, true);

      const second = db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-b", leaseDurationMs: 60_000 });
      assert.equal(second, false, "a second owner must not acquire an unexpired lock");

      db.releaseMaintenanceLock({ scope: "background", ownerToken: "owner-a" });
      const third = db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-b", leaseDurationMs: 60_000 });
      assert.equal(third, true, "releasing the lock must let another owner acquire it");
    } finally {
      cleanup();
    }
  });

  test("releasing with the wrong owner token is a no-op", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      assert.equal(db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-a", leaseDurationMs: 60_000 }), true);
      db.releaseMaintenanceLock({ scope: "background", ownerToken: "someone-else" });
      assert.equal(
        db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-b", leaseDurationMs: 60_000 }),
        false,
        "an unmatched release must not free a lock still held by its real owner",
      );
    } finally {
      cleanup();
    }
  });

  test("an expired lease is reclaimed on the next acquire attempt", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      assert.equal(db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-a", leaseDurationMs: 1 }), true);
      // Force the lease into the past directly rather than sleeping in a test.
      db.db.prepare("UPDATE maintenance_lock SET expires_at = ? WHERE scope = ?")
        .run("2000-01-01T00:00:00.000Z", "background");
      assert.equal(
        db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-b", leaseDurationMs: 60_000 }),
        true,
        "an expired lease must be reclaimable by a new owner",
      );
    } finally {
      cleanup();
    }
  });

  test("independent scopes do not contend with each other", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      assert.equal(db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-a" }), true);
      assert.equal(db.acquireMaintenanceLock({ scope: "other-scope", ownerToken: "owner-b" }), true);
    } finally {
      cleanup();
    }
  });

  test("a read-only connection never attempts to create the table or acquire", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb();
    try {
      db.close();
      const reader = new LoreDb(config);
      reader.openReadOnly();
      try {
        assert.equal(reader.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-a" }), false);
        assert.equal(tableExists(reader, "maintenance_lock"), false, "a read-only runtime must never create the table");
        // Must not throw even though the table (and any lock) does not exist.
        reader.releaseMaintenanceLock({ scope: "background", ownerToken: "owner-a" });
      } finally {
        reader.close();
      }
    } finally {
      cleanup();
    }
  });

  test("acquires on an existing v20 store with no migration — the table is created lazily, not by a schema bump", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = tempDir();
    try {
      const dbPath = path.join(tempHome, "lore.db");
      const backupDir = path.join(tempHome, "backups");
      const raw = new DatabaseSync(dbPath);
      raw.exec(readFileSync(path.join(FIXTURE_DIR, "v20-lore-v0.15.0.sql"), "utf8"));
      raw.close();

      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();
      try {
        // This is the crux of it: an already-current v20 store takes the
        // "nothing to migrate" fast path (no SCHEMA_STATEMENTS run, no
        // backup), so the lock table cannot come from a migration.
        assert.equal(db.getCurrentVersion(), SCHEMA_VERSION);
        assert.equal(SCHEMA_VERSION, 20, "this test only proves the point if SCHEMA_VERSION stays unbumped");
        assert.equal(db.lastBackupPath, null, "an already-current v20 store must not be migrated");
        assert.equal(tableExists(db, "maintenance_lock"), false, "the lock table must not exist before first use");

        assert.equal(db.acquireMaintenanceLock({ scope: "background", ownerToken: "owner-a" }), true);
        assert.equal(tableExists(db, "maintenance_lock"), true, "acquiring the lock must create the table lazily");
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
