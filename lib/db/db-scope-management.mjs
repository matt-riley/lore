import crypto from "node:crypto";
import { classifyEpisodeDigest, classifySemanticMemory, MEMORY_SCOPE, normalizeScope } from "../memory/memory-scope.mjs";
import { parseJsonArray } from "../utils/json-array-utils.mjs";
import { parseJsonObject } from "../utils/json-object-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { addStringFilter } from "../utils/sql-filter-utils.mjs";
import { nowIso, SCOPE_SOURCE, normalizeScopeSource } from "./db-shared.mjs";

export function effectiveRepositoryForScope(scope, rowRepository, metadata = {}, fallbackRepository = null) {
  if (scope === MEMORY_SCOPE.GLOBAL) {
    return null;
  }
  return normalizeRepository(rowRepository)
    ?? normalizeRepository(metadata?.originRepository)
    ?? normalizeRepository(fallbackRepository);
}

export function classifySemanticRow(row, { fallbackRepository = null, ignoreManualOverride = false } = {}) {
  const metadata = parseJsonObject(row.metadata_json);
  const scopeSource = normalizeScopeSource(row.scope_source);
  if (!ignoreManualOverride && scopeSource === SCOPE_SOURCE.MANUAL) {
    const scope = normalizeScope(row.scope, MEMORY_SCOPE.REPO);
    return {
      scope,
      repository: effectiveRepositoryForScope(scope, row.repository, metadata, fallbackRepository),
      metadata,
      scopeSource,
    };
  }
  const classification = classifySemanticMemory({
    type: row.type,
    content: row.content,
    scope: null,
    repository: row.repository ?? fallbackRepository ?? metadata.originRepository ?? null,
    tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
    metadata,
  });
  return {
    ...classification,
    scopeSource: SCOPE_SOURCE.AUTO,
  };
}

export function classifyEpisodeRow(row, { fallbackRepository = null, ignoreManualOverride = false } = {}) {
  const scopeSource = normalizeScopeSource(row.scope_source);
  if (!ignoreManualOverride && scopeSource === SCOPE_SOURCE.MANUAL) {
    const scope = normalizeScope(row.scope, MEMORY_SCOPE.REPO);
    return {
      scope,
      repository: effectiveRepositoryForScope(scope, row.repository, {}, fallbackRepository),
      scopeSource,
    };
  }
  const classification = classifyEpisodeDigest({
    scope: null,
    repository: row.repository ?? fallbackRepository ?? null,
    summary: row.summary,
    actions: parseJsonArray(row.actions_json),
    decisions: parseJsonArray(row.decisions_json),
    learnings: parseJsonArray(row.learnings_json),
    refs: parseJsonArray(row.refs_json),
    themes: parseJsonArray(row.themes_json),
    openItems: parseJsonArray(row.open_items_json),
  });
  return {
    ...classification,
    scopeSource: SCOPE_SOURCE.AUTO,
  };
}

export function getSemanticMemoryByIds(owner, ids) {
  owner.ensureOpen();
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(", ");
  return owner.db.prepare(`
    SELECT
      id, type, content, confidence, source_session_id, source_turn_index,
      scope, scope_source, scope_override_actor, scope_override_reason, scope_override_source, scope_override_at,
      repository, tags, created_at, updated_at, superseded_by, canonical_key, reinforcement_count,
      last_seen_at, expires_at, metadata_json
    FROM semantic_memory
    WHERE id IN (${placeholders})
    ORDER BY updated_at DESC
  `).all(...ids);
}

export function getEpisodeDigestsByIds(owner, ids) {
  owner.ensureOpen();
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(", ");
  return owner.db.prepare(`
    SELECT
      id, session_id, scope, scope_source, scope_override_actor, scope_override_reason, scope_override_source, scope_override_at,
      repository, branch, summary, actions_json, decisions_json, learnings_json, files_changed_json,
      refs_json, significance, themes_json, open_items_json, source, date_key, created_at, updated_at
    FROM episode_digest
    WHERE id IN (${placeholders})
    ORDER BY updated_at DESC
  `).all(...ids);
}

