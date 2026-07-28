import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

import { loadConfig, normalizeBoolean, clampInteger } from "./lib/config.mjs";
import {
  applySessionExtraction,
  buildSessionStartBackfillDecision,
  buildSessionStartBackfillPreview,
  processControlledBackfillRun,
  processDeferredExtractions,
  startControlledBackfillRun,
  summarizeBackfillRunProgress,
} from "./lib/backfill.mjs";
import { LoreDb } from "./lib/db.mjs";
import { runMaintenanceSweep } from "./lib/maintenance-scheduler.mjs";
import { recallMemory } from "./lib/memory-operations.mjs";
import { createMemoryTools } from "./lib/memory-tools.mjs";
import {
  buildProceduralProfile,
  detectRelevantInstructionFiles,
} from "./lib/procedural-memory.mjs";
import { SessionStoreReader } from "./lib/session-store-reader.mjs";
import { createTraceRecorder } from "./lib/trace-recorder.mjs";
import {
  readWorkspaceContext,
  resolveWorkspacePath,
} from "./lib/workspace-reader.mjs";
import { assembleMemoryCapsule, detectPromptContextNeed } from "./lib/capsule-assembler.mjs";
import { hydrateWorkstreamOverlay } from "./lib/overlay-hydrator.mjs";
import { seedOnboardingMemories } from "./lib/onboarding.mjs";
import {
  readOverlayAutoHydrationEnabled,
  readErrorTelemetryEnabled,
  readPostToolUseEnabled,
  readSubagentScopeTrackingEnabled,
} from "./lib/rollout-flags.mjs";
import {
  buildErrorTelemetryRecord,
  buildPostToolUseObservation,
} from "./lib/passive-hooks.mjs";
import { createSubagentScopeTracker } from "./lib/subagent-scope-tracker.mjs";
import { runPreToolUseGuardrail } from "./lib/pre-tool-use-guardrail.mjs";
import { consumeLatestMemoryHygieneSummary } from "./lib/memory-hygiene.mjs";
import { setTimeout as delay } from "node:timers/promises";

let lastKnownCwd = process.cwd();

const metrics = {
  sessionStartMs: [],
  userPromptSubmittedMs: [],
  errorTelemetryMs: [],
  postToolUseMs: [],
  preToolUseMs: [],
};

const capsuleCache = new Map();
const ambientStylePresenceCache = new Map();
const surfacedHygieneSummaryBySession = new Map();

const logOnceKeys = new Set();

function combineContextSections(...sections) {
  return sections
    .map((section) => String(section ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function consumeSessionHygieneSummary(db, repository, sessionId) {
  const result = consumeLatestMemoryHygieneSummary({
    db,
    repository,
    lastSurfacedArtifactId: surfacedHygieneSummaryBySession.get(sessionId) ?? null,
  });
  if (result) {
    surfacedHygieneSummaryBySession.set(sessionId, result.artifactId);
  }
  return result?.text ?? "";
}

const runtime = {
  initialized: false,
  config: null,
  db: null,
  sessionStore: null,
  traceRecorder: null,
  lastError: null,
  lastBackupPath: null,
  processingDeferred: false,
  processingMaintenance: false,
  processingBackfill: false,
  tracePersistenceWrites: 0,
  errorTelemetryWrites: 0,
  pendingWork: new Set(),
  shuttingDown: false,
};

/**
 * Register a background promise in the runtime tracking set.
 * The promise is removed automatically when it settles so the set only
 * contains in-flight work.
 *
 * @param {Promise<unknown>} promise
 */
function trackBackgroundWork(promise) {
  runtime.pendingWork.add(promise);
  promise.finally(() => {
    runtime.pendingWork.delete(promise);
  });
}

/**
 * Spawn a tracked microtask.  The async function is called via
 * Promise.resolve() so it runs in the next microtask checkpoint, equivalent
 * to queueMicrotask, but the resulting promise is registered in
 * runtime.pendingWork so shutdownRuntime can drain it.
 *
 * Returns without spawning if shutdown has already been requested.
 *
 * @param {() => Promise<unknown>} fn
 */
function spawnTrackedMicrotask(fn) {
  if (runtime.shuttingDown) {
    return;
  }
  trackBackgroundWork(Promise.resolve().then(fn));
}

/**
 * Spawn a tracked deferred task via setTimeout(0).  Equivalent to the
 * existing setTimeout(async () => {...}, 0) pattern, but the resulting
 * promise is registered in runtime.pendingWork so shutdownRuntime can drain
 * it.
 *
 * Returns without spawning if shutdown has already been requested.
 *
 * @param {() => Promise<unknown>} fn
 */
function spawnTrackedDeferredTask(fn) {
  if (runtime.shuttingDown) {
    return;
  }
  const p = new Promise((resolve, reject) => {
    setTimeout(() => {
      Promise.resolve().then(fn).then(resolve, reject);
    }, 0);
  });
  trackBackgroundWork(p);
}

/**
 * Initiate a bounded shutdown of the extension runtime.
 *
 * Marks the runtime as shutting down (so no new background work is spawned),
 * waits up to gracePeriodMs for any in-flight background jobs to settle, then
 * closes the database exactly once.  Safe to call multiple times — the flag
 * ensures only the first invocation does real work.
 *
 * @param {object} session - Copilot session (used for graceful drain logs)
 * @param {number} [gracePeriodMs=4000]
 */
async function shutdownRuntime(session, gracePeriodMs = 4000) {
  if (runtime.shuttingDown) {
    return;
  }
  runtime.shuttingDown = true;

  if (runtime.pendingWork.size > 0) {
    await Promise.race([
      Promise.allSettled([...runtime.pendingWork]),
      delay(gracePeriodMs),
    ]);
  }

  try {
    runtime.db?.close();
  } catch {
    // best-effort close; never rethrow from shutdown path
  }
  runtime.db = null;
}

function recordMetric(values, value, windowSize) {
  values.push(value);
  if (values.length > windowSize) {
    values.splice(0, values.length - windowSize);
  }
}

function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p)),
  );
  return sorted[index];
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function cacheKey(parts) {
  return parts.map((part) => String(part ?? "")).join("::");
}

function readCache(map, key) {
  const hit = map.get(key);
  if (!hit) {
    return null;
  }
  if (hit.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(map, key, value, ttlMs, maxEntries = 32) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey) {
      map.delete(oldestKey);
    }
  }
  return value;
}

