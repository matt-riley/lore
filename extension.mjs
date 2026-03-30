import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

import { loadConfig } from "./lib/config.mjs";
import {
  applySessionExtraction,
  buildSessionStartBackfillDecision,
  previewControlledBackfill,
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
import { readOverlayAutoHydrationEnabled } from "./lib/rollout-flags.mjs";
import { setTimeout as delay } from "node:timers/promises";

let lastKnownCwd = process.cwd();

const metrics = {
  sessionStartMs: [],
  userPromptSubmittedMs: [],
};

const capsuleCache = new Map();
const ambientStylePresenceCache = new Map();

const logOnceKeys = new Set();

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
};

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
  };
}

function readSessionStartBackfillOptions(config) {
  const raw = config?.maintenanceScheduler?.sessionStartBackfill ?? {};
  return {
    enabled: normalizeBoolean(raw.enabled, false),
    includeOtherRepositories: normalizeBoolean(raw.includeOtherRepositories, true),
    refreshExisting: normalizeBoolean(raw.refreshExisting, false),
    batchSize: clampInteger(raw.batchSize, 25, { min: 1, max: 500 }),
    notifyEveryItems: clampInteger(raw.notifyEveryItems, 50, { min: 1, max: 10_000 }),
  };
}

function readSessionStoreInspectionLimit(sessionStore) {
  if (!sessionStore?.db) {
    return 1;
  }
  const row = sessionStore.db.prepare(`
    SELECT COUNT(*) AS count
    FROM sessions
  `).get();
  return Math.max(1, Number(row?.count ?? 0));
}

