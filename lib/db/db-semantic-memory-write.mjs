import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildSemanticCanonicalKey, classifySemanticMemory } from "../memory/memory-scope.mjs";
import { findActiveSuppression as findLifecycleSuppression, isExplicitLifecycleWrite, normalizeEvidence } from "./db-memory-lifecycle.mjs";
import { parseJsonObject } from "../utils/json-object-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { nowIso, SCOPE_SOURCE, normalizeScopeSource } from "./db-shared.mjs";

const LAST_SEEN_AT_CASE_SQL = "last_seen_at = CASE WHEN ? IS NULL THEN COALESCE(last_seen_at, ?) WHEN last_seen_at IS NULL OR ? > last_seen_at THEN ? ELSE last_seen_at END";

function lastSeenAtParams(value) {
  return [value, value, value, value];
}

function mergeTagText(existingTags, incomingTags) {
  const tags = new Set(
    `${existingTags || ""} ${incomingTags || ""}`
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  return [...tags].join(" ");
}

function resolveTimestamp(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const MS_PER_HOUR = 60 * 60 * 1000;

const VOLATILE_TTL_MS = Object.freeze({
  assistant_goal: 24 * MS_PER_HOUR,
  open_loop: 7 * 24 * MS_PER_HOUR,
  blocker: 7 * 24 * MS_PER_HOUR,
});

function defaultVolatileExpiry(type, timestamp) {
  const ttlMs = VOLATILE_TTL_MS[type];
  if (!ttlMs) {
    return null;
  }
  const start = Date.parse(timestamp);
  if (!Number.isFinite(start)) {
    return null;
  }
  return new Date(start + ttlMs).toISOString();
}

export function buildSemanticMemoryWriteContext(owner, memory, timestamp) {
  const classification = classifySemanticMemory(memory);
  const evidence = normalizeEvidence({
    sessionId: memory.sourceSessionId,
    memory,
    repository: classification.repository,
  });
  return {
    id: memory.id ?? crypto.randomUUID(),
    type: memory.type,
    content: memory.content,
    classification,
    repository: normalizeRepository(classification.repository),
    scope: classification.scope,
    domainKey: normalizeText(memory.domainKey).toLowerCase() || null,
    tagsText: Array.isArray(memory.tags) ? memory.tags.join(" ") : "",
    sourceText: typeof classification.metadata?.source === "string" ? classification.metadata.source : "",
    canonicalKey: buildSemanticCanonicalKey({
      ...memory,
      metadata: classification.metadata,
      content: memory.content,
      type: memory.type,
    }),
    incomingReinforcement: Number.isInteger(memory.reinforcementCount)
      ? Math.max(1, memory.reinforcementCount)
      : 1,
    incomingLastSeenAt: memory.lastSeenAt ?? timestamp,
    incomingConfidence: typeof memory.confidence === "number" ? memory.confidence : 1.0,
    insertedUpdatedAt: resolveTimestamp(memory.updatedAt, timestamp),
    evidence,
    explicitWrite: isExplicitLifecycleWrite(memory, classification.metadata),
    hasExpiresAt: Object.hasOwn(memory ?? {}, "expiresAt") || Object.hasOwn(memory ?? {}, "expires_at"),
    expiresAt: Object.hasOwn(memory ?? {}, "expiresAt") ? memory.expiresAt : memory.expires_at,
  };
}

export function findActiveSuppression(owner, write) {
  return findLifecycleSuppression(owner, write);
}

export function isMemorySuppressed(owner, id) {
  return !!owner.db.prepare(`
    SELECT 1 FROM memory_suppression
    WHERE memory_id = ? AND superseded_at IS NULL AND COALESCE(repair_candidate, 0) = 0
    LIMIT 1
  `).get(id);
}

export function listActiveMemorySuppressions(owner) {
  owner.ensureOpen();
  return owner.db.prepare(`
    SELECT memory_id, canonical_fingerprint, evidence_fingerprint, scope, repository
    FROM memory_suppression
    WHERE superseded_at IS NULL AND COALESCE(repair_candidate, 0) = 0
  `).all();
}

export function findManualSemanticMemoryMatch(owner, memory, canonicalKey, scope, repository) {
  return owner.db.prepare(`
    SELECT
      id, tags, metadata_json, scope, repository, scope_source, confidence,
      reinforcement_count, last_seen_at, expires_at
    FROM semantic_memory
    WHERE superseded_by IS NULL
      AND type = ?
      AND (
        (? IS NOT NULL AND canonical_key = ?)
        OR (canonical_key IS NULL AND content = ?)
      )
      AND scope_source = 'manual'
      AND scope = ?
      AND IFNULL(repository, '') = IFNULL(?, '')
    ORDER BY CASE WHEN canonical_key IS NOT NULL THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).get(
    memory.type,
    canonicalKey,
    canonicalKey,
    memory.content,
    scope,
    repository,
  );
}

export function findScopedSemanticMemoryMatch(owner, memory, canonicalKey, scope, repository) {
  return owner.db.prepare(`
    SELECT id, content, tags, metadata_json, scope_source, reinforcement_count, last_seen_at, expires_at
    FROM semantic_memory
    WHERE superseded_by IS NULL
      AND type = ?
      AND (
        (? IS NOT NULL AND canonical_key = ?)
        OR (canonical_key IS NULL AND content = ?)
      )
      AND scope = ?
      AND IFNULL(repository, '') = IFNULL(?, '')
    ORDER BY CASE WHEN canonical_key IS NOT NULL THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).get(
    memory.type,
    canonicalKey,
    canonicalKey,
    memory.content,
    scope,
    repository,
  );
}

export function buildSemanticMemoryMetadata(owner, existingMetadata, domainKey, classificationMetadata, evidence = null) {
  return {
    ...existingMetadata,
    ...(domainKey ? { domainKey } : {}),
    ...classificationMetadata,
    ...(evidence ? {
      evidence: {
        key: evidence.key,
        sourceRecordId: evidence.sourceRecordId,
        sourceKind: evidence.sourceKind,
        revision: evidence.revision,
        contentHash: evidence.contentHash,
      },
    } : {}),
  };
}

export function updateManualSemanticMemoryMatch(owner, memory, write, timestamp, match) {
  const mergedMetadata = owner.buildSemanticMemoryMetadata(
    parseJsonObject(match.metadata_json),
    write.domainKey,
    write.classification.metadata,
    write.explicitWrite ? null : write.evidence,
  );
  owner.db.prepare(`
    UPDATE semantic_memory
    SET confidence = MAX(confidence, ?),
        updated_at = ?,
        source_session_id = COALESCE(?, source_session_id),
        source_turn_index = COALESCE(?, source_turn_index),
        domain_key = COALESCE(?, domain_key),
        tags = ?,
        metadata_json = ?,
        canonical_key = COALESCE(canonical_key, ?),
        reinforcement_count = MAX(1, COALESCE(reinforcement_count, 1) + ?),
        expires_at = CASE WHEN ? = 1 THEN ? ELSE expires_at END,
        ${LAST_SEEN_AT_CASE_SQL}
    WHERE id = ?
  `).run(
    write.incomingConfidence,
    timestamp,
    memory.sourceSessionId ?? null,
    Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
    write.domainKey,
    mergeTagText(match.tags, write.tagsText),
    JSON.stringify(mergedMetadata),
    write.canonicalKey,
    write.incomingReinforcement,
    write.hasExpiresAt ? 1 : 0,
    write.hasExpiresAt ? write.expiresAt ?? null : null,
    ...lastSeenAtParams(write.incomingLastSeenAt),
    match.id,
  );
  return match.id;
}

export function updateProtectedSemanticMemoryMatch(owner, existing) {
  // Inferred evidence can share an explicit proposition, but it must not
  // rewrite the explicit row's provenance, confidence, or reinforcement.
  return existing.id;
}

export function updateScopedSemanticMemoryMatch(owner, memory, existing, write, timestamp) {
  const mergedMetadata = owner.buildSemanticMemoryMetadata(
    parseJsonObject(existing.metadata_json),
    write.domainKey,
    write.classification.metadata,
    write.explicitWrite ? null : write.evidence,
  );
  owner.db.prepare(`
    UPDATE semantic_memory
    SET confidence = ?,
        updated_at = ?,
        source_session_id = COALESCE(?, source_session_id),
        source_turn_index = COALESCE(?, source_turn_index),
        domain_key = COALESCE(?, domain_key),
        tags = ?,
        metadata_json = ?,
        canonical_key = COALESCE(canonical_key, ?),
        reinforcement_count = MAX(1, COALESCE(reinforcement_count, 1) + ?),
        expires_at = CASE WHEN ? = 1 THEN ? ELSE expires_at END,
        ${LAST_SEEN_AT_CASE_SQL}
    WHERE id = ?
  `).run(
    write.incomingConfidence,
    timestamp,
    memory.sourceSessionId ?? null,
    Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
    write.domainKey,
    mergeTagText(existing.tags, write.tagsText),
    JSON.stringify(mergedMetadata),
    write.canonicalKey,
    write.incomingReinforcement,
    write.hasExpiresAt ? 1 : 0,
    write.hasExpiresAt ? write.expiresAt ?? null : null,
    ...lastSeenAtParams(write.incomingLastSeenAt),
    existing.id,
  );
  return existing.id;
}

export function insertNewSemanticMemory(owner, memory, write, timestamp) {
  const expiresAt = write.hasExpiresAt
    ? write.expiresAt ?? null
    : defaultVolatileExpiry(memory.type, timestamp);
  owner.db.prepare(`
    INSERT INTO semantic_memory (
      id, type, content, confidence, source_session_id, source_turn_index,
      scope, repository, domain_key, tags, created_at, updated_at, superseded_by, canonical_key,
      reinforcement_count, last_seen_at, expires_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    write.id,
    memory.type,
    memory.content,
    write.incomingConfidence,
    memory.sourceSessionId ?? null,
    Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
    write.scope,
    write.repository,
    write.domainKey,
    write.tagsText,
    memory.createdAt ?? timestamp,
    write.insertedUpdatedAt,
    memory.supersededBy ?? null,
    write.canonicalKey,
    write.incomingReinforcement,
    write.incomingLastSeenAt,
    expiresAt,
    JSON.stringify(owner.buildSemanticMemoryMetadata({}, write.domainKey, write.classification.metadata,
      write.explicitWrite ? null : write.evidence)),
  );
  return write.id;
}

export function upsertManualSemanticMemory(owner, memory, write, timestamp) {
  const manualScopeMatch = owner.findManualSemanticMemoryMatch(memory, write.canonicalKey, write.scope, write.repository);
  if (!manualScopeMatch?.id) return null;
  return write.explicitWrite
    ? owner.updateManualSemanticMemoryMatch(memory, write, timestamp, manualScopeMatch)
    : owner.updateProtectedSemanticMemoryMatch(manualScopeMatch, write, timestamp);
}

export function upsertScopedSemanticMemory(owner, memory, write, timestamp) {
  const existing = owner.findScopedSemanticMemoryMatch(
    memory,
    write.canonicalKey,
    write.scope,
    write.repository,
  );
  if (!existing?.id) {
    return null;
  }
  // An explicit save is an intentional restore. Keep the suppressed
  // generated row immutable and create a fresh manual row so retrieval can
  // distinguish the restoration from the forgotten proposition.
  if (write.explicitWrite && (owner.isMemorySuppressed(existing.id) || owner.findActiveSuppression(write))) {
    return null;
  }
  const existingMetadata = parseJsonObject(existing.metadata_json);
  const manualExisting = ["memory_save", "lore_retain", "onboarding", "pi", "pi:command"].includes(existingMetadata.source);
  const manualIncoming = write.explicitWrite;
  const lockedScope = normalizeScopeSource(existing.scope_source) === SCOPE_SOURCE.MANUAL;
  if ((manualExisting || lockedScope) && !manualIncoming) return owner.updateProtectedSemanticMemoryMatch(existing, write, timestamp);
  if (write.preserveProposition && existing.content !== memory.content) return null;
  return owner.updateScopedSemanticMemoryMatch(memory, existing, write, timestamp);
}

export function insertSemanticMemory(owner, memory, { preserveProposition = false } = {}) {
  owner.ensureOpen();
  const timestamp = nowIso();
  const write = owner.buildSemanticMemoryWriteContext(memory, timestamp);
  if (write.hasExpiresAt && write.expiresAt !== null && write.expiresAt !== undefined
    && (typeof write.expiresAt !== "string" || !Number.isFinite(Date.parse(write.expiresAt)))) {
    throw new Error("expiresAt must be a valid timestamp or null");
  }
  if (typeof write.expiresAt === "string") write.expiresAt = new Date(write.expiresAt).toISOString();
  write.preserveProposition = preserveProposition;
  if (!write.explicitWrite && owner.findActiveSuppression(write)) {
    return null;
  }
  const id = owner.upsertManualSemanticMemory(memory, write, timestamp)
    ?? owner.upsertScopedSemanticMemory(memory, write, timestamp)
    ?? owner.insertNewSemanticMemory(memory, write, timestamp);
  if (owner.pendingSemanticDurability) owner.pendingSemanticDurability.add(id);
  else owner.verifySemanticMemoryDurability(id);
  return id;
}

// Capture hooks can race at turn/session end. Commit the complete refresh
// atomically, then perform the usual independent-connection durability check.
export function withSemanticMemoryTransaction(owner, callback) {
  owner.ensureOpen();
  if (owner.pendingSemanticDurability) throw new Error("Nested semantic transactions are not supported");
  owner.db.exec("BEGIN IMMEDIATE");
  const pending = new Set();
  owner.pendingSemanticDurability = pending;
  let committed = false;
  try {
    const result = callback();
    if (result?.then) throw new Error("Semantic transaction callbacks must be synchronous");
    owner.db.exec("COMMIT");
    committed = true;
    for (const id of pending) owner.verifySemanticMemoryDurability(id);
    return result;
  } catch (error) {
    if (!committed) owner.db.exec("ROLLBACK");
    throw error;
  } finally {
    owner.pendingSemanticDurability = null;
  }
}

// Re-reads the row via an independent connection right after writing it.
// A same-connection read can't catch a cross-process WAL checkpoint race
// (multiple Copilot CLI processes can hold lore.db open concurrently);
// this call, from a fresh connection, mirrors what an external reader
// would actually see and turns a silent data-loss into a real failure
// instead of a false "Retained semantic memory <id>" success message.
export function verifySemanticMemoryDurability(owner, id) {
  const dbPath = owner.config.paths.derivedStorePath;
  let verifyDb;
  try {
    verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    verifyDb.exec("PRAGMA busy_timeout = 2000;");
    const row = verifyDb.prepare(`
      SELECT id FROM semantic_memory WHERE id = ? LIMIT 1
    `).get(id);
    if (!row) {
      throw new Error(
        `semantic memory ${id} did not durably persist: not visible via an ` +
        "independent connection immediately after insert. This can happen when " +
        "multiple concurrent Copilot CLI processes hold lore.db open and a WAL " +
        "checkpoint races an in-flight write. The memory was NOT saved - retry.",
      );
    }
  } finally {
    try {
      verifyDb?.close();
    } catch {
      // best-effort close of the verification connection
    }
  }
}