function buildDbWatermark(db) {
  if (!db) {
    return "none";
  }
  const stats = db.getStats();
  return [
    stats.semanticCount ?? 0,
    stats.episodeCount ?? 0,
    stats.daySummaryCount ?? 0,
    stats.improvementCount ?? 0,
  ].join("/");
}

function buildLatencyTrend(values) {
  if (values.length === 0) {
    return {
      recentAverageMs: 0,
      previousAverageMs: 0,
      deltaMs: 0,
      trend: "no_samples",
    };
  }

  const windowSize = Math.max(1, Math.min(10, Math.floor(values.length / 2) || 1));
  const recentValues = values.slice(-windowSize);
  const previousValues = values.slice(-(windowSize * 2), -windowSize);
  const recentAverageMs = Math.round(average(recentValues));
  const previousAverageMs = previousValues.length > 0
    ? Math.round(average(previousValues))
    : 0;
  const deltaMs = previousValues.length > 0 ? recentAverageMs - previousAverageMs : 0;
  const trend = previousValues.length === 0
    ? "insufficient_history"
    : Math.abs(deltaMs) <= 5
      ? "flat"
      : deltaMs > 0
        ? "rising"
        : "falling";

  return {
    recentAverageMs,
    previousAverageMs,
    deltaMs,
    trend,
  };
}

function buildLatencyMetric(values, minSamples, targetMs) {
  const samples = values.length;
  const p95Ms = Math.round(percentile(values, 0.95));
  const ready = samples >= minSamples;
  const { recentAverageMs, previousAverageMs, deltaMs, trend } = buildLatencyTrend(values);
  return {
    averageMs: Math.round(average(values)),
    p50Ms: Math.round(percentile(values, 0.5)),
    p95Ms,
    maxMs: Math.round(samples > 0 ? Math.max(...values) : 0),
    latestMs: Math.round(values.at(-1) ?? 0),
    samples,
    minSamples,
    targetMs,
    ready,
    readiness: ready ? "ready" : "insufficient_samples",
    targetStatus: ready
      ? (p95Ms <= targetMs ? "within_target" : "above_target")
      : "warming_up",
    recentAverageMs,
    previousAverageMs,
    trendDeltaMs: deltaMs,
    trend,
  };
}

function buildSimpleLatencyMetric(values) {
  const samples = values.length;
  return {
    samples,
    averageMs: Math.round(average(values)),
    p95Ms: Math.round(percentile(values, 0.95)),
    maxMs: Math.round(samples > 0 ? Math.max(...values) : 0),
    latestMs: Math.round(values.at(-1) ?? 0),
  };
}

function buildLatencyMetrics(config) {
  const minSamples = {
    sessionStart: Math.max(1, Number(config?.latencyReadinessMinSamples?.sessionStart ?? 20)),
    userPromptSubmitted: Math.max(
      1,
      Number(config?.latencyReadinessMinSamples?.userPromptSubmitted ?? 50),
    ),
  };
  const sessionStartTargetMs = Math.max(0, Number(config?.latencyTargetsMs?.sessionStartP95 ?? 100));
  const userPromptSubmittedTargetMs = Math.max(
    0,
    Number(config?.latencyTargetsMs?.userPromptSubmittedP95 ?? 150),
  );
  const userPromptSubmitted = buildLatencyMetric(
    metrics.userPromptSubmittedMs,
    minSamples.userPromptSubmitted,
    userPromptSubmittedTargetMs,
  );
  const sessionStartWithTarget = buildLatencyMetric(
    metrics.sessionStartMs,
    minSamples.sessionStart,
    sessionStartTargetMs,
  );

  return {
    sessionStart: sessionStartWithTarget,
    userPromptSubmitted,
    sessionStartP95: sessionStartWithTarget.p95Ms,
    userPromptSubmittedP95: userPromptSubmitted.p95Ms,
    sampleSize: {
      sessionStart: sessionStartWithTarget.samples,
      userPromptSubmitted: userPromptSubmitted.samples,
    },
    passiveHooks: {
      errorTelemetry: buildSimpleLatencyMetric(metrics.errorTelemetryMs),
      postToolUse: buildSimpleLatencyMetric(metrics.postToolUseMs),
    },
  };
}

function readSessionStartBackfillOptions(config) {
  const raw = config?.maintenanceScheduler?.sessionStartBackfill ?? {};
  return {
    enabled: normalizeBoolean(raw.enabled, false),
    includeOtherRepositories: normalizeBoolean(raw.includeOtherRepositories, true),
    refreshExisting: normalizeBoolean(raw.refreshExisting, false),
    batchSize: clampInteger(raw.batchSize, 25, { min: 1, max: 500 }),
    maxCandidates: clampInteger(raw.maxCandidates, 250, { min: 1, max: 10_000 }),
    maxInspected: clampInteger(raw.maxInspected, 2000, { min: 1, max: 100_000 }),
    notifyEveryItems: clampInteger(raw.notifyEveryItems, 50, { min: 1, max: 10_000 }),
  };
}

function formatSessionStartBackfillScopeLabel(repository, includeOtherRepositories) {
  if (includeOtherRepositories || !repository) {
    return "all repositories";
  }
  return repository;
}

function readBackfillRunIncludeOtherRepositories(run, fallback) {
  if (typeof run?.include_other_repositories === "number") {
    return run.include_other_repositories === 1;
  }
  if (typeof run?.includeOtherRepositories === "boolean") {
    return run.includeOtherRepositories;
  }
  return fallback;
}

function buildSessionStartBackfillScopeDescription({
  run,
  repository,
  includeOtherRepositories,
  currentScopeLabel = null,
}) {
  const runScopeLabel = formatSessionStartBackfillScopeLabel(
    run?.repository ?? repository,
    readBackfillRunIncludeOtherRepositories(run, includeOtherRepositories),
  );
  if (currentScopeLabel && runScopeLabel !== currentScopeLabel) {
    return `${runScopeLabel} (current session: ${currentScopeLabel})`;
  }
  return runScopeLabel;
}

function buildSessionStartBackfillProgressMessage({ run, scopeLabel }) {
  const progress = summarizeBackfillRunProgress(run);
  const base = `lore archive import progress for ${scopeLabel}: ${progress.completedCount}/${progress.totalCount} (${progress.progressPercent}%), created ${progress.createdCount}, refreshed ${progress.refreshedCount}, failed ${progress.failedCount}`;
  if (run.status === "completed") {
    return `${base} — complete${run.snapshot_path ? ` (snapshot: ${run.snapshot_path})` : ""}`;
  }
  if (run.status === "failed") {
    return `${base} — failed${run.last_error ? ` (last error: ${run.last_error})` : ""}`;
  }
  return base;
}

