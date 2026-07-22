const MEMORY_STATUS_IDENTITY_FIELDS = Object.freeze([
  ["enabled", "config", "enabled"],
  ["repository", "runtime", "repository", "global-only"],
  ["dbPath", "stats", "dbPath"],
  ["schemaVersion", "stats", "schemaVersion"],
  ["semanticCount", "stats", "semanticCount"],
  ["episodeCount", "stats", "episodeCount"],
  ["semanticGlobalCount", "stats", "semanticGlobalCount"],
  ["semanticTransferableCount", "stats", "semanticTransferableCount"],
  ["semanticRepoCount", "stats", "semanticRepoCount"],
  ["semanticManualCount", "stats", "semanticManualCount"],
  ["episodeTransferableCount", "stats", "episodeTransferableCount"],
  ["episodeRepoCount", "stats", "episodeRepoCount"],
  ["episodeManualCount", "stats", "episodeManualCount"],
  ["daySummaryCount", "stats", "daySummaryCount"],
  ["overrideAuditCount", "stats", "overrideAuditCount"],
  ["semanticCanonicalCount", "stats", "semanticCanonicalCount", 0],
  ["semanticReinforcedCount", "stats", "semanticReinforcedCount", 0],
  ["assistantGoalCount", "stats", "assistantGoalCount", 0],
  ["recurringMistakeCount", "stats", "recurringMistakeCount", 0],
  ["userIdentityCount", "stats", "userIdentityCount", 0],
  ["workstreamOverlayCount", "stats", "workstreamOverlayCount", 0],
  ["domainCount", "stats", "domainCount", 0],
  ["observationCount", "stats", "observationCount", 0],
  ["directiveCount", "stats", "directiveCount", 0],
]);

export function buildMemoryStatusIdentityLines(runtime, stats) {
  const sources = { config: runtime.config, runtime, stats };
  return MEMORY_STATUS_IDENTITY_FIELDS.map(([label, source, key, fallback]) => (
    `${label}: ${sources[source][key] ?? fallback}`
  ));
}
