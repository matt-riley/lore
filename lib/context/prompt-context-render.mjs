import { MEMORY_SCOPE } from "../memory/memory-scope.mjs";
import { isPlaceholderSummary } from "../db/db-episode-scoring.mjs";
import {
  appendPromptCrossRepoHintsSection,
  appendPromptTemporalVerifierSection,
} from "../db/db-temporal-sections.mjs";
import { appendPromptTemporalRecallIntro } from "../db/db-temporal-recall.mjs";
import { pushPromptContextSection } from "../db/db-temporal-shared.mjs";
import { parseJsonArray } from "../utils/json-array-utils.mjs";
import { tokenizeText } from "../utils/query-normalizer.mjs";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { estimateTokens } from "../utils/token-estimator.mjs";

const PROMPT_SECTION_SOURCE_MAP = {
  "Relevant Day Summary": "day_summary",
  "Relevant Prior Work": "related_work",
  "Response Style And Addressing": "style_addressing",
  "Relevant Commitments, Preferences, And Identity": "commitments",
  "Cross-Repo Examples": "cross_repo_examples",
  "Cross-Repo Hints": "cross_repo_hints",
  "Transferable Cross-Repo Preferences": "cross_repo_preferences",
  "Active Workstream": "workstream_overlays",
  "Pending Proposal Review": "proposal_awareness",
};

function mapPromptSectionSource(title) {
  return PROMPT_SECTION_SOURCE_MAP[String(title || "")] ?? "context";
}

function buildOutputSectionDetails(text) {
  const details = [];
  let currentTitle = null;
  let currentLines = [];

  const flush = () => {
    if (!currentTitle) {
      return;
    }
    const sectionText = [`## ${currentTitle}`, ...currentLines].join("\n").trim();
    details.push({
      title: currentTitle,
      source: mapPromptSectionSource(currentTitle),
      usedTokens: estimateTokens(sectionText),
      entryCount: currentLines.filter((line) => /^\s*[-[]/.test(line)).length,
    });
  };

  for (const line of String(text || "").split("\n")) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      currentLines = [];
      continue;
    }
    if (currentTitle) {
      currentLines.push(line);
    }
  }
  flush();
  return details;
}

function summarizeArray(items, label, limit) {
  const values = parseJsonArray(items).map(normalizeText).filter(Boolean).slice(0, limit);
  if (values.length === 0) {
    return "";
  }
  return `${label}: ${values.join(", ")}`;
}

function isLowSignalContextItem(value) {
  const text = normalizeText(value).replace(/:\s*$/, "");
  return /^(files created|files modified|remaining work|immediate next steps|diagnostics\/validation|phase \d+ implementation so far intentionally stayed within the approved boundary|the user asked to start implementing|the conversation covered)/i.test(text);
}

