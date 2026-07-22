import { ensureArray } from "./memory-tools-array-utils.mjs";
import { formatRows } from "./memory-tools-render-utils.mjs";

function determineMaintenancePhase(result) {
  if (result.dryRun === true) {
    return "planning";
  }
  switch (result.status) {
    case "disabled":
      return "disabled";
    case "failed":
      return "failed";
    case "needs_attention":
      return "attention";
    case "completed":
      return "complete";
    case "planned":
      return "planning";
    case "skipped":
      return "idle";
    default:
      return "processing";
  }
}

function summarizeMaintenanceProgress(result) {
  const totalCount = Number(result.taskCount ?? 0);
  const completedCount = Number(result.completedCount ?? 0);
  const needsAttentionCount = Number(result.needsAttentionCount ?? 0);
  const failedCount = Number(result.failedCount ?? 0);
  const skippedCount = Number(result.skippedCount ?? 0);
  const terminalCount = completedCount + needsAttentionCount + failedCount + skippedCount;
  const pendingCount = Math.max(0, totalCount - terminalCount);
  const progressPercent = totalCount > 0
    ? Math.min(100, Math.max(0, Math.round((terminalCount / totalCount) * 100)))
    : 100;
  const currentPhase = determineMaintenancePhase(result);
  return {
    totalCount,
    completedCount,
    needsAttentionCount,
    failedCount,
    skippedCount,
    pendingCount,
    progressPercent,
    currentPhase,
  };
}

function formatMaintenanceTaskState(task) {
  return [
    `- ${task.label}`,
    `enabled=${task.enabled}`,
    `selected=${task.selected}`,
    `due=${task.due}`,
    `reason=${task.dueReason}`,
    `cadenceMinutes=${task.cadenceMinutes}`,
    task.lastRunMinutesAgo == null ? null : `lastRunMinutesAgo=${task.lastRunMinutesAgo}`,
    task.nextRunMinutes == null ? null : `nextRunMinutes=${task.nextRunMinutes}`,
    task.state?.last_status ? `lastStatus=${task.state.last_status}` : null,
    task.state?.last_completed_at ? `lastCompletedAt=${task.state.last_completed_at}` : null,
  ].filter(Boolean).join(" ");
}

function formatMaintenanceRunRows(runs) {
  return formatRows(runs, (run) => [
    `- ${run.id}`,
    `status=${run.status}`,
    `trigger=${run.trigger}`,
    `tasks=${ensureArray(run.plannedTasks).join(",") || "none"}`,
    `completed=${run.completed_count}`,
    `needsAttention=${run.needs_attention_count}`,
    `failed=${run.failed_count}`,
    `skipped=${run.skipped_count}`,
    `started=${run.started_at}`,
    run.completed_at ? `completedAt=${run.completed_at}` : null,
  ].filter(Boolean).join(" "));
}

const MAINTENANCE_TASK_SUMMARY_FIELDS = Object.freeze([
  ["processed", "processed"],
  ["failed", "failed"],
  ["staleCount", "stale"],
  ["incidentCount", "incidents"],
  ["warningCount", "warnings"],
  ["criticalCount", "critical"],
]);

function buildMaintenanceTaskSummaryFields(summary) {
  return MAINTENANCE_TASK_SUMMARY_FIELDS
    .map(([key, label]) => (
      typeof summary[key] === "number"
        ? `${label}=${summary[key]}`
        : null
    ));
}

function formatMaintenanceTaskResult(task) {
  const summary = task.summary ?? {};
  const caseIds = ensureArray(summary.caseIds);
  return [
    `- ${task.label}`,
    `status=${task.status}`,
    `durationMs=${task.durationMs}`,
    caseIds.length > 0 ? `cases=${caseIds.join(",")}` : null,
    ...buildMaintenanceTaskSummaryFields(summary),
    summary.recordedArtifactId ? `artifactId=${summary.recordedArtifactId}` : null,
    summary.error ? `error=${summary.error}` : null,
  ].filter(Boolean).join(" ");
}

export function formatMaintenanceReport(result, { includeRecentRuns = false } = {}) {
  const progress = summarizeMaintenanceProgress(result);
  const lines = [
    `status: ${result.status}`,
    `dryRun: ${result.dryRun === true}`,
    `trigger: ${result.trigger}`,
    `repository: ${result.repository ?? "all"}`,
    `taskCount: ${result.taskCount}`,
    `completedCount: ${result.completedCount}`,
    `needsAttentionCount: ${result.needsAttentionCount}`,
    `failedCount: ${result.failedCount}`,
    `skippedCount: ${result.skippedCount}`,
    `progressTotalCount: ${progress.totalCount}`,
    `progressCompletedCount: ${progress.completedCount}`,
    `progressNeedsAttentionCount: ${progress.needsAttentionCount}`,
    `progressFailedCount: ${progress.failedCount}`,
    `progressSkippedCount: ${progress.skippedCount}`,
    `progressPendingCount: ${progress.pendingCount}`,
    `progressPercent: ${progress.progressPercent}`,
    `currentPhase: ${progress.currentPhase}`,
  ];

  if (result.runId) {
    lines.push(`runId: ${result.runId}`);
  }

  lines.push(
    "",
    "## Tasks",
    "",
    result.tasks.length > 0 ? result.tasks.map(formatMaintenanceTaskResult).join("\n") : "- none",
  );

  if (result.plan) {
    lines.push(
      "",
      "## Scheduler Plan",
      "",
      `enabled: ${result.plan.enabled}`,
      `autoRunOnSessionStart: ${result.plan.autoRunOnSessionStart}`,
      `maxTasksPerRun: ${result.plan.maxTasksPerRun}`,
      `dueTaskCount: ${result.plan.dueTasks.length}`,
      `skippedDueToCap: ${result.plan.skippedDueToCap}`,
      "",
      "## Task State",
      "",
      result.plan.tasks.length > 0 ? result.plan.tasks.map(formatMaintenanceTaskState).join("\n") : "- none",
    );
  }

  if (includeRecentRuns && result.plan?.recentRuns) {
    lines.push("", "## Recent Runs", "", formatMaintenanceRunRows(result.plan.recentRuns));
  }

  return lines.join("\n");
}

export function appendMaintenanceSections(lines, maintenance) {
  lines.push("", "## Maintenance Tasks", "", maintenance.tasks.map(formatMaintenanceTaskState).join("\n") || "- none");
  if (maintenance.recentRuns.length > 0) {
    lines.push("", "## Recent Maintenance Runs", "", formatMaintenanceRunRows(maintenance.recentRuns));
  }
}
