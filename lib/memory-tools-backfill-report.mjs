import {
  applySessionExtraction,
  summarizeBackfillPreviewProgress,
  summarizeBackfillRunProgress,
  previewControlledBackfill,
  processControlledBackfillRun,
  restoreControlledBackfillRun,
  startControlledBackfillRun,
} from "./backfill.mjs";
import { ensureString } from "./memory-tools-validation-utils.mjs";
import { formatRows } from "./memory-tools-render-utils.mjs";

function formatBackfillRunRows(rows) {
  return formatRows(rows, (row) => [
    ...formatBackfillProgressKeyValues(summarizeBackfillRunProgress(row)),
    `- ${row.id}`,
    `status=${row.status}`,
    `processed=${row.processed_count}/${row.total_candidates}`,
    `snapshot=${row.snapshot_path ?? "none"}`,
  ].join(" "));
}

function formatBackfillItems(rows) {
  return formatRows(rows, (row) => [
    `- ${row.session_id}`,
    `planned=${row.planned_action}`,
    `status=${row.status}`,
    row.episode_before_scope || row.episode_after_scope
      ? `episode=${row.episode_before_scope ?? "none"}->${row.episode_after_scope ?? "none"}`
      : null,
    Number.isInteger(row.semantic_delta) ? `semanticDelta=${row.semantic_delta}` : null,
    row.error ? `error=${row.error}` : null,
  ].filter(Boolean).join(" "));
}

function formatBackfillProgressKeyValues(progress) {
  return [
    `progressTotalCount: ${progress.totalCount}`,
    `progressCompletedCount: ${progress.completedCount}`,
    `progressCreatedCount: ${progress.createdCount}`,
    `progressRefreshedCount: ${progress.refreshedCount}`,
    `progressFailedCount: ${progress.failedCount}`,
    `progressSkippedCount: ${progress.skippedCount}`,
    `progressPendingCount: ${progress.pendingCount}`,
    `progressRunningCount: ${progress.runningCount}`,
    `progressPercent: ${progress.progressPercent}`,
    `currentPhase: ${progress.currentPhase}`,
  ];
}

function formatControlledBackfillPreview(preview) {
  const progress = summarizeBackfillPreviewProgress(preview);
  return [
    `dryRun: ${preview.dryRun === true}`,
    `repository: ${preview.repository ?? "all"}`,
    `inspected: ${preview.inspected}`,
    `skippedExisting: ${preview.skippedExisting}`,
    `candidateCount: ${preview.candidates.length}`,
    ...formatBackfillProgressKeyValues(progress),
    "",
    "## Candidates",
    "",
    formatRows(preview.candidates, (candidate) => [
      `- ${candidate.sessionId}`,
      `planned=${candidate.plannedAction}`,
      `repository=${candidate.repository ?? "unknown"}`,
      candidate.updatedAt ? `updated=${candidate.updatedAt}` : null,
      candidate.summary ? `summary=${candidate.summary}` : null,
    ].filter(Boolean).join(" ")),
  ].join("\n");
}


function formatControlledBackfillRun(run, items = []) {
  const progress = summarizeBackfillRunProgress(run);
  return [
    `runId: ${run.id}`,
    `status: ${run.status}`,
    `repository: ${run.repository ?? "all"}`,
    ...formatBackfillProgressKeyValues(progress),
    `batchSize: ${run.batch_size}`,
    `snapshotPath: ${run.snapshot_path ?? "none"}`,
    `startedAt: ${run.started_at}`,
    `updatedAt: ${run.updated_at}`,
    `completedAt: ${run.completed_at ?? "not complete"}`,
    "",
    "## Item Summary",
    "",
    formatBackfillItems(items),
  ].join("\n");
}