async function loadSessionStartBackfillDecisionState({ activeRuntime, repository, options }) {
  const latestRun = activeRuntime.db.listBackfillRuns({ limit: 1 })[0] ?? null;
  let preview = null;
  const decision = latestRun?.status === "running"
    ? buildSessionStartBackfillDecision({ preview: null, latestRun })
    : (() => null)();
  if (decision) {
    return {
      latestRun,
      preview,
      decision,
    };
  }

  preview = await buildSessionStartBackfillPreview({
    db: activeRuntime.db,
    sessionStore: activeRuntime.sessionStore,
    repository,
    includeOtherRepositories: options.includeOtherRepositories,
    maxCandidates: options.maxCandidates,
    maxInspected: options.maxInspected,
    refreshExisting: options.refreshExisting,
  });

  return {
    latestRun,
    preview,
    decision: buildSessionStartBackfillDecision({ preview, latestRun }),
  };
}

function shouldReportSessionStartBackfillProgress({
  force = false,
  currentRun,
  progress,
  lastReportedCompleted,
  hasReportedIntermediateProgress,
  notifyEveryItems,
}) {
  const isTerminal = currentRun.status === "completed" || currentRun.status === "failed";
  const reachedNotifyThreshold = (progress.completedCount - lastReportedCompleted) >= notifyEveryItems;
  return force
    || isTerminal
    || (!hasReportedIntermediateProgress && progress.completedCount > 0)
    || reachedNotifyThreshold;
}

async function reportSessionStartBackfillProgress({
  session,
  currentRun,
  repository,
  options,
  currentScopeLabel,
  state,
  force = false,
}) {
  const progress = summarizeBackfillRunProgress(currentRun);
  const shouldReport = shouldReportSessionStartBackfillProgress({
    force,
    currentRun,
    progress,
    lastReportedCompleted: state.lastReportedCompleted,
    hasReportedIntermediateProgress: state.hasReportedIntermediateProgress,
    notifyEveryItems: options.notifyEveryItems,
  });
  if (!shouldReport) {
    return state;
  }

  const isTerminal = currentRun.status === "completed" || currentRun.status === "failed";
  const nextState = {
    lastReportedCompleted: progress.completedCount,
    hasReportedIntermediateProgress: state.hasReportedIntermediateProgress || !isTerminal,
  };
  const scopeDescription = buildSessionStartBackfillScopeDescription({
    run: currentRun,
    repository,
    includeOtherRepositories: options.includeOtherRepositories,
    currentScopeLabel,
  });
  await session.log(
    buildSessionStartBackfillProgressMessage({
      run: currentRun,
      scopeLabel: scopeDescription,
    }),
    {
      ephemeral: true,
      ...(currentRun.status === "failed" ? { level: "warning" } : {}),
    },
  );
  return nextState;
}

async function waitForSessionStartBackfillDependencies(activeRuntime) {
  while (activeRuntime.processingMaintenance || activeRuntime.processingDeferred) {
    await delay(25);
  }
}

async function initializeSessionStartBackfillRun({
  session,
  activeRuntime,
  repository,
  options,
  currentScopeLabel,
  latestRun,
  preview,
  decision,
}) {
  if (decision.action === "resume") {
    const run = latestRun;
    const progress = summarizeBackfillRunProgress(run);
    const scopeDescription = buildSessionStartBackfillScopeDescription({
      run,
      repository,
      includeOtherRepositories: options.includeOtherRepositories,
      currentScopeLabel,
    });
    await session.log(
      `lore archive import resumed for ${scopeDescription}: ${progress.completedCount}/${progress.totalCount} (${progress.progressPercent}%)`,
      { ephemeral: true },
    );
    return {
      run,
      state: {
        lastReportedCompleted: progress.completedCount,
        hasReportedIntermediateProgress: false,
      },
    };
  }

  await session.log(
    decision.reason === "partial_candidates"
      ? `lore archive import started for ${currentScopeLabel}: 0/${decision.candidateCount} session(s) queued after a bounded preview scanned ${preview?.inspected ?? 0}/${preview?.inspectionLimit ?? options.maxInspected} session(s). Progress updates will appear here.`
      : `lore archive import started for ${currentScopeLabel}: 0/${decision.candidateCount} session(s) queued. Progress updates will appear here.`,
    { ephemeral: true },
  );
  return {
    run: startControlledBackfillRun({
      db: activeRuntime.db,
      sessionStore: activeRuntime.sessionStore,
      repository,
      includeOtherRepositories: options.includeOtherRepositories,
      limit: options.maxCandidates,
      refreshExisting: options.refreshExisting,
      batchSize: options.batchSize,
      plan: preview,
      snapshotPolicy: "never",
    }).run,
    state: {
      lastReportedCompleted: 0,
      hasReportedIntermediateProgress: false,
    },
  };
}

async function drainSessionStartBackfillRun({
  session,
  activeRuntime,
  repository,
  options,
  currentScopeLabel,
  run,
  state,
}) {
  let currentRun = run;
  let currentState = await reportSessionStartBackfillProgress({
    session,
    currentRun,
    repository,
    options,
    currentScopeLabel,
    state,
    force: currentRun.status === "completed" || currentRun.status === "failed",
  });

  while (currentRun.status === "running") {
    currentRun = processControlledBackfillRun({
      db: activeRuntime.db,
      sessionStore: activeRuntime.sessionStore,
      runId: currentRun.id,
      limit: options.batchSize,
      retryFailed: true,
    }).run;
    currentState = await reportSessionStartBackfillProgress({
      session,
      currentRun,
      repository,
      options,
      currentScopeLabel,
      state: currentState,
    });
    if (currentRun.status === "running") {
      // Yield between synchronous batches so session-start import stays cooperative.
      await delay(0);
    }
  }

  await reportSessionStartBackfillProgress({
    session,
    currentRun,
    repository,
    options,
    currentScopeLabel,
    state: currentState,
    force: true,
  });
}

