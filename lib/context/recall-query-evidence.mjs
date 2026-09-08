const QUERY_EVIDENCE_LOOKUPS = new Set([
  "workstreamOverlays",
  "localMemories",
  "daySummary",
  "localEpisodes",
  "crossRepoPreferences",
  "crossRepoEpisodes",
  "crossRepoExamples",
  "crossRepoHints",
  "temporalVerifier",
  "relevantKnowledge",
  "historyHints",
  "longRangeHints",
]);
const QUERY_EVIDENCE_FIELDS = [
  "includedRows",
  "rows",
  "rankedRows",
];

export function recallHasQueryEvidence(result) {
  return Object.entries(result.trace?.lookups ?? {}).some(([name, lookup]) => (
    QUERY_EVIDENCE_LOOKUPS.has(name)
    && QUERY_EVIDENCE_FIELDS.some((field) => (
      Array.isArray(lookup?.[field]) && lookup[field].length > 0
    ))
  ));
}
