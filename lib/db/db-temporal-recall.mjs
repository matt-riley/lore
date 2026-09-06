import {
  serializeSessionTraceRow,
} from "./db-temporal-shared.mjs";

function resolveTemporalSignal(temporalDate, hasIncludedDaySummary, hasIncludedEpisodes, temporalVerifierRows, daySummaryReason) {
  if (temporalDate === null) {
    return { source: "none", confidence: "none", verifierReason: daySummaryReason };
  }
  if (hasIncludedDaySummary) {
    return { source: "day_summary", confidence: "high", verifierReason: null };
  }
  if (hasIncludedEpisodes) {
    return { source: "episode_fallback", confidence: "medium", verifierReason: null };
  }
  if (temporalVerifierRows.length > 0) {
    return { source: "session_store_verifier", confidence: "low", verifierReason: daySummaryReason };
  }
  const verifierReason = daySummaryReason === "missing_day_summary" || daySummaryReason === "summary_did_not_match_prompt_terms"
    ? daySummaryReason
    : null;
  return { source: "none", confidence: "none", verifierReason };
}

function appendPromptTemporalRecallIntro(lines, trace, {
  need,
  temporalDate,
  allowCrossRepoFallback,
  pureTemporalRecall,
  hasIncludedDaySummary,
  hasIncludedEpisodes,
  temporalVerifierRows,
  daySummaryReason,
}) {
  if (!need.hasTemporalSignal) {
    return;
  }
  const temporalScope = allowCrossRepoFallback && pureTemporalRecall ? "cross_repo" : "local";
  const { source: temporalSource, confidence: temporalConfidence, verifierReason: temporalVerifierReason } =
    resolveTemporalSignal(temporalDate, hasIncludedDaySummary, hasIncludedEpisodes, temporalVerifierRows, daySummaryReason);

  trace.temporal = {
    date: temporalDate,
    source: temporalSource,
    confidence: temporalConfidence,
    scope: temporalScope,
    verifierUsed: temporalVerifierRows.length > 0,
    verifierReason: temporalVerifierReason,
  };

  if (temporalDate === null || temporalSource === "none") {
    return;
  }
  if (temporalSource === "session_store_verifier") {
    lines.push(`Temporal recall: low confidence, verified from raw session history (${temporalDate}, ${temporalScope}).`);
    return;
  }
  const sourceLabel = temporalSource === "day_summary" ? "day summary" : "episode fallback";
  lines.push(`Temporal recall: ${temporalConfidence} confidence via ${sourceLabel} (${temporalDate}, ${temporalScope}).`);
}

function setPromptTemporalVerifierTraceState({
  trace,
  repository,
  sessionStore,
  temporalDate,
  pureTemporalRecall,
  temporalVerifierEnabled,
  shouldRunTemporalVerifier,
  temporalVerifierRows,
}) {
  trace.lookups.temporalVerifier.enabled = !!sessionStore && temporalDate !== null && pureTemporalRecall;
  trace.lookups.temporalVerifier.rows = temporalVerifierRows.map((session) => serializeSessionTraceRow(session, repository));
  if (!temporalVerifierEnabled) {
    trace.lookups.temporalVerifier.reason = !sessionStore
      ? "session_store_unavailable"
      : temporalDate === null
        ? "unresolved_temporal_date"
        : "non_pure_temporal_prompt";
  } else if (!shouldRunTemporalVerifier) {
    trace.lookups.temporalVerifier.reason = "primary_temporal_evidence_available";
  } else if (temporalVerifierRows.length === 0) {
    trace.lookups.temporalVerifier.reason = "no_sessions_for_date";
  }
}

export {
  appendPromptTemporalRecallIntro,
  setPromptTemporalVerifierTraceState,
};
