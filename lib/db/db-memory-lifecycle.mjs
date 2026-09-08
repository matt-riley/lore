import crypto from "node:crypto";

function normalizeLifecycleText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function buildSuppressionFingerprint({ type, canonicalKey }) {
  return crypto.createHash("sha256")
    .update([type ?? "", canonicalKey ?? ""].join("\0"))
    .digest("hex");
}

function acceptsRevision(incoming, current) {
  if (current === null || current === undefined || current === "") return true;
  if (incoming === null || incoming === undefined || incoming === "") return false;
  const nextNumber = Number(incoming);
  const currentNumber = Number(current);
  if (Number.isFinite(nextNumber) && Number.isFinite(currentNumber)) return nextNumber >= currentNumber;
  // Opaque revisions have no meaningful ordering. The ingestion checkpoint
  // uses expectedRevision CAS to reject stale writers before evidence writes.
  return true;
}

function hashLifecycleValue(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function buildContentEvidenceFingerprint({ type, content }) {
  return hashLifecycleValue([type ?? "", content ?? ""].join("\0"));
}

function safeEvidenceFingerprint(value) {
  const normalized = normalizeLifecycleText(value);
  return normalized && /^[0-9a-f]{64}$/iu.test(normalized) ? normalized : hashLifecycleValue(normalized);
}

function buildFallbackEvidenceKey({ sessionId, memory, proposition }) {
  const turn = Number.isInteger(memory?.sourceTurnIndex) ? memory.sourceTurnIndex : "unknown";
  const type = normalizeLifecycleText(memory?.type) ?? "memory";
  const normalized = String(proposition ?? memory?.content ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const fingerprint = crypto.createHash("sha256").update(`${type}\0${normalized}`).digest("hex").slice(0, 32);
  return `generated:${sessionId}:${turn}:${type}:${fingerprint}`;
}

export function normalizeEvidence({ sessionId, memory, repository }) {
  const evidence = memory?.evidence ?? {};
  const proposition = normalizeLifecycleText(memory?.content) ?? "";
  const key = normalizeLifecycleText(evidence.key)
    ?? buildFallbackEvidenceKey({ sessionId, memory, proposition });
  const contentHash = normalizeLifecycleText(evidence.contentHash)
    ?? crypto.createHash("sha256").update(proposition).digest("hex");
  return {
    key,
    sessionId: normalizeLifecycleText(sessionId),
    repository: normalizeLifecycleText(repository),
    sourceIdentity: normalizeLifecycleText(evidence.sourceIdentity),
    sourceRecordId: normalizeLifecycleText(evidence.sourceRecordId)
      ?? (Number.isInteger(memory?.sourceTurnIndex) ? String(memory.sourceTurnIndex) : null),
    sourceKind: normalizeLifecycleText(evidence.sourceKind) ?? normalizeLifecycleText(memory?.type) ?? "semantic",
    revision: normalizeLifecycleText(evidence.revision) ?? contentHash,
    propositionFingerprint: normalizeLifecycleText(evidence.propositionFingerprint) ?? contentHash,
    contentHash,
    metadata: {
      ...(memory?.metadata?.sourceAttribution ? { sourceAttribution: memory.metadata.sourceAttribution } : {}),
      ...(memory?.metadata?.confidenceBasis ? { confidenceBasis: memory.metadata.confidenceBasis } : {}),
      ...(evidence.metadata && typeof evidence.metadata === "object" ? evidence.metadata : {}),
    },
  };
}

export function isExplicitLifecycleWrite(memory, classificationMetadata = {}) {
  const source = classificationMetadata.source ?? memory?.metadata?.source;
  return source === "memory_save"
    || source === "lore_retain"
    || source === "onboarding"
    || source === "pi"
    || source === "pi:command"
    || memory?.scopeSource === "manual"
    || memory?.scope_source === "manual";
}

function mapCheckpointRow(row) {
  if (!row) return null;
  return {
    client: row.client,
    sessionId: row.session_id,
    repository: row.repository ?? null,
    sourceIdentity: row.source_identity,
    offset: row.offset,
    partialRecord: parseJson(row.partial_record_json),
    adapterState: parseJson(row.adapter_state_json),
    branchState: parseJson(row.branch_state_json),
    revision: row.revision,
    checkpointRevision: Number(row.checkpoint_revision ?? 0),
    health: {
      lastSuccessAt: row.last_success_at,
      pendingBytes: row.pending_bytes,
      failureCode: row.failure_code,
    },
    updatedAt: row.updated_at,
  };
}

function parseJson(value) {
  if (value === null || value === undefined || value === "") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function mapRepositoryMappingRow(row) {
  return { legacy: row.legacy, canonical: row.canonical };
}

export function findActiveSuppression(owner, write) {
  const canonicalFingerprint = write.canonicalKey
    ? buildSuppressionFingerprint({
      type: write.type,
      canonicalKey: write.canonicalKey,
      scope: write.scope,
      repository: write.repository,
    })
    : null;
  const evidenceFingerprints = [
    write.evidence?.key,
    write.evidence?.contentHash,
    write.evidence?.propositionFingerprint,
    buildContentEvidenceFingerprint({
      type: write.type,
      content: write.content,
      scope: write.scope,
      repository: write.repository,
    }),
  ].filter((value, index, all) => typeof value === "string" && value && all.indexOf(value) === index)
    .flatMap((value) => [value, safeEvidenceFingerprint(value)])
    .filter((value, index, all) => all.indexOf(value) === index);
  return owner.db.prepare(`
    SELECT suppression_key
    FROM memory_suppression
    WHERE superseded_at IS NULL
      AND COALESCE(repair_candidate, 0) = 0
      AND (
        (? IS NOT NULL AND canonical_fingerprint = ? AND scope = ?
          AND IFNULL(repository, '') = IFNULL(?, ''))
        OR (evidence_fingerprint IN (${evidenceFingerprints.map(() => "?").join(", ")})
          AND scope = ? AND IFNULL(repository, '') = IFNULL(?, ''))
      )
    ORDER BY created_at DESC
    LIMIT 1
  `).get(canonicalFingerprint, canonicalFingerprint, write.scope, write.repository,
    ...evidenceFingerprints, write.scope, write.repository);
}

export function upsertSessionEvidence(owner, evidence, capturedAt = new Date().toISOString()) {
  const current = owner.db.prepare("SELECT revision, content_hash, retired_at FROM session_evidence WHERE evidence_key = ?").get(evidence.key);
  if (current && !acceptsRevision(evidence.revision, current.revision)) {
    return { accepted: false, active: current.retired_at === null };
  }
  owner.db.prepare(`
    INSERT INTO session_evidence (
      evidence_key, session_id, repository, source_identity, source_record_id, source_kind,
      revision, proposition_fingerprint, content_hash, metadata_json, captured_at, retired_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(evidence_key) DO UPDATE SET
      session_id = excluded.session_id,
      repository = excluded.repository,
      source_identity = excluded.source_identity,
      source_record_id = excluded.source_record_id,
      source_kind = excluded.source_kind,
      revision = excluded.revision,
      proposition_fingerprint = excluded.proposition_fingerprint,
      content_hash = excluded.content_hash,
      metadata_json = excluded.metadata_json,
      captured_at = excluded.captured_at,
      retired_at = CASE
        WHEN session_evidence.retired_at IS NULL THEN NULL
        WHEN session_evidence.revision != excluded.revision
          OR session_evidence.content_hash != excluded.content_hash THEN NULL
        ELSE session_evidence.retired_at
      END
  `).run(evidence.key, evidence.sessionId, evidence.repository, evidence.sourceIdentity, evidence.sourceRecordId,
    evidence.sourceKind, evidence.revision, evidence.propositionFingerprint, evidence.contentHash,
    JSON.stringify(evidence.metadata), capturedAt);
  const updated = owner.db.prepare("SELECT retired_at FROM session_evidence WHERE evidence_key = ?").get(evidence.key);
  return { accepted: true, active: updated?.retired_at == null, revised: Boolean(current && (current.revision !== evidence.revision || current.content_hash !== evidence.contentHash)) };
}

export function listSemanticEvidence(owner, memoryId) {
  owner.ensureOpen();
  return owner.db.prepare(`
    SELECT se.evidence_key, se.session_id, se.repository, se.source_identity, se.source_record_id,
      se.source_kind, se.revision, se.proposition_fingerprint, se.content_hash,
      se.metadata_json, se.captured_at, se.retired_at, me.linked_at,
      me.retired_at AS link_retired_at
    FROM memory_evidence me
    JOIN session_evidence se ON se.evidence_key = me.evidence_key
    WHERE me.memory_id = ?
    ORDER BY se.captured_at ASC, se.evidence_key ASC
  `).all(memoryId).map((row) => ({
    key: row.evidence_key,
    sessionId: row.session_id,
    repository: row.repository ?? null,
    sourceIdentity: row.source_identity,
    sourceRecordId: row.source_record_id,
    sourceKind: row.source_kind,
    revision: row.revision,
    propositionFingerprint: row.proposition_fingerprint,
    contentHash: row.content_hash,
    metadata: parseJson(row.metadata_json),
    capturedAt: row.captured_at,
    retiredAt: row.retired_at,
    linkedAt: row.linked_at,
    linkRetiredAt: row.link_retired_at,
  }));
}

export function reconcileGeneratedMemories(owner, { sessionId, repository, memories = [], retiredEvidenceKeys = [] }) {
  owner.ensureOpen();
  if (!owner.pendingSemanticDurability) {
    return owner.withSemanticMemoryTransaction(() => reconcileGeneratedMemories(owner, { sessionId, repository, memories, retiredEvidenceKeys }));
  }
  const timestamp = new Date().toISOString();
  const linked = [];
  for (const memory of Array.isArray(memories) ? memories : []) {
    const evidence = normalizeEvidence({ sessionId, memory, repository });
    const evidenceState = upsertSessionEvidence(owner, evidence, timestamp);
    if (!evidenceState?.accepted || !evidenceState.active) {
      linked.push(null);
      continue;
    }
    const existingEvidence = owner.db.prepare(`
      SELECT sm.* FROM memory_evidence me
      JOIN semantic_memory sm ON sm.id = me.memory_id
      WHERE me.evidence_key = ? AND me.retired_at IS NULL AND sm.superseded_by IS NULL
      ORDER BY sm.updated_at DESC LIMIT 1
    `).get(evidence.key);
    const sameProposition = existingEvidence?.type === memory.type && existingEvidence?.content === memory.content;
    const explicitExisting = existingEvidence && isExplicitLifecycleWrite(existingEvidence, parseJson(existingEvidence.metadata_json) ?? {});
    let memoryId = sameProposition ? existingEvidence.id : null;
    if (existingEvidence && !sameProposition) {
      owner.db.prepare("UPDATE memory_evidence SET retired_at = ? WHERE evidence_key = ? AND retired_at IS NULL")
        .run(timestamp, evidence.key);
    }
    if (memoryId && !explicitExisting) {
      const metadata = owner.buildSemanticMemoryMetadata(parseJson(existingEvidence.metadata_json) ?? {},
        existingEvidence.domain_key, memory.metadata ?? {}, evidence);
      owner.db.prepare("UPDATE semantic_memory SET metadata_json = ? WHERE id = ?")
        .run(JSON.stringify(metadata), memoryId);
    }
    if (!memoryId) {
      memoryId = owner.insertSemanticMemory({
        ...memory,
        sourceSessionId: memory.sourceSessionId ?? sessionId,
        repository: memory.repository ?? repository,
        evidence: {
          ...memory.evidence,
          key: evidence.key,
          contentHash: evidence.contentHash,
          sourceRecordId: evidence.sourceRecordId,
          sourceKind: evidence.sourceKind,
          revision: evidence.revision,
        },
      }, { preserveProposition: evidenceState.revised || Boolean(existingEvidence && !sameProposition) });
    }
    if (!memoryId) {
      linked.push(null);
      continue;
    }
    owner.db.prepare(`
      INSERT INTO memory_evidence (memory_id, evidence_key, linked_at, retired_at)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(memory_id, evidence_key) DO UPDATE SET linked_at = excluded.linked_at,
        retired_at = NULL
    `).run(memoryId, evidence.key, timestamp);
    linked.push(memoryId);
  }
  for (const key of Array.isArray(retiredEvidenceKeys) ? retiredEvidenceKeys : []) {
    if (typeof key !== "string" || !key.trim()) continue;
    owner.db.prepare("UPDATE session_evidence SET retired_at = ? WHERE evidence_key = ?").run(timestamp, key);
    owner.db.prepare("UPDATE memory_evidence SET retired_at = ? WHERE evidence_key = ?").run(timestamp, key);
  }
  return linked;
}

export function getIngestionCheckpoint(owner, client, sessionId) {
  owner.ensureOpen();
  const row = owner.db.prepare(`
    SELECT client, session_id, repository, source_identity, offset, partial_record_json,
      adapter_state_json, branch_state_json, revision, checkpoint_revision, last_success_at,
      pending_bytes, failure_code, updated_at
    FROM ingestion_checkpoint WHERE client = ? AND session_id = ?
  `).get(String(client), String(sessionId));
  return mapCheckpointRow(row);
}

export function saveIngestionCheckpoint(owner, client, sessionId, state = {}) {
  owner.ensureOpen();
  if (!owner.pendingSemanticDurability && !owner._checkpointTransaction) {
    owner.db.exec("BEGIN IMMEDIATE TRANSACTION");
    owner._checkpointTransaction = true;
    try {
      const result = saveIngestionCheckpoint(owner, client, sessionId, state);
      owner.db.exec("COMMIT");
      return result;
    } catch (error) {
      owner.db.exec("ROLLBACK");
      throw error;
    } finally {
      owner._checkpointTransaction = false;
    }
  }
  const normalizedClient = String(client ?? "").trim();
  const normalizedSessionId = String(sessionId ?? "").trim();
  if (!normalizedClient || !normalizedSessionId) throw new Error("client and sessionId are required for an ingestion checkpoint");
  const health = state.health && typeof state.health === "object" ? state.health : {};
  const now = new Date().toISOString();
  const existing = owner.db.prepare("SELECT repository, source_identity, revision, checkpoint_revision FROM ingestion_checkpoint WHERE client = ? AND session_id = ?")
    .get(normalizedClient, normalizedSessionId);
  const revision = state.revision == null ? null : String(state.revision);
  const repository = typeof state.repository === "string"
    ? (state.repository.trim() || null)
    : existing?.repository ?? null;
  const sourceIdentity = typeof state.sourceIdentity === "string"
    ? (state.sourceIdentity.trim() || null)
    : existing?.source_identity ?? null;
  const expectedCheckpointRevision = state.expectedCheckpointRevision
    ?? (Object.hasOwn(state, "expectedRevision") && /^\d+$/.test(String(state.expectedRevision))
      ? Number(state.expectedRevision) : null);
  const expectedSourceRevision = expectedCheckpointRevision === null && Object.hasOwn(state, "expectedRevision")
    ? String(state.expectedRevision ?? "") : null;
  if ((!existing && expectedCheckpointRevision !== null && Number(expectedCheckpointRevision) !== 0)
    || (existing && expectedCheckpointRevision !== null
    && Number(expectedCheckpointRevision) !== Number(existing.checkpoint_revision ?? 0))) {
    const conflict = new Error("ingestion checkpoint revision conflict");
    conflict.code = "CHECKPOINT_REVISION_CONFLICT";
    conflict.currentRevision = Number(existing?.checkpoint_revision ?? 0);
    conflict.currentSourceRevision = existing?.revision ?? null;
    throw conflict;
  }
  if (existing && expectedSourceRevision !== null
    && expectedSourceRevision !== String(existing.revision ?? "")) {
    const conflict = new Error("ingestion checkpoint source revision conflict");
    conflict.code = "CHECKPOINT_REVISION_CONFLICT";
    conflict.currentRevision = Number(existing?.checkpoint_revision ?? 0);
    conflict.currentSourceRevision = existing?.revision ?? null;
    throw conflict;
  }
  owner.db.prepare(`
    INSERT INTO ingestion_checkpoint (
      client, session_id, repository, source_identity, offset, partial_record_json,
      adapter_state_json, branch_state_json, revision, checkpoint_revision, last_success_at,
      pending_bytes, failure_code, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client, session_id) DO UPDATE SET
      repository = excluded.repository, source_identity = excluded.source_identity, offset = excluded.offset,
      partial_record_json = excluded.partial_record_json, adapter_state_json = excluded.adapter_state_json,
      branch_state_json = excluded.branch_state_json, revision = excluded.revision,
      checkpoint_revision = ingestion_checkpoint.checkpoint_revision + 1,
      last_success_at = excluded.last_success_at, pending_bytes = excluded.pending_bytes,
      failure_code = excluded.failure_code, updated_at = excluded.updated_at
  `).run(normalizedClient, normalizedSessionId,
    repository,
    sourceIdentity,
    Number.isFinite(state.offset) ? Math.max(0, Math.trunc(state.offset)) : 0,
    state.partialRecord == null ? null : JSON.stringify(state.partialRecord),
    JSON.stringify(state.adapterState && typeof state.adapterState === "object" ? state.adapterState : {}),
    JSON.stringify(state.branchState && typeof state.branchState === "object" ? state.branchState : {}),
    revision,
    existing ? Number(existing.checkpoint_revision ?? 0) + 1 : 1,
    typeof health.lastSuccessAt === "string" ? health.lastSuccessAt : null,
    Number.isFinite(health.pendingBytes) ? Math.max(0, Math.trunc(health.pendingBytes)) : 0,
    typeof health.failureCode === "string" ? health.failureCode : null, now);
  return getIngestionCheckpoint(owner, normalizedClient, normalizedSessionId);
}

export function listCaptureHealth(owner, { repository = null } = {}) {
  owner.ensureOpen();
  const params = [];
  let sql = `SELECT client, session_id, repository, source_identity, offset, partial_record_json,
    adapter_state_json, branch_state_json, revision, checkpoint_revision, last_success_at,
    pending_bytes, failure_code, updated_at FROM ingestion_checkpoint`;
  if (repository !== null && repository !== undefined) { sql += " WHERE repository = ?"; params.push(String(repository)); }
  sql += " ORDER BY updated_at DESC, client ASC, session_id ASC";
  return owner.db.prepare(sql).all(...params).map(mapCheckpointRow);
}

export function getRepositoryMappings(owner) {
  owner.ensureOpen();
  return owner.db.prepare("SELECT legacy, canonical FROM repository_identity_mapping ORDER BY legacy ASC").all().map(mapRepositoryMappingRow);
}

export function setRepositoryMapping(owner, { legacy, canonical }) {
  owner.ensureOpen();
  const normalizedLegacy = String(legacy ?? "").trim();
  const normalizedCanonical = String(canonical ?? "").trim();
  if (!normalizedLegacy || !normalizedCanonical) throw new Error("legacy and canonical repository identities are required");
  const now = new Date().toISOString();
  owner.db.prepare(`
    INSERT INTO repository_identity_mapping (legacy, canonical, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(legacy) DO UPDATE SET canonical = excluded.canonical, updated_at = excluded.updated_at
  `).run(normalizedLegacy, normalizedCanonical, now, now);
  return { legacy: normalizedLegacy, canonical: normalizedCanonical };
}

export function forgetMemory(owner, { id, supersededBy, actor = "user", reason = "manual_forget" }) {
  owner.ensureOpen();
  if (!owner.pendingSemanticDurability) return owner.withSemanticMemoryTransaction(() => forgetMemory(owner, { id, supersededBy, actor, reason }));
  const existing = owner.db.prepare("SELECT id, type, content, canonical_key, scope, repository FROM semantic_memory WHERE id = ?").get(id);
  if (!existing) throw new Error(`semantic memory not found: ${id}`);
  const marker = supersededBy ?? `manual:${new Date().toISOString()}`;
  const timestamp = new Date().toISOString();
  owner.db.prepare("UPDATE semantic_memory SET superseded_by = ?, updated_at = ? WHERE id = ?").run(marker, timestamp, id);
  const evidenceRows = owner.db.prepare(`
    SELECT COALESCE(se.content_hash, se.proposition_fingerprint, se.evidence_key) AS fingerprint
    FROM memory_evidence me JOIN session_evidence se ON se.evidence_key = me.evidence_key
    WHERE me.memory_id = ? AND me.retired_at IS NULL AND se.retired_at IS NULL
  `).all(id);
  const fingerprints = [...new Set([
    buildContentEvidenceFingerprint(existing),
    ...evidenceRows.map((row) => safeEvidenceFingerprint(row.fingerprint)),
  ])];
  const canonicalFingerprint = existing.canonical_key ? buildSuppressionFingerprint({
    type: existing.type,
    canonicalKey: existing.canonical_key,
    scope: existing.scope,
    repository: existing.repository,
  }) : null;
  const insert = owner.db.prepare(`
    INSERT OR IGNORE INTO memory_suppression (
      suppression_key, memory_id, canonical_fingerprint, scope, repository,
      evidence_fingerprint, actor, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const fingerprint of fingerprints) insert.run(`memory:${id}:${fingerprint}`, id, canonicalFingerprint,
    existing.scope ?? "repo", existing.repository ?? null, fingerprint, String(actor), String(reason), timestamp);
  return { id, supersededBy: marker };
}