function rankContextItems(items, terms = []) {
  return parseJsonArray(items)
    .map(normalizeText)
    .filter(Boolean)
    .map((value, index) => {
      const tokens = tokenizeText(value);
      let matched = 0;
      let score = 0;
      for (const term of terms) {
        if (tokens.has(term)) {
          matched += 1;
          score += 2;
        }
      }
      if (/[`_/]/.test(value)) {
        score += 1.5;
      }
      if (/\b(prompt|shaping|scope|override|audit|backfill|restore|rollback|snapshot|deferred|identity|cross-repo|memory|trace|schema|replay)\b/i.test(value)) {
        score += 1.5;
      }
      if (value.length >= 20 && value.length <= 220) {
        score += 0.5;
      }
      if (isLowSignalContextItem(value)) {
        score -= 3;
      }
      if (/:\s*$/.test(value)) {
        score -= 1;
      }
      return { value, index, matched, score };
    })
    .sort((left, right) => {
      if (right.matched !== left.matched) {
        return right.matched - left.matched;
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });
}

function summarizeRelevantArray(items, label, terms, limit) {
  const ranked = rankContextItems(items, terms);
  const matches = terms.length > 0
    ? ranked.filter((item) => item.matched > 0)
    : ranked;
  const selected = (matches.length > 0 ? matches : ranked)
    .slice(0, limit)
    .map((item) => item.value);
  if (selected.length === 0) {
    return "";
  }
  return `${label}: ${selected.join(", ")}`;
}

function formatEpisodeContextLine(episode, { terms = [] } = {}) {
  const summary = normalizeText(episode.summary);
  if (!summary || isPlaceholderSummary(summary)) {
    return "";
  }

  const details = [
    summarizeRelevantArray(episode.decisions_json, "decision", terms, 1),
    summarizeRelevantArray(episode.open_items_json, "open", terms, 1),
    summarizeRelevantArray(episode.actions_json, "actions", terms, 2),
    summarizeArray(episode.themes_json, "themes", 3),
  ].filter(Boolean);

  const prefix = episode.date_key ? `${episode.date_key}: ` : "";
  const repositoryLabel = episode.currentRepository
    && episode.repository
    && episode.repository !== episode.currentRepository
    ? ` [example from ${episode.repository}]`
    : "";
  if (details.length === 0) {
    return `- ${prefix}${summary}${repositoryLabel}`;
  }
  return `- ${prefix}${summary}${repositoryLabel} — ${details.slice(0, 2).join(" | ")}`;
}

function formatDaySummaryContextLine(summary, currentRepository = null) {
  const label = summary.repository
    ? currentRepository && summary.repository === currentRepository
      ? ""
      : ` in ${summary.repository}`
    : "";
  return [
    `[MEMORY: day summary for ${summary.date_key}${label}]`,
    normalizeText(summary.summary),
  ].join("\n");
}

export function formatSemanticContextLine(memory) {
  const scopeLabel = memory.scope === MEMORY_SCOPE.GLOBAL
    ? "/global"
    : memory.scope === MEMORY_SCOPE.TRANSFERABLE
      ? "/transferable"
      : "";
  const repositoryLabel = memory.currentRepository
    && memory.repository
    && memory.repository !== memory.currentRepository
    ? `, from ${memory.repository}`
    : "";
  return `- [${memory.type}${scopeLabel}${repositoryLabel}] ${memory.content}`;
}

function appendPromptDaySummarySection(lines, trace, {
  repository,
  includedDaySummaryRows,
  daySummaryReason,
  temporalDate,
}) {
  if (includedDaySummaryRows.length > 0) {
    trace.lookups.daySummary.included = true;
    pushPromptContextSection(lines, "Relevant Day Summary");
    includedDaySummaryRows.forEach((summary, index) => {
      if (index > 0) {
        lines.push("");
      }
      lines.push(formatDaySummaryContextLine(summary, repository));
    });
    trace.output.sectionTitles.push("Relevant Day Summary");
    return;
  }
  trace.lookups.daySummary.reason = daySummaryReason;
  if (daySummaryReason === "missing_day_summary" || daySummaryReason === "summary_did_not_match_prompt_terms") {
    trace.omissions.push({ stage: "day_summary", reason: daySummaryReason, date: temporalDate });
    return;
  }
  trace.omissions.push({ stage: "day_summary", reason: daySummaryReason });
}

function appendPromptEpisodesSection(lines, trace, {
  episodes,
  renderTerms,
  allowRepoLocalTaskContext,
  episodeDetails,
}) {
  if (episodes.length > 0) {
    pushPromptContextSection(lines, "Relevant Prior Work");
    for (const [index, episode] of episodes.entries()) {
      const line = formatEpisodeContextLine(episode, { terms: renderTerms, index });
      if (line) {
        lines.push(line);
      }
    }
    trace.output.sectionTitles.push("Relevant Prior Work");
    return;
  }
  trace.omissions.push({
    stage: "local_episodes",
    reason: allowRepoLocalTaskContext
      ? episodeDetails.trace?.reason ?? "no_relevant_episode_matches"
      : "identity_only_prompt",
  });
}

function appendPromptStyleSection(lines, trace, effectiveStyleSection) {
  if (effectiveStyleSection.text) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(effectiveStyleSection.text);
    trace.output.sectionTitles.push(effectiveStyleSection.title);
    return;
  }
  trace.omissions.push({ stage: "style_addressing", reason: effectiveStyleSection.trace.reason });
}

function appendPromptLocalMemoriesSection(lines, trace, localMemories, identityOnly = false) {
  if (localMemories.length > 0) {
    pushPromptContextSection(lines, "Relevant Commitments, Preferences, And Identity");
    for (const memory of localMemories) {
      lines.push(formatSemanticContextLine(memory));
    }
    trace.output.sectionTitles.push("Relevant Commitments, Preferences, And Identity");
    return;
  }
  trace.omissions.push({ stage: "local_memories", reason: identityOnly ? "identity_only_prompt" : "no_matching_memories" });
}

function appendPromptCrossRepoExamplesSection(lines, trace, crossRepoEpisodes, promptTerms) {
  if (crossRepoEpisodes.length === 0) {
    return;
  }
  pushPromptContextSection(lines, "Cross-Repo Examples");
  for (const [index, episode] of crossRepoEpisodes.entries()) {
    const line = formatEpisodeContextLine(episode, { terms: promptTerms, index });
    if (line) {
      lines.push(line);
    }
  }
  trace.output.sectionTitles.push("Cross-Repo Examples");
}

function appendPromptCrossRepoPreferencesSection(lines, trace, {
  crossRepoPreferences,
  allowGenericCrossRepoFallback,
  pureTemporalRecall,
}) {
  if (crossRepoPreferences.length > 0) {
    pushPromptContextSection(lines, "Transferable Cross-Repo Preferences");
    for (const memory of crossRepoPreferences) {
      lines.push(formatSemanticContextLine(memory));
    }
    trace.output.sectionTitles.push("Transferable Cross-Repo Preferences");
    return;
  }
  trace.lookups.crossRepoPreferences.reason = allowGenericCrossRepoFallback
    ? "no_transferable_preferences"
    : pureTemporalRecall
      ? "handled_by_temporal_day_summaries"
      : "cross_repo_lookup_disabled";
}

function appendExplainSections(lines, trace, {
  need, state, semanticCtx, temporalCtx, crossRepoCtx,
  allowRepoLocalTaskContext, allowCrossRepoFallback, repository, sessionStore, identityOnly, promptTerms,
}) {
  const { renderTerms, hasIncludedDaySummary, hasIncludedEpisodes, daySummaryReason, shouldRunTemporalVerifier, temporalVerifierRows } = state;
  const { temporalDate, pureTemporalRecall, includedDaySummaryRows, episodes, episodeDetails, effectiveStyleSection } = temporalCtx;
  const { allowGenericCrossRepoFallback, crossRepoEpisodes, crossRepoHints, crossRepoPreferences } = crossRepoCtx;
  appendPromptTemporalRecallIntro(lines, trace, {
    need, temporalDate, allowCrossRepoFallback, pureTemporalRecall,
    hasIncludedDaySummary, hasIncludedEpisodes, temporalVerifierRows, daySummaryReason,
  });
  appendPromptDaySummarySection(lines, trace, { repository, includedDaySummaryRows, daySummaryReason, temporalDate });
  appendPromptEpisodesSection(lines, trace, { episodes, renderTerms, allowRepoLocalTaskContext, episodeDetails });
  appendPromptTemporalVerifierSection(lines, trace, { repository, temporalVerifierRows, shouldRunTemporalVerifier, temporalDate });
  appendPromptStyleSection(lines, trace, effectiveStyleSection);
  appendPromptLocalMemoriesSection(lines, trace, semanticCtx.localMemories, identityOnly);
  appendPromptCrossRepoExamplesSection(lines, trace, crossRepoEpisodes, promptTerms);
  appendPromptCrossRepoHintsSection(lines, trace, {
    repository, crossRepoEpisodes, crossRepoHints, allowGenericCrossRepoFallback, pureTemporalRecall, sessionStore,
  });
  appendPromptCrossRepoPreferencesSection(lines, trace, { crossRepoPreferences, allowGenericCrossRepoFallback, pureTemporalRecall });
}

function finalizePromptContextResult(lines, trace, {
  crossRepoEpisodes,
  allowGenericCrossRepoFallback,
  pureTemporalRecall,
}) {
  if (crossRepoEpisodes.length === 0) {
    trace.lookups.crossRepoEpisodes.reason = allowGenericCrossRepoFallback
      ? "no_cross_repo_examples"
      : pureTemporalRecall
        ? "handled_by_temporal_day_summaries"
        : "cross_repo_lookup_disabled";
  }
  const text = lines.join("\n");
  trace.output.sectionDetails = buildOutputSectionDetails(text);
  trace.output.estimatedTokens = estimateTokens(text);
  return { text, trace };
}

export function renderPromptContext(collected) {
  const {
    trace,
    need,
    state,
    semanticCtx,
    temporalCtx,
    crossRepoCtx,
    flags,
    repository,
    sessionStore,
    promptTerms,
  } = collected;
  const lines = [];
  appendExplainSections(lines, trace, {
    need,
    state,
    semanticCtx,
    temporalCtx,
    crossRepoCtx,
    allowRepoLocalTaskContext: flags.allowRepoLocalTaskContext,
    allowCrossRepoFallback: flags.allowCrossRepoFallback,
    repository,
    sessionStore,
    identityOnly: flags.identityOnly,
    promptTerms,
  });
  return finalizePromptContextResult(lines, trace, {
    crossRepoEpisodes: crossRepoCtx.crossRepoEpisodes,
    allowGenericCrossRepoFallback: crossRepoCtx.allowGenericCrossRepoFallback,
    pureTemporalRecall: temporalCtx.pureTemporalRecall,
  });
}