function runControlledBackfillPreview(runtime, request) {
  const preview = previewControlledBackfill({
    db: runtime.db,
    sessionStore: runtime.sessionStore,
    repository: runtime.repository,
    includeOtherRepositories: request.includeOtherRepositories,
    limit: request.limit,
    refreshExisting: request.refreshExisting,
  });
  return formatControlledBackfillPreview(preview);
}

function runControlledBackfillStart(runtime, request) {
  const result = startControlledBackfillRun({
    db: runtime.db,
    sessionStore: runtime.sessionStore,
    repository: runtime.repository,
    includeOtherRepositories: request.includeOtherRepositories,
    limit: request.limit,
    refreshExisting: request.refreshExisting,
    batchSize: request.batchSize,
    snapshotPolicy: "auto",
  });
  return [
    `Started controlled backfill run ${result.runId}.`,
    "",
    formatControlledBackfillRun(result.run, result.items),
  ].join("\n");
}

function runControlledBackfillResume(runtime, request, args) {
  const runId = ensureString(args.runId, "runId");
  const result = processControlledBackfillRun({
    db: runtime.db,
    sessionStore: runtime.sessionStore,
    runId,
    limit: request.batchSize,
    retryFailed: args.retryFailed === true,
  });
  return [
    `Processed controlled backfill run ${runId}.`,
    "",
    formatControlledBackfillRun(result.run, result.items),
  ].join("\n");
}

function runControlledBackfillRestore(runtime, args) {
  const runId = ensureString(args.runId, "runId");
  const restored = restoreControlledBackfillRun({
    db: runtime.db,
    runId,
  });
  return [
    `Restored lore.db from snapshot for run ${runId}.`,
    `snapshotPath: ${restored.snapshotPath}`,
    `schemaVersion: ${restored.schemaVersion}`,
  ].join("\n");
}

export function runControlledBackfillAction({ runtime, request, args }) {
  const action = typeof args.action === "string" ? args.action : "preview";
  const actionHandlers = {
    preview: () => runControlledBackfillPreview(runtime, request),
    start: () => runControlledBackfillStart(runtime, request),
    resume: () => runControlledBackfillResume(runtime, request, args),
    status: () => formatBackfillStatus(runtime, args, request.batchSize),
    restore: () => runControlledBackfillRestore(runtime, args),
  };
  const handler = actionHandlers[action];
  if (handler) {
    return handler();
  }
  throw new Error(`unsupported controlled backfill action: ${action}`);
}

function formatBackfillStatus(runtime, args, batchSize) {
  if (typeof args.runId === "string" && args.runId.trim().length > 0) {
    const runId = args.runId.trim();
    const run = runtime.db.getBackfillRun(runId);
    if (!run) {
      throw new Error(`backfill run not found: ${runId}`);
    }
    const items = runtime.db.listBackfillRunItems({ runId, limit: Math.max(batchSize, 10) });
    return formatControlledBackfillRun(run, items);
  }
  const runs = runtime.db.listBackfillRuns({ limit: Math.max(batchSize, 10) });
  return [
    "## Backfill Runs",
    "",
    formatBackfillRunRows(runs),
  ].join("\n");
}

export function runLegacyBackfill({ runtime, request }) {
  const sessions = runtime.sessionStore.getRecentSessions({
    repository: request.includeOtherRepositories ? null : runtime.repository,
    limit: request.limit,
  });

  let created = 0;
  for (const candidate of sessions) {
    if (!request.refreshExisting && runtime.db.hasEpisodeDigest(candidate.id)) {
      continue;
    }
    const artifacts = runtime.sessionStore.getSessionArtifacts(candidate.id);
    if (!artifacts) {
      continue;
    }
    applySessionExtraction({
      db: runtime.db,
      sessionId: candidate.id,
      repository: candidate.repository ?? runtime.repository,
      sessionArtifacts: artifacts,
      workspace: { workspace: null },
    });
    created += 1;
  }

  return request.refreshExisting
    ? `Backfilled or refreshed ${created} session(s).`
    : `Backfilled ${created} session(s).`;
}
