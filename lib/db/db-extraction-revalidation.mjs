import { parseJsonObject } from "../utils/json-object-utils.mjs";
import { clampInteger } from "../utils/numeric-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { ensureScopeOverrideAuditMetadataColumn } from "./db-scope-management.mjs";
import { nowIso } from "./db-shared.mjs";

const CANDIDATE_TYPES = Object.freeze(["user_preference", "rejected_approach", "directive", "recurring_mistake"]);

/**
 * Bounded window of active, rule-extracted directive/preference/rejection/
 * recurring-mistake rows whose stored extractorVersion is missing or older
 * than the current one -- exactly the rows extraction-revalidation.mjs's pure
 * classifier should replay the grammar against.
 *
 * A row counts as rule-extracted when either:
 *   - metadata.source is exactly 'rule_extractor' (rows written after this
 *     feature landed, once the rule extractor started stamping its source), or
 *   - metadata.source is absent entirely AND the row carries a
 *     source_turn_index and source_session_id AND scope_source is 'auto'.
 *     This second branch exists because every real pre-existing rule-extracted
 *     row (written before source-stamping landed) has metadata_json of `{}`
 *     or `{"originRepository": "..."}` -- no `source` key at all -- but is
 *     still tied to the originating turn/session and was never manually
 *     scoped. A strict `= 'rule_extractor'` match alone would silently skip
 *     every one of these legacy rows forever.
 *
 * Manual/explicit writes never match either branch: their metadata.source is
 * a non-null value other than 'rule_extractor' (memory_save, lore_retain,
 * onboarding, pi, pi:command), or scope_source = 'manual', or (being written
 * directly rather than from a captured turn) they carry no source_turn_index
 * -- mirroring isExplicitLifecycleWrite (db-memory-lifecycle.mjs).
 */