async function runSessionStartBackfillWork({
  session,
  activeRuntime,
  repository,
  options,
  currentScopeLabel,
}) {
  await waitForSessionStartBackfillDependencies(activeRuntime);

  const { latestRun, preview, decision } = await loadSessionStartBackfillDecisionState({
    activeRuntime,
    repository,
    options,
  });
  if (decision.action === "skip") {
    if (decision.reason === "inspection_bound") {
      await session.log(
        `lore archive import deferred for ${currentScopeLabel}: inspected ${preview?.inspected ?? 0}/${preview?.inspectionLimit ?? options.maxInspected} session(s) without finding pending candidates. More history remains for future startup sweeps.`,
        { ephemeral: true },
      );
    }
    return;
  }

  const { run, state } = await initializeSessionStartBackfillRun({
    session,
    activeRuntime,
    repository,
    options,
    currentScopeLabel,
    latestRun,
    preview,
    decision,
  });
  await drainSessionStartBackfillRun({
    session,
    activeRuntime,
    repository,
    options,
    currentScopeLabel,
    run,
    state,
  });
}

function buildTraceRecorderEligibility(repository, promptNeed) {
  return {
    local: repository ? ["global", `repo:${repository}`] : ["global"],
    crossRepo: promptNeed?.allowCrossRepoFallback === true ? ["transferable"] : [],
  };
}

function buildBypassTrace({ repository, promptNeed, reason }) {
  return {
    mode: "prompt_submit_bypass",
    repository,
    promptNeed,
    eligibility: buildTraceRecorderEligibility(repository, promptNeed),
    lookups: {},
    omissions: [{ stage: "prompt_context", reason }],
    output: {
      sectionTitles: [],
      sectionDetails: [],
      estimatedTokens: 0,
    },
    routerDecision: {
      route: "no_lookup",
      reason,
      includeOtherRepositories: false,
      usedWorkstreamOverlays: false,
      usedLegacyPath: false,
      additionalContext: false,
      sectionCount: 0,
    },
  };
}

async function logOnce(session, key, message, level = "warning") {
  if (logOnceKeys.has(key)) {
    return;
  }
  logOnceKeys.add(key);
  await session.log(message, { ephemeral: true, level });
}

async function ensureRuntime(session) {
  if (runtime.initialized) {
    return runtime;
  }

  try {
    runtime.config = await loadConfig();
    runtime.db = new LoreDb(runtime.config);
    const initResult = runtime.db.initialize();
    runtime.lastBackupPath = initResult.backupPath ?? null;

    runtime.sessionStore = new SessionStoreReader(runtime.config);
    runtime.sessionStore.initialize();
    runtime.traceRecorder = createTraceRecorder(runtime.config);

    runtime.initialized = true;
    runtime.lastError = null;

    await session.log("lore initialized", { ephemeral: true });
    return runtime;
  } catch (error) {
    runtime.lastError = error instanceof Error ? error : new Error(String(error));
    await logOnce(
      session,
      "lore-init-failed",
      `lore unavailable; hooks will fail open: ${runtime.lastError.message}`,
    );
    return runtime;
  }
}

async function getContext(session, sessionId, cwd) {
  const activeRuntime = await ensureRuntime(session);
  const workspacePath = resolveWorkspacePath(
    session.workspacePath,
    sessionId,
    activeRuntime.config?.paths?.copilotHome,
  );
  const workspace = await readWorkspaceContext(workspacePath);
  const repository = workspace.workspace?.repository ?? null;

  return {
    runtime: activeRuntime,
    workspacePath,
    workspace,
    repository,
    cwd: cwd || lastKnownCwd,
  };
}

function hooksEnabled(config) {
  return config?.enabled === true;
}

function shouldEmitLatencyWarning(metric) {
  if (!metric || metric.ready !== true) {
    return false;
  }
  return metric.targetStatus === "above_target";
}

function buildLatencyWarning(hookName, measuredMs, targetMs) {
  if (measuredMs <= targetMs) {
    return null;
  }
  return `${hookName} exceeded latency target (${Math.round(measuredMs)}ms > ${targetMs}ms)`;
}

function writeActivitySuccessUpdates({ db, repository, updates }) {
  db.upsertActivitySuccess({ repository, updates });
  db.upsertActivitySuccess({ repository: null, updates });
}

function buildTraceSuccessUpdates({ traceRecord, traceId, durationMs, hook }) {
  const recordedAt = traceRecord.recordedAt ?? new Date().toISOString();
  const traceUpdates = {
    lastTraceRecordedAt: recordedAt,
    lastTraceHook: hook,
    lastTraceId: traceId,
  };
  const sectionTitles = traceRecord?.output?.sectionTitles ?? [];
  const contextInjected = traceRecord?.output?.contextInjected === true;
  const contextInjectionUpdates = contextInjected || sectionTitles.length > 0
    ? {
      lastContextInjectionAt: recordedAt,
      lastContextInjectionHook: hook,
      lastContextInjectionSections: sectionTitles,
      lastContextInjectionTraceId: traceId,
      lastContextInjectionDurationMs: durationMs,
    }
    : null;

  return {
    recordedAt,
    traceUpdates,
    contextInjectionUpdates,
  };
}

function persistDurableTraceSample({
  activeRuntime,
  repository,
  traceRecord,
  traceId,
  hook,
  recordedAt,
}) {
  activeRuntime.db.insertRetrievalTraceSample(buildDurableTraceSamplePayload({
    repository,
    traceRecord,
    traceId,
    hook,
    recordedAt,
  }));

  maybePruneDurableTraceSamples({
    activeRuntime,
    repository,
  });
}

function buildDurableTraceSampleRecordFields(traceRecord) {
  const rec = traceRecord ?? {};
  const { routerDecision = {}, output = {}, latencyMs = null, promptPreview = "" } = rec;
  return {
    route: routerDecision.route ?? null,
    routeReason: routerDecision.reason ?? null,
    contextInjected: output.contextInjected === true,
    latencyMs,
    promptPreview,
    sectionTitles: output.sectionTitles ?? [],
  };
}

function buildDurableTraceSampleEvidenceFields(traceRecord) {
  const { promptNeed = {}, eligibility = {}, lookups = {}, omissions = [], output = {}, mode = null } = traceRecord ?? {};
  return { promptNeed, eligibility, lookups, omissions, output, trace: { mode } };
}

function buildDurableTraceSamplePayload({
  repository,
  traceRecord,
  traceId,
  hook,
  recordedAt,
}) {
  return {
    id: traceId,
    repository,
    scopeType: repository ? "repo" : "global",
    hook,
    ...buildDurableTraceSampleRecordFields(traceRecord),
    ...buildDurableTraceSampleEvidenceFields(traceRecord),
    recordedAt,
  };
}