export function previewScopeChanges(owner, {
  targetType,
  ids,
  action = "set",
  scope,
  repository,
}) {
  owner.ensureOpen();
  const targetIds = Array.isArray(ids) ? [...new Set(ids.filter((value) => typeof value === "string" && value.trim().length > 0))] : [];
  if (targetIds.length === 0) {
    throw new Error("ids must include at least one target id");
  }
  const normalizedAction = action === "clear" ? "clear" : "set";
  const nextScope = normalizedAction === "set" ? normalizeScope(scope, null) : null;
  if (normalizedAction === "set" && !nextScope) {
    throw new Error("scope must be one of: global, transferable, repo");
  }
  const fallbackRepository = normalizeRepository(repository);
  const rows = targetType === "episode"
    ? owner.getEpisodeDigestsByIds(targetIds)
    : owner.getSemanticMemoryByIds(targetIds);

  const foundIds = new Set(rows.map((row) => row.id));
  const missingIds = targetIds.filter((id) => !foundIds.has(id));
  const previews = rows.map((row) => {
    const currentMetadata = targetType === "semantic" ? parseJsonObject(row.metadata_json) : {};
    const current = {
      scope: row.scope,
      repository: row.repository,
      scopeSource: normalizeScopeSource(row.scope_source),
    };
    const next = normalizedAction === "clear"
      ? (targetType === "episode"
          ? classifyEpisodeRow(row, { fallbackRepository, ignoreManualOverride: true })
          : classifySemanticRow(row, { fallbackRepository, ignoreManualOverride: true }))
      : {
          scope: nextScope,
          repository: effectiveRepositoryForScope(nextScope, row.repository, currentMetadata, fallbackRepository),
          scopeSource: SCOPE_SOURCE.MANUAL,
        };
    return {
      id: row.id,
      targetType,
      current,
      next,
      changed: current.scope !== next.scope
        || (current.repository ?? null) !== (next.repository ?? null)
        || current.scopeSource !== next.scopeSource,
    };
  });

  return {
    action: normalizedAction,
    targetType,
    requestedCount: targetIds.length,
    matchedCount: previews.length,
    missingIds,
    rows: previews,
  };
}

export function insertScopeOverrideAudit(owner, {
  targetType,
  targetId,
  action,
  previousScope,
  nextScope,
  previousRepository,
  nextRepository,
  actor,
  reason,
  source,
}) {
  owner.db.prepare(`
    INSERT INTO scope_override_audit (
      id, target_type, target_id, action, previous_scope, next_scope,
      previous_repository, next_repository, actor, reason, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    targetType,
    targetId,
    action,
    previousScope ?? null,
    nextScope ?? null,
    normalizeRepository(previousRepository),
    normalizeRepository(nextRepository),
    actor,
    reason,
    source,
    nowIso(),
  );
}

export function applyScopeChanges(owner, {
  targetType,
  ids,
  action = "set",
  scope,
  repository,
  actor,
  reason,
  source,
}) {
  owner.ensureOpen();
  const preview = owner.previewScopeChanges({
    targetType,
    ids,
    action,
    scope,
    repository,
  });
  const timestamp = nowIso();
  const normalizedAction = preview.action;
  const updateSemantic = owner.db.prepare(`
    UPDATE semantic_memory
    SET scope = ?,
        repository = ?,
        scope_source = ?,
        scope_override_actor = ?,
        scope_override_reason = ?,
        scope_override_source = ?,
        scope_override_at = ?,
        updated_at = ?
    WHERE id = ?
  `);
  const updateEpisode = owner.db.prepare(`
    UPDATE episode_digest
    SET scope = ?,
        repository = ?,
        scope_source = ?,
        scope_override_actor = ?,
        scope_override_reason = ?,
        scope_override_source = ?,
        scope_override_at = ?,
        updated_at = ?
    WHERE id = ?
  `);

  for (const row of preview.rows) {
    const nextScopeSource = normalizedAction === "clear" ? SCOPE_SOURCE.AUTO : SCOPE_SOURCE.MANUAL;
    const overrideActor = normalizedAction === "clear" ? null : actor;
    const overrideReason = normalizedAction === "clear" ? null : reason;
    const overrideSource = normalizedAction === "clear" ? null : source;
    const overrideAt = normalizedAction === "clear" ? null : timestamp;
    if (targetType === "episode") {
      updateEpisode.run(
        row.next.scope,
        row.next.repository,
        nextScopeSource,
        overrideActor,
        overrideReason,
        overrideSource,
        overrideAt,
        timestamp,
        row.id,
      );
    } else {
      updateSemantic.run(
        row.next.scope,
        row.next.repository,
        nextScopeSource,
        overrideActor,
        overrideReason,
        overrideSource,
        overrideAt,
        timestamp,
        row.id,
      );
    }
    owner.insertScopeOverrideAudit({
      targetType,
      targetId: row.id,
      action: normalizedAction,
      previousScope: row.current.scope,
      nextScope: row.next.scope,
      previousRepository: row.current.repository,
      nextRepository: row.next.repository,
      actor,
      reason,
      source,
    });
  }

  return preview;
}

export function listScopeOverrideAudit(owner, { targetType, targetId, limit = 10 }) {
  owner.ensureOpen();
  const params = [];
  const where = [];
  addStringFilter(where, params, "target_type", targetType);
  addStringFilter(where, params, "target_id", targetId);
  params.push(limit);
  return owner.db.prepare(`
    SELECT
      id, target_type, target_id, action, previous_scope, next_scope,
      previous_repository, next_repository, actor, reason, source, created_at
    FROM scope_override_audit
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params);
}
