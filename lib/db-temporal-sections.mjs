import { normalizeText } from "./session-text-normalizer.mjs";
import {
  pushPromptContextSection,
  serializeSessionTraceRow,
} from "./db-temporal-shared.mjs";

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

// fallow-ignore-next-line complexity
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
  appendPromptTemporalVerifierSection,
};
