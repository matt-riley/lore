import { buildSemanticCanonicalKey } from "./memory-scope.mjs";
import { retainMemory } from "./memory-operations.mjs";
import { extractSessionMemories } from "./rule-extractor.mjs";
import { enhanceSessionExtractionWithLocalInference } from "./local-inference-extraction.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { clampInteger } from "./config.mjs";

/**
 * Generate a lightweight unique token for deferred extraction lease ownership.
 * Uses process PID + timestamp + random suffix — no crypto dependency needed
 * for this local, in-process lock mechanism.
 *
 * @returns {string}
 */
function generateOwnerToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function shouldTrackSessionImprovement(memory) {
  return memory?.type === "assistant_goal" || memory?.type === "recurring_mistake";
}

const SESSION_IMPROVEMENT_DESCRIPTORS = Object.freeze({
  assistant_goal: {
    title: "assistant goal",
    summaryLabel: "Goal",
    detailKey: "goal",
  },
  recurring_mistake: {
    title: "recurring mistake",
    summaryLabel: "Mistake",
    detailKey: "mistake",
  },
});

function buildSessionImprovementDescriptor(memory) {
  const descriptor = SESSION_IMPROVEMENT_DESCRIPTORS[memory?.type]
    ?? SESSION_IMPROVEMENT_DESCRIPTORS.recurring_mistake;
  return {
    ...descriptor,
    detailValue: memory?.metadata?.[descriptor.detailKey] ?? memory?.content,
  };
}

function buildSessionImprovementTrace(episodeDigest) {
  return {
    episodeSummary: episodeDigest.summary,
    themes: episodeDigest.themes ?? [],
  };
}

function buildSessionImprovementSourceCaseId({
  memory,
  scope,
  repository,
  canonicalKey,
}) {
  return [
    "session",
    memory.type,
    scope,
    repository,
    canonicalKey ?? String(memory.sourceTurnIndex ?? "na"),
  ].join(":");
}

function buildSessionImprovementEvidence({
  sessionId,
  repository,
  memory,
  descriptor,
  signalType,
}) {
  return {
    sessionId,
    repository,
    memoryType: memory.type,
    signalType,
    sourceTurnIndex: memory.sourceTurnIndex ?? null,
    content: memory.content,
    [descriptor.detailKey]: descriptor.detailValue,
    examples: memory.metadata?.examples ?? [],
    tags: memory.tags ?? [],
  };
}

function buildSessionImprovementArtifact({ sessionId, memory, episodeDigest, linkedMemoryId }) {
  const descriptor = buildSessionImprovementDescriptor(memory);
  const canonicalKey = buildSemanticCanonicalKey(memory);
  const repository = memory.repository ?? episodeDigest.repository ?? "global";
  const scope = memory.scope ?? "repo";
  const signalType = memory.metadata?.signalType ?? null;
  const sourceLabel = signalType?.startsWith("repeated_") ? "Session-inferred" : "Session-derived";
  const sourceCaseId = buildSessionImprovementSourceCaseId({
    memory,
    scope,
    repository,
    canonicalKey,
  });
  return {
    sourceCaseId,
    sourceKind: "session",
    title: `${sourceLabel} ${descriptor.title}`,
    summary: `${descriptor.summaryLabel}: ${descriptor.detailValue}`,
    linkedMemoryId,
    evidence: buildSessionImprovementEvidence({
      sessionId,
      repository,
      memory,
      descriptor,
      signalType,
    }),
    trace: buildSessionImprovementTrace(episodeDigest),
  };
}

export function applySessionExtraction({
  db,
  sessionId,
  repository,
  sessionArtifacts,
  workspace,
  extraction: suppliedExtraction = null,
}) {
  const extraction = suppliedExtraction ?? extractSessionMemories({
    sessionId,
    repository,
    sessionArtifacts,
    workspace,
    config: db.config,
  });
  db.deleteGeneratedSemanticMemories(sessionId);
  db.upsertEpisodeDigest(extraction.episodeDigest);
  db.refreshDaySummary({
    date: extraction.episodeDigest.dateKey,
    repository: extraction.episodeDigest.repository,
  });
  for (const memory of extraction.semanticMemories) {
    const retained = retainMemory({
      db,
      kind: "semantic",
      memory,
    });
    const linkedMemoryId = retained.id;
    if (!linkedMemoryId) {
      continue;
    }
    if (db.config?.rollout?.autoWriteImprovementGoals === true && shouldTrackSessionImprovement(memory)) {
      db.upsertImprovementArtifact(buildSessionImprovementArtifact({
        sessionId,
        memory,
        episodeDigest: extraction.episodeDigest,
        linkedMemoryId,
      }));
    }
  }
  return extraction;
}

