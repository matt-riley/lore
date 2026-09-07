import { DatabaseSync } from "node:sqlite";
import { existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.mjs";

const VERSION_TABLES = ["lore_schema_version", "coherence_schema_version"];

function sqlQuote(value) {
  return String(value).replaceAll("'", "''");
}

function schemaInfo(db, dbPath) {
  const found = [];
  for (const table of VERSION_TABLES) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const rows = db.prepare(`SELECT version FROM ${table}`).all();
    if (rows.some((row) => typeof row.version !== "number" || !Number.isInteger(row.version) || row.version < 0)) {
      throw new Error(`malformed Lore schema version in ${table} at ${path.resolve(dbPath)}`);
    }
    const version = rows.length > 0 ? Math.max(...rows.map((row) => row.version)) : 0;
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
    const actual = new Set(db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all().map((column) => column.name));
    return columns.every((column) => actual.has(column));
  });
  return { ...(selected ?? { tableName: null, version: 0 }), requiredTables };
}

export function inspectDatabase(dbPath) {
  const normalized = path.resolve(String(dbPath));
  if (!existsSync(normalized)) return { path: normalized, exists: false, integrity: "missing", schemaVersion: null };
  const db = new DatabaseSync(normalized, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const info = schemaInfo(db, normalized);
    return { path: normalized, exists: true, integrity: integrity === "ok" ? "ok" : integrity, schemaVersion: info.version, schemaTable: info.tableName, requiredTables: info.requiredTables };
  } finally { db.close(); }
}

function schemaShape(db) {
  return new Map(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").all()
      .map(({ name }) => [name, new Set(db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all().map((column) => column.name))]),
  );
}

export function validateCanonicalShape(db) {
  const canonical = new DatabaseSync(":memory:");
  try {
    for (const statement of SCHEMA_STATEMENTS) canonical.exec(statement);
    const expected = schemaShape(canonical);
    const actual = schemaShape(db);
    for (const [table, columns] of expected) {
      const actualColumns = actual.get(table);
      if (!actualColumns || [...columns].some((column) => !actualColumns.has(column))) {
        throw new Error(`snapshot is not a complete Lore database (missing table or columns in ${table})`);
      }
    }
  } finally { canonical.close(); }
}

export function readCurrentSuppressions(dbPath) {
  if (!existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_suppression'").get();
    if (!table) return [];
    return db.prepare(`
      SELECT suppression_key, memory_id, canonical_fingerprint, scope, repository,
        evidence_fingerprint, actor, reason, created_at, superseded_at,
        repair_candidate, legacy_marker_fingerprint
      FROM memory_suppression
    `).all();
  } catch {
    return [];
  } finally { db.close(); }
}

function mergeCurrentSuppressions(stagePath, suppressions) {
  const db = new DatabaseSync(stagePath);
  try {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO memory_suppression (
        suppression_key, memory_id, canonical_fingerprint, scope, repository,
        evidence_fingerprint, actor, reason, created_at, superseded_at,
        repair_candidate, legacy_marker_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of suppressions) insert.run(
        row.suppression_key,
        row.memory_id,
        row.canonical_fingerprint,
        row.scope,
        row.repository,
        row.evidence_fingerprint,
        row.actor,
        row.reason,
        row.created_at,
        row.superseded_at,
        row.repair_candidate ?? 0,
        row.legacy_marker_fingerprint ?? null,
      );
      // A snapshot can predate a forget/purge of an explicit manual row.
      // Retrieval intentionally exempts fresh manual writes from proposition
      // suppression, so merely merging the ledger would resurrect that old ID.
      // Reapply only exact active identities, preserving fresh manual IDs and
      // existing supersession provenance. Include the snapshot's own ledger.
      db.prepare(`
        UPDATE semantic_memory
        SET superseded_by = 'suppressed:restore'
        WHERE superseded_by IS NULL
          AND id IN (
            SELECT memory_id FROM memory_suppression
            WHERE superseded_at IS NULL AND COALESCE(repair_candidate, 0) = 0
              AND memory_id IS NOT NULL
          )
      `).run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}

export function prepareSnapshotStage({ snapshotPath, stagePath, suppressions = [], upgrade }) {
  const original = inspectDatabase(snapshotPath);
  if (!original.exists || original.integrity !== "ok") throw new Error("snapshot integrity check failed");
  if (!original.schemaTable || original.schemaVersion < 1 || !original.requiredTables) {
    throw new Error("snapshot is not a recognized Lore database");
  }
  const source = new DatabaseSync(snapshotPath, { readOnly: true });
  try { source.exec(`VACUUM INTO '${sqlQuote(stagePath)}'`); } finally { source.close(); }
  chmodSync(stagePath, 0o600);
  upgrade(stagePath);
  mergeCurrentSuppressions(stagePath, suppressions);
  const staged = new DatabaseSync(stagePath);
  try {
    validateCanonicalShape(staged);
    if (staged.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("staged snapshot integrity check failed");
    staged.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
  } finally { staged.close(); }
  return inspectDatabase(stagePath);
}
