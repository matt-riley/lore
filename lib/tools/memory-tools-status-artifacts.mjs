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