export function listExtractionRevalidationCandidates(owner, {
  repository = null,
  includeGlobal = true,
  limit = 100,
  extractorVersion,
} = {}) {
  owner.ensureOpen();
  if (typeof extractorVersion !== "string" || !extractorVersion) {
    throw new Error("extractorVersion is required");
  }
  const repo = normalizeRepository(repository);
  const typePlaceholders = CANDIDATE_TYPES.map(() => "?").join(", ");
  const params = [...CANDIDATE_TYPES, extractorVersion];
  let scopeSql = "1 = 1";
  if (repo) {
    scopeSql = includeGlobal
      ? "(scope = 'global' OR repository = ?)"
      : "(scope != 'global' AND repository = ?)";
    params.push(repo);
  } else if (!includeGlobal) {
    scopeSql = "scope != 'global'";
  }
  params.push(clampInteger(limit, 100, { min: 1, max: 500 }));
  const rows = owner.db.prepare(`
    SELECT id, type, content, scope, scope_source, repository, tags, confidence, metadata_json, updated_at
    FROM semantic_memory
    WHERE superseded_by IS NULL
      AND type IN (${typePlaceholders})
      AND COALESCE(scope_source, 'auto') != 'manual'
      AND (
        json_extract(metadata_json, '$.source') = 'rule_extractor'
        OR (
          json_extract(metadata_json, '$.source') IS NULL
          AND source_turn_index IS NOT NULL
          AND source_session_id IS NOT NULL
          AND COALESCE(scope_source, 'auto') = 'auto'
        )
      )
      AND (
        json_extract(metadata_json, '$.extractorVersion') IS NULL
        OR json_extract(metadata_json, '$.extractorVersion') < ?
      )
      AND ${scopeSql}
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(...params);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    content: row.content,
    scope: row.scope,
    scopeSource: row.scope_source,
    repository: row.repository,
    tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
    confidence: row.confidence,
    metadata: parseJsonObject(row.metadata_json),
    updatedAt: row.updated_at,
  }));
}

/**
 * Supersede a generated row with a reversible extractor-revalidation marker.
 * Unlike forgetMemory (db-memory-lifecycle.mjs), this never writes a
 * memory_suppression row: a rejected revalidation is "the current grammar
 * would not produce this row", not "the user wants this content suppressed",
 * so the two must stay independent, and this is restorable via
 * restoreMemoriesBySupersessionMarker.
 */
export function supersedeExtractionRevalidationMemory(owner, { id, marker }) {
  owner.ensureOpen();
  const timestamp = nowIso();
  const result = owner.db.prepare(`
    UPDATE semantic_memory SET superseded_by = ?, updated_at = ?
    WHERE id = ? AND superseded_by IS NULL
  `).run(marker, timestamp, id);
  return result.changes > 0;
}

/**
 * Reclassify a row's type in place (the grammar now recognizes the content
 * as a different standing type than the one it was stored as). There is no
 * dedicated "type override" audit table, so this reuses
 * scope_override_audit's previous/next-scope columns to record the previous
 * and next *type* under a distinct action name -- the closest existing
 * reversible audit path (db-scope-management.mjs), short of a schema change.
 */
export function reclassifyExtractionRevalidationMemory(owner, {
  id,
  previousType,
  nextType,
  extractorVersion,
  marker,
  actor,
  reason,
}) {
  owner.ensureOpen();
  if (typeof extractorVersion !== "string" || !extractorVersion) {
    throw new Error("extractorVersion is required");
  }
  ensureScopeOverrideAuditMetadataColumn(owner);
  const previousRow = owner.db.prepare(`
    SELECT type, metadata_json
    FROM semantic_memory
    WHERE id = ? AND superseded_by IS NULL
  `).get(id);
  if (!previousRow || previousRow.type !== previousType) {
    return false;
  }
  const timestamp = nowIso();
  const result = owner.db.prepare(`
    UPDATE semantic_memory
    SET type = ?,
        metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.extractorVersion', ?),
        updated_at = ?
    WHERE id = ? AND type = ? AND superseded_by IS NULL AND metadata_json IS ?
  `).run(nextType, extractorVersion, timestamp, id, previousType, previousRow.metadata_json);
  if (result.changes === 0) {
    return false;
  }
  owner.insertScopeOverrideAudit({
    targetType: "semantic",
    targetId: id,
    action: "extractor_revalidation_reclassify",
    previousScope: previousType,
    nextScope: nextType,
    previousRepository: null,
    nextRepository: null,
    previousMetadataJson: previousRow.metadata_json,
    actor,
    reason,
    source: marker,
  });
  return true;
}

/**
 * Demote a global row's scope through the existing scope-change audit path
 * (applyScopeChanges / insertScopeOverrideAudit) rather than a bespoke
 * write, so scope history for this row reads the same way a manual
 * memory_scope_override would.
 */
export function demoteExtractionRevalidationMemory(owner, {
  id,
  targetRepository,
  marker,
  actor,
  reason,
}) {
  owner.ensureOpen();
  return owner.applyScopeChanges({
    targetType: "semantic",
    ids: [id],
    action: "set",
    scope: "repo",
    repository: targetRepository,
    actor,
    reason,
    source: marker,
  });
}

function normalizedMarker(marker) {
  const value = String(marker ?? "").trim();
  if (!value.startsWith("extractor-revalidation:")) {
    throw new Error("marker must start with extractor-revalidation:");
  }
  return value;
}

/**
 * Reverse everything one extractor-revalidation run applied: rejected rows
 * (restoreMemoriesBySupersessionMarker) plus every scope/type change this
 * run recorded in scope_override_audit, restored to its pre-run value and
 * logged as its own audit row so the rollback itself stays traceable.
 */
export function rollbackExtractionRevalidation(owner, { marker, actor, reason } = {}) {
  owner.ensureOpen();
  const normalized = normalizedMarker(marker);
  ensureScopeOverrideAuditMetadataColumn(owner);
  const restoredRejectedIds = owner.restoreMemoriesBySupersessionMarker(normalized);
  const auditRows = owner.db.prepare(`
    SELECT id, target_id, action, previous_scope, next_scope, previous_repository, next_repository,
      previous_metadata_json
    FROM scope_override_audit
    WHERE source = ?
    ORDER BY created_at ASC
  `).all(normalized);
  const timestamp = nowIso();
  const restoredOverrideIds = [];
  for (const row of auditRows) {
    if (row.action === "extractor_revalidation_reclassify") {
      const previousMetadata = row.previous_metadata_json === null
        ? null
        : parseJsonObject(row.previous_metadata_json);
      const hasPreviousExtractorVersion = previousMetadata !== null
        && Object.hasOwn(previousMetadata, "extractorVersion");
      const previousExtractorVersionJson = hasPreviousExtractorVersion
        ? JSON.stringify(previousMetadata.extractorVersion)
        : "null";
      const result = owner.db.prepare(`
        UPDATE semantic_memory
        SET type = ?,
            metadata_json = CASE
              WHEN ? = 1 THEN json_set(
                COALESCE(metadata_json, '{}'), '$.extractorVersion', json(?)
              )
              ELSE json_remove(COALESCE(metadata_json, '{}'), '$.extractorVersion')
            END,
            updated_at = ?
        WHERE id = ? AND type = ? AND superseded_by IS NULL
      `).run(
        row.previous_scope,
        hasPreviousExtractorVersion ? 1 : 0,
        previousExtractorVersionJson,
        timestamp,
        row.target_id,
        row.next_scope,
      );
      if (result.changes === 0) continue;
      owner.insertScopeOverrideAudit({
        targetType: "semantic",
        targetId: row.target_id,
        action: "extractor_revalidation_rollback",
        previousScope: row.next_scope,
        nextScope: row.previous_scope,
        previousRepository: null,
        nextRepository: null,
        actor,
        reason,
        source: normalized,
      });
      restoredOverrideIds.push(row.target_id);
    } else if (row.action === "set") {
      const result = owner.db.prepare(`
        UPDATE semantic_memory
        SET scope = ?, repository = ?, scope_source = 'auto',
          scope_override_actor = NULL, scope_override_reason = NULL,
          scope_override_source = NULL, scope_override_at = NULL, updated_at = ?
        WHERE id = ? AND scope = ? AND repository IS ?
          AND scope_override_source = ? AND superseded_by IS NULL
      `).run(
        row.previous_scope,
        row.previous_repository,
        timestamp,
        row.target_id,
        row.next_scope,
        row.next_repository,
        normalized,
      );
      if (result.changes === 0) continue;
      owner.insertScopeOverrideAudit({
        targetType: "semantic",
        targetId: row.target_id,
        action: "extractor_revalidation_rollback",
        previousScope: row.next_scope,
        nextScope: row.previous_scope,
        previousRepository: null,
        nextRepository: row.previous_repository,
        actor,
        reason,
        source: normalized,
      });
      restoredOverrideIds.push(row.target_id);
    }
  }
  return {
    marker: normalized,
    restoredRejectedIds,
    restoredOverrideIds,
  };
}
