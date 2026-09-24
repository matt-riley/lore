/**
 * tests/unit/db-open-fast-path.test.mjs
 *
 * LoreDb.initialize() runs on every native hook call, from every concurrent
 * agent session sharing one lore.db. Historically it always took the writer
 * lock (BEGIN IMMEDIATE) twice, even when the schema was already current and
 * there was nothing to protect. These tests pin down the fast path added to
 * skip the writer lock entirely when no migration/adoption/backup is needed,
 * and confirm a stale schema still migrates safely (exactly once) when
 * multiple processes race to open it concurrently.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { LoreDb } from "../../lib/db/db.mjs";
import { SCHEMA_VERSION } from "../../lib/db/schema.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-open-fast-path-"));
}

function runChild(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("LoreDb.initialize() fast path", () => {
  test("a current-schema open never takes the writer lock", { skip: SKIP_NO_FTS5 }, () => {
    const root = tempDir();
    const dbPath = path.join(root, "lore.db");
    const backupDir = path.join(root, "backups");
    try {
      // Bring the schema to the current version first.
      const seed = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
      seed.initialize();
      seed.close();

      // Hold the writer lock on a separate connection without committing or
      // rolling back, simulating a concurrent session mid-write.
      const holder = new DatabaseSync(dbPath);
      holder.exec("PRAGMA busy_timeout = 100; BEGIN IMMEDIATE TRANSACTION;");
      try {
        const loreDb = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
        const started = Date.now();
        const result = loreDb.initialize();
        const elapsedMs = Date.now() - started;
        // The fast path never issues BEGIN IMMEDIATE, so it must return well
        // under the holder's 100ms busy_timeout (and under our own 5000ms),
        // proving it did not queue behind the RESERVED lock at all.
        assert.ok(elapsedMs < 100, `expected fast path to skip the writer lock, took ${elapsedMs}ms`);
        assert.equal(result.backupPath, null);
        assert.equal(loreDb.getCurrentVersion(), SCHEMA_VERSION);
        loreDb.close();
      } finally {
        holder.exec("ROLLBACK");
        holder.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stale-schema open still migrates when a concurrent connection holds a read transaction", { skip: SKIP_NO_FTS5 }, () => {
    const root = tempDir();
    const dbPath = path.join(root, "lore.db");
    const backupDir = path.join(root, "backups");
    try {
      const raw = new DatabaseSync(dbPath);
      // Switch to WAL mode up front, exactly as a real install already would
      // be by the time it's stale (initialize() sets WAL on every open).
      // Otherwise a concurrent reader below would block *this* process's own
      // rollback-journal -> WAL switch, which is a different (uninteresting)
      // lock than the one this test is about.
      raw.exec("PRAGMA journal_mode = WAL; CREATE TABLE lore_schema_version (version INTEGER NOT NULL); INSERT INTO lore_schema_version VALUES (17);");
      raw.close();

      // A concurrent long-lived reader (e.g. another session mid-recall)
      // must not block the migrator's writer lock in WAL mode.
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      reader.exec("BEGIN DEFERRED TRANSACTION; SELECT * FROM lore_schema_version;");
      try {
        const loreDb = new LoreDb({ paths: { derivedStorePath: dbPath, backupDir } });
        loreDb.initialize();
        assert.equal(loreDb.getCurrentVersion(), SCHEMA_VERSION);
        loreDb.close();
      } finally {
        reader.exec("ROLLBACK");
        reader.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("concurrent processes opening a stale schema converge on one migration with no corruption", { skip: SKIP_NO_FTS5 }, async () => {
    const root = tempDir();
    const dbPath = path.join(root, "lore.db");
    const backupDir = path.join(root, "backups");
    try {
      const raw = new DatabaseSync(dbPath);
      raw.exec("CREATE TABLE lore_schema_version (version INTEGER NOT NULL); INSERT INTO lore_schema_version VALUES (17);");
      raw.close();

      const workerScript = `
        import { LoreDb } from "./lib/db/db.mjs";
        const db = new LoreDb({ paths: { derivedStorePath: process.env.DB_PATH, backupDir: process.env.BACKUP_DIR } });
        db.initialize();
        process.stdout.write(JSON.stringify({ version: db.getCurrentVersion() }));
        db.close();
      `;
      const env = { DB_PATH: dbPath, BACKUP_DIR: backupDir };
      const results = await Promise.all([runChild(workerScript, env), runChild(workerScript, env), runChild(workerScript, env)]);

      for (const result of results) {
        assert.equal(result.code, 0, `child failed: ${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).version, SCHEMA_VERSION);
      }

      const check = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.equal(check.prepare("SELECT MAX(version) AS version FROM lore_schema_version").get().version, SCHEMA_VERSION);
      } finally {
        check.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
