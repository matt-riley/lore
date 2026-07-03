import {
  applySessionExtraction,
  summarizeBackfillPreviewProgress,
  summarizeBackfillRunProgress,
  previewControlledBackfill,
  processControlledBackfillRun,
  restoreControlledBackfillRun,
  startControlledBackfillRun,
} from "./backfill.mjs";
import { buildRecallEnvelope } from "./memory-operations.mjs";
import {
  parseWorkstreamOverlayMemory,
  WORKSTREAM_MEMORY_TYPE,
} from "./workstream-overlays.mjs";
import {
  readMemoryDomainsEnabled,
  readEvolutionLedgerEnabled,
  readRefreshableObservationsEnabled,
  readGeneratedArtifactIntegrityEnabled,
  readMemoryOperationsEnabled,
  readProposalGenerationEnabled,
  readRetentionSanitizationEnabled,
  readTraceRecorderEnabled,
  readTemporalQueryNormalizationEnabled,
  readWorkstreamOverlaysEnabled,
  readDirectivesEnabled,
} from "./rollout-flags.mjs";
import {
  formatRetrievalTraceSampleRows,
  formatTrajectoryArtifactRows,
  formatDoctorReport,
  formatDoctorSafetyGateSection,
  formatReviewGateReport,
} from "./memory-tools-observability-reports.mjs";
import { ensureArray } from "./memory-tools-array-utils.mjs";
import { ensureLimit } from "./memory-tools-validation-utils.mjs";
import { formatRows } from "./memory-tools-render-utils.mjs";

function formatRecallSummary(trace) {
  return Object.entries(trace?.lookups ?? {})
    .map(([name, lookup]) => {
      const matched = Array.isArray(lookup?.rows)
        ? lookup.rows.length
        : Array.isArray(lookup?.rankedRows)
          ? lookup.rankedRows.length
          : 0;
      const included = Array.isArray(lookup?.includedRows) ? lookup.includedRows.length : 0;
      return `- ${name}: matched=${matched} included=${included}${lookup?.reason ? ` reason=${lookup.reason}` : ""}`;
    })
    .join("\n");
}

function formatRecallReport(result, { includeTrace = false } = {}) {
  const lines = [
    `repository: ${result.repository ?? "global-only"}`,
    `estimatedTokens: ${result.estimatedTokens ?? 0}`,
    `sections: ${(result.trace?.output?.sectionTitles ?? []).join(", ") || "none"}`,
    "",
    "## Context",
    "",
    result.text || "No context.",
  ];
  if (includeTrace) {
    lines.push(
      "",
      "## Lookup Summary",
      "",
      formatRecallSummary(result.trace) || "- none",
    );
  }
  return lines.join("\n");
}

function formatRecallSupportingFactsLines(envelope) {
  return [
    "",
    "## Supporting Facts",
    "",
    ...(envelope.supportingFacts.length > 0
      ? envelope.supportingFacts.map((fact) => `- ${fact}`)
      : ["- none"]),
  ];
}

