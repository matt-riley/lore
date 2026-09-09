import { queryActivityStateRow, mapActivityStateRow } from "./db-activity-state.mjs";

const SEMANTIC_SCOPE_STAT_FIELDS = Object.freeze([
  ["semanticGlobalCount", "global_count"],
  ["semanticTransferableCount", "transferable_count"],
  ["semanticRepoCount", "repo_count"],
  ["semanticManualCount", "manual_count"],
]);

const EPISODE_SCOPE_STAT_FIELDS = Object.freeze([
  ["episodeGlobalCount", "global_count"],
  ["episodeTransferableCount", "transferable_count"],
  ["episodeRepoCount", "repo_count"],
  ["episodeManualCount", "manual_count"],
]);

const SEMANTIC_GROWTH_STAT_FIELDS = Object.freeze([
  ["semanticCanonicalCount", "canonical_count"],
  ["semanticReinforcedCount", "reinforced_count"],
  ["assistantGoalCount", "assistant_goal_count"],
  ["recurringMistakeCount", "recurring_mistake_count"],
  ["userIdentityCount", "user_identity_count"],
  ["workstreamOverlayCount", "workstream_overlay_count"],
  ["directiveCount", "directive_count"],
]);

const IMPROVEMENT_STAT_FIELDS = Object.freeze([
  ["improvementCount", "total_count"],
  ["improvementActiveCount", "active_count"],
  ["improvementResolvedCount", "resolved_count"],
  ["improvementSupersededCount", "superseded_count"],
  ["improvementProposalCount", "proposal_count"],
  ["draftProposalCount", "draft_proposal_count"],
  ["approvedProposalCount", "approved_proposal_count"],
  ["rejectedProposalCount", "rejected_proposal_count"],
  ["supersededProposalCount", "superseded_proposal_count"],
]);

const BACKFILL_STAT_FIELDS = Object.freeze([
  ["backfillRunningCount", "running_count"],
  ["backfillCompletedCount", "completed_count"],
  ["backfillFailedCount", "failed_count"],
  ["backfillDryRunCount", "dry_run_count"],
]);

const DEFERRED_STAT_FIELDS = Object.freeze([
  ["deferredPendingCount", "pending_count"],
  ["deferredRunningCount", "running_count"],
  ["deferredFailedCount", "failed_count"],
  ["deferredCompletedCount", "completed_count"],
]);

const MAINTENANCE_STAT_FIELDS = Object.freeze([
  ["maintenanceCompletedCount", "completed_count"],
  ["maintenanceNeedsAttentionCount", "needs_attention_count"],
  ["maintenanceFailedCount", "failed_count"],
  ["maintenanceSkippedCount", "skipped_count"],
]);

const TRAJECTORY_STAT_FIELDS = Object.freeze([
  ["trajectoryArtifactCount", "total_count"],
  ["trajectoryReplayFailureCount", "replay_failure_count"],
  ["trajectoryValidationMissCount", "validation_miss_count"],
  ["trajectoryProposalFailureCount", "proposal_failure_count"],
  ["trajectoryLatencyOutlierCount", "latency_outlier_count"],
]);

const INTENT_JOURNAL_STAT_FIELDS = Object.freeze([
  ["intentJournalCount", "total_count"],
  ["intentRoutingCount", "routing_count"],
  ["intentRolloutCount", "rollout_count"],
  ["intentReviewerCount", "reviewer_count"],
  ["intentFallbackCount", "fallback_count"],
  ["intentSerendipityCount", "serendipity_count"],
]);

const RETRIEVAL_TRACE_SAMPLE_STAT_FIELDS = Object.freeze([
  ["retrievalTraceSampleCount", "total_count"],
  ["retrievalTraceSampleGlobalCount", "global_count"],
  ["retrievalTraceSampleRepositoryCount", "repository_count"],
]);

function readTableCount(db, tableName) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function mapStatFields(row, mappings) {
  return Object.fromEntries(
    mappings.map(([outputKey, rowKey]) => [outputKey, row?.[rowKey] ?? 0]),
  );
}

function serializeLastSuccessActivity(row) {
  if (!row) {
    return null;
  }
  return mapActivityStateRow(row);
}

