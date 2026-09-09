import { parseJsonArray } from "../utils/json-array-utils.mjs";
import { jsonText } from "../utils/json-text-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { nowIso } from "./db-shared.mjs";

export const ACTIVITY_SUCCESS_VALUE_FIELDS = Object.freeze([
  ["lastContextInjectionAt", "last_context_injection_at"],
  ["lastContextInjectionHook", "last_context_injection_hook"],
  ["lastContextInjectionTraceId", "last_context_injection_trace_id"],
  ["lastExtractionCompletionAt", "last_extraction_completion_at"],
  ["lastMaintenanceCompletionAt", "last_maintenance_completion_at"],
  ["lastMaintenanceStatus", "last_maintenance_status"],
  ["lastMaintenanceRunId", "last_maintenance_run_id"],
  ["lastTraceRecordedAt", "last_trace_recorded_at"],
  ["lastTraceHook", "last_trace_hook"],
  ["lastTraceId", "last_trace_id"],
]);

export function mergeActivitySuccessValues(updates, existing) {
  return Object.fromEntries(
    ACTIVITY_SUCCESS_VALUE_FIELDS.map(([updateKey, existingKey]) => [
      updateKey,
      updates[updateKey] ?? existing?.[existingKey] ?? null,
    ]),
  );
}

export function mergeActivitySuccessSections(updates, existing) {
  return Array.isArray(updates.lastContextInjectionSections)
    ? updates.lastContextInjectionSections.slice(0, 8)
    : parseJsonArray(existing?.last_context_injection_sections_json);
}

export function mergeActivitySuccessDuration(updates, existing) {
  return Number.isFinite(updates.lastContextInjectionDurationMs)
    ? Math.round(updates.lastContextInjectionDurationMs)
    : (existing?.last_context_injection_duration_ms ?? null);
}

export function mergeActivitySuccessExtractionRepository(updates, existing, repo) {
  return normalizeRepository(updates.lastExtractionRepository)
    ?? existing?.last_extraction_repository
    ?? repo;
}

export function buildActivitySuccessState({ updates, existing, repo }) {
  return {
    ...mergeActivitySuccessValues(updates, existing),
    lastContextInjectionSections: mergeActivitySuccessSections(updates, existing),
    lastContextInjectionDurationMs: mergeActivitySuccessDuration(updates, existing),
    lastExtractionRepository: mergeActivitySuccessExtractionRepository(updates, existing, repo),
  };
}

export function queryActivityStateRow(db, scopeKey) {
  return db.prepare(`
    SELECT
      scope_key,
      scope_type,
      repository,
      last_context_injection_at,
      last_context_injection_hook,
      last_context_injection_sections_json,
      last_context_injection_trace_id,
      last_context_injection_duration_ms,
      last_extraction_completion_at,
      last_extraction_repository,
      last_maintenance_completion_at,
      last_maintenance_status,
      last_maintenance_run_id,
      last_trace_recorded_at,
      last_trace_hook,
      last_trace_id,
      updated_at
    FROM lore_activity_state
    WHERE scope_key = ?
  `).get(scopeKey);
}

export function mapActivityStateRow(row) {
  return {
    scopeKey: row.scope_key,
    scopeType: row.scope_type,
    repository: row.repository,
    lastContextInjectionAt: row.last_context_injection_at,
    lastContextInjectionHook: row.last_context_injection_hook,
    lastContextInjectionSections: parseJsonArray(row.last_context_injection_sections_json),
    lastContextInjectionTraceId: row.last_context_injection_trace_id,
    lastContextInjectionDurationMs: row.last_context_injection_duration_ms,
    lastExtractionCompletionAt: row.last_extraction_completion_at,
    lastExtractionRepository: row.last_extraction_repository,
    lastMaintenanceCompletionAt: row.last_maintenance_completion_at,
    lastMaintenanceStatus: row.last_maintenance_status,
    lastMaintenanceRunId: row.last_maintenance_run_id,
    lastTraceRecordedAt: row.last_trace_recorded_at,
    lastTraceHook: row.last_trace_hook,
    lastTraceId: row.last_trace_id,
    updatedAt: row.updated_at,
  };
}

