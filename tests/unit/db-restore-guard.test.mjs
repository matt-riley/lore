/**
 * tests/unit/db-restore-guard.test.mjs
 *
 * lib/db/db-restore-guard.mjs is the cross-process safety guard that
 * LoreDb.restoreFromBackup() (lib/db/db.mjs) and restoreRecoverySnapshot()
 * (lib/maintenance/recovery.mjs) both use before swapping a live lore.db's
 * files out from under any other process that might have it open. These
 * tests exercise the guard module directly, plus the sidecar lock's effect
 * on LoreDb.openDatabase()/openReadOnly(), and the end-to-end refusal
 * behavior through LoreDb.restoreFromBackup().
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LoreDb } from "../../lib/db/db.mjs";
import {
  RESTORE_IN_USE_MESSAGE,
  acquireRestoreGuard,
  assertExclusiveDatabaseAccess,
  isRestoreLockActive,
  restoreLockPath,
  waitForRestoreLockClear,
} from "../../lib/db/db-restore-guard.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-restore-guard-"));
}

function walDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);");
  return db;
}

describe("assertExclusiveDatabaseAccess / acquireRestoreGuard", () => {
  test("refuses while another connection holds an open read transaction", () => {
    const root = tempDir();
    const dbPath = path.join(root, "t.db");
    try {
      walDb(dbPath).close();
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      reader.exec("BEGIN DEFERRED TRANSACTION; SELECT * FROM t;");
      try {
        assert.throws(() => assertExclusiveDatabaseAccess(dbPath, { busyTimeoutMs: 50 }), new RegExp(RESTORE_IN_USE_MESSAGE));
      } finally {
        reader.exec("ROLLBACK");
        reader.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses while another connection holds an open write lock", () => {
    const root = tempDir();
    const dbPath = path.join(root, "t.db");
    try {
      walDb(dbPath).close();
      const writer = new DatabaseSync(dbPath);
      writer.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        assert.throws(() => assertExclusiveDatabaseAccess(dbPath, { busyTimeoutMs: 50 }), new RegExp(RESTORE_IN_USE_MESSAGE));
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("succeeds and holds the lock until release() when the store is idle", () => {
    const root = tempDir();
    const dbPath = path.join(root, "t.db");
    try {
      walDb(dbPath).close();
      const guard = acquireRestoreGuard(dbPath, { busyTimeoutMs: 50 });
      try {
        assert.equal(isRestoreLockActive(dbPath), true, "sidecar lock file should exist while the guard is held");
        assert.throws(() => {
          const intruder = new DatabaseSync(dbPath, { readOnly: true });
          try {
            intruder.exec("PRAGMA busy_timeout = 50;");
            intruder.prepare("SELECT * FROM t").all();
          } finally {
            intruder.close();
          }
        }, /locked|busy/i, "a new connection must not be able to read while the guard holds the exclusive lock");
      } finally {
        guard.release();
      }
      assert.equal(isRestoreLockActive(dbPath), false, "release() must remove the sidecar lock file");
      const after = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(after.prepare("SELECT COUNT(*) AS n FROM t").get().n, 1, "release() must free the exclusive lock so normal reads resume");
      } finally {
        after.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("degrades to a warning (without destroying sidecar files) when the target is not a valid database", () => {
    const root = tempDir();
    const dbPath = path.join(root, "t.db");
    try {
      writeFileSync(dbPath, "not a sqlite database");
      writeFileSync(`${dbPath}-wal`, "stray bytes that must survive the probe");
      const guard = acquireRestoreGuard(dbPath, { busyTimeoutMs: 50 });
      assert.ok(guard.warnings.length > 0, "an unreadable target should produce a warning, not a throw");
      guard.release();
      assert.equal(readFileSync(`${dbPath}-wal`, "utf8"), "stray bytes that must survive the probe", "probing a corrupt target must not delete or rewrite its sidecar files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a concurrent acquireRestoreGuard call refuses while one is already in progress", () => {
    const root = tempDir();
    const dbPath = path.join(root, "t.db");
    try {
      walDb(dbPath).close();
      const first = acquireRestoreGuard(dbPath, { busyTimeoutMs: 50 });
      try {
        assert.throws(() => acquireRestoreGuard(dbPath, { busyTimeoutMs: 50 }), /restore is already in progress/i);
      } finally {
        first.release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("holds the sidecar lock while the target does not exist yet", () => {
    const root = tempDir();
    const dbPath = path.join(root, "missing.db");
    try {
      const guard = acquireRestoreGuard(dbPath);
      assert.deepEqual(guard.warnings, []);
      assert.equal(isRestoreLockActive(dbPath), true);
      guard.release();
      assert.equal(isRestoreLockActive(dbPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("waitForRestoreLockClear", () => {
  test("returns immediately when no restore is in flight", () => {
    const root = tempDir();
    const dbPath = path.join(root, "t.db");
    try {
      const started = Date.now();
      waitForRestoreLockClear(dbPath, { retries: 3, intervalMs: 50 });
      assert.ok(Date.now() - started < 50, "must not wait at all when the sidecar lock does not exist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws a clear error after a brief backoff when the lock persists", () => {
    const root = tempDir();
    const dbPath = path.join(root, "t.db");
    try {
      writeFileSync(restoreLockPath(dbPath), "");
      const started = Date.now();
      assert.throws(() => waitForRestoreLockClear(dbPath, { retries: 3, intervalMs: 20 }), /being restored by another process/i);
      assert.ok(Date.now() - started >= 60, "should have backed off across all retries before giving up");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("LoreDb honors the sidecar restore lock", () => {
  test("openDatabase() refuses while a restore's sidecar lock is present", { skip: SKIP_NO_FTS5 }, () => {
    const root = tempDir();
    const dbPath = path.join(root, "lore.db");
    const backupDir = path.join(root, "backups");
    try {
      const seed = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      seed.initialize();
      seed.close();

      writeFileSync(restoreLockPath(dbPath), "");
      try {
        const blocked = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
        assert.throws(() => blocked.initialize(), /being restored by another process/i);
      } finally {
        rmSync(restoreLockPath(dbPath), { force: true });
      }

      // Clearing the lock must let a normal open through again.
      const recovered = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      recovered.initialize();
      recovered.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("openReadOnly() refuses while a restore's sidecar lock is present", { skip: SKIP_NO_FTS5 }, () => {
    const root = tempDir();
    const dbPath = path.join(root, "lore.db");
    const backupDir = path.join(root, "backups");
    try {
      const seed = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      seed.initialize();
      seed.close();

      writeFileSync(restoreLockPath(dbPath), "");
      try {
        const blocked = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
        assert.throws(() => blocked.openReadOnly(), /being restored by another process/i);
      } finally {
        rmSync(restoreLockPath(dbPath), { force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("LoreDb.restoreFromBackup cross-process guard", { skip: SKIP_NO_FTS5 }, () => {
  test("refuses while a second connection has an open read transaction, and changes nothing", () => {
    const root = tempDir();
    const dbPath = path.join(root, "lore.db");
    const backupDir = path.join(root, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();
      db.insertSemanticMemory({ type: "fact", content: "Original content before restore.", repository: "fixture-repo" });
      const backupPath = db.backupDatabase();
      db.close();

      const before = readFileSync(dbPath);
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      reader.exec("BEGIN DEFERRED TRANSACTION; SELECT * FROM semantic_memory;");
      try {
        assert.throws(() => db.restoreFromBackup(backupPath), new RegExp(RESTORE_IN_USE_MESSAGE));
      } finally {
        reader.exec("ROLLBACK");
        reader.close();
      }
      assert.deepEqual(readFileSync(dbPath), before, "a refused restore must leave the live store byte-for-byte unchanged");

      // The instance must still be usable afterward (it reopens its own
      // connection when the guard refuses).
      assert.ok(db.db, "LoreDb should reopen its own connection after a refused restore");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses while a second connection has an open write lock, and changes nothing", () => {
    const root = tempDir();
    const dbPath = path.join(root, "lore.db");
    const backupDir = path.join(root, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();
      const backupPath = db.backupDatabase();
      db.close();

      const before = readFileSync(dbPath);
      const writer = new DatabaseSync(dbPath);
      writer.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        assert.throws(() => db.restoreFromBackup(backupPath), new RegExp(RESTORE_IN_USE_MESSAGE));
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
      assert.deepEqual(readFileSync(dbPath), before);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still restores (and re-guards cleanly) when the store is idle", () => {
    const root = tempDir();
    const dbPath = path.join(root, "lore.db");
    const backupDir = path.join(root, "backups");
    try {
      const db = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      db.initialize();
      const id = db.insertSemanticMemory({ type: "fact", content: "Kept across restore.", repository: "fixture-repo" });
      const backupPath = db.backupDatabase();
      db.insertSemanticMemory({ type: "fact", content: "Should be gone after restore.", repository: "fixture-repo" });

      db.restoreFromBackup(backupPath);
      assert.equal(db.db.prepare("SELECT id FROM semantic_memory WHERE id = ?").get(id)?.id, id);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM semantic_memory WHERE content = ?").get("Should be gone after restore.").n, 0);
      assert.equal(isRestoreLockActive(dbPath), false, "a successful restore must not leave the sidecar lock behind");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
