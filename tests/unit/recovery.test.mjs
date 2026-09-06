import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

import {
  inspectRecoveryTarget,
  createRecoverySnapshot,
  restoreRecoverySnapshot,
  resolveRecoveryConfig,
} from "../../lib/recovery.mjs";
import { SCHEMA_VERSION } from "../../lib/schema.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lore-recovery-test-"));
  const dbPath = path.join(root, "lore.db");
  const backupDir = path.join(root, "backups");
  mkdirSync(backupDir);
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE lore_schema_version (version INTEGER NOT NULL); INSERT INTO lore_schema_version VALUES (${SCHEMA_VERSION}); CREATE TABLE semantic_memory (id TEXT PRIMARY KEY); CREATE TABLE episode_digest (id TEXT PRIMARY KEY); CREATE TABLE data (value TEXT); INSERT INTO data VALUES ('original');`);
  db.close();
  return { root, dbPath, backupDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("status is read-only and reports integrity, schema, and resolved path", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.dbPath);
    const result = inspectRecoveryTarget({ derivedStorePath: f.dbPath });
    assert.equal(result.integrity, "ok");
    assert.equal(result.schemaVersion, SCHEMA_VERSION);
    assert.equal(result.path, path.resolve(f.dbPath));
    assert.deepEqual(readFileSync(f.dbPath), before);
  } finally { f.cleanup(); }
});

test("snapshot is consistent and can be reopened", () => {
  const f = fixture();
  try {
    const result = createRecoverySnapshot({ derivedStorePath: f.dbPath, backupDir: f.backupDir });
    assert.ok(existsSync(result.snapshotPath));
    assert.equal(inspectRecoveryTarget({ derivedStorePath: result.snapshotPath }).integrity, "ok");
  } finally { f.cleanup(); }
});

test("snapshot includes committed WAL data", () => {
  const f = fixture();
  try {
    const writer = new DatabaseSync(f.dbPath);
    writer.exec("PRAGMA journal_mode=WAL; INSERT INTO data VALUES ('wal-committed');");
    const snapshot = createRecoverySnapshot({ derivedStorePath: f.dbPath, backupDir: f.backupDir }).snapshotPath;
    writer.close();
    const db = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM data WHERE value='wal-committed'").get().count, 1);
    db.close();
  } finally { f.cleanup(); }
});

test("restore previews by default and writes only with explicit acknowledgement", () => {
  const f = fixture();
  try {
    const snapshot = createRecoverySnapshot({ derivedStorePath: f.dbPath, backupDir: f.backupDir }).snapshotPath;
    const db = new DatabaseSync(f.dbPath); db.prepare("UPDATE data SET value='changed'").run(); db.close();
    const before = readFileSync(f.dbPath);
    const preview = restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot });
    assert.equal(preview.written, false);
    assert.deepEqual(readFileSync(f.dbPath), before);
    assert.throws(() => restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot, write: true }), /clients-stopped/iu);
    restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => [] });
    const reopened = new DatabaseSync(f.dbPath);
    assert.equal(reopened.prepare("SELECT value FROM data").get().value, "original");
    reopened.close();
  } finally { f.cleanup(); }
});

test("future schema snapshots are rejected before replacement", () => {
  const f = fixture();
  try {
    const future = path.join(f.root, "future.db");
    const db = new DatabaseSync(future);
    db.exec(`CREATE TABLE lore_schema_version (version INTEGER NOT NULL); INSERT INTO lore_schema_version VALUES (${SCHEMA_VERSION + 1});`); db.close();
    assert.throws(() => restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: future, write: true, clientsStopped: true, detectActiveUsers: () => [] }), /future Lore schema/iu);
    assert.equal(new DatabaseSync(f.dbPath).prepare("SELECT value FROM data").get().value, "original");
  } finally { f.cleanup(); }
});

test("corrupt snapshots are rejected before replacement", () => {
  const f = fixture();
  try {
    const corrupt = path.join(f.root, "corrupt.db");
    writeFileSync(corrupt, "not sqlite");
    assert.throws(() => restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: corrupt, write: true, clientsStopped: true, detectActiveUsers: () => [] }), /not a database|file is not a database/iu);
    assert.equal(new DatabaseSync(f.dbPath).prepare("SELECT value FROM data").get().value, "original");
  } finally { f.cleanup(); }
});

test("corrupt targets can be restored and retain rescue sidecars", () => {
  const f = fixture();
  try {
    const snapshot = createRecoverySnapshot({ derivedStorePath: f.dbPath, backupDir: f.backupDir }).snapshotPath;
    writeFileSync(f.dbPath, "corrupt target");
    writeFileSync(`${f.dbPath}-wal`, "raw wal");
    const result = restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => null });
    assert.ok(result.rescuePath);
    assert.equal(readFileSync(`${result.rescuePath}-wal`, "utf8"), "raw wal");
    assert.equal(inspectRecoveryTarget({ derivedStorePath: f.dbPath }).integrity, "ok");
  } finally { f.cleanup(); }
});

test("valid SQLite files without Lore tables are rejected as snapshots", () => {
  const f = fixture();
  try {
    const foreign = path.join(f.root, "foreign.db");
    const db = new DatabaseSync(foreign);
    db.exec("CREATE TABLE lore_schema_version (version INTEGER NOT NULL); INSERT INTO lore_schema_version VALUES (0); CREATE TABLE unrelated (value TEXT);");
    db.close();
    assert.throws(() => restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: foreign, write: true, clientsStopped: true, detectActiveUsers: () => [] }), /not a recognized Lore database/iu);
  } finally { f.cleanup(); }
});

test("CLI rejects missing values and multiple commands", () => {
  const script = path.resolve("scripts/recover.mjs");
  const missing = spawnSync(process.execPath, [script, "status", "--derived-store-path"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires a value/iu);
  const multiple = spawnSync(process.execPath, [script, "status", "backup"], { encoding: "utf8" });
  assert.notEqual(multiple.status, 0);
  assert.match(multiple.stderr, /only one recovery command/iu);
});

test("an active sqlite writer blocks replacement", () => {
  const f = fixture();
  try {
    const snapshot = createRecoverySnapshot({ derivedStorePath: f.dbPath, backupDir: f.backupDir }).snapshotPath;
    const lock = new DatabaseSync(f.dbPath);
    lock.exec("BEGIN IMMEDIATE");
    assert.throws(() => restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => [] }), /locked|busy/iu);
    lock.exec("ROLLBACK"); lock.close();
  } finally { f.cleanup(); }
});

test("failed replacement restores the original target", () => {
  const f = fixture();
  try {
    const snapshot = createRecoverySnapshot({ derivedStorePath: f.dbPath, backupDir: f.backupDir }).snapshotPath;
    let stageRename = true;
    const realRename = (from, to) => {
      if (stageRename && String(from).includes(".restore-")) { stageRename = false; throw new Error("injected rename failure"); }
      return renameSync(from, to);
    };
    assert.throws(() => restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => [], fsOps: { renameSync: realRename } }), /injected rename failure/iu);
    const reopened = new DatabaseSync(f.dbPath);
    assert.equal(reopened.prepare("SELECT value FROM data").get().value, "original");
    reopened.close();
  } finally { f.cleanup(); }
});

test("repeat restore removes stale wal and shm sidecars", () => {
  const f = fixture();
  try {
    const snapshot = createRecoverySnapshot({ derivedStorePath: f.dbPath, backupDir: f.backupDir }).snapshotPath;
    writeFileSync(`${f.dbPath}-wal`, "stale");
    writeFileSync(`${f.dbPath}-shm`, "stale");
    restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => [] });
    restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => [] });
    assert.equal(existsSync(`${f.dbPath}-wal`), false);
    assert.equal(existsSync(`${f.dbPath}-shm`), false);
  } finally { f.cleanup(); }
});

test("custom and legacy path resolution stays explicit", () => {
  const legacy = path.join(os.tmpdir(), `lore-legacy-${Date.now()}`);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "lore.db"), "");
  try {
    const resolved = resolveRecoveryConfig({ env: { LORE_COPILOT_HOME: legacy }, home: path.join(legacy, "home"), exists: (p) => existsSync(p) });
    assert.equal(resolved.derivedStorePath, path.join(legacy, "lore.db"));
    assert.equal(resolved.legacy, true);
  } finally { rmSync(legacy, { recursive: true, force: true }); }
});

test("restore preserves orphan WAL and SHM even when the target DB is missing", () => {
  const f = fixture();
  try {
    const snapshot = createRecoverySnapshot({ derivedStorePath: f.dbPath, backupDir: f.backupDir }).snapshotPath;
    rmSync(f.dbPath);
    writeFileSync(`${f.dbPath}-wal`, "orphan WAL evidence");
    writeFileSync(`${f.dbPath}-shm`, "orphan SHM evidence");
    const result = restoreRecoverySnapshot({ derivedStorePath: f.dbPath, snapshotPath: snapshot, write: true, clientsStopped: true, detectActiveUsers: () => [] });
    assert.ok(result.rescuePath);
    assert.equal(readFileSync(`${result.rescuePath}-wal`, "utf8"), "orphan WAL evidence");
    assert.equal(readFileSync(`${result.rescuePath}-shm`, "utf8"), "orphan SHM evidence");
  } finally { f.cleanup(); }
});
