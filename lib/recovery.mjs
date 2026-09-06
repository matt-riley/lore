import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
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
  const found = [];
  for (const table of VERSION_TABLES) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const row = db.prepare(`SELECT MAX(version) AS version, COUNT(*) AS count FROM ${table}`).get();
    if (row?.count > 0 && (typeof row.version !== "number" || !Number.isInteger(row.version) || row.version < 0)) {
      throw new Error(`malformed Lore schema version in ${table} at ${path.resolve(dbPath)}`);
    }
    const version = row?.count > 0 ? row.version : 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(`unsupported future Lore schema version ${version} (supported through ${SCHEMA_VERSION}) at ${path.resolve(dbPath)}`);
    }
    found.push({
      tableName: table,
      version,
    });
  }
  const selected = found[0];
  const requiredColumns = {
    semantic_memory: ["id", "type", "content", "created_at", "updated_at"],
    episode_digest: ["id", "session_id", "summary", "date_key", "created_at", "updated_at"],
  };
  const requiredTables = Object.entries(requiredColumns).every(([table, columns]) => {
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    return columns.every((column) => actual.has(column));
  });
  return { ...(selected ?? { tableName: null, version: 0 }), requiredTables };
}

function inspectDatabase(dbPath) {
  const normalized = path.resolve(String(dbPath));
  if (!existsSync(normalized)) return { path: normalized, exists: false, integrity: "missing", schemaVersion: null };
  const db = new DatabaseSync(normalized, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const info = schemaInfo(db, normalized);
    return { path: normalized, exists: true, integrity: integrity === "ok" ? "ok" : integrity, schemaVersion: info.version, schemaTable: info.tableName, requiredTables: info.requiredTables };
  } finally { db.close(); }
}

export function inspectRecoveryTarget({ derivedStorePath }) {
  return inspectDatabase(derivedStorePath);
}