export function summarizeBackfillPreviewProgress(preview) {
  const totalCount = preview.candidates.length;
  const pendingCount = totalCount;
  const completedCount = 0;
  const failedCount = 0;
  const skippedCount = preview.skippedExisting ?? 0;
  const progressPercent = totalCount > 0 ? 0 : 100;
  const currentPhase = totalCount > 0 ? "planning" : "idle";
  return {
    totalCount,
    completedCount,
    refreshedCount: 0,
    createdCount: 0,
    failedCount,
    skippedCount,
    pendingCount,
    runningCount: 0,
    progressPercent,
    currentPhase,
  };
}

export function summarizeBackfillRunProgress(run) {
  const totalCount = Number(run.total_candidates ?? 0);
  const completedCount = Number(run.processed_count ?? 0);
  const createdCount = Number(run.created_episode_count ?? 0);
  const refreshedCount = Number(run.refreshed_episode_count ?? 0);
  const failedCount = Number(run.failed_count ?? 0);
  const skippedCount = Number(run.skipped_count ?? 0);
  const pendingCount = Math.max(0, totalCount - completedCount);
  const runningCount = run.status === "running" ? Math.max(0, Math.min(pendingCount, run.batch_size ?? 1)) : 0;
  const progressPercent = totalCount > 0
    ? Math.min(100, Math.max(0, Math.round((completedCount / totalCount) * 100)))
    : 100;
  const PHASE_BY_STATUS = { running: "processing", failed: "failed", completed: "complete", preview: "planning" };
  const currentPhase = PHASE_BY_STATUS[run.status] ?? "idle";
  return {
    totalCount,
    completedCount,
    createdCount,
    refreshedCount,
    failedCount,
    skippedCount,
    pendingCount,
    runningCount,
    progressPercent,
    currentPhase,
  };
}

export function buildSessionStartBackfillDecision({ preview, latestRun = null }) {
  if (latestRun?.status === "running") {
    return {
      action: "resume",
      reason: "existing_run",
      candidateCount: Number(latestRun.total_candidates ?? 0),
      runId: latestRun.id,
    };
  }
  const candidateCount = Array.isArray(preview?.candidates) ? preview.candidates.length : 0;
  if (candidateCount === 0) {
    return {
      action: "skip",
      reason: preview?.inspectionBoundReached ? "inspection_bound" : "up_to_date",
      candidateCount: 0,
      runId: null,
    };
  }
  return {
    action: "start",
    reason: preview?.inspectionBoundReached ? "partial_candidates" : "pending_candidates",
    candidateCount,
    runId: null,
  };
}

function shouldUseDeferredLocalInference(config) {
  return config?.deferredExtraction?.useLocalInference === true
    && config?.localInference?.enabled === true;
}