function maybePruneDurableTraceSamples({ activeRuntime, repository }) {
  activeRuntime.tracePersistenceWrites = (activeRuntime.tracePersistenceWrites ?? 0) + 1;
  const shouldPrune = activeRuntime.tracePersistenceWrites % 10 === 0;
  if (!shouldPrune) {
    return;
  }

  activeRuntime.db.pruneRetrievalTraceSamples({
    repository,
    maxRowsPerRepository: activeRuntime.config?.traceRecorder?.durableMaxRowsPerRepository ?? 120,
    maxRowsGlobal: activeRuntime.config?.traceRecorder?.durableMaxRowsGlobal ?? 240,
    maxAgeMs: activeRuntime.config?.traceRecorder?.durableMaxAgeMs ?? (14 * 24 * 60 * 60 * 1000),
  });
}

function persistTraceContextInjectionUpdates(activeRuntime, repository, contextInjectionUpdates) {
  if (!contextInjectionUpdates) {
    return;
  }
  writeActivitySuccessUpdates({
    db: activeRuntime.db,
    repository,
    updates: contextInjectionUpdates,
  });
}

function resolveTraceSuccessRecord(traceResult) {
  const traceRecord = traceResult.record ?? null;
  return {
    traceRecord,
    traceId: traceResult.id ?? traceRecord?.id ?? null,
  };
}

function persistTraceSuccess({ activeRuntime, repository, traceResult, durationMs, hook, session }) {
  if (!activeRuntime?.db || !traceResult || typeof traceResult !== "object") {
    return;
  }
  const { traceRecord, traceId } = resolveTraceSuccessRecord(traceResult);
  if (!traceRecord) {
    return;
  }

  spawnTrackedMicrotask(async () => {
    try {
      const { recordedAt, traceUpdates, contextInjectionUpdates } = buildTraceSuccessUpdates({
        traceRecord,
        traceId,
        durationMs,
        hook,
      });
      writeActivitySuccessUpdates({
        db: activeRuntime.db,
        repository,
        updates: traceUpdates,
      });
      persistTraceContextInjectionUpdates(activeRuntime, repository, contextInjectionUpdates);

      if (traceResult.durableSelected !== true) {
        return;
      }

      persistDurableTraceSample({
        activeRuntime,
        repository,
        traceRecord,
        traceId,
        hook,
        recordedAt,
      });
    } catch (error) {
      // best-effort visibility persistence; warn but never block hook path
      const message = error instanceof Error ? error.message : String(error);
      await session.log(`lore trace persistence warning: ${message}`, {
        ephemeral: true,
        level: "warning",
      });
    }
  });
}

async function handleSessionStartHook({
  session,
  invocation,
  input,
  metrics,
}) {
  const startedAt = Date.now();
  const context = await getContext(session, invocation.sessionId, input.cwd);
  const { runtime: activeRuntime, repository, workspacePath } = context;

  if (isHookRuntimeUnavailable(activeRuntime)) {
    return;
  }

  if (!hooksEnabled(activeRuntime.config)) {
    await logOnce(
      session,
      "lore-disabled",
      `lore hooks are disabled by default; create ${activeRuntime.config.configPath} with { "enabled": true }, or set LORE_ENABLED=1 to enable`,
      "info",
    );
    return;
  }

  await maybeSeedSessionStartOnboarding(session, activeRuntime, invocation.sessionId);
  await maybeRunMaintenanceScheduler(session, activeRuntime, repository, workspacePath);
  await maybeRunSessionStartBackfill(session, activeRuntime, repository);
  maybeHydrateOverlay(session, activeRuntime, workspacePath, repository, invocation.sessionId);

  const prompt = input.initialPrompt ?? "";
  const { assembled } = await assembleSessionStartCapsule({
    prompt,
    repository,
    activeRuntime,
  });
  const additionalContext = combineContextSections(
    assembled.text,
    consumeSessionHygieneSummary(activeRuntime.db, repository, invocation.sessionId),
  );

  await finalizeHookObservation({
    session,
    activeRuntime,
    repository,
    hook: "onSessionStart",
    prompt,
    promptNeed: assembled.trace?.promptNeed ?? detectPromptContextNeed(prompt),
    trace: assembled.trace,
    contextText: additionalContext,
    durationMs: Date.now() - startedAt,
    metricWindow: metrics.sessionStartMs,
    latencyMetric: "sessionStart",
    hookLabel: "lore onSessionStart",
    targetMs: activeRuntime.config.latencyTargetsMs.sessionStartP95,
  });

  return additionalContext
    ? { additionalContext }
    : undefined;
}

function readSessionEndExtraction(activeRuntime, sessionId) {
  return activeRuntime.sessionStore
    ? activeRuntime.sessionStore.getSessionArtifacts(sessionId)
    : null;
}

function maybeEnqueueDeferredSessionExtraction(activeRuntime, sessionId, repository) {
  if (!activeRuntime.config?.deferredExtraction?.enabled
    || !activeRuntime.config.deferredExtraction.autoEnqueueOnSessionEnd) {
    return;
  }
  activeRuntime.db.enqueueDeferredExtraction({
    sessionId,
    repository,
    reason: "session_end",
    priority: 10,
    metadata: {
      mode: "deferred",
    },
  });
}

