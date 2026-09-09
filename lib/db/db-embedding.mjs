import { normalizeRepository } from "../utils/repository-utils.mjs";
import { buildSemanticEligibilitySql } from "./db-retrieval-policy.mjs";
import { nowIso } from "./db-shared.mjs";

/**
 * Ensure the memory_embedding table exists (semantic search cache).
 * Additive side table owned by the semantic-search feature; created
 * idempotently so existing databases adopt it without a full migration.
 */
export function ensureMemoryEmbeddingTable(owner) {
  owner.ensureOpen();
  owner.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embedding (
      memory_id TEXT PRIMARY KEY,
      content_hash TEXT,
      provider TEXT,
      model TEXT,
      dimensions INTEGER,
      vector TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Existing databases may have the original memory_id/vector-only table.
  // Add metadata columns in place so old rows remain readable but cannot be
  // mistaken for a validated cache entry until they are refreshed.
  for (const [column, definition] of [
    ["content_hash", "TEXT"],
    ["provider", "TEXT"],
    ["model", "TEXT"],
    ["dimensions", "INTEGER"],
  ]) {
    try {
      owner.ensureColumn("memory_embedding", column, definition);
    } catch (error) {
      // Another Lore process may have added the column between PRAGMA and
      // ALTER TABLE. Re-check before surfacing a genuine schema failure.
      if (!owner.tableHasColumn("memory_embedding", column)) {
        throw error;
      }
    }
  }
}

/**
 * List non-superseded semantic memories eligible for embedding-based search.
 *
 * @param {{ types?: string[], repository?: string | null }} [opts]
 * @returns {Array<{ id: string, type: string, content: string, repository: string | null, updated_at: string }>}
 */
export function listSemanticMemoriesForEmbedding(owner, { types = [], scopes = [], repository = null, includeOtherRepositories = false, transferableFallback = false, embeddingState = "all", limit = 256, offset = null, after = null, stableOrder = false, now = new Date() } = {}) {
  owner.ensureOpen();
  const params = [];
  const hasEmbeddingTable = owner.tableExists("memory_embedding");
  const columns = `sm.rowid AS memory_rowid, sm.id, sm.type, sm.content, sm.repository, sm.scope, sm.scope_source, sm.updated_at,
    sm.expires_at, sm.canonical_key, sm.metadata_json, sm.source_session_id${hasEmbeddingTable ? ", me.updated_at AS embedding_updated_at, me.vector, me.content_hash, me.provider, me.model, me.dimensions" : ""}`;
  let sql = `SELECT ${columns} FROM semantic_memory sm ${hasEmbeddingTable ? "LEFT JOIN memory_embedding me ON me.memory_id = sm.id" : ""}`;
  const eligibility = buildSemanticEligibilitySql({ alias: "sm", repository: normalizeRepository(repository), includeOtherRepositories, transferableFallback, now });
  sql += ` WHERE ${eligibility.sql}`;
  params.push(...eligibility.params);
  if (types.length > 0) {
    sql += ` AND sm.type IN (${types.map(() => "?").join(", ")})`;
    params.push(...types);
  }
  if (scopes.length > 0) {
    sql += ` AND sm.scope IN (${scopes.map(() => "?").join(", ")})`;
    params.push(...scopes);
  }
  if (embeddingState === "missing" && hasEmbeddingTable) {
    sql += " AND me.memory_id IS NULL";
  } else if (embeddingState === "cached" && hasEmbeddingTable) {
    sql += " AND me.memory_id IS NOT NULL";
  }
  if (after && typeof after === "object") {
    if (stableOrder) {
      sql += " AND (sm.updated_at > ? OR (sm.updated_at = ? AND sm.id > ?))";
      params.push(after.updatedAt ?? "", after.updatedAt ?? "", after.id ?? "");
    } else if (after.memoryRowid !== undefined && after.memoryRowid !== null) {
      sql += " AND sm.rowid > ?";
      params.push(Math.max(0, Math.trunc(Number(after.memoryRowid) || 0)));
    } else {
      sql += " AND (sm.updated_at > ? OR (sm.updated_at = ? AND sm.id > ?))";
      params.push(after.updatedAt ?? "", after.updatedAt ?? "", after.id ?? "");
    }
  }
  sql += stableOrder
    ? " ORDER BY sm.updated_at ASC, sm.id ASC"
    : hasEmbeddingTable
    ? " ORDER BY sm.rowid ASC"
    : " ORDER BY sm.updated_at ASC, sm.id ASC";
  sql += " LIMIT ?";
  params.push(Math.max(1, Math.min(256, Math.trunc(Number(limit) || 256))));
  if ((!after || typeof after !== "object") && offset !== null) {
    sql += " OFFSET ?";
    params.push(Math.max(0, Math.trunc(Number(offset) || 0)));
  }
  return owner.mapRetrievalRepositories(owner.db.prepare(sql).all(...params), normalizeRepository(repository));
}

export function countSemanticMemoriesForEmbedding(owner, { types = [], scopes = [], repository = null, includeOtherRepositories = false, now = new Date() } = {}) {
  owner.ensureOpen();
  const eligibility = buildSemanticEligibilitySql({
    alias: "sm",
    repository: normalizeRepository(repository),
    includeOtherRepositories,
    now,
  });
  const params = [...eligibility.params];
  let sql = `SELECT COUNT(*) AS count FROM semantic_memory sm WHERE ${eligibility.sql}`;
  if (types.length > 0) {
    sql += ` AND sm.type IN (${types.map(() => "?").join(", ")})`;
    params.push(...types);
  }
  if (scopes.length > 0) {
    sql += ` AND sm.scope IN (${scopes.map(() => "?").join(", ")})`;
    params.push(...scopes);
  }
  return Number(owner.db.prepare(sql).get(...params)?.count ?? 0);
}

/**
 * Read the cached embedding vector for a memory, or null when absent.
 *
 * @param {string} memoryId
 * @param {{ contentHash?: string, provider?: string, model?: string, dimensions?: number }} [key]
 * @returns {string | null} JSON-encoded vector
 */
export function getMemoryEmbedding(owner, memoryId, key = null) {
  owner.ensureOpen();
  const row = owner.db.prepare(`
    SELECT vector, content_hash, provider, model, dimensions
    FROM memory_embedding
    WHERE memory_id = ?
  `).get(memoryId);
  if (!row) {
    return null;
  }
  if (key && (
    row.content_hash !== key.contentHash
    || row.provider !== key.provider
    || row.model !== key.model
    || Number(row.dimensions) !== Number(key.dimensions)
  )) {
    return null;
  }
  return row.vector ?? null;
}

/**
 * Cache an embedding vector for a memory (insert or replace).
 *
 * @param {string} memoryId
 * @param {number[]} vector
 * @param {{ contentHash?: string, provider?: string, model?: string, dimensions?: number }} [key]
 */
export function setMemoryEmbedding(owner, memoryId, vector, key = {}) {
  owner.ensureOpen();
  owner.db.prepare(`
    INSERT OR REPLACE INTO memory_embedding
      (memory_id, content_hash, provider, model, dimensions, vector, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    memoryId,
    key.contentHash ?? null,
    key.provider ?? null,
    key.model ?? null,
    Number.isInteger(Number(key.dimensions)) ? Number(key.dimensions) : null,
    JSON.stringify(vector),
    nowIso(),
  );
}