function buildLoreStatsPayload({
  config,
  lastBackupPath,
  semanticCount,
  episodeCount,
  domainCount,
  observationCount,
  semanticScopes,
  episodeScopes,
  daySummaryCount,
  schemaVersion,
  overrideAuditCount,
  semanticGrowth,
  improvementCounts,
  backfillCounts,
  deferredCounts,
  maintenanceCounts,
  maintenanceLatest,
  maintenanceTaskCount,
  trajectoryCounts,
  intentJournalCounts,
  retrievalTraceSampleCounts,
  latestActivity,
}) {
  return {
    semanticCount,
    episodeCount,
    domainCount,
    observationCount,
    ...mapStatFields(semanticScopes, SEMANTIC_SCOPE_STAT_FIELDS),
    ...mapStatFields(episodeScopes, EPISODE_SCOPE_STAT_FIELDS),
    daySummaryCount,
    schemaVersion,
    dbPath: config.paths.derivedStorePath,
    backupDir: config.paths.backupDir,
    lastBackupPath,
    overrideAuditCount,
    ...mapStatFields(semanticGrowth, SEMANTIC_GROWTH_STAT_FIELDS),
    ...mapStatFields(improvementCounts, IMPROVEMENT_STAT_FIELDS),
    ...mapStatFields(backfillCounts, BACKFILL_STAT_FIELDS),
    ...mapStatFields(deferredCounts, DEFERRED_STAT_FIELDS),
    ...mapStatFields(maintenanceCounts, MAINTENANCE_STAT_FIELDS),
    maintenanceTaskStateCount: maintenanceTaskCount,
    lastMaintenanceStatus: maintenanceLatest?.status ?? null,
    lastMaintenanceStartedAt: maintenanceLatest?.started_at ?? null,
    lastMaintenanceCompletedAt: maintenanceLatest?.completed_at ?? null,
    ...mapStatFields(trajectoryCounts, TRAJECTORY_STAT_FIELDS),
    ...mapStatFields(intentJournalCounts, INTENT_JOURNAL_STAT_FIELDS),
    ...mapStatFields(retrievalTraceSampleCounts, RETRIEVAL_TRACE_SAMPLE_STAT_FIELDS),
    lastSuccessActivity: serializeLastSuccessActivity(latestActivity),
  };
}

function querySemanticMemoryStats(db) {
  const semanticCount = readTableCount(db, "semantic_memory");
  const semanticGrowth = db.prepare(`
    SELECT
      SUM(CASE WHEN canonical_key IS NOT NULL THEN 1 ELSE 0 END) AS canonical_count,
      SUM(CASE WHEN reinforcement_count > 1 THEN 1 ELSE 0 END) AS reinforced_count,
      SUM(CASE WHEN type = 'assistant_goal' THEN 1 ELSE 0 END) AS assistant_goal_count,
      SUM(CASE WHEN type = 'recurring_mistake' THEN 1 ELSE 0 END) AS recurring_mistake_count,
      SUM(CASE WHEN type = 'user_identity' THEN 1 ELSE 0 END) AS user_identity_count,
      SUM(CASE WHEN type = 'workstream_overlay' THEN 1 ELSE 0 END) AS workstream_overlay_count,
      SUM(CASE WHEN type = 'directive' THEN 1 ELSE 0 END) AS directive_count
    FROM semantic_memory
    WHERE superseded_by IS NULL
  `).get();
  const semanticScopes = db.prepare(`
    SELECT
      SUM(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) AS global_count,
      SUM(CASE WHEN scope = 'transferable' THEN 1 ELSE 0 END) AS transferable_count,
      SUM(CASE WHEN scope = 'repo' THEN 1 ELSE 0 END) AS repo_count,
      SUM(CASE WHEN scope_source = 'manual' THEN 1 ELSE 0 END) AS manual_count
    FROM semantic_memory
  `).get();
  return { semanticCount, semanticGrowth, semanticScopes };
}

function queryEpisodeDigestStats(db) {
  const episodeCount = readTableCount(db, "episode_digest");
  const episodeScopes = db.prepare(`
    SELECT
      SUM(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) AS global_count,
      SUM(CASE WHEN scope = 'transferable' THEN 1 ELSE 0 END) AS transferable_count,
      SUM(CASE WHEN scope = 'repo' THEN 1 ELSE 0 END) AS repo_count,
      SUM(CASE WHEN scope_source = 'manual' THEN 1 ELSE 0 END) AS manual_count
    FROM episode_digest
  `).get();
  const daySummaryCount = db.prepare(`SELECT COUNT(*) AS count FROM day_summary`).get().count;
  return { episodeCount, episodeScopes, daySummaryCount };
}

function queryExtractionJobStats(db) {
  const deferredCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count
    FROM deferred_extraction
  `).get();
  const backfillCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN dry_run = 1 THEN 1 ELSE 0 END) AS dry_run_count
    FROM backfill_run
    `).get();
  return { deferredCounts, backfillCounts };
}