async function handleSessionEndHook({
  session,
  invocation,
  input,
}) {
  const context = await getContext(session, invocation.sessionId, input.cwd);
  const { runtime: activeRuntime, workspace, repository } = context;

  if (!activeRuntime.initialized || activeRuntime.lastError || !hooksEnabled(activeRuntime.config)) {
    return;
  }

  try {
    const extraction = readSessionEndExtraction(activeRuntime, invocation.sessionId);
    if (extraction) {
      applySessionExtraction({
        db: activeRuntime.db,
        sessionId: invocation.sessionId,
        repository,
        sessionArtifacts: extraction,
        workspace,
      });
      maybeEnqueueDeferredSessionExtraction(activeRuntime, invocation.sessionId, repository);
    }

    if (input.reason === "error") {
      await session.log("lore observed session end with error", {
        ephemeral: true,
        level: "warning",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await session.log(`lore session-end extraction skipped: ${message}`, {
      ephemeral: true,
      level: "warning",
    });
  } finally {
    await shutdownRuntime(session);
  }
}

async function maybeProcessDeferredExtractions(session, activeRuntime, repository) {
  const deferredConfig = activeRuntime.config?.deferredExtraction;
  if (!deferredConfig?.enabled || !deferredConfig.autoProcessOnSessionStart) {
    return;
  }
  if (activeRuntime.processingDeferred || !activeRuntime.db || !activeRuntime.sessionStore) {
    return;
  }

  activeRuntime.processingDeferred = true;
  spawnTrackedMicrotask(async () => {
    try {
      const result = await processDeferredExtractions({
        db: activeRuntime.db,
        sessionStore: activeRuntime.sessionStore,
        repository: deferredConfig.processCurrentRepositoryOnly ? repository : null,
        limit: deferredConfig.maxJobsPerRun,
        retryDelayMinutes: deferredConfig.retryDelayMinutes,
      });
      if (result.failed > 0) {
        await session.log(`lore deferred extraction failed for ${result.failed} job(s)`, {
          ephemeral: true,
          level: "warning",
        });
      }
      if (result.inferenceFailed > 0) {
        await session.log(`lore local inference fell back for ${result.inferenceFailed} deferred extraction job(s)`, {
          ephemeral: true,
          level: "warning",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await session.log(`lore deferred extraction skipped: ${message}`, {
        ephemeral: true,
        level: "warning",
      });
    } finally {
      activeRuntime.processingDeferred = false;
    }
  });
}

async function maybeRunMaintenanceScheduler(session, activeRuntime, repository, workspacePath) {
  const maintenanceConfig = activeRuntime.config?.maintenanceScheduler;
  if (maintenanceConfig?.enabled === false) {
    await maybeProcessDeferredExtractions(session, activeRuntime, repository);
    return;
  }
  if (maintenanceConfig?.autoRunOnSessionStart === false) {
    return;
  }
  if (activeRuntime.processingMaintenance || !activeRuntime.db || !activeRuntime.sessionStore) {
    return;
  }

  activeRuntime.processingMaintenance = true;
  spawnTrackedMicrotask(async () => {
    try {
      const result = await runMaintenanceSweep({
        runtime: {
          ...activeRuntime,
          repository,
          workspacePath,
          metrics: buildLatencyMetrics(activeRuntime.config),
        },
        repository,
        trigger: "session_start",
      });
      if (result.status === "failed") {
        await session.log(`lore maintenance failed (${result.failedCount} task failure(s))`, {
          ephemeral: true,
          level: "warning",
        });
      } else if (result.status === "needs_attention") {
        await session.log(
          `lore maintenance found ${result.needsAttentionCount} task(s) needing attention`,
          {
            ephemeral: true,
            level: "warning",
          },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await session.log(`lore maintenance skipped: ${message}`, {
        ephemeral: true,
        level: "warning",
      });
    } finally {
      activeRuntime.processingMaintenance = false;
    }
  });
}

async function maybeRunSessionStartBackfill(session, activeRuntime, repository) {
  const options = readSessionStartBackfillOptions(activeRuntime.config);
  if (!options.enabled || !activeRuntime.db || !activeRuntime.sessionStore) {
    return;
  }
  const currentScopeLabel = formatSessionStartBackfillScopeLabel(repository, options.includeOtherRepositories);

  if (activeRuntime.processingBackfill) {
    const latestRun = activeRuntime.db.listBackfillRuns({ limit: 1 })[0] ?? null;
    if (latestRun?.status === "running") {
      const progress = summarizeBackfillRunProgress(latestRun);
      const scopeDescription = buildSessionStartBackfillScopeDescription({
        run: latestRun,
        repository,
        includeOtherRepositories: options.includeOtherRepositories,
        currentScopeLabel,
      });
      await session.log(
        `lore archive import already running for ${scopeDescription}: ${progress.completedCount}/${progress.totalCount} (${progress.progressPercent}%)`,
        { ephemeral: true },
      );
    }
    return;
  }

  activeRuntime.processingBackfill = true;
  spawnTrackedDeferredTask(async () => {
    try {
      await runSessionStartBackfillWork({
        session,
        activeRuntime,
        repository,
        options,
        currentScopeLabel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await session.log(`lore archive import skipped: ${message}`, {
        ephemeral: true,
        level: "warning",
      });
    } finally {
      activeRuntime.processingBackfill = false;
    }
  });
}

function maybeHydrateOverlay(session, activeRuntime, workspacePath, repository, sessionId) {
  if (!readOverlayAutoHydrationEnabled(activeRuntime.config)) {
    return;
  }
  if (!activeRuntime.db || !workspacePath) {
    return;
  }
  spawnTrackedMicrotask(async () => {
    try {
      await hydrateWorkstreamOverlay({
        db: activeRuntime.db,
        workspacePath,
        repository,
        sessionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await session.log(`lore overlay hydration skipped: ${message}`, {
        ephemeral: true,
        level: "warning",
      });
    }
  });
}

async function maybeSeedSessionStartOnboarding(session, activeRuntime, sessionId) {
  const onboardingSeed = activeRuntime.db
    ? seedOnboardingMemories({
      db: activeRuntime.db,
      sessionId,
    })
    : { insertedCount: 0, after: null };
  if (onboardingSeed.insertedCount > 0) {
    await session.log(
      "lore onboarding bootstrapped a default personality profile",
      { ephemeral: true },
    );
  }
  return onboardingSeed;
}

async function assembleSessionStartCapsule({ prompt, repository, activeRuntime }) {
  const relevantInstructionFiles = detectRelevantInstructionFiles(prompt);
  const proceduralProfile = await buildProceduralProfile({
    prompt,
    relevantInstructionFiles,
    config: activeRuntime.config,
  });
  const watermark = buildDbWatermark(activeRuntime.db);
  const startCacheKey = cacheKey([
    "session-start",
    repository ?? "global",
    prompt,
    proceduralProfile,
    watermark,
    activeRuntime.traceRecorder?.isEnabled?.() === true ? "trace" : "context-only",
  ]);
  const assembled = activeRuntime.db
    ? readCache(capsuleCache, startCacheKey)
      ?? writeCache(
        capsuleCache,
        startCacheKey,
        await assembleMemoryCapsule({
          prompt,
          repository,
          proceduralProfile,
          db: activeRuntime.db,
          sessionStore: activeRuntime.sessionStore,
          config: activeRuntime.config,
          includeTrace: activeRuntime.traceRecorder?.isEnabled?.() === true,
          includeProposalAwareness: true,
        }),
        5 * 60 * 1000,
        24,
      )
    : { text: "", sections: [] };

  return {
    assembled,
    proceduralProfile,
    startCacheKey,
  };
}

function isHookRuntimeUnavailable(activeRuntime) {
  return !activeRuntime.initialized || activeRuntime.lastError;
}

function recordHookTraceAndMetric({
  activeRuntime,
  repository,
  traceResult,
  durationMs,
  hook,
  metricWindow,
  session,
}) {
  persistTraceSuccess({
    activeRuntime,
    repository,
    traceResult,
    durationMs,
    hook,
    session,
  });
  recordMetric(
    metricWindow,
    durationMs,
    activeRuntime.config.limits.metricWindowSize,
  );
}

async function maybeEmitHookLatencyWarning({
  session,
  activeRuntime,
  durationMs,
  latencyMetric,
  hookLabel,
  targetMs,
}) {
  const latencySnapshot = buildLatencyMetrics(activeRuntime.config);
  if (!shouldEmitLatencyWarning(latencySnapshot[latencyMetric])) {
    return;
  }
  const warning = buildLatencyWarning(hookLabel, durationMs, targetMs);
  if (warning) {
    await session.log(warning, { ephemeral: true, level: "warning" });
  }
}

async function finalizeHookObservation({
  session,
  activeRuntime,
  repository,
  hook,
  prompt,
  promptNeed,
  trace,
  contextText,
  durationMs,
  metricWindow,
  latencyMetric,
  hookLabel,
  targetMs,
  includeLatencyWarning = true,
}) {
  const traceResult = activeRuntime.traceRecorder?.record({
    hook,
    prompt,
    repository,
    latencyMs: durationMs,
    promptNeed,
    trace,
    contextText,
  });
  recordHookTraceAndMetric({
    activeRuntime,
    repository,
    traceResult,
    durationMs,
    hook,
    metricWindow,
    session,
  });
  if (!includeLatencyWarning) {
    return;
  }
  await maybeEmitHookLatencyWarning({
    session,
    activeRuntime,
    durationMs,
    latencyMetric,
    hookLabel,
    targetMs,
  });
}

function readAmbientInteractionStylePresence(activeRuntime) {
  if (!activeRuntime.db) {
    return false;
  }
  const stylePresenceKey = cacheKey([
    "ambient-style-presence",
    buildDbWatermark(activeRuntime.db),
  ]);
  return readCache(ambientStylePresenceCache, stylePresenceKey)
    ?? writeCache(
      ambientStylePresenceCache,
      stylePresenceKey,
      !!activeRuntime.db.searchSemantic({
        query: "",
        repository: null,
        includeOtherRepositories: false,
        types: ["interaction_style"],
        scopes: ["global"],
        limit: 1,
      }).length,
      60 * 1000,
      4,
    );
}

async function recordUserPromptBypassObservation({
  session,
  activeRuntime,
  repository,
  inputPrompt,
  need,
  durationMs,
}) {
  await finalizeHookObservation({
    session,
    activeRuntime,
    repository,
    hook: "onUserPromptSubmitted",
    prompt: inputPrompt,
    promptNeed: need,
    trace: buildBypassTrace({
      repository,
      promptNeed: need,
      reason: "lookup_not_required_and_no_ambient_style",
    }),
    contextText: "",
    durationMs,
    metricWindow: metrics.userPromptSubmittedMs,
    latencyMetric: "userPromptSubmitted",
    hookLabel: "lore onUserPromptSubmitted",
    targetMs: activeRuntime.config.latencyTargetsMs.userPromptSubmittedP95,
    includeLatencyWarning: false,
  });
}

function maybeCompactErrorTelemetry(activeRuntime) {
  activeRuntime.errorTelemetryWrites = (activeRuntime.errorTelemetryWrites ?? 0) + 1;
  if (activeRuntime.errorTelemetryWrites % 20 !== 0) {
    return;
  }
  activeRuntime.db.pruneErrorTelemetry({
    maxRowsGlobal: 500,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  });
}

import { buildLoreHooks } from "./lib/hook-registration.mjs";

// Session-local sub-agent scope tracker. Reset on session end.
const subagentScopeTracker = createSubagentScopeTracker();

const session = await joinSession({
  onPermissionRequest: approveAll,
  hooks: buildLoreHooks({
    onSessionStart: async (input, invocation) => {
      lastKnownCwd = input.cwd || lastKnownCwd;
      subagentScopeTracker.reset(); // clear any stale state from previous session
      surfacedHygieneSummaryBySession.delete(invocation.sessionId);
      return handleSessionStartHook({ session, invocation, input, metrics });
    },

    onUserPromptSubmitted: async (input, invocation) => {
      const startedAt = Date.now();
      lastKnownCwd = input.cwd || lastKnownCwd;

      const context = await getContext(session, invocation.sessionId, input.cwd);
      const { runtime: activeRuntime, repository } = context;

      if (isHookRuntimeUnavailable(activeRuntime) || !hooksEnabled(activeRuntime.config)) {
        return;
      }

      const need = detectPromptContextNeed(input.prompt);
      const hasAmbientInteractionStyle = readAmbientInteractionStylePresence(activeRuntime);
      const hygieneSummary = consumeSessionHygieneSummary(
        activeRuntime.db,
        repository,
        invocation.sessionId,
      );
      if (!need.requiresLookup && !hasAmbientInteractionStyle && !hygieneSummary) {
        await recordUserPromptBypassObservation({
          session,
          activeRuntime,
          repository,
          inputPrompt: input.prompt,
          need,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const recall = need.requiresLookup || hasAmbientInteractionStyle
        ? recallMemory({
            db: activeRuntime.db,
            prompt: input.prompt,
            repository,
            includeOtherRepositories: need.allowCrossRepoFallback === true,
            limit: activeRuntime.config.limits.promptContextLimit,
            sessionStore: activeRuntime.sessionStore,
            promptNeed: need,
          })
        : {
            text: "",
            trace: {
              route: "prompt_context",
              promptNeed: need,
              lookups: {},
              output: { estimatedTokens: 0 },
            },
          };
      const additionalContext = combineContextSections(recall.text, hygieneSummary);

      await finalizeHookObservation({
        session,
        activeRuntime,
        repository,
        hook: "onUserPromptSubmitted",
        prompt: input.prompt,
        promptNeed: need,
        trace: recall.trace,
        contextText: additionalContext,
        durationMs: Date.now() - startedAt,
        metricWindow: metrics.userPromptSubmittedMs,
        latencyMetric: "userPromptSubmitted",
        hookLabel: "lore onUserPromptSubmitted",
        targetMs: activeRuntime.config.latencyTargetsMs.userPromptSubmittedP95,
      });

      if (!additionalContext) {
        return;
      }

      return {
        additionalContext,
      };
    },

    onSessionEnd: async (input, invocation) => {
      lastKnownCwd = input.cwd || lastKnownCwd;
      subagentScopeTracker.reset(); // ensure no scope state leaks past session end
      surfacedHygieneSummaryBySession.delete(invocation.sessionId);
      return handleSessionEndHook({ session, invocation, input });
    },

    onErrorOccurred: async (input, invocation) => {
      const startedAt = Date.now();
      try {
        const activeRuntime = runtime;
        if (!readErrorTelemetryEnabled(activeRuntime.config)) {
          return;
        }
        if (!activeRuntime.initialized || !activeRuntime.db || !hooksEnabled(activeRuntime.config)) {
          return;
        }
        const record = buildErrorTelemetryRecord(input, invocation?.sessionId);
        if (!record) {
          return;
        }
        spawnTrackedDeferredTask(async () => {
          try {
            activeRuntime.db.insertErrorTelemetry(record);
            maybeCompactErrorTelemetry(activeRuntime);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await session.log(`lore error telemetry persistence warning: ${message}`, {
              ephemeral: true,
              level: "warning",
            });
          }
        });
      } catch {
        // fail open — passive hook must never throw to the SDK
      } finally {
        recordMetric(
          metrics.errorTelemetryMs,
          Date.now() - startedAt,
          runtime.config?.limits?.metricWindowSize ?? 200,
        );
      }
      // Phase 2: no errorHandling override returned
    },

    onPostToolUse: async (input, _invocation) => {
      const startedAt = Date.now();
      try {
        const activeRuntime = runtime;
        if (!readPostToolUseEnabled(activeRuntime.config)) {
          return;
        }
        if (!activeRuntime.initialized || !activeRuntime.db || !hooksEnabled(activeRuntime.config)) {
          return;
        }
        const observation = buildPostToolUseObservation(input);
        if (!observation) {
          return;
        }
        const scopeMeta = readSubagentScopeTrackingEnabled(activeRuntime.config)
          ? subagentScopeTracker.getActiveScopeMetadata()
          : null;
        spawnTrackedDeferredTask(async () => {
          try {
            activeRuntime.db.insertTrajectoryArtifact({
              kind: "passive_hook_observation",
              repository: null,
              summary: `${observation.toolCategory}/${observation.success ? "success" : "failure"}`,
              severity: observation.success ? "info" : "warning",
              outcome: "captured",
              context: {
                hookKind: "onPostToolUse",
                toolCategory: observation.toolCategory,
                success: observation.success,
                argsShape: observation.argsShape,
                ...(scopeMeta ? { activeSubagent: scopeMeta.activeSubagent.name } : {}),
              },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await session.log(`lore post-tool observation warning: ${message}`, {
              ephemeral: true,
              level: "warning",
            });
          }
        });
      } catch {
        // fail open — passive hook must never throw to the SDK
      } finally {
        recordMetric(
          metrics.postToolUseMs,
          Date.now() - startedAt,
          runtime.config?.limits?.metricWindowSize ?? 200,
        );
      }
    },

    // onPreToolUse — narrow default-off guardrail (Phase 3).
    // Only active when rollout.preToolUseGuardrail is true.
    // Observes only the explicit Lore-relevant tool allowlist.
    // Never blocks; fails open on any error, timeout, or malformed payload.
    // onPreMcpToolCall is intentionally not registered: the SDK capability is
    // verified (PreMcpToolCallHookInput + metaToUse output, SDK ≥ 1.0.75) but
    // no concrete Lore MCP metadata use case is verified at this time.
    // See docs/copilot-sdk-hooks.md for rationale.
    onPreToolUse: async (input, _invocation) => {
      const startedAt = Date.now();
      try {
        return await runPreToolUseGuardrail(input, {
          config: runtime.config,
          scopeTracker: subagentScopeTracker,
        });
      } catch {
        // fail open — pre-tool hook must never throw to the SDK
        return undefined;
      } finally {
        recordMetric(
          metrics.preToolUseMs,
          Date.now() - startedAt,
          runtime.config?.limits?.metricWindowSize ?? 200,
        );
      }
    },
  }),
  tools: createMemoryTools({
    getRuntime: async (sessionId) => {
      const context = await getContext(session, sessionId, lastKnownCwd);
      return {
        ...context.runtime,
        repository: context.repository,
        workspace: context.workspace,
        workspacePath: context.workspacePath,
        metrics: buildLatencyMetrics(context.runtime.config),
      };
    },
  }),
});

// Subscribe to verified sub-agent events for scope tracking (Phase 3).
// Handlers check runtime.config at event time so the config is always loaded.
// These event subscriptions are safe to wire unconditionally; the guard inside
// each handler enforces the rollout flag before touching any state.
session.on("subagent.selected", (event) => {
  try {
    if (!runtime.config || !readSubagentScopeTrackingEnabled(runtime.config)) {
      return;
    }
    subagentScopeTracker.handleSelected(event);
  } catch {
    // safe no-op — event handler must never throw
  }
});

session.on("subagent.deselected", (event) => {
  try {
    if (!runtime.config || !readSubagentScopeTrackingEnabled(runtime.config)) {
      return;
    }
    subagentScopeTracker.handleDeselected(event);
  } catch {
    // safe no-op
  }
});

session.on("subagent.started", (event) => {
  try {
    if (!runtime.config || !readSubagentScopeTrackingEnabled(runtime.config)) {
      return;
    }
    subagentScopeTracker.handleStarted(event);
  } catch {
    // safe no-op
  }
});

session.on("subagent.completed", (event) => {
  try {
    if (!runtime.config || !readSubagentScopeTrackingEnabled(runtime.config)) {
      return;
    }
    subagentScopeTracker.handleCompleted(event);
  } catch {
    // safe no-op
  }
});

session.on("subagent.failed", (event) => {
  try {
    if (!runtime.config || !readSubagentScopeTrackingEnabled(runtime.config)) {
      return;
    }
    subagentScopeTracker.handleFailed(event);
  } catch {
    // safe no-op
  }
});

await ensureRuntime(session);