async function buildDeferredSessionExtraction({
  db,
  job,
  repository,
  artifacts,
  workspace,
  fetchImpl,
}) {
  const extraction = extractSessionMemories({
    sessionId: job.session_id,
    repository: job.repository ?? repository,
    sessionArtifacts: artifacts,
    workspace,
    config: db.config,
  });
  if (!shouldUseDeferredLocalInference(db.config)) {
    return {
      extraction,
      inferenceUsed: false,
      inferenceError: null,
    };
  }
  try {
    return {
      extraction: await enhanceSessionExtractionWithLocalInference({
        config: db.config.localInference,
        sessionArtifacts: artifacts,
        extraction,
        fetchImpl,
      }),
      inferenceUsed: true,
      inferenceError: null,
    };
  } catch (error) {
    return {
      extraction,
      inferenceUsed: false,
      inferenceError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function processDeferredExtractionJob({
  db,
  sessionStore,
  repository,
  job,
  fetchImpl,
  ownerToken,
}) {
  const artifacts = sessionStore.getSessionArtifacts(job.session_id);
  if (!artifacts) {
    throw new Error(`session artifacts not found for ${job.session_id}`);
  }
  const workspace = { workspace: sessionStore.getWorkspaceMetadata(job.session_id) };
  const prepared = await buildDeferredSessionExtraction({
    db,
    job,
    repository,
    artifacts,
    workspace,
    fetchImpl,
  });
  // applySessionExtraction writes are idempotent: upsertEpisodeDigest uses
  // ON CONFLICT(session_id) DO UPDATE and insertSemanticMemory uses a
  // find-before-upsert pattern — so a reclaimed worker processing the same
  // session will produce the same result without creating duplicates.
  applySessionExtraction({
    db,
    sessionId: job.session_id,
    repository: job.repository ?? repository,
    sessionArtifacts: artifacts,
    workspace,
    extraction: prepared.extraction,
  });
  db.completeDeferredExtraction(job.session_id, ownerToken);
  return prepared;
}

/**
 * Wrap processDeferredExtractionJob with a heartbeat interval so the lease
 * stays alive during long-running extraction work.  Clears the interval on
 * completion or error, ensuring no dangling timers.
 *
 * @param {object} params
 * @param {number} [params.heartbeatIntervalMs=120000] - How often to renew (default 2 min)
 * @param {number} [params.leaseDurationMs=600000] - Each renewal extends lease by this (default 10 min)
 */
async function processDeferredExtractionJobWithHeartbeat({
  db,
  sessionStore,
  repository,
  job,
  fetchImpl,
  ownerToken,
  heartbeatIntervalMs = 2 * 60 * 1000,
  leaseDurationMs = 10 * 60 * 1000,
}) {
  let heartbeatInterval = null;
  try {
    heartbeatInterval = setInterval(() => {
      db.heartbeatDeferredExtraction(job.session_id, ownerToken, leaseDurationMs);
    }, heartbeatIntervalMs);
    return await processDeferredExtractionJob({
      db,
      sessionStore,
      repository,
      job,
      fetchImpl,
      ownerToken,
    });
  } finally {
    if (heartbeatInterval !== null) {
      clearInterval(heartbeatInterval);
    }
  }
}

export async function processDeferredExtractions({
  db,
  sessionStore,
  repository,
  limit = 2,
  retryDelayMinutes = 15,
  fetchImpl = globalThis.fetch,
}) {
  // Reap abandoned work before claiming new jobs. This covers both modern
  // lease-aware rows and legacy running rows created before leases existed.
  const staleJobAfterMinutes = clampInteger(
    db.config?.deferredExtraction?.staleJobAfterMinutes,
    30,
    { min: 1, max: 365 * 24 * 60 },
  );
  db.reclaimStaleDeferredExtractions?.({
    staleAfterMs: staleJobAfterMinutes * 60 * 1000,
  });
  const staleRunAfterMinutes = clampInteger(
    db.config?.maintenanceScheduler?.staleRunAfterMinutes,
    30,
    { min: 1, max: 365 * 24 * 60 },
  );
  db.reclaimStaleMaintenanceRuns?.({
    staleAfterMs: staleRunAfterMinutes * 60 * 1000,
  });

  const jobs = db.listDeferredExtractions({
    repository,
    limit,
  });

  const ownerToken = generateOwnerToken();
  let processed = 0;
  let failed = 0;
  let inferenceUsed = 0;
  let inferenceFailed = 0;
  const inferenceErrors = [];

  for (const job of jobs) {
    const claimed = db.claimDeferredExtraction(job.session_id, ownerToken);
    if (!claimed) {
      // Another worker claimed this job between listDeferredExtractions and now.
      continue;
    }
    try {
      const result = await processDeferredExtractionJobWithHeartbeat({
        db,
        sessionStore,
        repository,
        job,
        fetchImpl,
        ownerToken,
      });
      if (result.inferenceUsed) {
        inferenceUsed += 1;
      }
      if (result.inferenceError) {
        inferenceFailed += 1;
        inferenceErrors.push({
          sessionId: job.session_id,
          message: result.inferenceError,
        });
      }
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.failDeferredExtraction(job.session_id, {
        errorMessage: message,
        retryDelayMinutes,
        ownerToken,
      });
      failed += 1;
    }
  }

  return {
    inspected: jobs.length,
    processed,
    failed,
    inferenceUsed,
    inferenceFailed,
    inferenceErrors,
  };
}

function normalizeBackfillRepository({ repository, includeOtherRepositories }) {
  return includeOtherRepositories ? null : repository;
}

function resolveControlledBackfillSnapshotPolicy(value) {
  if (value === undefined) {
    return "auto";
  }
  if (value === "auto" || value === "never") {
    return value;
  }
  throw new Error(
    `invalid controlled backfill snapshot policy: ${String(value)}; expected "auto" or "never"`,
  );
}

function maybeCreateControlledBackfillSnapshot({ db, candidateCount, snapshotPolicy }) {
  const resolvedSnapshotPolicy = resolveControlledBackfillSnapshotPolicy(snapshotPolicy);
  if (candidateCount <= 0) {
    return null;
  }
  return resolvedSnapshotPolicy === "never"
    ? null
    : db.backupDatabase();
}

function buildPlanEntries({
  db,
  candidates,
  repository,
  refreshExisting = true,
}) {
  const plan = [];
  let skippedExisting = 0;
  let ordinal = 0;
  for (const candidate of candidates) {
    const hasEpisode = db.hasEpisodeDigest(candidate.id);
    if (!refreshExisting && hasEpisode) {
      skippedExisting += 1;
      continue;
    }
    ordinal += 1;
    plan.push({
      ordinal,
      sessionId: candidate.id,
      repository: candidate.repository ?? repository,
      updatedAt: candidate.updated_at ?? null,
      summary: candidate.summary ?? null,
      plannedAction: hasEpisode ? "refresh" : "create",
    });
  }
  return {
    skippedExisting,
    candidates: plan,
  };
}

function buildControlledBackfillPlan({
  db,
  sessionStore,
  repository,
  includeOtherRepositories = false,
  limit = 25,
  refreshExisting = true,
}) {
  const targetRepository = normalizeBackfillRepository({ repository, includeOtherRepositories });
  const candidates = sessionStore.getRecentSessions({
    repository: targetRepository,
    limit,
  });

  const plan = buildPlanEntries({
    db,
    candidates,
    repository: targetRepository,
    refreshExisting,
  });

  return {
    repository: targetRepository,
    inspected: candidates.length,
    skippedExisting: plan.skippedExisting,
    candidates: plan.candidates,
  };
}

export function previewControlledBackfill({
  db,
  sessionStore,
  repository,
  includeOtherRepositories = false,
  limit = 25,
  refreshExisting = true,
}) {
  const plan = buildControlledBackfillPlan({
    db,
    sessionStore,
    repository,
    includeOtherRepositories,
    limit,
    refreshExisting,
  });
  return {
    dryRun: true,
    ...plan,
  };
}

function buildWindowCursor(window) {
  const lastRow = window[window.length - 1];
  if (!lastRow) return null;
  return {
    updatedAt: "sessionStoreUpdatedAt" in lastRow
      ? (lastRow.sessionStoreUpdatedAt ?? "")
      : (lastRow.updated_at ?? ""),
    id: lastRow.id,
  };
}

function collectWindowEntries({ db, window, targetRepository, refreshExisting, candidateLimit, collected }) {
  const matching = targetRepository
    ? window.filter((c) => c.repository === targetRepository)
    : window;
  const plan = buildPlanEntries({ db, candidates: matching, repository: targetRepository, refreshExisting });
  const entries = plan.candidates.slice(0, candidateLimit - collected.length).map((c) => ({
    id: c.sessionId,
    repository: c.repository,
    updated_at: c.updatedAt,
    summary: c.summary,
    plannedAction: c.plannedAction,
  }));
  return { entries, skippedExisting: plan.skippedExisting };
}

export async function buildSessionStartBackfillPreview({
  db,
  sessionStore,
  repository,
  includeOtherRepositories = false,
  maxCandidates = 250,
  maxInspected = 2000,
  refreshExisting = false,
  scanWindowSize = 100,
}) {
  const targetRepository = normalizeBackfillRepository({ repository, includeOtherRepositories });
  const candidateLimit = Math.max(1, Math.floor(maxCandidates));
  const inspectedLimit = Math.max(1, Math.floor(maxInspected));
  const windowSize = Math.max(1, Math.floor(scanWindowSize));
  const collected = [];
  let cursor = null;
  let inspected = 0;
  let skippedExisting = 0;

  while (collected.length < candidateLimit && inspected < inspectedLimit) {
    const window = sessionStore.getRecentSessionsWindow({
      limit: Math.min(windowSize, inspectedLimit - inspected),
      cursor,
    });
    if (!Array.isArray(window) || window.length === 0) {
      break;
    }
    inspected += window.length;
    cursor = buildWindowCursor(window) ?? cursor;

    const { entries, skippedExisting: windowSkipped } = collectWindowEntries({
      db, window, targetRepository, refreshExisting, candidateLimit, collected,
    });
    skippedExisting += windowSkipped;
    collected.push(...entries);
    if (collected.length < candidateLimit) {
      await delay(0);
    }
  }
  const inspectionBoundReached = inspected >= inspectedLimit && collected.length < candidateLimit;

  return {
    dryRun: true,
    repository: targetRepository,
    inspected,
    inspectionLimit: inspectedLimit,
    inspectionBoundReached,
    skippedExisting,
    candidates: collected.map((candidate, index) => ({
      ordinal: index + 1,
      sessionId: candidate.id,
      repository: candidate.repository,
      updatedAt: candidate.updated_at ?? null,
      summary: candidate.summary ?? null,
      plannedAction: candidate.plannedAction,
    })),
  };
}

export function processControlledBackfillRun({
  db,
  sessionStore,
  runId,
  limit,
  retryFailed = false,
}) {
  const run = db.getBackfillRun(runId);
  if (!run) {
    throw new Error(`backfill run not found: ${runId}`);
  }

  const statuses = retryFailed ? ["pending", "failed"] : ["pending"];
  const items = db.listBackfillRunItems({
    runId,
    statuses,
    limit: limit ?? run.batch_size,
  });
  let processed = 0;
  let failed = 0;
  let lastError = null;

  for (const item of items) {
    try {
      const beforeEpisode = db.getEpisodeDigestBySession(item.session_id);
      const beforeSemanticCount = db.countGeneratedSemanticMemoriesBySession(item.session_id);
      const artifacts = sessionStore.getSessionArtifacts(item.session_id);
      if (!artifacts) {
        throw new Error(`session artifacts not found for ${item.session_id}`);
      }
      applySessionExtraction({
        db,
        sessionId: item.session_id,
        repository: item.repository ?? run.repository,
        sessionArtifacts: artifacts,
        workspace: { workspace: sessionStore.getWorkspaceMetadata(item.session_id) },
      });
      const afterEpisode = db.getEpisodeDigestBySession(item.session_id);
      const afterSemanticCount = db.countGeneratedSemanticMemoriesBySession(item.session_id);
      db.updateBackfillRunItem({
        runId,
        sessionId: item.session_id,
        status: "completed",
        semanticBeforeCount: beforeSemanticCount,
        semanticAfterCount: afterSemanticCount,
        semanticDelta: afterSemanticCount - beforeSemanticCount,
        episodeBeforeScope: beforeEpisode?.scope ?? null,
        episodeAfterScope: afterEpisode?.scope ?? null,
      });
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.updateBackfillRunItem({
        runId,
        sessionId: item.session_id,
        status: "failed",
        error: message,
      });
      failed += 1;
      lastError = message;
    }
  }

  const summary = db.refreshBackfillRunSummary(runId, { lastError });
  return {
    run: summary,
    processed,
    failed,
    inspected: items.length,
    items: db.listBackfillRunItems({
      runId,
      limit: Math.max(run.batch_size, 10),
    }),
  };
}

export function startControlledBackfillRun({
  db,
  sessionStore,
  repository,
  includeOtherRepositories = false,
  limit = 25,
  refreshExisting = true,
  batchSize = 5,
  plan = null,
  snapshotPolicy = "auto",
}) {
  const effectivePlan = plan && Array.isArray(plan.candidates)
    ? plan
    : buildControlledBackfillPlan({
      db,
      sessionStore,
      repository,
      includeOtherRepositories,
      limit,
      refreshExisting,
    });
  const snapshotPath = maybeCreateControlledBackfillSnapshot({
    db,
    candidateCount: effectivePlan.candidates.length,
    snapshotPolicy,
  });
  const runId = db.createBackfillRun({
    strategy: "session_refresh",
    dryRun: false,
    repository: effectivePlan.repository,
    includeOtherRepositories,
    refreshExisting,
    batchSize,
    totalCandidates: effectivePlan.candidates.length,
    snapshotPath,
    metadata: {
      inspected: effectivePlan.inspected,
      skippedExisting: effectivePlan.skippedExisting,
    },
  });
  db.insertBackfillRunItems(runId, effectivePlan.candidates);
  const result = processControlledBackfillRun({
    db,
    sessionStore,
    runId,
    limit: batchSize,
  });
  return {
    runId,
    snapshotPath,
    inspected: effectivePlan.inspected,
    skippedExisting: effectivePlan.skippedExisting,
    totalCandidates: effectivePlan.candidates.length,
    ...result,
  };
}

export function restoreControlledBackfillRun({
  db,
  runId,
}) {
  const run = db.getBackfillRun(runId);
  if (!run) {
    throw new Error(`backfill run not found: ${runId}`);
  }
  if (!run.snapshot_path) {
    throw new Error(`backfill run ${runId} does not have a snapshot path`);
  }
  const restored = db.restoreFromBackup(run.snapshot_path);
  return {
    runId,
    snapshotPath: run.snapshot_path,
    ...restored,
  };
}
