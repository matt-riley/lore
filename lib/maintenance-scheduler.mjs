import { processDeferredExtractions } from "./backfill.mjs";
import {
  REPLAY_CASES,
  runReplayCorpus,
  runValidationSet,
  VALIDATION_CASES,
} from "./diagnostics.mjs";
import {
  generateProposalArtifacts,
  verifyProposalArtifacts,
} from "./proposal-generator.mjs";
import { runDoctorObservation } from "./coherence-doctor.mjs";

const TASK_ORDER = Object.freeze([
  "deferredExtraction",
  "validationCorpus",
  "replayCorpus",
  "backlogReview",
  "traceCompaction",
  "indexUpkeep",
  "doctorSnapshot",
]);

const TASK_LABELS = Object.freeze({
  deferredExtraction: "Deferred Extraction",
  validationCorpus: "Validation Corpus",
  replayCorpus: "Replay Corpus",
  backlogReview: "Backlog Review",
  traceCompaction: "Trace Compaction",
  indexUpkeep: "Index Upkeep",
  doctorSnapshot: "Doctor Snapshot",
});

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(lowered)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(lowered)) {
      return false;
    }
  }
  return fallback;
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function parseTime(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedMinutesSince(value) {
  const timestamp = parseTime(value);
  if (timestamp == null) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - timestamp) / (60 * 1000)));
}