function formatRecallLookupLines(lookup, detailLevel) {
  const lines = [
    `- ${lookup.name}: matched=${lookup.matchedCount} included=${lookup.includedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
  ];
  const samples = lookup.includedRows.length > 0 ? lookup.includedRows : lookup.matchedRows;
  lines.push(...samples.slice(0, 2).map((sample) => `  - ${sample}`));
  if (detailLevel === "full" && lookup.rankedRows.length > 0) {
    lines.push("  - ranking:");
    lines.push(...lookup.rankedRows.slice(0, 2).map((sample) => `    - ${sample}`));
  }
  if (lookup.filteredReasons.length > 0) {
    lines.push(`  - filtered: ${lookup.filteredReasons.join(", ")}`);
  }
  return lines;
}

function formatRecallEvidenceLines(envelope, detailLevel) {
  if (envelope.lookups.length === 0) {
    return ["", "## Lookup Evidence", "", "- none"];
  }
  return [
    "",
    "## Lookup Evidence",
    "",
    ...envelope.lookups.flatMap((lookup) => formatRecallLookupLines(lookup, detailLevel)),
  ];
}

export function formatRecallEnvelope(result, { detailLevel = "context", includeTrace = false } = {}) {
  const lines = [formatRecallReport(result, { includeTrace })];
  if (detailLevel === "context") {
    return lines.join("\n");
  }

  const envelope = buildRecallEnvelope(result);
  lines.push(...formatRecallSupportingFactsLines(envelope));
  lines.push(...formatRecallEvidenceLines(envelope, detailLevel));

  return lines.join("\n");
}

function humanizeFocus(value) {
  return String(value || "summary")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function humanizeLookupLabel(value) {
  return String(value || "lookup")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

export function formatReflectionReport(result, { detailLevel = "summary" } = {}) {
  const lines = [
    ...buildReflectionHeaderLines(result),
    ...buildReflectionInsightLines(result),
  ];

  if (detailLevel === "summary") {
    return lines.join("\n");
  }

  lines.push(...buildReflectionEvidenceLines(result));
  if (detailLevel !== "full") {
    return lines.join("\n");
  }

  lines.push(...buildReflectionLookupCoverageLines(result));
  return lines.join("\n");
}

function buildReflectionHeaderLines(result) {
  const cappedSuffix = result.recentSessionCountCapped ? "+ (capped)" : "";
  const lookbackLine = result.lookbackHours
    ? [`lookbackHours: ${result.lookbackHours} (sessions found: ${result.recentSessionCount ?? 0}${cappedSuffix})`]
    : [];
  return [
    `repository: ${result.repository ?? "global-only"}`,
    `focus: ${humanizeFocus(result.focus)}`,
    `estimatedTokens: ${result.recall?.estimatedTokens ?? 0}`,
    `sections: ${(result.envelope?.sections ?? []).join(", ") || "none"}`,
    ...lookbackLine,
    "",
    "## Reflection",
    "",
    result.summary,
    "",
    "## Key Insights",
    "",
  ];
}

function buildReflectionInsightLines(result) {
  if (!Array.isArray(result.insights) || result.insights.length === 0) {
    return ["- none"];
  }
  return result.insights.map((insight) => `- ${insight.text}${insight.source ? ` (${insight.source})` : ""}`);
}

function buildReflectionEvidenceLines(result) {
  return [
    "",
    "## Supporting Evidence",
    "",
    ...formatReflectionFactLines(result.envelope?.supportingFacts),
    "",
    "## Source Accounting",
    "",
    ...formatReflectionSourceAccountingLines(result.envelope?.sourceAccounting),
  ];
}

function formatReflectionFactLines(facts) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return ["- none"];
  }
  return facts.map((fact) => `- ${fact}`);
}

function formatReflectionSourceAccountingLines(sourceAccounting) {
  if (!Array.isArray(sourceAccounting) || sourceAccounting.length === 0) {
    return ["- none"];
  }
  return sourceAccounting.map((section) => (
    `- ${section.title}: source=${section.source ?? "unknown"} entries=${section.entryCount ?? 0} tokens=${section.usedTokens ?? 0}${section.budget ? `/${section.budget}` : ""}`
  ));
}

function buildReflectionLookupCoverageLines(result) {
  const lookups = Array.isArray(result.envelope?.lookups) ? result.envelope.lookups : [];
  return [
    "",
    "## Lookup Coverage",
    "",
    ...(lookups.length === 0 ? ["- none"] : lookups.flatMap((lookup) => formatReflectionLookupLines(lookup))),
  ];
}

function formatReflectionLookupLines(lookup) {
  return [
    `- ${humanizeLookupLabel(lookup.name)}: matched=${lookup.matchedCount} included=${lookup.includedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
    ...formatReflectionLookupSamples(lookup),
    ...(lookup.filteredReasons.length > 0 ? [`  - filtered: ${lookup.filteredReasons.join(", ")}`] : []),
  ];
}

function formatReflectionLookupSamples(lookup) {
  const includedEntries = lookup.includedEntries.slice(0, 2).map((sample) => `  - ${sample.text}`);
  if (includedEntries.length > 0) {
    return includedEntries;
  }
  return lookup.matchedEntries.slice(0, 1).map((sample) => `  - ${sample.text}`);
}

export function formatAuditRows(rows) {
  return formatRows(rows, (row) => [
    `- [${row.action}] ${row.target_type}:${row.target_id}`,
    `prev=${row.previous_scope ?? "none"}(${row.previous_repository ?? "global"})`,
    `next=${row.next_scope ?? "none"}(${row.next_repository ?? "global"})`,
    `actor=${row.actor}`,
    `source=${row.source}`,
    `reason=${row.reason}`,
    `at=${row.created_at}`,
  ].join(" "));
}

export function formatScopePreview(preview) {
  const lines = [
    `action: ${preview.action}`,
    `targetType: ${preview.targetType}`,
    `requestedCount: ${preview.requestedCount}`,
    `matchedCount: ${preview.matchedCount}`,
    `missingIds: ${preview.missingIds.length > 0 ? preview.missingIds.join(", ") : "none"}`,
    "",
    "## Rows",
    "",
  ];
  lines.push(formatRows(preview.rows, (row) => [
    `- ${row.id}`,
    `current=${row.current.scope}/${row.current.scopeSource}`,
    `(${row.current.repository ?? "global"})`,
    `-> next=${row.next.scope}/${row.next.scopeSource}`,
    `(${row.next.repository ?? "global"})`,
    `changed=${row.changed}`,
  ].join(" ")));
  return lines.join("\n");
}

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

function compareOverlayState(left, right) {
  const leftActive = left.status !== "done";
  const rightActive = right.status !== "done";
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

function formatWorkstreamOverlayStatus(runtime) {
  const rows = runtime.db.searchSemantic({
    query: "",
    repository: runtime.repository,
    includeOtherRepositories: false,
    types: [WORKSTREAM_MEMORY_TYPE],
    limit: 5,
  });
  const overlays = rows
    .map(parseWorkstreamOverlayMemory)
    .sort(compareOverlayState)
    .slice(0, 3);
  if (overlays.length === 0) {
    return ["activeWorkstreams: none"];
  }
  return overlays.map((overlay, index) => [
    `activeWorkstream${index + 1}: ${overlay.title}`,
    `[${overlay.status}]`,
    overlay.blockers.length > 0 ? `blockers=${overlay.blockers.length}` : null,
    overlay.nextActions.length > 0 ? `nextActions=${overlay.nextActions.length}` : null,
  ].filter(Boolean).join(" "));
}

function formatLatencyMetric(prefix, metric) {
  const normalized = normalizeLatencyMetric(metric);
  return [
    formatLatencyMetricLine(prefix, "P50Ms", normalized.p50Ms),
    formatLatencyMetricLine(prefix, "P95Ms", normalized.p95Ms),
    formatLatencyMetricLine(prefix, "AverageMs", normalized.averageMs),
    formatLatencyMetricLine(prefix, "MaxMs", normalized.maxMs),
    formatLatencyMetricLine(prefix, "LatestMs", normalized.latestMs),
    formatLatencyMetricLine(prefix, "Samples", normalized.samples),
    formatLatencyMetricLine(prefix, "P95Readiness", normalized.readiness),
    formatLatencyMetricLine(prefix, "MinSamplesForP95", normalized.minSamples),
    formatLatencyMetricLine(prefix, "TargetMs", normalized.targetMs),
    formatLatencyMetricLine(prefix, "TargetStatus", normalized.targetStatus),
    formatLatencyMetricLine(prefix, "RecentAverageMs", normalized.recentAverageMs),
    formatLatencyMetricLine(prefix, "PreviousAverageMs", normalized.previousAverageMs),
    formatLatencyMetricLine(prefix, "Trend", normalized.trend),
    formatLatencyMetricLine(prefix, "TrendDeltaMs", normalized.trendDeltaMs),
  ];
}

function formatLatencyMetricLine(prefix, suffix, value) {
  return `${prefix}${suffix}: ${value}`;
}

function normalizeLatencyMetric(metric) {
  const {
    p50Ms = 0,
    p95Ms = 0,
    averageMs = 0,
    maxMs = 0,
    latestMs = 0,
    samples = 0,
    readiness = "unknown",
    minSamples = 0,
    targetMs = 0,
    targetStatus = "unknown",
    recentAverageMs = 0,
    previousAverageMs = 0,
    trend = "unknown",
    trendDeltaMs = 0,
  } = metric ?? {};
  return {
    p50Ms,
    p95Ms,
    averageMs,
    maxMs,
    latestMs,
    samples,
    readiness,
    minSamples,
    targetMs,
    targetStatus,
    recentAverageMs,
    previousAverageMs,
    trend,
    trendDeltaMs,
  };
}

function formatTraceRecorderRoutes(routes) {
  return ensureArray(routes).length > 0
    ? ensureArray(routes).map((entry) => `${entry.route} x${entry.count}`).join(", ")
    : "none";
}

function formatTraceRecorderLookups(lookups) {
  return ensureArray(lookups).length > 0
    ? ensureArray(lookups)
      .slice(0, 5)
      .map((entry) => `${entry.name} included=${entry.includedCount}/${entry.seenCount} matched=${entry.matchedCount}/${entry.seenCount} dropped=${entry.droppedCount}`)
      .join(" | ")
    : "none";
}

function formatTraceRecorderPatterns(patterns) {
  return ensureArray(patterns).length > 0
    ? ensureArray(patterns).slice(0, 5).map((entry) => `${entry.label} x${entry.count}`).join(", ")
    : "none";
}

export function formatActivityStates(states) {
  if (ensureArray(states).length === 0) {
    return ["- none"];
  }
  return ensureArray(states).map((state) => formatActivityState(state));
}

// fallow-ignore-next-line complexity
function formatActivityState(state) {
  const sections = ensureArray(state.lastContextInjectionSections).join(", ") || "none";
  return [
    `- [${state.scopeKey}] scope=${state.scopeType}`,
    state.repository ? `repository=${state.repository}` : null,
    `lastContextInjectionAt=${state.lastContextInjectionAt ?? "none"}`,
    `lastContextHook=${state.lastContextInjectionHook ?? "none"}`,
    `lastContextSections=${sections}`,
    `lastExtractionCompletionAt=${state.lastExtractionCompletionAt ?? "none"}`,
    `lastMaintenanceCompletionAt=${state.lastMaintenanceCompletionAt ?? "none"}`,
    `lastMaintenanceStatus=${state.lastMaintenanceStatus ?? "none"}`,
    `lastTraceRecordedAt=${state.lastTraceRecordedAt ?? "none"}`,
    `lastTraceHook=${state.lastTraceHook ?? "none"}`,
    `updatedAt=${state.updatedAt ?? "none"}`,
  ].filter(Boolean).join(" ");
}

export {
  formatRetrievalTraceSampleRows,
  formatDoctorReport,
  formatDoctorSafetyGateSection,
  formatReviewGateReport,
};

const MEMORY_STATUS_IDENTITY_LINE_READERS = Object.freeze([
  ["enabled", (runtime) => runtime.config.enabled],
  ["repository", (runtime) => runtime.repository ?? "global-only"],
  ["dbPath", (_runtime, stats) => stats.dbPath],
  ["schemaVersion", (_runtime, stats) => stats.schemaVersion],
  ["semanticCount", (_runtime, stats) => stats.semanticCount],
  ["episodeCount", (_runtime, stats) => stats.episodeCount],
  ["semanticGlobalCount", (_runtime, stats) => stats.semanticGlobalCount],
  ["semanticTransferableCount", (_runtime, stats) => stats.semanticTransferableCount],
  ["semanticRepoCount", (_runtime, stats) => stats.semanticRepoCount],
  ["semanticManualCount", (_runtime, stats) => stats.semanticManualCount],
  ["episodeTransferableCount", (_runtime, stats) => stats.episodeTransferableCount],
  ["episodeRepoCount", (_runtime, stats) => stats.episodeRepoCount],
  ["episodeManualCount", (_runtime, stats) => stats.episodeManualCount],
  ["daySummaryCount", (_runtime, stats) => stats.daySummaryCount],
  ["overrideAuditCount", (_runtime, stats) => stats.overrideAuditCount],
  ["semanticCanonicalCount", (_runtime, stats) => stats.semanticCanonicalCount ?? 0],
  ["semanticReinforcedCount", (_runtime, stats) => stats.semanticReinforcedCount ?? 0],
  ["assistantGoalCount", (_runtime, stats) => stats.assistantGoalCount ?? 0],
  ["recurringMistakeCount", (_runtime, stats) => stats.recurringMistakeCount ?? 0],
  ["userIdentityCount", (_runtime, stats) => stats.userIdentityCount ?? 0],
  ["workstreamOverlayCount", (_runtime, stats) => stats.workstreamOverlayCount ?? 0],
  ["domainCount", (_runtime, stats) => stats.domainCount ?? 0],
  ["observationCount", (_runtime, stats) => stats.observationCount ?? 0],
  ["directiveCount", (_runtime, stats) => stats.directiveCount ?? 0],
]);

export function buildMemoryStatusIdentityLines(runtime, stats) {
  return MEMORY_STATUS_IDENTITY_LINE_READERS
    .map(([label, readValue]) => `${label}: ${readValue(runtime, stats)}`);
}

export function buildMemoryStatusRolloutLines(runtime, maintenance) {
  return [
    `memoryOperationsEnabled: ${readMemoryOperationsEnabled(runtime.config)}`,
    `memoryDomainsEnabled: ${readMemoryDomainsEnabled(runtime.config)}`,
    `refreshableObservationsEnabled: ${readRefreshableObservationsEnabled(runtime.config)}`,
    `workstreamOverlaysEnabled: ${readWorkstreamOverlaysEnabled(runtime.config)}`,
    `directivesEnabled: ${readDirectivesEnabled(runtime.config)}`,
    `temporalQueryNormalizationEnabled: ${readTemporalQueryNormalizationEnabled(runtime.config)}`,
    `retentionSanitizationEnabled: ${readRetentionSanitizationEnabled(runtime.config)}`,
    `traceRecorderEnabled: ${readTraceRecorderEnabled(runtime.config)}`,
    `evolutionLedgerEnabled: ${readEvolutionLedgerEnabled(runtime.config)}`,
    `proposalGenerationEnabled: ${readProposalGenerationEnabled(runtime.config)}`,
    `generatedArtifactIntegrityEnabled: ${readGeneratedArtifactIntegrityEnabled(runtime.config)}`,
    `maintenanceEnabled: ${maintenance.enabled}`,
    `maintenanceAutoRunOnSessionStart: ${maintenance.autoRunOnSessionStart}`,
    `maintenanceMaxTasksPerRun: ${maintenance.maxTasksPerRun}`,
    `maintenanceDueTaskCount: ${maintenance.dueTasks.length}`,
    `maintenanceSelectedTaskCount: ${maintenance.selectedTasks.length}`,
    `maintenanceSkippedDueToCap: ${maintenance.skippedDueToCap}`,
    ...formatWorkstreamOverlayStatus(runtime),
  ];
}

export function deriveMemoryStatusActivityPhases(stats) {
  const deferredActionableCount = (stats.deferredPendingCount ?? 0) + (stats.deferredFailedCount ?? 0);
  const deferredCurrentPhase = (stats.deferredRunningCount ?? 0) > 0
    ? "processing"
    : deferredActionableCount > 0
      ? "queued"
      : "idle";
  const backfillCurrentPhase = (stats.backfillRunningCount ?? 0) > 0 ? "processing" : "idle";
  return {
    deferredActionableCount,
    deferredCurrentPhase,
    backfillCurrentPhase,
  };
}

export function buildMemoryStatusLifecycleLines(stats, phases) {
  return [
    `backfillRunningCount: ${stats.backfillRunningCount}`,
    `backfillCompletedCount: ${stats.backfillCompletedCount}`,
    `backfillFailedCount: ${stats.backfillFailedCount}`,
    `backfillDryRunCount: ${stats.backfillDryRunCount}`,
    `backfillCurrentPhase: ${phases.backfillCurrentPhase}`,
    `deferredPendingCount: ${stats.deferredPendingCount}`,
    `deferredRunningCount: ${stats.deferredRunningCount}`,
    `deferredFailedCount: ${stats.deferredFailedCount}`,
    `deferredCompletedCount: ${stats.deferredCompletedCount}`,
    `deferredActionableCount: ${phases.deferredActionableCount}`,
    `deferredCurrentPhase: ${phases.deferredCurrentPhase}`,
  ];
}

const MEMORY_STATUS_IMPROVEMENT_FIELDS = [
  ["improvementCount", 0],
  ["improvementActiveCount", 0],
  ["improvementResolvedCount", 0],
  ["improvementSupersededCount", 0],
  ["improvementProposalCount", 0],
  ["draftProposalCount", 0],
  ["approvedProposalCount", 0],
  ["rejectedProposalCount", 0],
  ["supersededProposalCount", 0],
  ["maintenanceCompletedCount", 0],
  ["maintenanceNeedsAttentionCount", 0],
  ["maintenanceFailedCount", 0],
  ["maintenanceSkippedCount", 0],
  ["maintenanceTaskStateCount", 0],
  ["lastMaintenanceStatus", "none"],
  ["lastMaintenanceStartedAt", "none"],
  ["lastMaintenanceCompletedAt", "none"],
];

const MEMORY_STATUS_TRACE_ARTIFACT_FIELDS = [
  ["trajectoryArtifactCount", 0],
  ["trajectoryReplayFailureCount", 0],
  ["trajectoryValidationMissCount", 0],
  ["trajectoryProposalFailureCount", 0],
  ["trajectoryLatencyOutlierCount", 0],
  ["retrievalTraceSampleCount", 0],
  ["retrievalTraceSampleRepositoryCount", 0],
  ["retrievalTraceSampleGlobalCount", 0],
  ["intentJournalCount", 0],
  ["intentRoutingCount", 0],
  ["intentRolloutCount", 0],
  ["intentReviewerCount", 0],
  ["intentFallbackCount", 0],
  ["intentSerendipityCount", 0],
  ["lastBackupPath", "none"],
];

function formatStatusFieldLines(source, fields) {
  return fields.map(([label, fallback]) => `${label}: ${source[label] ?? fallback}`);
}

export function buildMemoryStatusImprovementLines(stats) {
  return formatStatusFieldLines(stats, MEMORY_STATUS_IMPROVEMENT_FIELDS);
}

export function buildMemoryStatusTraceArtifactLines(runtime, stats) {
  return [
    ...formatStatusFieldLines(stats, MEMORY_STATUS_TRACE_ARTIFACT_FIELDS),
    `configPath: ${runtime.config.configPath}`,
  ];
}

export function buildMemoryStatusMetricLines(runtime) {
  return [
    ...formatLatencyMetric("sessionStart", runtime.metrics.sessionStart),
    ...formatLatencyMetric("userPromptSubmitted", runtime.metrics.userPromptSubmitted),
  ];
}

function formatTraceRecorderHooks(hooks) {
  return ensureArray(hooks).map((entry) => [
    `traceHook:${entry.hook}`,
    `samples=${entry.samples}`,
    `withContext=${entry.withContextCount}`,
    `withoutContext=${entry.withoutContextCount}`,
    `p50=${entry.p50Ms}`,
    `p95=${entry.p95Ms}`,
    `avg=${entry.averageMs}`,
    `max=${entry.maxMs}`,
    `trend=${entry.trend}`,
    `delta=${entry.trendDeltaMs}`,
  ].join(" "));
}

function formatTraceLookupSamples(rows) {
  return ensureArray(rows)
    .map((row) => {
      const label = row?.type ? `[${row.type}] ` : "";
      const repository = row?.repository ? ` (${row.repository})` : "";
      return `${label}${row?.text ?? ""}${repository}`;
    })
    .filter(Boolean);
}

function formatTracePromptNeedLines(promptNeed) {
  if (!promptNeed) {
    return [];
  }
  return [
    `- promptNeed.requiresLookup: ${promptNeed.requiresLookup === true}`,
    `- promptNeed.wantsContinuity: ${promptNeed.wantsContinuity === true}`,
    `- promptNeed.allowCrossRepoFallback: ${promptNeed.allowCrossRepoFallback === true}`,
    `- promptNeed.identityOnly: ${promptNeed.identityOnly === true}`,
  ];
}

function formatRecentTraceLookupLines(lookups) {
  const lookupEntries = Object.entries(lookups ?? {});
  if (lookupEntries.length === 0) {
    return ["  - none"];
  }
  return lookupEntries.flatMap(([name, lookup]) => {
    const lines = [
      `  - ${name}: matched=${lookup.matchedCount} included=${lookup.includedCount} dropped=${lookup.droppedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
    ];
    for (const sample of formatTraceLookupSamples(lookup.includedRows).slice(0, 2)) {
      lines.push(`    - included: ${sample}`);
    }
    for (const sample of formatTraceLookupSamples(lookup.matchedRows).slice(0, 1)) {
      lines.push(`    - matched: ${sample}`);
    }
    for (const dropped of ensureArray(lookup.droppedRows).slice(0, 1)) {
      const rowText = dropped?.row?.text ? ` — ${dropped.row.text}` : "";
      lines.push(`    - dropped: ${dropped.stage}:${dropped.reason}${rowText}`);
    }
    return lines;
  });
}

function buildRecentTraceHeaderLines(record) {
  return [
    `### ${record.id}`,
    `- hook: ${record.hook}`,
    `- recordedAt: ${record.recordedAt}`,
    `- repository: ${record.repository ?? "global-only"}`,
    `- prompt: ${record.promptPreview || "none"}`,
    `- latencyMs: ${record.latencyMs}`,
  ];
}

function formatRecentTraceList(values) {
  return ensureArray(values).join(", ") || "none";
}

function formatRecentTraceValue(value, fallback = "none") {
  return value ?? fallback;
}

function buildRecentTraceRoutingLines(record) {
  return [
    `- route: ${formatRecentTraceValue(record.routerDecision?.route, "unknown")}`,
    `- routeReason: ${formatRecentTraceValue(record.routerDecision?.reason)}`,
    `- contextInjected: ${record.output?.contextInjected === true}`,
    `- sectionTitles: ${formatRecentTraceList(record.output?.sectionTitles)}`,
    `- eligibility.local: ${formatRecentTraceList(record.eligibility?.local)}`,
    `- eligibility.crossRepo: ${formatRecentTraceList(record.eligibility?.crossRepo)}`,
  ];
}

function formatRecentTraceOptionalLines(record) {
  return [
    record.output?.injectedContextPreview
      ? `- injectedContextPreview: ${record.output.injectedContextPreview}`
      : null,
    ensureArray(record.omissions).length > 0
      ? `- omissions: ${ensureArray(record.omissions).map((item) => `${item.stage}:${item.reason}`).join(", ")}`
      : null,
  ].filter(Boolean);
}

function formatRecentTraceRecord(record) {
  return [
    ...buildRecentTraceHeaderLines(record),
    ...buildRecentTraceRoutingLines(record),
    ...formatTracePromptNeedLines(record.promptNeed),
    "- lookups:",
    ...formatRecentTraceLookupLines(record.lookups),
    ...formatRecentTraceOptionalLines(record),
  ];
}

function formatRecentTraceRecords(records) {
  if (ensureArray(records).length === 0) {
    return ["- none"];
  }

  const lines = [];
  for (const record of ensureArray(records)) {
    lines.push(...formatRecentTraceRecord(record));
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
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

export function appendTraceRecorderStatusLines(lines, traceStats) {
  if (!traceStats) {
    return;
  }
  lines.push(
    `traceRecorderStoredRecords: ${traceStats.storedRecords}`,
    `traceRecorderTotalRecorded: ${traceStats.totalRecorded}`,
    `traceRecorderEvictedCount: ${traceStats.totalEvicted}`,
    `traceRecorderExpiredCount: ${traceStats.totalExpired}`,
    `traceRecorderMaxRecords: ${traceStats.maxRecords}`,
    `traceRecorderMaxAgeMs: ${traceStats.maxAgeMs}`,
    `traceRecorderLastRecordedAt: ${traceStats.lastRecordedAt ?? "none"}`,
    `traceRecorderRoutes: ${formatTraceRecorderRoutes(traceStats.routes)}`,
    `traceRecorderLookupLeaders: ${formatTraceRecorderLookups(traceStats.lookupHitRates)}`,
    `traceRecorderRepeatedWins: ${formatTraceRecorderPatterns(traceStats.repeatedWins)}`,
    `traceRecorderRepeatedMisses: ${formatTraceRecorderPatterns(traceStats.repeatedMisses)}`,
    ...formatTraceRecorderHooks(traceStats.hooks),
  );
}

export function appendRecentTraceSection(lines, runtime, args) {
  if (args.includeRecentTraces !== true) {
    return;
  }
  const recentTraceLimit = ensureLimit(args.recentTraceLimit, 3, 50);
  const recentRecords = runtime.traceRecorder?.getRecent?.(recentTraceLimit) ?? [];
  lines.push("", "## Recent Trace Records", "", ...formatRecentTraceRecords(recentRecords));
}

export function appendRecentTrajectorySection(lines, runtime, args) {
  if (args.includeRecentTrajectoryArtifacts !== true) {
    return;
  }
  const recentTrajectoryLimit = ensureLimit(args.recentTrajectoryLimit, 5, 50);
  const trajectoryRows = runtime.db.listTrajectoryArtifacts({
    repository: runtime.repository ?? undefined,
    limit: recentTrajectoryLimit,
  });
  lines.push("", "## Recent Trajectory Artifacts", "", formatTrajectoryArtifactRows(trajectoryRows));
}

export function appendMaintenanceSections(lines, maintenance) {
  lines.push("", "## Maintenance Tasks", "", maintenance.tasks.map(formatMaintenanceTaskState).join("\n") || "- none");
  if (maintenance.recentRuns.length > 0) {
    lines.push("", "## Recent Maintenance Runs", "", formatMaintenanceRunRows(maintenance.recentRuns));
  }
}
