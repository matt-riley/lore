import crypto from "node:crypto";
import { parseJsonArray } from "../utils/json-array-utils.mjs";
import { parseJsonObject } from "../utils/json-object-utils.mjs";
import { clampInteger } from "../utils/numeric-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { nowIso } from "./db-shared.mjs";

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function createMaintenanceRun(owner, {
  trigger,
  repository = null,
  dryRun = false,
  plannedTasks = [],
}) {
  owner.ensureOpen();
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  owner.db.prepare(`
    INSERT INTO maintenance_run (
      id, trigger, repository, dry_run, status, planned_tasks_json, summary_json,
      started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(trigger || "manual"),
    normalizeRepository(repository),
    dryRun ? 1 : 0,
    dryRun ? "planned" : "running",
    JSON.stringify(ensureArray(plannedTasks)),
    JSON.stringify({}),
    timestamp,
    timestamp,
  );
  return id;
}

export function reclaimStaleMaintenanceRuns(owner, { staleAfterMs = 30 * 60 * 1000 } = {}) {
  owner.ensureOpen();
  const numericStaleAfterMs = Number(staleAfterMs);
  const boundedStaleAfterMs = Number.isFinite(numericStaleAfterMs)
    ? Math.max(1, numericStaleAfterMs)
    : 30 * 60 * 1000;
  const staleCutoff = new Date(Date.now() - boundedStaleAfterMs).toISOString();
  const recoveredAt = nowIso();
  const staleRuns = owner.db.prepare(`
    SELECT id, repository, planned_tasks_json, started_at, updated_at
    FROM maintenance_run
    WHERE status = 'running'
      AND updated_at < ?
    ORDER BY updated_at ASC
  `).all(staleCutoff);
  if (staleRuns.length === 0) {
    return 0;
  }

  const updateRun = owner.db.prepare(`
    UPDATE maintenance_run
    SET status = 'failed',
        summary_json = ?,
        failed_count = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
      AND status = 'running'
  `);
  const updateTaskState = owner.db.prepare(`
    UPDATE maintenance_task_state
    SET last_status = 'failed',
        last_trigger = 'recovery',
        last_repository = ?,
        last_started_at = ?,
        last_completed_at = ?,
        last_duration_ms = 0,
        total_runs = total_runs + 1,
        total_failures = total_failures + 1,
        last_summary_json = ?,
        updated_at = ?
    WHERE task_name = ?
      AND last_status = 'running'
      AND (last_started_at IS NULL OR last_started_at <= ?)
  `);

  owner.db.exec("BEGIN IMMEDIATE");
  try {
    let recoveredCount = 0;
    for (const run of staleRuns) {
      const plannedTasks = parseJsonArray(run.planned_tasks_json)
        .filter((taskName) => typeof taskName === "string" && taskName.length > 0);
      const summary = {
        recovery: "stale maintenance run reclaimed",
        originalStatus: "running",
        startedAt: run.started_at ?? null,
        lastUpdatedAt: run.updated_at ?? null,
        recoveredAt,
        plannedTasks,
      };
      const failedCount = Math.max(1, plannedTasks.length);
      const updated = updateRun.run(
        JSON.stringify(summary),
        failedCount,
        recoveredAt,
        recoveredAt,
        run.id,
      );
      if (updated.changes === 0) {
        continue;
      }
      recoveredCount += 1;
      for (const taskName of plannedTasks) {
        updateTaskState.run(
          normalizeRepository(run.repository),
          recoveredAt,
          recoveredAt,
          JSON.stringify(summary),
          recoveredAt,
          taskName,
          run.updated_at ?? recoveredAt,
        );
      }
    }
    owner.db.exec("COMMIT");
    return recoveredCount;
  } catch (error) {
    try {
      owner.db.exec("ROLLBACK");
    } catch {
      // best-effort rollback before surfacing the original failure
    }
    throw error;
  }
}

export function completeMaintenanceRun(owner, {
  runId,
  status,
  repository = null,
  completedAt = null,
  completedCount = 0,
  needsAttentionCount = 0,
  failedCount = 0,
  skippedCount = 0,
  summary = {},
}) {
  owner.ensureOpen();
  const result = owner.db.prepare(`
    UPDATE maintenance_run
    SET status = ?,
        summary_json = ?,
        completed_count = ?,
        needs_attention_count = ?,
        failed_count = ?,
        skipped_count = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
      AND status = 'running'
  `).run(
    String(status || "completed"),
    JSON.stringify(summary ?? {}),
    completedCount,
    needsAttentionCount,
    failedCount,
    skippedCount,
    completedAt,
    nowIso(),
    runId,
  );
  if (completedAt && result.changes > 0) {
    owner.upsertActivitySuccess({
      repository,
      updates: {
        lastMaintenanceCompletionAt: completedAt,
        lastMaintenanceStatus: String(status || "completed"),
        lastMaintenanceRunId: runId,
      },
    });
    owner.upsertActivitySuccess({
      repository: null,
      updates: {
        lastMaintenanceCompletionAt: completedAt,
        lastMaintenanceStatus: String(status || "completed"),
        lastMaintenanceRunId: runId,
      },
    });
  }
}

export function listMaintenanceRuns(owner, { limit = 10 } = {}) {
  owner.ensureOpen();
  const rows = owner.db.prepare(`
    SELECT
      id, trigger, repository, dry_run, status, planned_tasks_json, summary_json,
      completed_count, needs_attention_count, failed_count, skipped_count,
      started_at, updated_at, completed_at
    FROM maintenance_run
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
  return rows.map((row) => ({
    ...row,
    plannedTasks: parseJsonArray(row.planned_tasks_json),
    summary: parseJsonObject(row.summary_json),
  }));
}

export function listMaintenanceTaskStates(owner) {
  owner.ensureOpen();
  const rows = owner.db.prepare(`
    SELECT
      task_name, last_status, last_trigger, last_repository, last_started_at,
      last_completed_at, last_duration_ms, cursor, total_runs, total_failures,
      total_needs_attention, last_summary_json, updated_at
    FROM maintenance_task_state
    ORDER BY task_name ASC
  `).all();
  return rows.map((row) => ({
    ...row,
    lastSummary: parseJsonObject(row.last_summary_json),
  }));
}

export function recordMaintenanceTaskStart(owner, {
  taskName,
  trigger,
  repository = null,
  startedAt = nowIso(),
}) {
  owner.ensureOpen();
  owner.db.prepare(`
    INSERT INTO maintenance_task_state (
      task_name, last_status, last_trigger, last_repository, last_started_at,
      last_completed_at, last_duration_ms, cursor, total_runs, total_failures,
      total_needs_attention, last_summary_json, updated_at
    ) VALUES (?, 'running', ?, ?, ?, NULL, 0, 0, 0, 0, 0, '{}', ?)
    ON CONFLICT(task_name) DO UPDATE SET
      last_status = 'running',
      last_trigger = excluded.last_trigger,
      last_repository = excluded.last_repository,
      last_started_at = excluded.last_started_at,
      updated_at = excluded.updated_at
  `).run(
    taskName,
    String(trigger || "manual"),
    normalizeRepository(repository),
    startedAt,
    startedAt,
  );
}

export function recordMaintenanceTaskResult(owner, {
  taskName,
  status,
  trigger,
  repository = null,
  startedAt = null,
  completedAt = nowIso(),
  durationMs = 0,
  cursor = 0,
  summary = {},
}) {
  owner.ensureOpen();
  const normalizedStatus = String(status || "completed");
  owner.db.prepare(`
    INSERT INTO maintenance_task_state (
      task_name, last_status, last_trigger, last_repository, last_started_at,
      last_completed_at, last_duration_ms, cursor, total_runs, total_failures,
      total_needs_attention, last_summary_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(task_name) DO UPDATE SET
      last_status = excluded.last_status,
      last_trigger = excluded.last_trigger,
      last_repository = excluded.last_repository,
      last_started_at = COALESCE(excluded.last_started_at, maintenance_task_state.last_started_at),
      last_completed_at = excluded.last_completed_at,
      last_duration_ms = excluded.last_duration_ms,
      cursor = excluded.cursor,
      total_runs = maintenance_task_state.total_runs + 1,
      total_failures = maintenance_task_state.total_failures
        + CASE WHEN excluded.last_status = 'failed' THEN 1 ELSE 0 END,
      total_needs_attention = maintenance_task_state.total_needs_attention
        + CASE WHEN excluded.last_status = 'needs_attention' THEN 1 ELSE 0 END,
      last_summary_json = excluded.last_summary_json,
      updated_at = excluded.updated_at
    WHERE maintenance_task_state.last_started_at IS NULL
      OR maintenance_task_state.last_started_at = excluded.last_started_at
  `).run(
    taskName,
    normalizedStatus,
    String(trigger || "manual"),
    normalizeRepository(repository),
    startedAt,
    completedAt,
    clampInteger(durationMs, 0, { min: 0, max: 24 * 60 * 60 * 1000 }),
    clampInteger(cursor, 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    normalizedStatus === "failed" ? 1 : 0,
    normalizedStatus === "needs_attention" ? 1 : 0,
    JSON.stringify(summary ?? {}),
    completedAt,
  );
}
