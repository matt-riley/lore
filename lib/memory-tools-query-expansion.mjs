import { expandRetrievalQueryWithLocalInference } from "./local-inference-augmentation.mjs";

const QUERY_EVIDENCE_LOOKUPS = new Set([
  "workstreamOverlays",
  "localMemories",
  "daySummary",
  "localEpisodes",
  "crossRepoPreferences",
  "crossRepoEpisodes",
  "crossRepoHints",
  "temporalVerifier",
]);

export async function resolveRetrievalPrompt(runtime, prompt) {
  if (runtime.config?.localInference?.queryExpansion?.enabled !== true) {
    return {
      query: prompt,
      addedTerms: [],
      requested: false,
      used: false,
      error: null,
    };
  }
  if (runtime.config?.localInference?.enabled !== true) {
    return {
      query: prompt,
      addedTerms: [],
      requested: true,
      used: false,
      error: "provider disabled",
    };
  }
  try {
    const expanded = await expandRetrievalQueryWithLocalInference({
      config: runtime.config.localInference,
      prompt,
      deterministicQuery: prompt,
      fetchImpl: runtime.localInferenceFetch,
    });
    return {
      ...expanded,
      requested: true,
      error: null,
    };
  } catch (error) {
    return {
      query: prompt,
      addedTerms: [],
      requested: true,
      used: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function recallHasQueryEvidence(result) {
  return Object.entries(result.trace?.lookups ?? {}).some(([name, lookup]) => (
    QUERY_EVIDENCE_LOOKUPS.has(name)
    && (
      (Array.isArray(lookup?.includedRows) && lookup.includedRows.length > 0)
      || (Array.isArray(lookup?.rows) && lookup.rows.length > 0)
      || (Array.isArray(lookup?.rankedRows) && lookup.rankedRows.length > 0)
    )
  ));
}