function dedupeTaskNames(taskNames = []) {
  const seen = new Set();
  const normalized = [];
  for (const value of ensureArray(taskNames)) {
    const name = typeof value === "string" ? value.trim() : "";
    if (!TASK_ORDER.includes(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function buildCaseWindow(cases, cursor, limit) {
  const boundedCases = ensureArray(cases);
  if (boundedCases.length === 0) {
    return {
      caseIds: [],
      nextCursor: 0,
      cursor: 0,
    };
  }
  const boundedLimit = clampInteger(limit, 1, { min: 1, max: boundedCases.length });
  const boundedCursor = clampInteger(cursor, 0, { min: 0, max: boundedCases.length - 1 });
  const caseIds = [];
  for (let index = 0; index < boundedLimit; index += 1) {
    const entry = boundedCases[(boundedCursor + index) % boundedCases.length];
    if (entry?.id) {
      caseIds.push(entry.id);
    }
  }
  return {
    caseIds,
    cursor: boundedCursor,
    nextCursor: boundedCases.length > 0
      ? (boundedCursor + caseIds.length) % boundedCases.length
      : 0,
  };
}

function buildMaintenanceOptions(config) {
  const maintenance = config?.maintenanceScheduler ?? config?.maintenance ?? {};
  const tasks = maintenance.tasks ?? {};
  const cadence = maintenance.taskCadenceMinutes ?? {};
  return Object.freeze({
    enabled: normalizeBoolean(maintenance.enabled, false),
    autoRunOnSessionStart: normalizeBoolean(maintenance.autoRunOnSessionStart, true),
    maxTasksPerRun: clampInteger(maintenance.maxTasksPerRun, 4, { min: 1, max: TASK_ORDER.length }),
    validationCaseLimit: clampInteger(maintenance.validationCaseLimit, 3, { min: 1, max: Math.max(1, VALIDATION_CASES.length) }),
    replayCaseLimit: clampInteger(maintenance.replayCaseLimit, 2, { min: 1, max: Math.max(1, REPLAY_CASES.length) }),
    backlogReviewLimit: clampInteger(maintenance.backlogReviewLimit, 10, { min: 1, max: 50 }),
    backlogStaleAfterHours: clampInteger(maintenance.backlogStaleAfterHours, 72, { min: 1, max: 24 * 365 }),
    tasks: {
      deferredExtraction: normalizeBoolean(tasks.deferredExtraction, true),
      validationCorpus: normalizeBoolean(tasks.validationCorpus, true),
      replayCorpus: normalizeBoolean(tasks.replayCorpus, true),
      backlogReview: normalizeBoolean(tasks.backlogReview, true),
      traceCompaction: normalizeBoolean(tasks.traceCompaction, false),
      indexUpkeep: normalizeBoolean(tasks.indexUpkeep, false),
      doctorSnapshot: normalizeBoolean(tasks.doctorSnapshot, false),
    },
    taskCadenceMinutes: {
      deferredExtraction: clampInteger(cadence.deferredExtraction, 0, { min: 0, max: 7 * 24 * 60 }),
      validationCorpus: clampInteger(cadence.validationCorpus, 12 * 60, { min: 0, max: 30 * 24 * 60 }),
      replayCorpus: clampInteger(cadence.replayCorpus, 24 * 60, { min: 0, max: 30 * 24 * 60 }),
      backlogReview: clampInteger(cadence.backlogReview, 6 * 60, { min: 0, max: 30 * 24 * 60 }),
      traceCompaction: clampInteger(cadence.traceCompaction, 60, { min: 0, max: 30 * 24 * 60 }),
      indexUpkeep: clampInteger(cadence.indexUpkeep, 12 * 60, { min: 0, max: 30 * 24 * 60 }),
      doctorSnapshot: clampInteger(cadence.doctorSnapshot, 24 * 60, { min: 0, max: 30 * 24 * 60 }),
    },
  });
}

function isTaskEnabled({ taskName, options, runtime, trigger }) {
  if (options.tasks[taskName] !== true) {
    return false;
  }
  if (taskName === "deferredExtraction") {
    if (runtime.config?.deferredExtraction?.enabled !== true) {
      return false;
    }
    if (trigger === "session_start" && runtime.config?.deferredExtraction?.autoProcessOnSessionStart !== true) {
      return false;
    }
    return true;
  }
  if (taskName === "traceCompaction") {
    return runtime.traceRecorder?.isEnabled?.() === true;
  }
  if (taskName === "doctorSnapshot") {
    return runtime.config?.rollout?.coherenceDoctor === true;
  }
  return true;
}

function buildDueEvaluation({ taskName, state, options, force = false }) {
  const cadenceMinutes = options.taskCadenceMinutes[taskName] ?? 0;
  const referenceAt = state?.last_completed_at ?? state?.last_started_at ?? null;
  if (force) {
    return {
      due: true,
      reason: "forced",
      cadenceMinutes,
      lastRunMinutesAgo: elapsedMinutesSince(referenceAt),
    };
  }
  if (!referenceAt) {
    return {
      due: true,
      reason: "never_run",
      cadenceMinutes,
      lastRunMinutesAgo: null,
    };
  }
  const ageMinutes = elapsedMinutesSince(referenceAt);
  if (cadenceMinutes === 0) {
    return {
      due: true,
      reason: "always_due",
      cadenceMinutes,
      lastRunMinutesAgo: ageMinutes,
    };
  }
  if (ageMinutes == null || ageMinutes >= cadenceMinutes) {
    return {
      due: true,
      reason: ageMinutes == null ? "due_unknown_age" : "cadence_elapsed",
      cadenceMinutes,
      lastRunMinutesAgo: ageMinutes,
    };
  }
  return {
    due: false,
    reason: "within_cadence",
    cadenceMinutes,
    lastRunMinutesAgo: ageMinutes,
    nextRunMinutes: cadenceMinutes - ageMinutes,
  };
}

function buildTaskPreview({ taskName, state, options }) {
  if (taskName === "validationCorpus") {
    return buildCaseWindow(VALIDATION_CASES, state?.cursor ?? 0, options.validationCaseLimit);
  }
  if (taskName === "replayCorpus") {
    return buildCaseWindow(REPLAY_CASES, state?.cursor ?? 0, options.replayCaseLimit);
  }
  return null;
}

function buildTaskEntry({
  taskName,
  state,
  options,
  runtime,
  trigger,
  selectedTaskNames,
  force,
}) {
  const enabled = isTaskEnabled({ taskName, options, runtime, trigger });
  const due = enabled
    ? buildDueEvaluation({ taskName, state, options, force })
    : {
      due: false,
      reason: "disabled",
      cadenceMinutes: options.taskCadenceMinutes[taskName] ?? 0,
      lastRunMinutesAgo: elapsedMinutesSince(state?.last_completed_at ?? state?.last_started_at ?? null),
    };
  const preview = buildTaskPreview({ taskName, state, options });
  return {
    taskName,
    label: TASK_LABELS[taskName] ?? taskName,
    enabled,
    selected: selectedTaskNames.includes(taskName),
    due: due.due,
    dueReason: due.reason,
    cadenceMinutes: due.cadenceMinutes,
    lastRunMinutesAgo: due.lastRunMinutesAgo,
    nextRunMinutes: due.nextRunMinutes ?? null,
    state: state ?? null,
    preview,
  };
}

export function buildMaintenancePlan({
  runtime,
  repository,
  trigger = "manual",
  requestedTasks = [],
  force = false,
} = {}) {
  const options = buildMaintenanceOptions(runtime.config);
  const taskStates = runtime.db.listMaintenanceTaskStates();
  const taskStateMap = new Map(taskStates.map((row) => [row.task_name, row]));
  const normalizedRequested = dedupeTaskNames(requestedTasks);
  const selectedTaskNames = normalizedRequested.length > 0 ? normalizedRequested : [...TASK_ORDER];

  const tasks = TASK_ORDER.map((taskName) => buildTaskEntry({
    taskName,
    state: taskStateMap.get(taskName),
    options,
    runtime,
    trigger,
    selectedTaskNames,
    force,
  }));

  const dueTasks = tasks.filter((task) => task.selected && task.enabled && task.due);
  const triggerBoundDueTasks = trigger === "session_start"
    ? dueTasks.filter((task) => task.taskName === "deferredExtraction")
    : dueTasks;
  const selectedTasks = triggerBoundDueTasks.slice(0, options.maxTasksPerRun);
  const deferredTask = tasks.find((task) => task.taskName === "deferredExtraction") ?? null;

  return {
    generatedAt: nowIso(),
    repository: repository ?? null,
    trigger,
    enabled: options.enabled,
    autoRunOnSessionStart: options.autoRunOnSessionStart,
    maxTasksPerRun: options.maxTasksPerRun,
    tasks,
    dueTasks: triggerBoundDueTasks,
    selectedTasks,
    deferredTask,
    skippedDueToCap: Math.max(0, triggerBoundDueTasks.length - selectedTasks.length),
    requestedTasks: normalizedRequested,
    force,
    recentRuns: runtime.db.listMaintenanceRuns({ limit: 5 }),
  };
}

function summarizeArtifacts(artifacts) {
  return ensureArray(artifacts).map((artifact) => ({
    id: artifact.id,
    sourceKind: artifact.sourceKind,
    sourceCaseId: artifact.sourceCaseId,
    title: artifact.title,
  }));
}

async function executeTask({
  taskName,
  runtime,
  repository,
  entry,
  options,
}) {
  if (taskName === "deferredExtraction") {
    const result = processDeferredExtractions({
      db: runtime.db,
      sessionStore: runtime.sessionStore,
      repository: runtime.config?.deferredExtraction?.processCurrentRepositoryOnly === false
        ? null
        : repository,
      limit: clampInteger(
        runtime.config?.deferredExtraction?.maxJobsPerRun,
        2,
        { min: 1, max: 20 },
      ),
      retryDelayMinutes: clampInteger(
        runtime.config?.deferredExtraction?.retryDelayMinutes,
        15,
        { min: 0, max: 24 * 60 },
      ),
    });
    const stats = runtime.db.getStats();
    return {
      status: result.failed > 0 ? "needs_attention" : "completed",
      cursor: entry.state?.cursor ?? 0,
      summary: {
        ...result,
        pendingAfter: stats.deferredPendingCount,
        failedAfter: stats.deferredFailedCount,
        completedAfter: stats.deferredCompletedCount,
      },
    };
  }

  if (taskName === "validationCorpus") {
    const preview = entry.preview ?? buildCaseWindow(VALIDATION_CASES, entry.state?.cursor ?? 0, options.validationCaseLimit);
    const result = await runValidationSet({
      runtime,
      caseIds: preview.caseIds,
    });
    return {
      status: result.failed > 0 ? "needs_attention" : "completed",
      cursor: preview.nextCursor,
      summary: {
        caseIds: preview.caseIds,
        total: result.total,
        passed: result.passed,
        failed: result.failed,
        improvementArtifacts: summarizeArtifacts(result.improvementArtifacts),
        generatedAt: result.generatedAt,
      },
    };
  }

  if (taskName === "replayCorpus") {
    const preview = entry.preview ?? buildCaseWindow(REPLAY_CASES, entry.state?.cursor ?? 0, options.replayCaseLimit);
    const result = await runReplayCorpus({
      runtime,
      caseIds: preview.caseIds,
    });
    const needsAttention = result.mustPassFailed > 0
      || result.rankingTargetMissing > 0
      || result.rankingTargetPartial > 0;
    return {
      status: needsAttention ? "needs_attention" : "completed",
      cursor: preview.nextCursor,
      summary: {
        caseIds: preview.caseIds,
        total: result.total,
        mustPassFailed: result.mustPassFailed,
        rankingTargetPartial: result.rankingTargetPartial,
        rankingTargetMissing: result.rankingTargetMissing,
        improvementArtifacts: summarizeArtifacts(result.improvementArtifacts),
        generatedAt: result.generatedAt,
      },
    };
  }

  if (taskName === "backlogReview") {
    const staleBefore = new Date(Date.now() - (options.backlogStaleAfterHours * 60 * 60 * 1000)).toISOString();
    const staleArtifacts = runtime.db.listImprovementArtifacts({
      status: "active",
      updatedBefore: staleBefore,
      sort: "updated_asc",
      limit: options.backlogReviewLimit,
    });
    const stats = runtime.db.getStats();
    const proposalGeneration = await generateProposalArtifacts({
      runtime,
      ids: staleArtifacts.map((artifact) => artifact.id),
      limit: options.backlogReviewLimit,
      updatedBefore: staleBefore,
    });
    const integrity = await verifyProposalArtifacts({
      runtime,
      limit: options.backlogReviewLimit,
      repair: false,
    });
    const needsAttention = staleArtifacts.length > 0
      || proposalGeneration.generatedCount > 0
      || integrity.issueCount > 0;
    return {
      status: needsAttention ? "needs_attention" : "completed",
      cursor: entry.state?.cursor ?? 0,
      summary: {
        reviewLimit: options.backlogReviewLimit,
        staleAfterHours: options.backlogStaleAfterHours,
        activeCount: stats.improvementActiveCount ?? 0,
        proposalCount: stats.improvementProposalCount ?? 0,
        staleCount: staleArtifacts.length,
        staleArtifacts: staleArtifacts.map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          sourceKind: artifact.source_kind,
          updatedAt: artifact.updated_at,
        })),
        proposalGeneration,
        integrity,
      },
    };
  }

  if (taskName === "traceCompaction") {
    const result = runtime.traceRecorder?.compact?.();
    return {
      status: "completed",
      cursor: entry.state?.cursor ?? 0,
      summary: result ?? {
        storedBefore: 0,
        storedAfter: 0,
        expiredRemoved: 0,
        totalRecorded: 0,
      },
    };
  }

  if (taskName === "indexUpkeep") {
    const result = runtime.db.runIndexUpkeep();
    return {
      status: "completed",
      cursor: entry.state?.cursor ?? 0,
      summary: result,
    };
  }

  if (taskName === "doctorSnapshot") {
    const result = runDoctorObservation({
      runtime,
      repository,
      dryRun: false,
      trajectoryLimit: 20,
    });
    return {
      status: result.incidentCount > 0 ? "needs_attention" : "completed",
      cursor: entry.state?.cursor ?? 0,
      summary: {
        incidentCount: result.incidentCount,
        criticalCount: result.criticalCount,
        warningCount: result.warningCount,
        infoCount: result.infoCount,
        recordedArtifactId: result.recordedArtifactId,
        generatedAt: result.generatedAt,
      },
    };
  }

  throw new Error(`unsupported maintenance task: ${taskName}`);
}

function summarizeRunStatus({ completedCount, needsAttentionCount, failedCount, skippedCount }) {
  if (failedCount > 0) {
    return "failed";
  }
  if (needsAttentionCount > 0) {
    return "needs_attention";
  }
  if (completedCount > 0) {
    return "completed";
  }
  return skippedCount > 0 ? "skipped" : "idle";
}

export async function runMaintenanceSweep({
  runtime,
  repository,
  trigger = "manual",
  requestedTasks = [],
  force = false,
  dryRun = false,
} = {}) {
  const plan = buildMaintenancePlan({
    runtime,
    repository,
    trigger,
    requestedTasks,
    force,
  });

  if (!plan.enabled) {
    return {
      generatedAt: plan.generatedAt,
      repository: plan.repository,
      trigger,
      dryRun,
      status: "disabled",
      taskCount: 0,
      completedCount: 0,
      needsAttentionCount: 0,
      failedCount: 0,
      skippedCount: plan.tasks.filter((task) => task.selected).length,
      tasks: [],
      plan,
    };
  }

  if (dryRun || plan.selectedTasks.length === 0) {
    return {
      generatedAt: plan.generatedAt,
      repository: plan.repository,
      trigger,
      dryRun,
      status: plan.selectedTasks.length === 0 ? "skipped" : "planned",
      taskCount: plan.selectedTasks.length,
      completedCount: 0,
      needsAttentionCount: 0,
      failedCount: 0,
      skippedCount: Math.max(0, plan.tasks.filter((task) => task.selected).length - plan.selectedTasks.length),
      tasks: plan.selectedTasks.map((task) => ({
        taskName: task.taskName,
        label: task.label,
        status: "planned",
        durationMs: 0,
        summary: task.preview ? { caseIds: task.preview.caseIds } : null,
      })),
      plan,
    };
  }

  const runId = runtime.db.createMaintenanceRun({
    trigger,
    repository,
    dryRun: false,
    plannedTasks: plan.selectedTasks.map((task) => task.taskName),
  });

  const tasks = [];
  let completedCount = 0;
  let needsAttentionCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const entry of plan.selectedTasks) {
    const startedAt = nowIso();
    runtime.db.recordMaintenanceTaskStart({
      taskName: entry.taskName,
      trigger,
      repository,
      startedAt,
    });
    const durationStartedAt = Date.now();
    try {
      const execution = await executeTask({
        taskName: entry.taskName,
        runtime,
        repository,
        entry,
        options: buildMaintenanceOptions(runtime.config),
      });
      const durationMs = Date.now() - durationStartedAt;
      runtime.db.recordMaintenanceTaskResult({
        taskName: entry.taskName,
        status: execution.status,
        trigger,
        repository,
        startedAt,
        completedAt: nowIso(),
        durationMs,
        cursor: execution.cursor,
        summary: execution.summary,
      });
      if (execution.status === "needs_attention") {
        needsAttentionCount += 1;
      } else if (execution.status === "skipped") {
        skippedCount += 1;
      } else {
        completedCount += 1;
      }
      tasks.push({
        taskName: entry.taskName,
        label: entry.label,
        status: execution.status,
        durationMs,
        summary: execution.summary,
      });
    } catch (error) {
      const durationMs = Date.now() - durationStartedAt;
      const message = error instanceof Error ? error.message : String(error);
      runtime.db.recordMaintenanceTaskResult({
        taskName: entry.taskName,
        status: "failed",
        trigger,
        repository,
        startedAt,
        completedAt: nowIso(),
        durationMs,
        cursor: entry.state?.cursor ?? 0,
        summary: {
          error: message,
        },
      });
      failedCount += 1;
      tasks.push({
        taskName: entry.taskName,
        label: entry.label,
        status: "failed",
        durationMs,
        summary: {
          error: message,
        },
      });
    }
  }

  const status = summarizeRunStatus({
    completedCount,
    needsAttentionCount,
    failedCount,
    skippedCount,
  });
  const completedAt = nowIso();
  runtime.db.completeMaintenanceRun({
    runId,
    status,
    repository,
    completedAt,
    completedCount,
    needsAttentionCount,
    failedCount,
    skippedCount,
    summary: {
      repository,
      trigger,
      tasks,
    },
  });

  return {
    generatedAt: plan.generatedAt,
    repository: plan.repository,
    trigger,
    dryRun: false,
    runId,
    status,
    taskCount: tasks.length,
    completedCount,
    needsAttentionCount,
    failedCount,
    skippedCount,
    tasks,
    completedAt,
    plan,
  };
}

export function getMaintenanceStatus({
  runtime,
  repository,
} = {}) {
  const plan = buildMaintenancePlan({
    runtime,
    repository,
    trigger: "status",
    requestedTasks: [],
    force: false,
  });
  return {
    generatedAt: plan.generatedAt,
    repository: plan.repository,
    enabled: plan.enabled,
    autoRunOnSessionStart: plan.autoRunOnSessionStart,
    maxTasksPerRun: plan.maxTasksPerRun,
    dueTasks: plan.dueTasks,
    selectedTasks: plan.selectedTasks,
    skippedDueToCap: plan.skippedDueToCap,
    recentRuns: plan.recentRuns,
    tasks: plan.tasks,
  };
}
