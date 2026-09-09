import crypto from "node:crypto";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { buildBackfillRunSummaryUpdateImpl } from "./db-improvement-artifacts.mjs";
import { nowIso } from "./db-shared.mjs";

export function countGeneratedSemanticMemoriesBySession(owner, sessionId) {
  owner.ensureOpen();
  return owner.db.prepare(`
    SELECT COUNT(*) AS count
    FROM semantic_memory
    WHERE source_session_id = ?
      AND superseded_by IS NULL
      AND COALESCE(json_extract(metadata_json, '$.source'), '') NOT IN ('memory_save', 'lore_retain', 'onboarding', 'pi', 'pi:command')
  `).get(sessionId).count;
}

export function getEpisodeDigestBySession(owner, sessionId) {
  owner.ensureOpen();
  return owner.db.prepare(`
    SELECT id, session_id, scope, scope_source, repository, updated_at
    FROM episode_digest
    WHERE session_id = ?
  `).get(sessionId);
}

export function createBackfillRun(owner, {
  strategy = "session_refresh",
  dryRun = false,
  repository = null,
  includeOtherRepositories = false,
  refreshExisting = true,
  batchSize = 10,
  totalCandidates = 0,
  snapshotPath = null,
  metadata = {},
}) {
  owner.ensureOpen();
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  owner.db.prepare(`
    INSERT INTO backfill_run (
      id, strategy, status, dry_run, repository, include_other_repositories, refresh_existing,
      batch_size, total_candidates, snapshot_path, metadata_json, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    strategy,
    dryRun ? "preview" : "running",
    dryRun ? 1 : 0,
    normalizeRepository(repository),
    includeOtherRepositories ? 1 : 0,
    refreshExisting ? 1 : 0,
    batchSize,
    totalCandidates,
    snapshotPath,
    JSON.stringify(metadata),
    timestamp,
    timestamp,
  );
  return id;
}

export function insertBackfillRunItems(owner, runId, items) {
  owner.ensureOpen();
  const insert = owner.db.prepare(`
    INSERT INTO backfill_run_item (
      run_id, session_id, repository, ordinal, planned_action, status
    ) VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  for (const item of items) {
    insert.run(
      runId,
      item.sessionId,
      normalizeRepository(item.repository),
      item.ordinal,
      item.plannedAction,
    );
  }
}

export function getBackfillRun(owner, runId) {
  owner.ensureOpen();
  return owner.db.prepare(`
    SELECT
      id, strategy, status, dry_run, repository, include_other_repositories,
      refresh_existing, batch_size, total_candidates, processed_count,
      created_episode_count, refreshed_episode_count, skipped_count,
      failed_count, snapshot_path, metadata_json, started_at, updated_at,
      completed_at, last_error
    FROM backfill_run
    WHERE id = ?
  `).get(runId);
}

export function listBackfillRunItems(owner, { runId, statuses = [], limit = 10 }) {
  owner.ensureOpen();
  const params = [runId];
  let sql = `
    SELECT
      run_id, session_id, repository, ordinal, planned_action, status,
      semantic_before_count, semantic_after_count, semantic_delta,
      episode_before_scope, episode_after_scope, processed_at, error
    FROM backfill_run_item
    WHERE run_id = ?
  `;
  if (Array.isArray(statuses) && statuses.length > 0) {
    sql += ` AND status IN (${statuses.map(() => "?").join(", ")}) `;
    params.push(...statuses);
  }
  sql += ` ORDER BY ordinal ASC LIMIT ? `;
  params.push(limit);
  return owner.db.prepare(sql).all(...params);
}

export function updateBackfillRunItem(owner, {
  runId,
  sessionId,
  status,
  semanticBeforeCount = null,
  semanticAfterCount = null,
  semanticDelta = null,
  episodeBeforeScope = null,
  episodeAfterScope = null,
  error = null,
}) {
  owner.ensureOpen();
  owner.db.prepare(`
    UPDATE backfill_run_item
    SET status = ?,
        semantic_before_count = ?,
        semantic_after_count = ?,
        semantic_delta = ?,
        episode_before_scope = ?,
        episode_after_scope = ?,
        processed_at = ?,
        error = ?
    WHERE run_id = ? AND session_id = ?
  `).run(
    status,
    semanticBeforeCount,
    semanticAfterCount,
    semanticDelta,
    episodeBeforeScope,
    episodeAfterScope,
    nowIso(),
    error,
    runId,
    sessionId,
  );
}

export function getBackfillRunCounts(owner, runId) {
  return owner.db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('completed', 'skipped', 'failed') THEN 1 ELSE 0 END) AS processed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN planned_action = 'create' AND status = 'completed' THEN 1 ELSE 0 END) AS created_episode_count,
      SUM(CASE WHEN planned_action = 'refresh' AND status = 'completed' THEN 1 ELSE 0 END) AS refreshed_episode_count,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
    FROM backfill_run_item
    WHERE run_id = ?
  `).get(runId);
}

export function deriveBackfillRunStatus(owner, counts) {
  if ((counts?.pending_count ?? 0) > 0) {
    return "running";
  }
  if ((counts?.failed_count ?? 0) > 0) {
    return "failed";
  }
  return "completed";
}

export function deriveBackfillRunLastError(owner, runId, lastError) {
  if (typeof lastError === "string" && lastError.length > 0) {
    return lastError;
  }
  return owner.db.prepare(`
    SELECT error
    FROM backfill_run_item
    WHERE run_id = ?
      AND status = 'failed'
      AND error IS NOT NULL
      AND error != ''
    ORDER BY COALESCE(processed_at, '') DESC, ordinal DESC
    LIMIT 1
  `).get(runId)?.error ?? null;
}

export function buildBackfillRunSummaryUpdate(owner, runId, { lastError = null } = {}) {
  return buildBackfillRunSummaryUpdateImpl(owner.db, runId, { lastError });
}

export function writeBackfillRunSummary(owner, runId, summaryUpdate) {
  owner.db.prepare(`
    UPDATE backfill_run
    SET status = ?,
        processed_count = ?,
        created_episode_count = ?,
        refreshed_episode_count = ?,
        skipped_count = ?,
        failed_count = ?,
        completed_at = COALESCE(?, completed_at),
        updated_at = ?,
        last_error = COALESCE(?, last_error)
    WHERE id = ?
  `).run(
    summaryUpdate.status,
    summaryUpdate.processedCount,
    summaryUpdate.createdEpisodeCount,
    summaryUpdate.refreshedEpisodeCount,
    summaryUpdate.skippedCount,
    summaryUpdate.failedCount,
    summaryUpdate.completedAt,
    summaryUpdate.updatedAt,
    summaryUpdate.lastError,
    runId,
  );
}

export function refreshBackfillRunSummary(owner, runId, options = {}) {
  owner.ensureOpen();
  const summaryUpdate = owner.buildBackfillRunSummaryUpdate(runId, options);
  owner.writeBackfillRunSummary(runId, summaryUpdate);
  return owner.getBackfillRun(runId);
}

export function listBackfillRuns(owner, { limit = 10 }) {
  owner.ensureOpen();
  return owner.db.prepare(`
    SELECT
      id, strategy, status, dry_run, repository, include_other_repositories,
      refresh_existing, batch_size, total_candidates, processed_count,
      created_episode_count, refreshed_episode_count, skipped_count,
      failed_count, snapshot_path, started_at, updated_at, completed_at, last_error
    FROM backfill_run
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
}
