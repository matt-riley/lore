import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadFileConfigSync, mergeDeep, USER_CONFIG_DEFAULTS, isPlainObject } from "./config.mjs";
import { resolveLorePaths } from "./lore-paths.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";

const VERSION_TABLES = ["lore_schema_version", "coherence_schema_version"];

function sqlQuote(value) {
  return String(value).replaceAll("'", "''");
}

function schemaInfo(db, dbPath) {
  for (const table of VERSION_TABLES) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const row = db.prepare(`SELECT MAX(version) AS version FROM ${table}`).get();
    const version = Number.isInteger(row?.version) ? row.version : 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(`unsupported future Lore schema version ${version} (supported through ${SCHEMA_VERSION}) at ${path.resolve(dbPath)}`);
    }
    return { tableName: table, version };
  }
  return { tableName: null, version: 0 };
}

function inspectDatabase(dbPath) {
  const normalized = path.resolve(String(dbPath));
  if (!existsSync(normalized)) return { path: normalized, exists: false, integrity: "missing", schemaVersion: null };
  const db = new DatabaseSync(normalized, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const info = schemaInfo(db, normalized);
    return { path: normalized, exists: true, integrity: integrity === "ok" ? "ok" : integrity, schemaVersion: info.version, schemaTable: info.tableName };
  } finally { db.close(); }
}

export function inspectRecoveryTarget({ derivedStorePath }) {
  return inspectDatabase(derivedStorePath);
}

export function resolveRecoveryConfig({ env = process.env, home = os.homedir(), exists = existsSync, configPath, derivedStorePath, rawStorePath, backupDir } = {}) {
  const resolved = resolveLorePaths({ env, home, exists });
  const selectedConfigPath = configPath ? path.resolve(configPath) : resolved.configPath;
  const fileConfig = selectedConfigPath && exists(selectedConfigPath) ? loadFileConfigSync(selectedConfigPath) : {};
  const merged = mergeDeep(USER_CONFIG_DEFAULTS, isPlainObject(fileConfig) ? fileConfig : {});
  const paths = {
    ...merged.paths,
    rawStorePath: rawStorePath ?? fileConfig?.paths?.rawStorePath ?? (resolved.legacy ? path.join(resolved.loreHome, "session-store.db") : merged.paths.rawStorePath),
    derivedStorePath: derivedStorePath ?? fileConfig?.paths?.derivedStorePath ?? resolved.derivedStorePath,
    backupDir: backupDir ?? fileConfig?.paths?.backupDir ?? resolved.backupDir,
  };
  return {
    ...merged,
    configPath: selectedConfigPath,
    paths,
    derivedStorePath: paths.derivedStorePath,
    rawStorePath: paths.rawStorePath,
    backupDir: paths.backupDir,
    legacy: resolved.legacy,
  };
}

function flushFile(filePath) {
  const fd = openSync(filePath, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function createRecoverySnapshot({ derivedStorePath, backupDir, now = new Date() }) {
  const sourcePath = path.resolve(derivedStorePath);
  if (!existsSync(sourcePath)) throw new Error(`Lore database does not exist: ${sourcePath}`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const destinationDir = path.resolve(backupDir);
  mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(destinationDir, `lore-${stamp}-${process.pid}.db`);
  rmSync(snapshotPath, { force: true });
  try {
    source.exec(`VACUUM INTO '${sqlQuote(snapshotPath)}'`);
  } finally { source.close(); }
  chmodSync(snapshotPath, 0o600);
  flushFile(snapshotPath);
  const validation = inspectDatabase(snapshotPath);
  if (validation.integrity !== "ok") throw new Error(`snapshot integrity check failed: ${validation.integrity}`);
  return { snapshotPath, sourcePath, ...validation };
}

function defaultActiveDetector(dbPath) {
  const result = spawnSync("lsof", ["-Fpn", "--", dbPath, `${dbPath}-wal`, `${dbPath}-shm`], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const users = new Set();
  for (const line of String(result.stdout || "").split("\n")) {
    if (line.startsWith("p") && line.slice(1) !== String(process.pid)) users.add(line.slice(1));
  }
  return [...users];
}

function preflightWriterLock(dbPath) {
  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=250; BEGIN IMMEDIATE; ROLLBACK;");
  } catch (error) {
    throw new Error(`Lore database is locked; stop clients before restore: ${error.message}`, { cause: error });
  } finally { db.close(); }
}

function validateSnapshot(snapshotPath) {
  const result = inspectDatabase(snapshotPath);
  if (!result.exists) throw new Error(`snapshot path does not exist: ${result.path}`);
  if (result.integrity !== "ok") throw new Error(`snapshot integrity check failed: ${result.integrity}`);
  return result;
}

export function restoreRecoverySnapshot({ derivedStorePath, snapshotPath, write = false, clientsStopped = false, detectActiveUsers = defaultActiveDetector, fsOps = {} } = {}) {
  const target = path.resolve(derivedStorePath);
  const source = path.resolve(snapshotPath);
  const validation = validateSnapshot(source);
  if (!write) return { written: false, target, snapshotPath: source, validation };
  if (!clientsStopped) throw new Error("restore --write requires explicit --clients-stopped acknowledgement");
  const active = detectActiveUsers(target);
  if (Array.isArray(active) && active.length > 0) throw new Error(`active Lore clients detected: ${active.join(", ")}`);
  preflightWriterLock(target);

  const ops = { copyFileSync, renameSync, rmSync, ...fsOps };
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const rescue = `${target}.rescue-${stamp}-${process.pid}`;
  const stage = `${target}.restore-${stamp}-${process.pid}.tmp`;
  const sidecars = ["-wal", "-shm"];
  let movedTarget = false;
  try {
    ops.copyFileSync(source, stage);
    chmodSync(stage, 0o600);
    if (existsSync(target)) {
      ops.renameSync(target, rescue);
      movedTarget = true;
      for (const suffix of sidecars) if (existsSync(`${target}${suffix}`)) ops.renameSync(`${target}${suffix}`, `${rescue}${suffix}`);
    }
    ops.renameSync(stage, target);
    for (const suffix of sidecars) ops.rmSync(`${target}${suffix}`, { force: true });
    const reopened = inspectDatabase(target);
    if (reopened.integrity !== "ok") throw new Error(`restored database failed integrity check: ${reopened.integrity}`);
    return { written: true, target, snapshotPath: source, rescuePath: movedTarget ? rescue : null, validation: reopened };
  } catch (error) {
    try { ops.rmSync(stage, { force: true }); } catch {}
    if (movedTarget) {
      try { ops.rmSync(target, { force: true }); } catch {}
      try { ops.renameSync(rescue, target); } catch {}
      for (const suffix of sidecars) if (existsSync(`${rescue}${suffix}`)) { try { ops.renameSync(`${rescue}${suffix}`, `${target}${suffix}`); } catch {} }
    }
    throw error;
  }
}

export { defaultActiveDetector };
