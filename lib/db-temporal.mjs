import { normalizeText } from "./text-normalizer.mjs";

// Pure utility functions
function isCrossRepoRow(row, repository) {
  return !!(
    row
    && row.repository
    && (!repository || row.repository !== repository)
  );
}

function serializeSessionTraceRow(session, currentRepository = null) {
  return {
    sessionId: session.session_id ?? null,
    sourceType: session.source_type ?? null,
    repository: session.repository ?? null,
    updatedAt: session.updated_at ?? null,
    crossRepo: isCrossRepoRow(session, currentRepository),
    excerpt: normalizeText(session.excerpt || session.workspaceSummary || session.summary),
  };
}

// Pure helper functions
function pushPromptContextSection(lines, title) {
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(`## ${title}`, "");
}

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

function formatSessionHintLine(session) {
  const excerpt = normalizeText(session.excerpt || session.workspaceSummary || session.summary);
  if (!excerpt) {
    return "";
  }
  const prefix = session.updated_at ? `${String(session.updated_at).slice(0, 10)}: ` : "";
  const sourceLabel = session.source_type ? `[${session.source_type}] ` : "";
  const repositoryLabel = session.currentRepository
    && session.repository
    && session.repository !== session.currentRepository
    ? ` [example from ${session.repository}]`
    : "";
  return `- ${prefix}${sourceLabel}${excerpt}${repositoryLabel}`;
}

function formatTemporalVerifierSessionLine(session) {
  const summary = normalizeText(session.workspaceSummary || session.summary);
  if (!summary) {
    return "";
  }
  const timestamp = session.sessionStoreUpdatedAt
    ?? session.sessionStoreCreatedAt
    ?? session.updated_at
    ?? session.created_at
    ?? "";
  const prefix = timestamp ? `${String(timestamp).slice(0, 10)}: ` : "";
  const repositoryLabel = session.currentRepository
    && session.repository
    && session.repository !== session.currentRepository
    ? ` [example from ${session.repository}]`
    : "";
  return `- ${prefix}${summary}${repositoryLabel}`;
}

// Temporal-related prompt section functions
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

function appendPromptTemporalVerifierSection(lines, trace, {
  repository,
  temporalVerifierRows,
  shouldRunTemporalVerifier,
  temporalDate,
}) {
  if (temporalVerifierRows.length > 0) {
    pushPromptContextSection(lines, "Verified Session History");
    for (const session of temporalVerifierRows) {
      const line = formatTemporalVerifierSessionLine(session);
      if (line) {
        lines.push(line);
      }
    }
    trace.lookups.temporalVerifier.includedRows = temporalVerifierRows.map((session) => serializeSessionTraceRow(session, repository));
    trace.output.sectionTitles.push("Verified Session History");
    return;
  }
  if (shouldRunTemporalVerifier) {
    trace.omissions.push({
      stage: "temporal_verifier",
      reason: trace.lookups.temporalVerifier.reason ?? "no_sessions_for_date",
      date: temporalDate,
    });
  }
}

function appendPromptCrossRepoHintsSection(lines, trace, {
  repository,
  crossRepoEpisodes,
  crossRepoHints,
  allowGenericCrossRepoFallback,
  pureTemporalRecall,
  sessionStore,
}) {
  if (crossRepoEpisodes.length === 0 && crossRepoHints.length > 0) {
    pushPromptContextSection(lines, "Cross-Repo Hints");
    for (const session of crossRepoHints) {
      const line = formatSessionHintLine(session);
      if (line) {
        lines.push(line);
      }
    }
    trace.lookups.crossRepoHints.includedRows = crossRepoHints.map((session) => serializeSessionTraceRow(session, repository));
    trace.output.sectionTitles.push("Cross-Repo Hints");
    return;
  }
  if (!allowGenericCrossRepoFallback) {
    trace.lookups.crossRepoHints.reason = pureTemporalRecall
      ? "handled_by_temporal_day_summaries"
      : "cross_repo_lookup_disabled";
    trace.omissions.push({
      stage: "cross_repo_hints",
      reason: pureTemporalRecall ? "handled_by_temporal_day_summaries" : "cross_repo_lookup_disabled",
    });
    return;
  }
  if (!sessionStore) {
    trace.lookups.crossRepoHints.reason = "session_store_unavailable";
    trace.omissions.push({ stage: "cross_repo_hints", reason: "session_store_unavailable" });
    return;
  }
  if (crossRepoEpisodes.length > 0) {
    trace.lookups.crossRepoHints.reason = "suppressed_by_cross_repo_examples";
    trace.omissions.push({ stage: "cross_repo_hints", reason: "suppressed_by_cross_repo_examples" });
    return;
  }
  trace.lookups.crossRepoHints.reason = "no_cross_repo_hints";
  trace.omissions.push({ stage: "cross_repo_hints", reason: "no_cross_repo_hints" });
}

export {
  appendPromptCrossRepoHintsSection,
  appendPromptTemporalRecallIntro,
  appendPromptTemporalVerifierSection,
  isCrossRepoRow,
  pushPromptContextSection,
  serializeSessionTraceRow,
  setPromptTemporalVerifierTraceState,
};
