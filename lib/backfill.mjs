import { buildSemanticCanonicalKey } from "./memory-scope.mjs";
import { retainMemory } from "./memory-operations.mjs";
import { extractSessionMemories } from "./rule-extractor.mjs";

function shouldTrackSessionImprovement(memory) {
  return memory?.type === "assistant_goal" || memory?.type === "recurring_mistake";
}

function buildSessionImprovementArtifact({ sessionId, memory, episodeDigest, linkedMemoryId }) {
  const canonicalKey = buildSemanticCanonicalKey(memory);
  const repository = memory.repository ?? episodeDigest.repository ?? "global";
  const scope = memory.scope ?? "repo";
  const signalType = memory.metadata?.signalType ?? null;
  const sourceLabel = signalType?.startsWith("repeated_") ? "Session-inferred" : "Session-derived";
  const sourceCaseId = [
    "session",
    memory.type,
    scope,
    repository,
    canonicalKey ?? String(memory.sourceTurnIndex ?? "na"),
  ].join(":");

  if (memory.type === "assistant_goal") {
    const goal = memory.metadata?.goal ?? memory.content;
    return {
      sourceCaseId,
      sourceKind: "session",
      title: `${sourceLabel} assistant goal`,
      summary: `Goal: ${goal}`,
      linkedMemoryId,
      evidence: {
        sessionId,
        repository,
        memoryType: memory.type,
        signalType,
        sourceTurnIndex: memory.sourceTurnIndex ?? null,
        content: memory.content,
        goal,
        examples: memory.metadata?.examples ?? [],
        tags: memory.tags ?? [],
      },
      trace: {
        episodeSummary: episodeDigest.summary,
        themes: episodeDigest.themes ?? [],
      },
    };
  }

  const mistake = memory.metadata?.mistake ?? memory.content;
  return {
    sourceCaseId,
    sourceKind: "session",
    title: `${sourceLabel} recurring mistake`,
    summary: `Mistake: ${mistake}`,
    linkedMemoryId,
    evidence: {
      sessionId,
      repository,
      memoryType: memory.type,
      signalType,
      sourceTurnIndex: memory.sourceTurnIndex ?? null,
      content: memory.content,
      mistake,
      examples: memory.metadata?.examples ?? [],
      tags: memory.tags ?? [],
    },
    trace: {
      episodeSummary: episodeDigest.summary,
      themes: episodeDigest.themes ?? [],
    },
  };
}

export function applySessionExtraction({
  db,
  sessionId,
  repository,
  sessionArtifacts,
  workspace,
}) {
  const extraction = extractSessionMemories({
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
  const currentPhase = run.status === "running"
    ? "processing"
    : run.status === "failed"
      ? "failed"
      : run.status === "completed"
        ? "complete"
        : run.status === "preview"
          ? "planning"
          : "idle";
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
      reason: "up_to_date",
      candidateCount: 0,
      runId: null,
    };
  }
  return {
    action: "start",
    reason: "pending_candidates",
    candidateCount,
    runId: null,
  };
}

export function backfillRecentSessions({
  db,
  sessionStore,
  repository,
  limit = 25,
  refreshExisting = false,
}) {
  const candidates = sessionStore.getRecentSessions({ repository, limit });
  let created = 0;

  for (const candidate of candidates) {
    if (!refreshExisting && db.hasEpisodeDigest(candidate.id)) {
      continue;
    }
    const artifacts = sessionStore.getSessionArtifacts(candidate.id);
    if (!artifacts) {
      continue;
    }
    applySessionExtraction({
      db,
      sessionId: candidate.id,
      repository: candidate.repository ?? repository,
      sessionArtifacts: artifacts,
      workspace: { workspace: null },
    });
    created += 1;
  }

  return { created, inspected: candidates.length };
}

export function processDeferredExtractions({
  db,
  sessionStore,
  repository,
  limit = 2,
  retryDelayMinutes = 15,
}) {
  const jobs = db.listDeferredExtractions({
    repository,
    limit,
  });

  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    db.markDeferredExtractionRunning(job.session_id);
    try {
      const artifacts = sessionStore.getSessionArtifacts(job.session_id);
      if (!artifacts) {
        throw new Error(`session artifacts not found for ${job.session_id}`);
      }
      applySessionExtraction({
        db,
        sessionId: job.session_id,
        repository: job.repository ?? repository,
        sessionArtifacts: artifacts,
        workspace: { workspace: sessionStore.getWorkspaceMetadata(job.session_id) },
      });
      db.completeDeferredExtraction(job.session_id);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.failDeferredExtraction(job.session_id, {
        errorMessage: message,
        retryDelayMinutes,
      });
      failed += 1;
    }
  }

  return {
    inspected: jobs.length,
    processed,
    failed,
  };
}

function normalizeBackfillRepository({ repository, includeOtherRepositories }) {
  return includeOtherRepositories ? null : repository;
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

export function buildSessionStartBackfillPreview({
  db,
  sessionStore,
  repository,
  includeOtherRepositories = false,
  maxCandidates = 250,
  refreshExisting = false,
  scanWindowSize = 100,
}) {
  const targetRepository = normalizeBackfillRepository({ repository, includeOtherRepositories });
  const candidateLimit = Math.max(1, Math.floor(maxCandidates));
  const windowSize = Math.max(1, Math.floor(scanWindowSize));
  const collected = [];
  let offset = 0;
  let inspected = 0;
  let skippedExisting = 0;

  while (collected.length < candidateLimit) {
    const window = sessionStore.getRecentSessionsWindow({
      limit: windowSize,
      offset,
    });
    if (!Array.isArray(window) || window.length === 0) {
      break;
    }
    offset += window.length;
    inspected += window.length;

    const matching = targetRepository
      ? window.filter((candidate) => candidate.repository === targetRepository)
      : window;
    const remaining = candidateLimit - collected.length;
    const plan = buildPlanEntries({
      db,
      candidates: matching,
      repository: targetRepository,
      refreshExisting,
    });
    skippedExisting += plan.skippedExisting;
    collected.push(...plan.candidates.slice(0, remaining).map((candidate) => ({
      id: candidate.sessionId,
      repository: candidate.repository,
      updated_at: candidate.updatedAt,
      summary: candidate.summary,
      plannedAction: candidate.plannedAction,
    })));
  }

  return {
    dryRun: true,
    repository: targetRepository,
    inspected,
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
  const snapshotPath = effectivePlan.candidates.length > 0 ? db.backupDatabase() : null;
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