export function upsertActivitySuccess(owner, {
  repository = null,
  updates = {},
} = {}) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const scopeKey = repo ? `repo:${repo}` : "global";
  const scopeType = repo ? "repo" : "global";
  const timestamp = nowIso();
  const normalizedUpdates = updates && typeof updates === "object" ? updates : {};

  const existing = owner.db.prepare(`
    SELECT *
    FROM lore_activity_state
    WHERE scope_key = ?
    LIMIT 1
  `).get(scopeKey);

  const next = buildActivitySuccessState({
    updates: normalizedUpdates,
    existing,
    repo,
  });

  owner.db.prepare(`
    INSERT INTO lore_activity_state (
      scope_key,
      scope_type,
      repository,
      last_context_injection_at,
      last_context_injection_hook,
      last_context_injection_sections_json,
      last_context_injection_trace_id,
      last_context_injection_duration_ms,
      last_extraction_completion_at,
      last_extraction_repository,
      last_maintenance_completion_at,
      last_maintenance_status,
      last_maintenance_run_id,
      last_trace_recorded_at,
      last_trace_hook,
      last_trace_id,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      scope_type = excluded.scope_type,
      repository = excluded.repository,
      last_context_injection_at = excluded.last_context_injection_at,
      last_context_injection_hook = excluded.last_context_injection_hook,
      last_context_injection_sections_json = excluded.last_context_injection_sections_json,
      last_context_injection_trace_id = excluded.last_context_injection_trace_id,
      last_context_injection_duration_ms = excluded.last_context_injection_duration_ms,
      last_extraction_completion_at = excluded.last_extraction_completion_at,
      last_extraction_repository = excluded.last_extraction_repository,
      last_maintenance_completion_at = excluded.last_maintenance_completion_at,
      last_maintenance_status = excluded.last_maintenance_status,
      last_maintenance_run_id = excluded.last_maintenance_run_id,
      last_trace_recorded_at = excluded.last_trace_recorded_at,
      last_trace_hook = excluded.last_trace_hook,
      last_trace_id = excluded.last_trace_id,
      updated_at = excluded.updated_at
  `).run(
    scopeKey,
    scopeType,
    repo,
    next.lastContextInjectionAt,
    next.lastContextInjectionHook,
    jsonText(next.lastContextInjectionSections),
    next.lastContextInjectionTraceId,
    next.lastContextInjectionDurationMs,
    next.lastExtractionCompletionAt,
    next.lastExtractionRepository,
    next.lastMaintenanceCompletionAt,
    next.lastMaintenanceStatus,
    next.lastMaintenanceRunId,
    next.lastTraceRecordedAt,
    next.lastTraceHook,
    next.lastTraceId,
    timestamp,
  );

  return owner.getActivityState({ repository: repo, includeGlobal: false });
}

export function collectDirectActivityRows(owner, repo, includeGlobal) {
  const rows = [];
  if (repo) {
    const row = queryActivityStateRow(owner.db, `repo:${repo}`);
    if (row) rows.push(row);
  }
  if (includeGlobal) {
    const row = queryActivityStateRow(owner.db, "global");
    if (row) rows.push(row);
  }
  return rows;
}

export function collectFallbackActivityRows(owner, repo, includeGlobal) {
  const rows = [];
  if (repo) {
    const fallback = owner.deriveActivityStateFallback({ repository: repo, scopeKey: `repo:${repo}`, scopeType: "repo" });
    if (fallback) rows.push(fallback);
  }
  if (includeGlobal) {
    const fallback = owner.deriveActivityStateFallback({ repository: null, scopeKey: "global", scopeType: "global" });
    if (fallback) rows.push(fallback);
  }
  return rows;
}

export function getActivityState(owner, { repository = null, includeGlobal = true } = {}) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const direct = owner.collectDirectActivityRows(repo, includeGlobal);
  const rows = direct.length > 0 ? direct : owner.collectFallbackActivityRows(repo, includeGlobal);
  return rows.map(mapActivityStateRow);
}

export function deriveActivityStateFallback(owner, {
  repository = null,
  scopeKey,
  scopeType,
} = {}) {
  owner.ensureOpen();
  const fallbackScope = owner.buildActivityFallbackScope(repository);
  const fallbackRows = owner.readActivityFallbackRows(fallbackScope);
  const timestamps = owner.collectActivityFallbackTimestamps(fallbackRows);
  return timestamps.length > 0
    ? owner.serializeActivityStateFallback({
        scopeKey,
        scopeType,
        repository: fallbackScope.repo,
        timestamps,
        ...fallbackRows,
      })
    : null;
}

export function buildActivityFallbackScope(owner, repository = null) {
  const repo = normalizeRepository(repository);
  return {
    repo,
    scopedWhere: repo ? "WHERE repository = ?" : "",
    scopedParams: repo ? [repo] : [],
  };
}

export function readActivityFallbackRows(owner, { repo, scopedWhere, scopedParams }) {
  return {
    latestContextRow: owner.readLatestContextFallbackRow(repo, scopedParams),
    latestTraceRow: owner.readLatestTraceFallbackRow(scopedWhere, scopedParams),
    latestMaintenanceRow: owner.readLatestMaintenanceFallbackRow(repo, scopedParams),
    latestExtractionRow: owner.readLatestExtractionFallbackRow(scopedWhere, scopedParams),
  };
}