export function resolveRecoveryConfig({ env = process.env, home = os.homedir(), exists = existsSync, configPath, derivedStorePath, rawStorePath, backupDir } = {}) {
  const resolved = resolveLorePaths({ env, home, exists });
  const selectedConfigPath = configPath ? path.resolve(expandUserPath(configPath)) : resolved.configPath;
  const fileConfig = selectedConfigPath && exists(selectedConfigPath) ? loadFileConfigSync(selectedConfigPath) : {};
  const merged = mergeDeep(USER_CONFIG_DEFAULTS, isPlainObject(fileConfig) ? fileConfig : {});
  const paths = {
    ...merged.paths,
    rawStorePath: path.resolve(expandUserPath(rawStorePath ?? fileConfig?.paths?.rawStorePath ?? (resolved.legacy ? path.join(resolved.loreHome, "session-store.db") : merged.paths.rawStorePath))),
    derivedStorePath: path.resolve(expandUserPath(derivedStorePath ?? fileConfig?.paths?.derivedStorePath ?? resolved.derivedStorePath)),
    backupDir: path.resolve(expandUserPath(backupDir ?? fileConfig?.paths?.backupDir ?? resolved.backupDir)),
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

function expandUserPath(value) {
  const text = String(value ?? "");
  return text === "~" ? os.homedir() : text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text;
}

export function createRecoverySnapshot({ derivedStorePath, backupDir, now = new Date() }) {
  const sourcePath = path.resolve(derivedStorePath);
  if (!existsSync(sourcePath)) throw new Error(`Lore database does not exist: ${sourcePath}`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const stamp = `${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}`;
  const destinationDir = path.resolve(backupDir);
  mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(destinationDir, `lore-${stamp}.db`);
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
  if (!existsSync(dbPath)) return null;
  try { inspectDatabase(dbPath); } catch (error) {
    return `SQLite lock preflight unavailable for corrupt target (${error.message}); lsof detection is the only active-client check available`;
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=250; BEGIN IMMEDIATE; ROLLBACK;");
  } catch (error) {
    if (/locked|busy/i.test(String(error.message))) {
      throw new Error(`Lore database is locked; stop clients before restore: ${error.message}`, { cause: error });
    }
    return `SQLite lock preflight unavailable for target (${error.message}); lsof detection is the only active-client check available`;
  } finally { db.close(); }
}

function validateSnapshot(snapshotPath) {
  const result = inspectDatabase(snapshotPath);
  if (!result.exists) throw new Error(`snapshot path does not exist: ${result.path}`);
  if (result.integrity !== "ok") throw new Error(`snapshot integrity check failed: ${result.integrity}`);
  if (result.schemaTable === null || result.schemaVersion === null || result.schemaVersion < 1 || !result.requiredTables) {
    throw new Error(`snapshot is not a recognized Lore database (requires a known schema version and semantic_memory/episode_digest tables): ${result.path}`);
  }
  return result;
}

export function restoreRecoverySnapshot({ derivedStorePath, snapshotPath, write = false, clientsStopped = false, detectActiveUsers = defaultActiveDetector, fsOps = {} } = {}) {
  const target = path.resolve(expandUserPath(derivedStorePath));
  const source = path.resolve(expandUserPath(snapshotPath));
  const validation = validateSnapshot(source);
  if (!write) return { written: false, target, snapshotPath: source, validation };
  if (!clientsStopped) throw new Error("restore --write requires explicit --clients-stopped acknowledgement");
  const warnings = [];
  const active = detectActiveUsers(target);
  if (active === null) warnings.push("lsof active-client detection unavailable");
  if (Array.isArray(active) && active.length > 0) throw new Error(`active Lore clients detected: ${active.join(", ")}`);
  const lockWarning = preflightWriterLock(target);
  if (lockWarning) warnings.push(lockWarning);

  const ops = { renameSync, rmSync, ...fsOps };
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stamp = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID()}`;
  const rescue = `${target}.rescue-${stamp}`;
  const stage = `${target}.restore-${stamp}.tmp`;
  const sidecars = ["-wal", "-shm"];
  let movedTarget = false;
  let installedTarget = false;
  const movedSidecars = [];
  try {
    const stageDb = new DatabaseSync(source, { readOnly: true });
    try { stageDb.exec(`VACUUM INTO '${sqlQuote(stage)}'`); } finally { stageDb.close(); }
    chmodSync(stage, 0o600);
    flushFile(stage);
    const stagedValidation = validateSnapshot(stage);
    if (existsSync(target)) {
      ops.renameSync(target, rescue);
      movedTarget = true;
    }
    for (const suffix of sidecars) {
      if (!existsSync(`${target}${suffix}`)) continue;
      ops.renameSync(`${target}${suffix}`, `${rescue}${suffix}`);
      movedSidecars.push(suffix);
    }
    ops.renameSync(stage, target);
    installedTarget = true;
    const reopened = inspectDatabase(target);
    if (reopened.integrity !== "ok") throw new Error(`restored database failed integrity check: ${reopened.integrity}`);
    return { written: true, target, snapshotPath: source, rescuePath: movedTarget || movedSidecars.length ? rescue : null, validation: reopened, warnings, stagedValidation };
  } catch (error) {
    const rollbackErrors = [];
    try { ops.rmSync(stage, { force: true }); } catch (rollbackError) { rollbackErrors.push(`stage cleanup failed: ${rollbackError.message}`); }
    if (installedTarget) {
      try { ops.rmSync(target, { force: true }); } catch (rollbackError) { rollbackErrors.push(`new target cleanup failed: ${rollbackError.message}`); }
    }
    if (movedTarget) {
      try { ops.renameSync(rescue, target); } catch (rollbackError) { rollbackErrors.push(`rescue restore failed; rescue preserved at ${rescue}: ${rollbackError.message}`); }
    }
    for (const suffix of movedSidecars) {
      try { ops.renameSync(`${rescue}${suffix}`, `${target}${suffix}`); } catch (rollbackError) { rollbackErrors.push(`rescue ${suffix} restore failed; rescue preserved at ${rescue}${suffix}: ${rollbackError.message}`); }
    }
    if (rollbackErrors.length) error.message = `${error.message}; ${rollbackErrors.join("; ")}; rescue path: ${rescue}`;
    throw error;
  }
}

export { defaultActiveDetector };