function queryMaintenanceRunStats(db) {
  const maintenanceCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status = 'needs_attention' THEN 1 ELSE 0 END) AS needs_attention_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
    FROM maintenance_run
    WHERE dry_run = 0
  `).get();
  const maintenanceLatest = db.prepare(`
    SELECT status, started_at, completed_at
    FROM maintenance_run
    WHERE dry_run = 0
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();
  const maintenanceTaskCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM maintenance_task_state
  `).get().count;
  return { maintenanceCounts, maintenanceLatest, maintenanceTaskCount };
}

function queryImprovementBacklogStats(db) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
      SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded_count,
      SUM(CASE WHEN proposal_path IS NOT NULL THEN 1 ELSE 0 END) AS proposal_count,
      SUM(CASE WHEN review_state = 'draft' THEN 1 ELSE 0 END) AS draft_proposal_count,
      SUM(CASE WHEN review_state = 'approved' THEN 1 ELSE 0 END) AS approved_proposal_count,
      SUM(CASE WHEN review_state = 'rejected' THEN 1 ELSE 0 END) AS rejected_proposal_count,
      SUM(CASE WHEN review_state = 'superseded' THEN 1 ELSE 0 END) AS superseded_proposal_count
    FROM improvement_backlog
  `).get();
}

function querySignalStats(db) {
  const trajectoryCounts = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN kind = 'replay_failure' THEN 1 ELSE 0 END) AS replay_failure_count,
      SUM(CASE WHEN kind = 'validation_miss' THEN 1 ELSE 0 END) AS validation_miss_count,
      SUM(CASE WHEN kind = 'proposal_failure' THEN 1 ELSE 0 END) AS proposal_failure_count,
      SUM(CASE WHEN kind = 'latency_outlier' THEN 1 ELSE 0 END) AS latency_outlier_count
    FROM trajectory_artifact
  `).get();
  const intentJournalCounts = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN intent_kind = 'routing' THEN 1 ELSE 0 END) AS routing_count,
      SUM(CASE WHEN intent_kind = 'rollout' THEN 1 ELSE 0 END) AS rollout_count,
      SUM(CASE WHEN intent_kind = 'reviewer' THEN 1 ELSE 0 END) AS reviewer_count,
      SUM(CASE WHEN intent_kind = 'fallback' THEN 1 ELSE 0 END) AS fallback_count,
      SUM(CASE WHEN intent_kind = 'serendipity' THEN 1 ELSE 0 END) AS serendipity_count
    FROM intent_journal
  `).get();
  const retrievalTraceSampleCounts = db.prepare(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN repository IS NULL OR repository = '' THEN 1 ELSE 0 END) AS global_count,
      SUM(CASE WHEN repository IS NOT NULL AND repository != '' THEN 1 ELSE 0 END) AS repository_count
    FROM retrieval_trace_sample
  `).get();
  return { trajectoryCounts, intentJournalCounts, retrievalTraceSampleCounts };
}

export function getStats(owner) {
  owner.ensureOpen();
  const { semanticCount, semanticGrowth, semanticScopes } = querySemanticMemoryStats(owner.db);
  const { episodeCount, episodeScopes, daySummaryCount } = queryEpisodeDigestStats(owner.db);
  const domainCount = readTableCount(owner.db, "memory_domain");
  const observationCount = readTableCount(owner.db, "refreshable_observation");
  const { deferredCounts, backfillCounts } = queryExtractionJobStats(owner.db);
  const schemaVersion = owner.getCurrentVersion();
  const overrideAuditCount = readTableCount(owner.db, "scope_override_audit");
  const improvementCounts = queryImprovementBacklogStats(owner.db);
  const { maintenanceCounts, maintenanceLatest, maintenanceTaskCount } = queryMaintenanceRunStats(owner.db);
  const { trajectoryCounts, intentJournalCounts, retrievalTraceSampleCounts } = querySignalStats(owner.db);
  const latestActivity = queryActivityStateRow(owner.db, "global");

  return buildLoreStatsPayload({
    config: owner.config,
    lastBackupPath: owner.lastBackupPath,
    semanticCount,
    episodeCount,
    domainCount,
    observationCount,
    semanticScopes,
    episodeScopes,
    daySummaryCount,
    schemaVersion,
    overrideAuditCount,
    semanticGrowth,
    improvementCounts,
    backfillCounts,
    deferredCounts,
    maintenanceCounts,
    maintenanceLatest,
    maintenanceTaskCount,
    trajectoryCounts,
    intentJournalCounts,
    retrievalTraceSampleCounts,
    latestActivity,
  });
}