export function serializeActivityStateFallback(owner, {
  scopeKey,
  scopeType,
  repository,
  latestContextRow,
  latestTraceRow,
  latestMaintenanceRow,
  latestExtractionRow,
  timestamps,
}) {
  return owner.buildActivityStateFallbackRow({
    scope_key: scopeKey,
    scope_type: scopeType,
    repository,
    ...owner.serializeActivityFallbackContext(latestContextRow),
    ...owner.serializeActivityFallbackExtraction(latestExtractionRow, repository),
    ...owner.serializeActivityFallbackMaintenance(latestMaintenanceRow),
    ...owner.serializeActivityFallbackTrace(latestTraceRow),
    updated_at: owner.resolveActivityFallbackUpdatedAt({
      latestContextRow,
      latestTraceRow,
      latestMaintenanceRow,
      latestExtractionRow,
      timestamps,
    }),
  });
}

export function serializeActivityFallbackContext(owner, latestContextRow) {
  const row = latestContextRow ?? {};
  return {
    last_context_injection_at: row.recorded_at ?? null,
    last_context_injection_hook: row.hook ?? null,
    last_context_injection_sections_json: JSON.stringify(parseJsonArray(row.section_titles_json)),
    last_context_injection_trace_id: row.id ?? null,
    last_context_injection_duration_ms: row.latency_ms ?? null,
  };
}

export function serializeActivityFallbackExtraction(owner, latestExtractionRow, repository) {
  return {
    last_extraction_completion_at: latestExtractionRow?.updated_at ?? null,
    last_extraction_repository: normalizeRepository(latestExtractionRow?.repository) ?? repository,
  };
}

export function serializeActivityFallbackMaintenance(owner, latestMaintenanceRow) {
  return {
    last_maintenance_completion_at: latestMaintenanceRow?.completed_at ?? null,
    last_maintenance_status: latestMaintenanceRow?.status ?? null,
    last_maintenance_run_id: latestMaintenanceRow?.id ?? null,
  };
}

export function serializeActivityFallbackTrace(owner, latestTraceRow) {
  return {
    last_trace_recorded_at: latestTraceRow?.recorded_at ?? null,
    last_trace_hook: latestTraceRow?.hook ?? null,
    last_trace_id: latestTraceRow?.id ?? null,
  };
}

export function resolveActivityFallbackUpdatedAt(owner, {
  latestContextRow,
  latestTraceRow,
  latestMaintenanceRow,
  latestExtractionRow,
  timestamps,
}) {
  const effectiveTimestamps = Array.isArray(timestamps)
    ? timestamps
    : owner.collectActivityFallbackTimestamps({
        latestContextRow,
        latestTraceRow,
        latestMaintenanceRow,
        latestExtractionRow,
      });
  return [...effectiveTimestamps].sort().at(-1) ?? nowIso();
}

export function readLatestContextFallbackRow(owner, repo, scopedParams) {
  return owner.db.prepare(`
    SELECT
      id,
      repository,
      hook,
      latency_ms,
      section_titles_json,
      recorded_at
    FROM retrieval_trace_sample
    WHERE context_injected = 1
      ${repo ? "AND repository = ?" : ""}
    ORDER BY recorded_at DESC
    LIMIT 1
  `).get(...scopedParams);
}

export function readLatestTraceFallbackRow(owner, scopedWhere, scopedParams) {
  return owner.db.prepare(`
    SELECT
      id,
      repository,
      hook,
      recorded_at
    FROM retrieval_trace_sample
    ${scopedWhere}
    ORDER BY recorded_at DESC
    LIMIT 1
  `).get(...scopedParams);
}

export function readLatestMaintenanceFallbackRow(owner, repo, scopedParams) {
  return owner.db.prepare(`
    SELECT
      id,
      repository,
      status,
      completed_at
    FROM maintenance_run
    WHERE completed_at IS NOT NULL
      ${repo ? "AND repository = ?" : ""}
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(...scopedParams);
}

export function readLatestExtractionFallbackRow(owner, scopedWhere, scopedParams) {
  return owner.db.prepare(`
    SELECT repository, updated_at
    FROM (
      SELECT repository, updated_at
      FROM semantic_memory
      ${scopedWhere}
      UNION ALL
      SELECT repository, updated_at
      FROM episode_digest
      ${scopedWhere}
    )
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(...scopedParams, ...scopedParams);
}

export function collectActivityFallbackTimestamps(owner, {
  latestContextRow,
  latestTraceRow,
  latestMaintenanceRow,
  latestExtractionRow,
}) {
  return [
    latestContextRow?.recorded_at,
    latestTraceRow?.recorded_at,
    latestMaintenanceRow?.completed_at,
    latestExtractionRow?.updated_at,
  ].filter((value) => typeof value === "string" && value.length > 0);
}

export function buildActivityStateFallbackRow(owner, row) {
  return row;
}