function formatSessionStartBackfillScopeLabel(repository, includeOtherRepositories) {
  if (includeOtherRepositories || !repository) {
    return "all repositories";
  }
  return repository;
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

function persistTraceSuccess({ activeRuntime, repository, traceResult, durationMs, hook }) {
  if (!activeRuntime?.db || !traceResult || typeof traceResult !== "object") {
    return;
  }
  const traceRecord = traceResult.record ?? null;
  const traceId = traceResult.id ?? traceRecord?.id ?? null;
  if (!traceRecord) {
    return;
  }

  queueMicrotask(() => {
    try {
      const recordedAt = traceRecord.recordedAt ?? new Date().toISOString();
      activeRuntime.db.upsertActivitySuccess({
        repository,
        updates: {
          lastTraceRecordedAt: recordedAt,
          lastTraceHook: hook,
          lastTraceId: traceId,
        },
      });
      activeRuntime.db.upsertActivitySuccess({
        repository: null,
        updates: {
          lastTraceRecordedAt: recordedAt,
          lastTraceHook: hook,
          lastTraceId: traceId,
        },
      });

      const sectionTitles = traceRecord?.output?.sectionTitles ?? [];
      const contextInjected = traceRecord?.output?.contextInjected === true;
      if (contextInjected || sectionTitles.length > 0) {
        activeRuntime.db.upsertActivitySuccess({
          repository,
          updates: {
            lastContextInjectionAt: recordedAt,
            lastContextInjectionHook: hook,
            lastContextInjectionSections: sectionTitles,
            lastContextInjectionTraceId: traceId,
            lastContextInjectionDurationMs: durationMs,
          },
        });
        activeRuntime.db.upsertActivitySuccess({
          repository: null,
          updates: {
            lastContextInjectionAt: recordedAt,
            lastContextInjectionHook: hook,
            lastContextInjectionSections: sectionTitles,
            lastContextInjectionTraceId: traceId,
            lastContextInjectionDurationMs: durationMs,
          },
        });
      }

      if (traceResult.durableSelected !== true) {
        return;
      }

      activeRuntime.db.insertRetrievalTraceSample({
        id: traceId,
        repository,
        scopeType: repository ? "repo" : "global",
        hook,
        route: traceRecord?.routerDecision?.route ?? null,
        routeReason: traceRecord?.routerDecision?.reason ?? null,
        contextInjected: traceRecord?.output?.contextInjected === true,
        latencyMs: traceRecord?.latencyMs ?? null,
        promptPreview: traceRecord?.promptPreview ?? "",
        sectionTitles: traceRecord?.output?.sectionTitles ?? [],
        promptNeed: traceRecord?.promptNeed ?? {},
        eligibility: traceRecord?.eligibility ?? {},
        lookups: traceRecord?.lookups ?? {},
        omissions: traceRecord?.omissions ?? [],
        output: traceRecord?.output ?? {},
        trace: {
          mode: traceRecord?.mode ?? null,
        },
        recordedAt,
      });

      activeRuntime.tracePersistenceWrites = (activeRuntime.tracePersistenceWrites ?? 0) + 1;
      if (activeRuntime.tracePersistenceWrites % 10 === 0) {
        activeRuntime.db.pruneRetrievalTraceSamples({
          repository,
          maxRowsPerRepository: activeRuntime.config?.traceRecorder?.durableMaxRowsPerRepository ?? 120,
          maxRowsGlobal: activeRuntime.config?.traceRecorder?.durableMaxRowsGlobal ?? 240,
          maxAgeMs: activeRuntime.config?.traceRecorder?.durableMaxAgeMs ?? (14 * 24 * 60 * 60 * 1000),
        });
      }
    } catch {
      // best-effort visibility persistence; never block hook path
    }
  });
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
  queueMicrotask(async () => {
    try {
      const result = processDeferredExtractions({
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

async function maybeRunMaintenanceScheduler(session, activeRuntime, repository) {
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
  queueMicrotask(async () => {
    try {
      const result = await runMaintenanceSweep({
        runtime: {
          ...activeRuntime,
          repository,
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
  const scopeLabel = formatSessionStartBackfillScopeLabel(repository, options.includeOtherRepositories);

  if (activeRuntime.processingBackfill) {
    const latestRun = activeRuntime.db.listBackfillRuns({ limit: 1 })[0] ?? null;
    if (latestRun?.status === "running") {
      const progress = summarizeBackfillRunProgress(latestRun);
      await session.log(
        `lore archive import already running for ${scopeLabel}: ${progress.completedCount}/${progress.totalCount} (${progress.progressPercent}%)`,
        { ephemeral: true },
      );
    }
    return;
  }

  activeRuntime.processingBackfill = true;
  queueMicrotask(async () => {
    try {
      while (activeRuntime.processingMaintenance || activeRuntime.processingDeferred) {
        await delay(25);
      }

      const inspectionLimit = readSessionStoreInspectionLimit(activeRuntime.sessionStore);
      const latestRun = activeRuntime.db.listBackfillRuns({ limit: 1 })[0] ?? null;
      const preview = previewControlledBackfill({
        db: activeRuntime.db,
        sessionStore: activeRuntime.sessionStore,
        repository,
        includeOtherRepositories: options.includeOtherRepositories,
        limit: inspectionLimit,
        refreshExisting: options.refreshExisting,
      });
      const decision = buildSessionStartBackfillDecision({ preview, latestRun });
      if (decision.action === "skip") {
        return;
      }

      let run = null;
      let lastReportedCompleted = 0;
      let hasReportedIntermediateProgress = false;

      if (decision.action === "resume") {
        run = latestRun;
        const progress = summarizeBackfillRunProgress(run);
        lastReportedCompleted = progress.completedCount;
        await session.log(
          `lore archive import resumed for ${scopeLabel}: ${progress.completedCount}/${progress.totalCount} (${progress.progressPercent}%)`,
          { ephemeral: true },
        );
      } else {
        await session.log(
          `lore archive import started for ${scopeLabel}: 0/${decision.candidateCount} session(s) queued. Progress updates will appear here.`,
          { ephemeral: true },
        );
        const started = startControlledBackfillRun({
          db: activeRuntime.db,
          sessionStore: activeRuntime.sessionStore,
          repository,
          includeOtherRepositories: options.includeOtherRepositories,
          limit: inspectionLimit,
          refreshExisting: options.refreshExisting,
          batchSize: options.batchSize,
        });
        run = started.run;
      }

      const reportProgress = async (currentRun, { force = false } = {}) => {
        const progress = summarizeBackfillRunProgress(currentRun);
        const isTerminal = currentRun.status === "completed" || currentRun.status === "failed";
        const reachedNotifyThreshold = (progress.completedCount - lastReportedCompleted) >= options.notifyEveryItems;
        const shouldReport = force
          || isTerminal
          || (!hasReportedIntermediateProgress && progress.completedCount > 0)
          || reachedNotifyThreshold;
        if (!shouldReport) {
          return;
        }
        if (!isTerminal) {
          hasReportedIntermediateProgress = true;
        }
        lastReportedCompleted = progress.completedCount;
        await session.log(
          buildSessionStartBackfillProgressMessage({
            run: currentRun,
            scopeLabel,
          }),
          {
            ephemeral: true,
            ...(currentRun.status === "failed" ? { level: "warning" } : {}),
          },
        );
      };

      await reportProgress(run, {
        force: run.status === "completed" || run.status === "failed",
      });

      while (run.status === "running") {
        const result = processControlledBackfillRun({
          db: activeRuntime.db,
          sessionStore: activeRuntime.sessionStore,
          runId: run.id,
          limit: options.batchSize,
          retryFailed: true,
        });
        run = result.run;
        await reportProgress(run);
      }

      await reportProgress(run, { force: true });
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
  queueMicrotask(async () => {
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

const session = await joinSession({
  onPermissionRequest: approveAll,
  hooks: {
    onSessionStart: async (input, invocation) => {
      const startedAt = Date.now();
      lastKnownCwd = input.cwd || lastKnownCwd;

      const context = await getContext(session, invocation.sessionId, input.cwd);
      const { runtime: activeRuntime, repository, workspacePath } = context;

      if (!activeRuntime.initialized || activeRuntime.lastError) {
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

      const onboardingSeed = activeRuntime.db
        ? seedOnboardingMemories({
          db: activeRuntime.db,
          sessionId: invocation.sessionId,
        })
        : { insertedCount: 0, after: null };
      if (onboardingSeed.insertedCount > 0) {
        await session.log(
          "lore onboarding bootstrapped a default personality profile",
          { ephemeral: true },
        );
      }

      await maybeRunMaintenanceScheduler(session, activeRuntime, repository);
      await maybeRunSessionStartBackfill(session, activeRuntime, repository);
      maybeHydrateOverlay(session, activeRuntime, workspacePath, repository, invocation.sessionId);

      const relevantInstructionFiles = detectRelevantInstructionFiles(input.initialPrompt ?? "");
      const proceduralProfile = await buildProceduralProfile({
        prompt: input.initialPrompt ?? "",
        relevantInstructionFiles,
        config: activeRuntime.config,
      });
      const watermark = buildDbWatermark(activeRuntime.db);
      const startCacheKey = cacheKey([
        "session-start",
        repository ?? "global",
        input.initialPrompt ?? "",
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
              prompt: input.initialPrompt ?? "",
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

      const durationMs = Date.now() - startedAt;
      const sessionStartTrace = activeRuntime.traceRecorder?.record({
        hook: "onSessionStart",
        prompt: input.initialPrompt ?? "",
        repository,
        latencyMs: durationMs,
        promptNeed: assembled.trace?.promptNeed ?? detectPromptContextNeed(input.initialPrompt ?? ""),
        trace: assembled.trace,
        contextText: assembled.text,
      });
      persistTraceSuccess({
        activeRuntime,
        repository,
        traceResult: sessionStartTrace,
        durationMs,
        hook: "onSessionStart",
      });
      recordMetric(
        metrics.sessionStartMs,
        durationMs,
        activeRuntime.config.limits.metricWindowSize,
      );
      const latencySnapshot = buildLatencyMetrics(activeRuntime.config);
      if (shouldEmitLatencyWarning(latencySnapshot.sessionStart)) {
        const warning = buildLatencyWarning(
          "lore onSessionStart",
          durationMs,
          activeRuntime.config.latencyTargetsMs.sessionStartP95,
        );
        if (warning) {
          await session.log(warning, { ephemeral: true, level: "warning" });
        }
      }

      if (!assembled.text) {
        return;
      }

      return {
        additionalContext: assembled.text,
      };
    },

    onUserPromptSubmitted: async (input, invocation) => {
      const startedAt = Date.now();
      lastKnownCwd = input.cwd || lastKnownCwd;

      const context = await getContext(session, invocation.sessionId, input.cwd);
      const { runtime: activeRuntime, repository } = context;

      if (!activeRuntime.initialized || activeRuntime.lastError || !hooksEnabled(activeRuntime.config)) {
        return;
      }

      const need = detectPromptContextNeed(input.prompt);
      const stylePresenceKey = cacheKey([
        "ambient-style-presence",
        buildDbWatermark(activeRuntime.db),
      ]);
      const hasAmbientInteractionStyle = activeRuntime.db
        ? (readCache(ambientStylePresenceCache, stylePresenceKey)
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
          ))
        : false;
      if (!need.requiresLookup && !hasAmbientInteractionStyle) {
        const durationMs = Date.now() - startedAt;
        const bypassTrace = activeRuntime.traceRecorder?.record({
          hook: "onUserPromptSubmitted",
          prompt: input.prompt,
          repository,
          latencyMs: durationMs,
          promptNeed: need,
          trace: buildBypassTrace({
            repository,
            promptNeed: need,
            reason: "lookup_not_required_and_no_ambient_style",
          }),
          contextText: "",
        });
        persistTraceSuccess({
          activeRuntime,
          repository,
          traceResult: bypassTrace,
          durationMs,
          hook: "onUserPromptSubmitted",
        });
        recordMetric(
          metrics.userPromptSubmittedMs,
          durationMs,
          activeRuntime.config.limits.metricWindowSize,
        );
        return;
      }

      const recall = recallMemory({
        db: activeRuntime.db,
        prompt: input.prompt,
        repository,
        includeOtherRepositories: need.allowCrossRepoFallback === true,
        limit: activeRuntime.config.limits.promptContextLimit,
        sessionStore: activeRuntime.sessionStore,
        promptNeed: need,
      });
      const additionalContext = recall.text;

      const durationMs = Date.now() - startedAt;
      const promptTrace = activeRuntime.traceRecorder?.record({
        hook: "onUserPromptSubmitted",
        prompt: input.prompt,
        repository,
        latencyMs: durationMs,
        promptNeed: need,
        trace: recall.trace,
        contextText: additionalContext,
      });
      persistTraceSuccess({
        activeRuntime,
        repository,
        traceResult: promptTrace,
        durationMs,
        hook: "onUserPromptSubmitted",
      });
      recordMetric(
        metrics.userPromptSubmittedMs,
        durationMs,
        activeRuntime.config.limits.metricWindowSize,
      );
      const latencySnapshot = buildLatencyMetrics(activeRuntime.config);
      if (shouldEmitLatencyWarning(latencySnapshot.userPromptSubmitted)) {
        const warning = buildLatencyWarning(
          "lore onUserPromptSubmitted",
          durationMs,
          activeRuntime.config.latencyTargetsMs.userPromptSubmittedP95,
        );
        if (warning) {
          await session.log(warning, { ephemeral: true, level: "warning" });
        }
      }

      if (!additionalContext) {
        return;
      }

      return {
        additionalContext,
      };
    },

    onSessionEnd: async (input, invocation) => {
      lastKnownCwd = input.cwd || lastKnownCwd;
      const context = await getContext(session, invocation.sessionId, input.cwd);
      const { runtime: activeRuntime, workspace, repository } = context;

      if (!activeRuntime.initialized || activeRuntime.lastError || !hooksEnabled(activeRuntime.config)) {
        return;
      }

      try {
        const extraction = activeRuntime.sessionStore
          ? activeRuntime.sessionStore.getSessionArtifacts(invocation.sessionId)
          : null;
        if (!extraction) {
          return;
        }

        applySessionExtraction({
          db: activeRuntime.db,
          sessionId: invocation.sessionId,
          repository,
          sessionArtifacts: extraction,
          workspace,
        });

        if (activeRuntime.config?.deferredExtraction?.enabled
          && activeRuntime.config.deferredExtraction.autoEnqueueOnSessionEnd) {
          activeRuntime.db.enqueueDeferredExtraction({
            sessionId: invocation.sessionId,
            repository,
            reason: "session_end",
            priority: 10,
            metadata: {
              mode: "deferred",
            },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await session.log(`lore session-end extraction skipped: ${message}`, {
          ephemeral: true,
          level: "warning",
        });
      }

      if (input.reason === "error") {
        await session.log("lore observed session end with error", {
          ephemeral: true,
          level: "warning",
        });
      }
    },
  },
  tools: createMemoryTools({
    getRuntime: async (sessionId) => {
      const context = await getContext(session, sessionId, lastKnownCwd);
      return {
        ...context.runtime,
        repository: context.repository,
        workspace: context.workspace,
        metrics: buildLatencyMetrics(context.runtime.config),
      };
    },
  }),
});

await ensureRuntime(session);
