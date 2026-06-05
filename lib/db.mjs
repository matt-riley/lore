import crypto from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { detectPromptContextNeed } from "./capsule-assembler.mjs";
import {
  buildSemanticCanonicalKey,
  classifyEpisodeDigest,
  classifySemanticMemory,
  detectAssistantIdentityName,
  MEMORY_SCOPE,
  normalizeScope,
} from "./memory-scope.mjs";
import { buildMemoryDomain } from "./memory-domains.mjs";
import { buildRefreshableObservation } from "./observations.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";
import { MigrationRunner } from "./db-migration-runner.mjs";
import {
  buildStyleAddressingSection,
  isStyleAddressingMemory,
} from "./style-addressing.mjs";
import { readTemporalQueryNormalizationEnabled } from "./rollout-flags.mjs";
import {
  addStringFilter,
  clampInteger,
  jsonText,
  normalizeRepository,
  parseJsonArray,
  parseJsonObject,
  validateRequiredStringField,
} from "./data-utils.mjs";
import {
  extractFtsTerms as extractNormalizedFtsTerms,
  extractDirectTerms as extractNormalizedDirectTerms,
  extractTemporalContentTerms as extractNormalizedTemporalContentTerms,
  inferDateFromPrompt as inferNormalizedDateFromPrompt,
  normalizeFtsToken,
  QUERY_ALIASES,
  sanitizeFtsQuery as sanitizeNormalizedFtsQuery,
  tokenizeText,
} from "./query-normalizer.mjs";
import { normalizeText } from "./text-normalizer.mjs";
import { estimateTokens } from "./token-estimator.mjs";
import {
  appendPromptCrossRepoHintsSection,
  appendPromptTemporalRecallIntro,
  appendPromptTemporalVerifierSection,
  isCrossRepoRow,
  pushPromptContextSection,
  serializeSessionTraceRow,
  setPromptTemporalVerifierTraceState,
} from "./db-temporal.mjs";
import {
  buildEpisodeQueryTermsets,
  buildTermWeights,
  explainEpisodeExclusionReason,
  isGenericWorkSummary,
  isPlaceholderSummary,
  isToolInvocationSummary,
  scoreAndRankEpisodeCandidates,
} from "./db-episode-scoring.mjs";
import {
  buildImprovementArtifactEpisode,
  buildImprovementArtifactFilters,
  buildBackfillRunSummaryUpdateImpl,
  normalizeImprovementStatus,
  setImprovementArtifactProposalImpl,
  upsertImprovementArtifactImpl,
  IMPROVEMENT_SOURCE_KIND,
  IMPROVEMENT_STATUS,
  IMPROVEMENT_REVIEW_STATE,
} from "./db-improvement-artifacts.mjs";
import {
  buildRetrievalTraceSampleRecordImpl,
  listRetrievalTraceSamplesImpl,
  pruneRetrievalTraceSamplesImpl,
} from "./db-trace-samples.mjs";

const SCOPE_SOURCE = Object.freeze({
  AUTO: "auto",
  MANUAL: "manual",
});

const PRIMARY_SCHEMA_VERSION_TABLE = "lore_schema_version";

function nowIso() {
  return new Date().toISOString();
}

function escapeSqlString(value) {
  return String(value || "").replace(/'/g, "''");
}

function buildDefaultPromptNeed(prompt, includeOtherRepositories = false) {
  const detected = detectPromptContextNeed(prompt);
  return {
    ...detected,
    allowCrossRepoFallback: detected.allowCrossRepoFallback || includeOtherRepositories,
  };
}

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

function resolveTimestamp(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function withCurrentRepository(rows, repository) {
  return rows.map((row) => ({
    ...row,
    currentRepository: repository,
  }));
}

function extractTemporalContentTerms(query, config = null) {
  if (!readTemporalQueryNormalizationEnabled(config)) {
    return extractNormalizedDirectTerms(query);
  }
  return extractNormalizedTemporalContentTerms(query);
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

const ACTIVITY_SUCCESS_VALUE_FIELDS = Object.freeze([
  ["lastContextInjectionAt", "last_context_injection_at"],
  ["lastContextInjectionHook", "last_context_injection_hook"],
  ["lastContextInjectionTraceId", "last_context_injection_trace_id"],
  ["lastExtractionCompletionAt", "last_extraction_completion_at"],
  ["lastMaintenanceCompletionAt", "last_maintenance_completion_at"],
  ["lastMaintenanceStatus", "last_maintenance_status"],
  ["lastMaintenanceRunId", "last_maintenance_run_id"],
  ["lastTraceRecordedAt", "last_trace_recorded_at"],
  ["lastTraceHook", "last_trace_hook"],
  ["lastTraceId", "last_trace_id"],
]);

function mergeActivitySuccessValues(updates, existing) {
  return Object.fromEntries(
    ACTIVITY_SUCCESS_VALUE_FIELDS.map(([updateKey, existingKey]) => [
      updateKey,
      updates[updateKey] ?? existing?.[existingKey] ?? null,
    ]),
  );
}

function mergeActivitySuccessSections(updates, existing) {
  return Array.isArray(updates.lastContextInjectionSections)
    ? updates.lastContextInjectionSections.slice(0, 8)
    : parseJsonArray(existing?.last_context_injection_sections_json);
}

function mergeActivitySuccessDuration(updates, existing) {
  return Number.isFinite(updates.lastContextInjectionDurationMs)
    ? Math.round(updates.lastContextInjectionDurationMs)
    : (existing?.last_context_injection_duration_ms ?? null);
}

function mergeActivitySuccessExtractionRepository(updates, existing, repo) {
  return normalizeRepository(updates.lastExtractionRepository)
    ?? existing?.last_extraction_repository
    ?? repo;
}

function buildActivitySuccessState({ updates, existing, repo }) {
  return {
    ...mergeActivitySuccessValues(updates, existing),
    lastContextInjectionSections: mergeActivitySuccessSections(updates, existing),
    lastContextInjectionDurationMs: mergeActivitySuccessDuration(updates, existing),
    lastExtractionRepository: mergeActivitySuccessExtractionRepository(updates, existing, repo),
  };
}

function normalizeDaySummaryRepository(repository) {
  return normalizeRepository(repository) ?? "";
}

function normalizeScopeSource(value, fallback = SCOPE_SOURCE.AUTO) {
  return value === SCOPE_SOURCE.MANUAL ? SCOPE_SOURCE.MANUAL : fallback;
}

function applyScopeFilter(sql, params, repo, includeOtherRepositories, alias = "") {
  if (includeOtherRepositories) {
    return sql;
  }
  const scopeCol = alias ? `${alias}.scope` : "scope";
  const repoCol = alias ? `${alias}.repository` : "repository";
  if (repo) {
    params.push(MEMORY_SCOPE.GLOBAL, repo);
    return `${sql} AND (${scopeCol} = ? OR ${repoCol} = ?) `;
  }
  params.push(MEMORY_SCOPE.GLOBAL);
  return `${sql} AND ${scopeCol} = ? `;
}

const LAST_SEEN_AT_CASE_SQL = "last_seen_at = CASE WHEN ? IS NULL THEN COALESCE(last_seen_at, ?) WHEN last_seen_at IS NULL OR ? > last_seen_at THEN ? ELSE last_seen_at END";

function lastSeenAtParams(value) {
  return [value, value, value, value];
}

function dedupeSemanticRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.type}::${normalizeText(row.content).toLowerCase()}::${row.scope ?? MEMORY_SCOPE.REPO}::${row.repository ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function mergeTagText(existingTags, incomingTags) {
  const tags = new Set(
    `${existingTags || ""} ${incomingTags || ""}`
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  return [...tags].join(" ");
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

function formatSemanticContextLine(memory) {
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



function serializeSemanticTraceRow(memory, currentRepository = null) {
  return {
    id: memory.id ?? null,
    type: memory.type ?? null,
    scope: memory.scope ?? null,
    scopeSource: memory.scope_source ?? null,
    repository: memory.repository ?? null,
    updatedAt: memory.updated_at ?? null,
    canonicalKey: memory.canonical_key ?? null,
    reinforcementCount: memory.reinforcement_count ?? 1,
    lastSeenAt: memory.last_seen_at ?? null,
    crossRepo: isCrossRepoRow(memory, currentRepository),
    content: normalizeText(memory.content),
  };
}

function serializeEpisodeTraceRow(episode, currentRepository = null) {
  return {
    id: episode.id ?? null,
    sessionId: episode.session_id ?? null,
    scope: episode.scope ?? null,
    scopeSource: episode.scope_source ?? null,
    repository: episode.repository ?? null,
    updatedAt: episode.updated_at ?? null,
    dateKey: episode.date_key ?? null,
    significance: episode.significance ?? 0,
    crossRepo: isCrossRepoRow(episode, currentRepository),
    summary: normalizeText(episode.summary),
    decisions: parseJsonArray(episode.decisions_json).map(normalizeText).filter(Boolean).slice(0, 6),
    actions: parseJsonArray(episode.actions_json).map(normalizeText).filter(Boolean).slice(0, 6),
    openItems: parseJsonArray(episode.open_items_json).map(normalizeText).filter(Boolean).slice(0, 6),
    themes: parseJsonArray(episode.themes_json).map(normalizeText).filter(Boolean).slice(0, 6),
  };
}

function serializeDaySummaryTraceRow(summary, currentRepository = null) {
  return {
    repository: summary.repository ?? null,
    dateKey: summary.date_key ?? null,
    computedAt: summary.computed_at ?? null,
    crossRepo: isCrossRepoRow(summary, currentRepository),
    summary: normalizeText(summary.summary),
  };
}

function buildLocalEligibility(repository) {
  if (repository) {
    return [MEMORY_SCOPE.GLOBAL, `${MEMORY_SCOPE.REPO}:${repository}`];
  }
  return [MEMORY_SCOPE.GLOBAL];
}

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

function createPromptContextTrace({
  prompt,
  repository,
  allowCrossRepoFallback,
  allowGenericCrossRepoFallback,
  promptTerms,
  identityName,
  temporalDate,
  memories,
  localMemories,
  identityMemories,
  effectiveStyleSection,
  assistantPersonaRows,
  relationshipPreferenceRows,
  daySummaryRows,
  includedDaySummaryRows,
  episodeDetails,
  crossRepoPreferenceRows,
  crossRepoPreferences,
  crossRepoEpisodeDetails,
  crossRepoEpisodes,
  crossRepoHints,
  sessionStore,
}) {
  return {
    mode: "prompt_context",
    repository,
    includeOtherRepositories: allowCrossRepoFallback,
    promptTerms,
    identityName: identityName ?? null,
    temporalDate,
    temporal: null,
    eligibility: {
      localSemantic: buildLocalEligibility(repository),
      localEpisodes: buildLocalEligibility(repository),
      crossRepoFallback: allowCrossRepoFallback ? [MEMORY_SCOPE.TRANSFERABLE] : [],
    },
    lookups: {
      localMemories: {
        query: prompt,
        types: ["commitment", "open_loop", "rejected_approach", "blocker", "user_preference", "assistant_identity", "user_identity", "assistant_goal", "recurring_mistake"],
        rows: memories.map((memory) => serializeSemanticTraceRow(memory, repository)),
        includedRows: localMemories.map((memory) => serializeSemanticTraceRow(memory, repository)),
      },
      identityMemories: {
        query: identityName ?? "",
        scopes: [MEMORY_SCOPE.GLOBAL],
        rows: identityMemories.map((memory) => serializeSemanticTraceRow(memory, repository)),
        includedRows: identityMemories.map((memory) => serializeSemanticTraceRow(memory, repository)),
      },
      styleAddressing: {
        enabled: effectiveStyleSection.trace.enabled,
        ambientEnabled: effectiveStyleSection.trace.ambientEnabled,
        includeAmbient: effectiveStyleSection.trace.includeAmbient,
        promptLocal: effectiveStyleSection.trace.promptLocal,
        rows: [
          ...assistantPersonaRows.map((memory) => serializeSemanticTraceRow(memory, repository)),
          ...relationshipPreferenceRows.map((memory) => serializeSemanticTraceRow(memory, repository)),
        ],
        includedRows: effectiveStyleSection.trace.includeAmbient
          ? [
              ...assistantPersonaRows.map((memory) => serializeSemanticTraceRow(memory, repository)),
              ...relationshipPreferenceRows.map((memory) => serializeSemanticTraceRow(memory, repository)),
            ]
          : [],
        reason: effectiveStyleSection.trace.reason,
      },
      daySummary: {
        date: temporalDate,
        rows: daySummaryRows.map((summary) => serializeDaySummaryTraceRow(summary, repository)),
        includedRows: includedDaySummaryRows.map((summary) => serializeDaySummaryTraceRow(summary, repository)),
        included: false,
        reason: null,
      },
      localEpisodes: episodeDetails.trace,
      crossRepoPreferences: {
        enabled: allowGenericCrossRepoFallback,
        scopes: [MEMORY_SCOPE.TRANSFERABLE],
        rows: crossRepoPreferenceRows.map((memory) => serializeSemanticTraceRow(memory, repository)),
        includedRows: crossRepoPreferences.map((memory) => serializeSemanticTraceRow(memory, repository)),
        filtered: crossRepoPreferenceRows
          .filter((memory) => !isCrossRepoRow(memory, repository))
          .map((memory) => ({
            stage: "cross_repo_filter",
            reason: "same_repository",
            row: serializeSemanticTraceRow(memory, repository),
          })),
        reason: null,
      },
      crossRepoEpisodes: {
        enabled: allowGenericCrossRepoFallback,
        scopes: [MEMORY_SCOPE.TRANSFERABLE],
        rankedRows: crossRepoEpisodeDetails?.trace?.rankedRows ?? [],
        includedRows: crossRepoEpisodes.map((episode) => serializeEpisodeTraceRow(episode, repository)),
        filtered: [
          ...(crossRepoEpisodeDetails?.trace?.filtered ?? []),
          ...((crossRepoEpisodeDetails?.episodes ?? [])
            .filter((episode) => !isCrossRepoRow(episode, repository))
            .map((episode) => ({
              stage: "cross_repo_filter",
              reason: "same_repository",
              row: serializeEpisodeTraceRow(episode, repository),
            }))),
        ],
        reason: null,
      },
      crossRepoHints: {
        enabled: allowGenericCrossRepoFallback && !!sessionStore,
        rows: crossRepoHints.map((session) => serializeSessionTraceRow(session, repository)),
        includedRows: [],
        reason: null,
      },
      temporalVerifier: {
        enabled: !!sessionStore && temporalDate !== null,
        date: temporalDate,
        rows: [],
        includedRows: [],
        reason: null,
      },
    },
    omissions: [],
    output: {
      sectionTitles: [],
      sectionDetails: [],
      estimatedTokens: 0,
    },
  };
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

function effectiveRepositoryForScope(scope, rowRepository, metadata = {}, fallbackRepository = null) {
  if (scope === MEMORY_SCOPE.GLOBAL) {
    return null;
  }
  return normalizeRepository(rowRepository)
    ?? normalizeRepository(metadata?.originRepository)
    ?? normalizeRepository(fallbackRepository);
}

function classifySemanticRow(row, { fallbackRepository = null, ignoreManualOverride = false } = {}) {
  const metadata = parseJsonObject(row.metadata_json);
  const scopeSource = normalizeScopeSource(row.scope_source);
  if (!ignoreManualOverride && scopeSource === SCOPE_SOURCE.MANUAL) {
    const scope = normalizeScope(row.scope, MEMORY_SCOPE.REPO);
    return {
      scope,
      repository: effectiveRepositoryForScope(scope, row.repository, metadata, fallbackRepository),
      metadata,
      scopeSource,
    };
  }
  const classification = classifySemanticMemory({
    type: row.type,
    content: row.content,
    scope: null,
    repository: row.repository ?? fallbackRepository ?? metadata.originRepository ?? null,
    tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
    metadata,
  });
  return {
    ...classification,
    scopeSource: SCOPE_SOURCE.AUTO,
  };
}

function classifyEpisodeRow(row, { fallbackRepository = null, ignoreManualOverride = false } = {}) {
  const scopeSource = normalizeScopeSource(row.scope_source);
  if (!ignoreManualOverride && scopeSource === SCOPE_SOURCE.MANUAL) {
    const scope = normalizeScope(row.scope, MEMORY_SCOPE.REPO);
    return {
      scope,
      repository: effectiveRepositoryForScope(scope, row.repository, {}, fallbackRepository),
      scopeSource,
    };
  }
  const classification = classifyEpisodeDigest({
    scope: null,
    repository: row.repository ?? fallbackRepository ?? null,
    summary: row.summary,
    actions: parseJsonArray(row.actions_json),
    decisions: parseJsonArray(row.decisions_json),
    learnings: parseJsonArray(row.learnings_json),
    refs: parseJsonArray(row.refs_json),
    themes: parseJsonArray(row.themes_json),
    openItems: parseJsonArray(row.open_items_json),
  });
  return {
    ...classification,
    scopeSource: SCOPE_SOURCE.AUTO,
  };
}

function dedupeSemanticContextRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.type}::${normalizeText(row.content).toLowerCase()}::${row.scope ?? ""}::${row.repository ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function mapMemoryDomainRow(row) {
  return {
    domainKey: row.domain_key,
    kind: row.kind,
    title: row.title,
    mission: row.mission,
    scope: row.scope,
    repository: row.repository,
    directives: parseJsonArray(row.directives_json),
    disposition: parseJsonObject(row.disposition_json),
    metadata: parseJsonObject(row.metadata_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function mapObservationRow(row) {
  return {
    observationKey: row.observation_key,
    domainKey: row.domain_key,
    title: row.title,
    prompt: row.prompt,
    focus: row.focus,
    summary: row.summary,
    confidence: row.confidence,
    scope: row.scope,
    repository: row.repository,
    freshnessHours: row.freshness_hours,
    status: row.status,
    source: row.source,
    trace: parseJsonObject(row.trace_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRefreshedAt: row.last_refreshed_at,
  };
}

// --- Stats query helpers (todo 3) ---

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

// --- Activity state helpers (todos 3+4) ---

function queryActivityStateRow(db, scopeKey) {
  return db.prepare(`
    SELECT
      scope_key,
      scope_type,
      repository,
      last_context_injection_at,
      last_context_injection_hook,
      last_context_injection_sections_json,
      last_context_injection_trace_id,
      last_context_injection_duration_ms,
      last_extraction_completion_at,
      last_extraction_repository,
      last_maintenance_completion_at,
      last_maintenance_status,
      last_maintenance_run_id,
      last_trace_recorded_at,
      last_trace_hook,
      last_trace_id,
      updated_at
    FROM lore_activity_state
    WHERE scope_key = ?
  `).get(scopeKey);
}

function mapActivityStateRow(row) {
  return {
    scopeKey: row.scope_key,
    scopeType: row.scope_type,
    repository: row.repository,
    lastContextInjectionAt: row.last_context_injection_at,
    lastContextInjectionHook: row.last_context_injection_hook,
    lastContextInjectionSections: parseJsonArray(row.last_context_injection_sections_json),
    lastContextInjectionTraceId: row.last_context_injection_trace_id,
    lastContextInjectionDurationMs: row.last_context_injection_duration_ms,
    lastExtractionCompletionAt: row.last_extraction_completion_at,
    lastExtractionRepository: row.last_extraction_repository,
    lastMaintenanceCompletionAt: row.last_maintenance_completion_at,
    lastMaintenanceStatus: row.last_maintenance_status,
    lastMaintenanceRunId: row.last_maintenance_run_id,
    lastTraceRecordedAt: row.last_trace_recorded_at,
    lastTraceHook: row.last_trace_hook,
    lastTraceId: row.last_trace_id,
    updatedAt: row.updated_at,
  };
}

// --- Retrieval trace sample helpers (todo 5) ---

export class LoreDb {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.lastBackupPath = null;
    this.migrations = new MigrationRunner(this.db, this.config);
  }

  openDatabase() {
    const dbPath = this.config.paths.derivedStorePath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrations = new MigrationRunner(this.db, this.config);
  }

  close() {
    if (!this.db) {
      return;
    }
    try {
      this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
    } catch {
      // best-effort checkpoint before close
    }
    this.db.close();
    this.db = null;
    this.migrations = new MigrationRunner(this.db, this.config);
  }

  initialize() {
    if (this.db) {
      return { backupPath: this.lastBackupPath };
    }

    const dbPath = this.config.paths.derivedStorePath;
    this.openDatabase();

    const currentVersionInfo = this.getCurrentVersionInfo();
    const currentVersion = currentVersionInfo.version;
    if (
      currentVersion > 0
      && currentVersionInfo.tableName
      && currentVersionInfo.tableName !== PRIMARY_SCHEMA_VERSION_TABLE
    ) {
      this.adoptSchemaVersion(currentVersion);
    }
    this.adoptLegacyActivityStateTable();
    if (currentVersion < SCHEMA_VERSION && existsSync(dbPath) && currentVersion > 0) {
      this.lastBackupPath = this.backupDatabase();
    }

    this.runMigrations(currentVersion);
    return { backupPath: this.lastBackupPath };
  }

  backupDatabase() {
    const backupDir = this.config.paths.backupDir;
    mkdirSync(backupDir, { recursive: true });

    const timestamp = nowIso().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `lore-${timestamp}.db`);
    rmSync(backupPath, { force: true });
    this.ensureOpen();
    this.db.exec(`VACUUM INTO '${escapeSqlString(backupPath)}'`);
    return backupPath;
  }

  restoreFromBackup(backupPath) {
    const normalizedPath = path.resolve(String(backupPath || ""));
    if (!existsSync(normalizedPath)) {
      throw new Error(`backup path does not exist: ${normalizedPath}`);
    }
    const dbPath = this.config.paths.derivedStorePath;
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    this.close();
    rmSync(walPath, { force: true });
    rmSync(shmPath, { force: true });
    copyFileSync(normalizedPath, dbPath);
    this.openDatabase();
    const currentVersion = this.getCurrentVersion();
    if (currentVersion < SCHEMA_VERSION) {
      this.runMigrations(currentVersion);
    }
    return {
      restoredFrom: normalizedPath,
      schemaVersion: this.getCurrentVersion(),
    };
  }

  runIndexUpkeep() {
    this.ensureOpen();
    return this.migrations.runIndexUpkeep();
  }

  getCurrentVersion() {
    return this.migrations.getCurrentVersion(this);
  }

  getCurrentVersionInfo() {
    return this.migrations.getCurrentVersionInfo();
  }

  adoptSchemaVersion(version) {
    return this.migrations.adoptSchemaVersion(version);
  }

  tableExists(tableName) {
    return this.migrations.tableExists(tableName);
  }

  adoptLegacyActivityStateTable() {
    return this.migrations.adoptLegacyActivityStateTable(this);
  }

  getPreSchemaMigrationSteps() {
    return this.migrations.getPreSchemaMigrationSteps(this);
  }

  getPostSchemaMigrationSteps() {
    return this.migrations.getPostSchemaMigrationSteps(this);
  }

  applySchemaStatementsMigration() {
    return this.migrations.applySchemaStatementsMigration();
  }

  buildMigrationPlan(currentVersion) {
    return this.migrations.buildMigrationPlan(currentVersion, this);
  }

  runMigrations(currentVersion) {
    return this.migrations.runMigrations(currentVersion, this);
  }

  tableHasColumn(tableName, columnName) {
    return this.migrations.tableHasColumn(tableName, columnName);
  }

  ensureColumn(tableName, columnName, definitionSql) {
    return this.migrations.ensureColumn(tableName, columnName, definitionSql, this);
  }

  applyScopeMigration() {
    return this.migrations.applyScopeMigration(this);
  }

  applyScopeGovernanceMigration() {
    return this.migrations.applyScopeGovernanceMigration(this);
  }

  applyGrowthMemoryMigration() {
    return this.migrations.applyGrowthMemoryMigration(this);
  }

  prepareGrowthMemoryMigration() {
    return this.migrations.prepareGrowthMemoryMigration(this);
  }

  backfillGrowthMemoryCanonicalKeys() {
    return this.migrations.backfillGrowthMemoryCanonicalKeys(this);
  }

  listGrowthMemoryRowsForCanonicalBackfill() {
    return this.migrations.listGrowthMemoryRowsForCanonicalBackfill();
  }

  mergeGrowthMemoryDuplicateUserIdentityRows() {
    return this.migrations.mergeGrowthMemoryDuplicateUserIdentityRows(this);
  }

  listGrowthMigrationCandidates(canonicalKey) {
    return this.migrations.listGrowthMigrationCandidates(canonicalKey);
  }

  getGrowthMigrationLastSeen(candidate) {
    return this.migrations.getGrowthMigrationLastSeen(candidate);
  }

  mergeGrowthMigrationCandidates(candidates, winner) {
    return this.migrations.mergeGrowthMigrationCandidates(candidates, winner, this);
  }

  updateGrowthMigrationWinner(winnerId, mergedState) {
    return this.migrations.updateGrowthMigrationWinner(winnerId, mergedState);
  }

  supersedeGrowthMigrationLosers(winnerId, losers) {
    return this.migrations.supersedeGrowthMigrationLosers(winnerId, losers);
  }

  applyImprovementBacklogMigration() {
    return this.migrations.applyImprovementBacklogMigration(this);
  }

  applyPhase5ImprovementLoopMigration() {
    return this.migrations.applyPhase5ImprovementLoopMigration(this);
  }

  applyTrajectoryArtifactsMigration() {
    return this.migrations.applyTrajectoryArtifactsMigration();
  }

  applyIntentJournalMigration() {
    return this.migrations.applyIntentJournalMigration();
  }

  applyLoreVisibilitySubstrateMigration() {
    return this.migrations.applyLoreVisibilitySubstrateMigration();
  }

  applyMemoryDomainObservationMigration() {
    return this.migrations.applyMemoryDomainObservationMigration(this);
  }

  ensureOpen() {
    if (!this.db) {
      throw new Error("lore database is not initialized");
    }
  }

  getStats() {
    this.ensureOpen();
    const { semanticCount, semanticGrowth, semanticScopes } = querySemanticMemoryStats(this.db);
    const { episodeCount, episodeScopes, daySummaryCount } = queryEpisodeDigestStats(this.db);
    const domainCount = readTableCount(this.db, "memory_domain");
    const observationCount = readTableCount(this.db, "refreshable_observation");
    const { deferredCounts, backfillCounts } = queryExtractionJobStats(this.db);
    const schemaVersion = this.getCurrentVersion();
    const overrideAuditCount = readTableCount(this.db, "scope_override_audit");
    const improvementCounts = queryImprovementBacklogStats(this.db);
    const { maintenanceCounts, maintenanceLatest, maintenanceTaskCount } = queryMaintenanceRunStats(this.db);
    const { trajectoryCounts, intentJournalCounts, retrievalTraceSampleCounts } = querySignalStats(this.db);
    const latestActivity = queryActivityStateRow(this.db, "global");

    return buildLoreStatsPayload({
      config: this.config,
      lastBackupPath: this.lastBackupPath,
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

  insertIntentJournalEntry({
    repository = null,
    sessionId = null,
    turnHint = null,
    intentKind = "journal",
    summary,
    rationale = null,
    context = {},
  }) {
    this.ensureOpen();
    const normalizedSummary = String(summary || "").trim();
    if (!normalizedSummary) {
      throw new Error("summary is required");
    }
    const normalizedIntentKind = String(intentKind || "").trim().toLowerCase() || "journal";
    const allowedKinds = new Set(["journal", "routing", "rollout", "reviewer", "fallback", "serendipity"]);
    const safeIntentKind = allowedKinds.has(normalizedIntentKind) ? normalizedIntentKind : "journal";
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO intent_journal (
        id,
        repository,
        session_id,
        turn_hint,
        intent_kind,
        summary,
        rationale,
        context_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normalizeRepository(repository),
      typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : null,
      typeof turnHint === "string" && turnHint.trim().length > 0 ? turnHint.trim() : null,
      safeIntentKind,
      normalizedSummary,
      typeof rationale === "string" && rationale.trim().length > 0 ? rationale.trim() : null,
      JSON.stringify(context ?? {}),
      nowIso(),
    );
    return id;
  }

  listIntentJournalEntries({
    repository,
    sessionId,
    intentKind,
    limit = 10,
  } = {}) {
    this.ensureOpen();
    const where = [];
    const params = [];
    addStringFilter(where, params, "repository", repository);
    addStringFilter(where, params, "session_id", sessionId);
    addStringFilter(where, params, "intent_kind", intentKind, (v) => v.toLowerCase());
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT
        id,
        repository,
        session_id,
        turn_hint,
        intent_kind,
        summary,
        rationale,
        context_json,
        created_at
      FROM intent_journal
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params);
    return rows.map((row) => ({
      ...row,
      context: parseJsonObject(row.context_json),
    }));
  }

  insertTrajectoryArtifact({
    kind,
    repository = null,
    sourceCaseId = null,
    sourceKind = null,
    improvementArtifactId = null,
    eventKey = null,
    summary,
    severity = "info",
    outcome = "captured",
    latencyMs = null,
    targetMs = null,
    context = {},
    trace = {},
  }) {
    this.ensureOpen();
    const normalizedKind = validateRequiredStringField(kind, "kind");
    const normalizedSummary = validateRequiredStringField(summary, "summary");
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO trajectory_artifact (
        id,
        kind,
        repository,
        source_case_id,
        source_kind,
        improvement_artifact_id,
        event_key,
        summary,
        severity,
        outcome,
        latency_ms,
        target_ms,
        context_json,
        trace_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normalizedKind,
      normalizeRepository(repository),
      sourceCaseId ? String(sourceCaseId) : null,
      sourceKind ? String(sourceKind) : null,
      improvementArtifactId ? String(improvementArtifactId) : null,
      eventKey ? String(eventKey) : null,
      normalizedSummary,
      String(severity || "info"),
      String(outcome || "captured"),
      Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
      Number.isFinite(targetMs) ? Math.round(targetMs) : null,
      JSON.stringify(context ?? {}),
      JSON.stringify(trace ?? {}),
      nowIso(),
    );
    return id;
  }

  listTrajectoryArtifacts({
    kind,
    sourceKind,
    sourceCaseId,
    repository,
    limit = 10,
  } = {}) {
    this.ensureOpen();
    const where = [];
    const params = [];
    addStringFilter(where, params, "kind", kind);
    addStringFilter(where, params, "source_kind", sourceKind);
    addStringFilter(where, params, "source_case_id", sourceCaseId);
    addStringFilter(where, params, "repository", repository);
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT
        id,
        kind,
        repository,
        source_case_id,
        source_kind,
        improvement_artifact_id,
        event_key,
        summary,
        severity,
        outcome,
        latency_ms,
        target_ms,
        context_json,
        trace_json,
        created_at
      FROM trajectory_artifact
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params);
    return rows.map((row) => ({
      ...row,
      context: parseJsonObject(row.context_json),
      trace: parseJsonObject(row.trace_json),
    }));
  }


  upsertActivitySuccess({
    repository = null,
    updates = {},
  } = {}) {
    this.ensureOpen();
    const repo = normalizeRepository(repository);
    const scopeKey = repo ? `repo:${repo}` : "global";
    const scopeType = repo ? "repo" : "global";
    const timestamp = nowIso();
    const normalizedUpdates = updates && typeof updates === "object" ? updates : {};

    const existing = this.db.prepare(`
      SELECT *
      FROM lore_activity_state
      WHERE scope_key = ?
      LIMIT 1
    `).get(scopeKey);

    const next = buildActivitySuccessState({
      updates: normalizedUpdates,
      existing,
      repo,
    });

    this.db.prepare(`
      INSERT INTO lore_activity_state (
        scope_key,
        scope_type,
        repository,
        last_context_injection_at,
        last_context_injection_hook,
        last_context_injection_sections_json,
        last_context_injection_trace_id,
        last_context_injection_duration_ms,
        last_extraction_completion_at,
        last_extraction_repository,
        last_maintenance_completion_at,
        last_maintenance_status,
        last_maintenance_run_id,
        last_trace_recorded_at,
        last_trace_hook,
        last_trace_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        scope_type = excluded.scope_type,
        repository = excluded.repository,
        last_context_injection_at = excluded.last_context_injection_at,
        last_context_injection_hook = excluded.last_context_injection_hook,
        last_context_injection_sections_json = excluded.last_context_injection_sections_json,
        last_context_injection_trace_id = excluded.last_context_injection_trace_id,
        last_context_injection_duration_ms = excluded.last_context_injection_duration_ms,
        last_extraction_completion_at = excluded.last_extraction_completion_at,
        last_extraction_repository = excluded.last_extraction_repository,
        last_maintenance_completion_at = excluded.last_maintenance_completion_at,
        last_maintenance_status = excluded.last_maintenance_status,
        last_maintenance_run_id = excluded.last_maintenance_run_id,
        last_trace_recorded_at = excluded.last_trace_recorded_at,
        last_trace_hook = excluded.last_trace_hook,
        last_trace_id = excluded.last_trace_id,
        updated_at = excluded.updated_at
    `).run(
      scopeKey,
      scopeType,
      repo,
      next.lastContextInjectionAt,
      next.lastContextInjectionHook,
      jsonText(next.lastContextInjectionSections),
      next.lastContextInjectionTraceId,
      next.lastContextInjectionDurationMs,
      next.lastExtractionCompletionAt,
      next.lastExtractionRepository,
      next.lastMaintenanceCompletionAt,
      next.lastMaintenanceStatus,
      next.lastMaintenanceRunId,
      next.lastTraceRecordedAt,
      next.lastTraceHook,
      next.lastTraceId,
      timestamp,
    );

    return this.getActivityState({ repository: repo, includeGlobal: false });
  }

  collectDirectActivityRows(repo, includeGlobal) {
    const rows = [];
    if (repo) {
      const row = queryActivityStateRow(this.db, `repo:${repo}`);
      if (row) rows.push(row);
    }
    if (includeGlobal) {
      const row = queryActivityStateRow(this.db, "global");
      if (row) rows.push(row);
    }
    return rows;
  }

  collectFallbackActivityRows(repo, includeGlobal) {
    const rows = [];
    if (repo) {
      const fallback = this.deriveActivityStateFallback({ repository: repo, scopeKey: `repo:${repo}`, scopeType: "repo" });
      if (fallback) rows.push(fallback);
    }
    if (includeGlobal) {
      const fallback = this.deriveActivityStateFallback({ repository: null, scopeKey: "global", scopeType: "global" });
      if (fallback) rows.push(fallback);
    }
    return rows;
  }

  getActivityState({ repository = null, includeGlobal = true } = {}) {
    this.ensureOpen();
    const repo = normalizeRepository(repository);
    const direct = this.collectDirectActivityRows(repo, includeGlobal);
    const rows = direct.length > 0 ? direct : this.collectFallbackActivityRows(repo, includeGlobal);
    return rows.map(mapActivityStateRow);
  }

  deriveActivityStateFallback({
    repository = null,
    scopeKey,
    scopeType,
  } = {}) {
    this.ensureOpen();
    const fallbackScope = this.buildActivityFallbackScope(repository);
    const fallbackRows = this.readActivityFallbackRows(fallbackScope);
    const timestamps = this.collectActivityFallbackTimestamps(fallbackRows);
    return timestamps.length > 0
      ? this.serializeActivityStateFallback({
          scopeKey,
          scopeType,
          repository: fallbackScope.repo,
          timestamps,
          ...fallbackRows,
        })
      : null;
  }

  buildActivityFallbackScope(repository = null) {
    const repo = normalizeRepository(repository);
    return {
      repo,
      scopedWhere: repo ? "WHERE repository = ?" : "",
      scopedParams: repo ? [repo] : [],
    };
  }

  readActivityFallbackRows({ repo, scopedWhere, scopedParams }) {
    return {
      latestContextRow: this.readLatestContextFallbackRow(repo, scopedParams),
      latestTraceRow: this.readLatestTraceFallbackRow(scopedWhere, scopedParams),
      latestMaintenanceRow: this.readLatestMaintenanceFallbackRow(repo, scopedParams),
      latestExtractionRow: this.readLatestExtractionFallbackRow(scopedWhere, scopedParams),
    };
  }

  serializeActivityStateFallback({
    scopeKey,
    scopeType,
    repository,
    latestContextRow,
    latestTraceRow,
    latestMaintenanceRow,
    latestExtractionRow,
    timestamps,
  }) {
    return this.buildActivityStateFallbackRow({
      scope_key: scopeKey,
      scope_type: scopeType,
      repository,
      ...this.serializeActivityFallbackContext(latestContextRow),
      ...this.serializeActivityFallbackExtraction(latestExtractionRow, repository),
      ...this.serializeActivityFallbackMaintenance(latestMaintenanceRow),
      ...this.serializeActivityFallbackTrace(latestTraceRow),
      updated_at: this.resolveActivityFallbackUpdatedAt({
        latestContextRow,
        latestTraceRow,
        latestMaintenanceRow,
        latestExtractionRow,
        timestamps,
      }),
    });
  }

  serializeActivityFallbackContext(latestContextRow) {
    const row = latestContextRow ?? {};
    return {
      last_context_injection_at: row.recorded_at ?? null,
      last_context_injection_hook: row.hook ?? null,
      last_context_injection_sections_json: JSON.stringify(parseJsonArray(row.section_titles_json)),
      last_context_injection_trace_id: row.id ?? null,
      last_context_injection_duration_ms: row.latency_ms ?? null,
    };
  }

  serializeActivityFallbackExtraction(latestExtractionRow, repository) {
    return {
      last_extraction_completion_at: latestExtractionRow?.updated_at ?? null,
      last_extraction_repository: normalizeRepository(latestExtractionRow?.repository) ?? repository,
    };
  }

  serializeActivityFallbackMaintenance(latestMaintenanceRow) {
    return {
      last_maintenance_completion_at: latestMaintenanceRow?.completed_at ?? null,
      last_maintenance_status: latestMaintenanceRow?.status ?? null,
      last_maintenance_run_id: latestMaintenanceRow?.id ?? null,
    };
  }

  serializeActivityFallbackTrace(latestTraceRow) {
    return {
      last_trace_recorded_at: latestTraceRow?.recorded_at ?? null,
      last_trace_hook: latestTraceRow?.hook ?? null,
      last_trace_id: latestTraceRow?.id ?? null,
    };
  }

  resolveActivityFallbackUpdatedAt({
    latestContextRow,
    latestTraceRow,
    latestMaintenanceRow,
    latestExtractionRow,
    timestamps,
  }) {
    const effectiveTimestamps = Array.isArray(timestamps)
      ? timestamps
      : this.collectActivityFallbackTimestamps({
          latestContextRow,
          latestTraceRow,
          latestMaintenanceRow,
          latestExtractionRow,
        });
    return [...effectiveTimestamps].sort().at(-1) ?? nowIso();
  }

  readLatestContextFallbackRow(repo, scopedParams) {
    return this.db.prepare(`
      SELECT
        id,
        repository,
        hook,
        latency_ms,
        section_titles_json,
        recorded_at
      FROM retrieval_trace_sample
      WHERE context_injected = 1
        ${repo ? "AND repository = ?" : ""}
      ORDER BY recorded_at DESC
      LIMIT 1
    `).get(...scopedParams);
  }

  readLatestTraceFallbackRow(scopedWhere, scopedParams) {
    return this.db.prepare(`
      SELECT
        id,
        repository,
        hook,
        recorded_at
      FROM retrieval_trace_sample
      ${scopedWhere}
      ORDER BY recorded_at DESC
      LIMIT 1
    `).get(...scopedParams);
  }

  readLatestMaintenanceFallbackRow(repo, scopedParams) {
    return this.db.prepare(`
      SELECT
        id,
        repository,
        status,
        completed_at
      FROM maintenance_run
      WHERE completed_at IS NOT NULL
        ${repo ? "AND repository = ?" : ""}
      ORDER BY completed_at DESC
      LIMIT 1
    `).get(...scopedParams);
  }

  readLatestExtractionFallbackRow(scopedWhere, scopedParams) {
    return this.db.prepare(`
      SELECT repository, updated_at
      FROM (
        SELECT repository, updated_at
        FROM semantic_memory
        ${scopedWhere}
        UNION ALL
        SELECT repository, updated_at
        FROM episode_digest
        ${scopedWhere}
      )
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(...scopedParams, ...scopedParams);
  }

  collectActivityFallbackTimestamps({
    latestContextRow,
    latestTraceRow,
    latestMaintenanceRow,
    latestExtractionRow,
  }) {
    return [
      latestContextRow?.recorded_at,
      latestTraceRow?.recorded_at,
      latestMaintenanceRow?.completed_at,
      latestExtractionRow?.updated_at,
    ].filter((value) => typeof value === "string" && value.length > 0);
  }

  buildActivityStateFallbackRow(row) {
    return row;
  }

  normalizeRetrievalTraceHook(hook) {
    return String(hook || "").trim();
  }

  normalizeRetrievalTraceScopeType(scopeType) {
    return scopeType === "global" ? "global" : "repo";
  }

  normalizeRetrievalTraceSectionTitles(sectionTitles) {
    if (!Array.isArray(sectionTitles)) {
      return [];
    }
    return sectionTitles
      .slice(0, 8)
      .map((title) => (title == null ? "" : String(title)));
  }

  buildRetrievalTraceSampleRecord({
    id = null,
    repository = null,
    scopeType = "repo",
    hook,
    route = null,
    routeReason = null,
    contextInjected = false,
    latencyMs = null,
    promptPreview = "",
    sectionTitles = [],
    promptNeed = {},
    eligibility = {},
    lookups = {},
    omissions = [],
    output = {},
    trace = {},
    recordedAt = nowIso(),
  }) {
    return buildRetrievalTraceSampleRecordImpl(this, {
      id,
      repository,
      scopeType,
      hook,
      route,
      routeReason,
      contextInjected,
      latencyMs,
      promptPreview,
      sectionTitles,
      promptNeed,
      eligibility,
      lookups,
      omissions,
      output,
      trace,
      recordedAt,
    });
  }

  writeRetrievalTraceSample(record) {
    this.db.prepare(`
      INSERT INTO retrieval_trace_sample (
        id,
        repository,
        scope_type,
        hook,
        route,
        route_reason,
        context_injected,
        latency_ms,
        prompt_preview,
        section_titles_json,
        prompt_need_json,
        eligibility_json,
        lookups_json,
        omissions_json,
        output_json,
        trace_json,
        recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.repository,
      record.scopeType,
      record.hook,
      record.route,
      record.routeReason,
      record.contextInjected,
      record.latencyMs,
      record.promptPreview,
      JSON.stringify(record.sectionTitles),
      record.promptNeed,
      record.eligibility,
      record.lookups,
      record.omissions,
      record.output,
      record.trace,
      record.recordedAt,
    );
  }

  insertRetrievalTraceSample(sample = {}) {
    this.ensureOpen();
    const record = this.buildRetrievalTraceSampleRecord(sample);
    this.writeRetrievalTraceSample(record);
    return record.id;
  }

  pruneRetrievalTraceSamples({
    repository = null,
    maxRowsPerRepository = 120,
    maxRowsGlobal = 240,
    maxAgeMs = 14 * 24 * 60 * 60 * 1000,
  } = {}) {
    this.ensureOpen();
    return pruneRetrievalTraceSamplesImpl(this.db, {
      repository,
      maxRowsPerRepository,
      maxRowsGlobal,
      maxAgeMs,
    });
  }

  listRetrievalTraceSamples({
    repository,
    includeGlobal = true,
    limit = 10,
  } = {}) {
    this.ensureOpen();
    return listRetrievalTraceSamplesImpl(this.db, {
      repository,
      includeGlobal,
      limit,
    });
  }

  getSemanticMemoryByIds(ids) {
    this.ensureOpen();
    if (!Array.isArray(ids) || ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT
        id, type, content, confidence, source_session_id, source_turn_index,
        scope, scope_source, scope_override_actor, scope_override_reason, scope_override_source, scope_override_at,
        repository, tags, created_at, updated_at, superseded_by, canonical_key, reinforcement_count,
        last_seen_at, expires_at, metadata_json
      FROM semantic_memory
      WHERE id IN (${placeholders})
      ORDER BY updated_at DESC
    `).all(...ids);
  }

  getEpisodeDigestsByIds(ids) {
    this.ensureOpen();
    if (!Array.isArray(ids) || ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT
        id, session_id, scope, scope_source, scope_override_actor, scope_override_reason, scope_override_source, scope_override_at,
        repository, branch, summary, actions_json, decisions_json, learnings_json, files_changed_json,
        refs_json, significance, themes_json, open_items_json, source, date_key, created_at, updated_at
      FROM episode_digest
      WHERE id IN (${placeholders})
      ORDER BY updated_at DESC
    `).all(...ids);
  }

  previewScopeChanges({
    targetType,
    ids,
    action = "set",
    scope,
    repository,
  }) {
    this.ensureOpen();
    const targetIds = Array.isArray(ids) ? [...new Set(ids.filter((value) => typeof value === "string" && value.trim().length > 0))] : [];
    if (targetIds.length === 0) {
      throw new Error("ids must include at least one target id");
    }
    const normalizedAction = action === "clear" ? "clear" : "set";
    const nextScope = normalizedAction === "set" ? normalizeScope(scope, null) : null;
    if (normalizedAction === "set" && !nextScope) {
      throw new Error("scope must be one of: global, transferable, repo");
    }
    const fallbackRepository = normalizeRepository(repository);
    const rows = targetType === "episode"
      ? this.getEpisodeDigestsByIds(targetIds)
      : this.getSemanticMemoryByIds(targetIds);

    const foundIds = new Set(rows.map((row) => row.id));
    const missingIds = targetIds.filter((id) => !foundIds.has(id));
    const previews = rows.map((row) => {
      const currentMetadata = targetType === "semantic" ? parseJsonObject(row.metadata_json) : {};
      const current = {
        scope: row.scope,
        repository: row.repository,
        scopeSource: normalizeScopeSource(row.scope_source),
      };
      const next = normalizedAction === "clear"
        ? (targetType === "episode"
            ? classifyEpisodeRow(row, { fallbackRepository, ignoreManualOverride: true })
            : classifySemanticRow(row, { fallbackRepository, ignoreManualOverride: true }))
        : {
            scope: nextScope,
            repository: effectiveRepositoryForScope(nextScope, row.repository, currentMetadata, fallbackRepository),
            scopeSource: SCOPE_SOURCE.MANUAL,
          };
      return {
        id: row.id,
        targetType,
        current,
        next,
        changed: current.scope !== next.scope
          || (current.repository ?? null) !== (next.repository ?? null)
          || current.scopeSource !== next.scopeSource,
      };
    });

    return {
      action: normalizedAction,
      targetType,
      requestedCount: targetIds.length,
      matchedCount: previews.length,
      missingIds,
      rows: previews,
    };
  }

  insertScopeOverrideAudit({
    targetType,
    targetId,
    action,
    previousScope,
    nextScope,
    previousRepository,
    nextRepository,
    actor,
    reason,
    source,
  }) {
    this.db.prepare(`
      INSERT INTO scope_override_audit (
        id, target_type, target_id, action, previous_scope, next_scope,
        previous_repository, next_repository, actor, reason, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      targetType,
      targetId,
      action,
      previousScope ?? null,
      nextScope ?? null,
      normalizeRepository(previousRepository),
      normalizeRepository(nextRepository),
      actor,
      reason,
      source,
      nowIso(),
    );
  }

  applyScopeChanges({
    targetType,
    ids,
    action = "set",
    scope,
    repository,
    actor,
    reason,
    source,
  }) {
    this.ensureOpen();
    const preview = this.previewScopeChanges({
      targetType,
      ids,
      action,
      scope,
      repository,
    });
    const timestamp = nowIso();
    const normalizedAction = preview.action;
    const updateSemantic = this.db.prepare(`
      UPDATE semantic_memory
      SET scope = ?,
          repository = ?,
          scope_source = ?,
          scope_override_actor = ?,
          scope_override_reason = ?,
          scope_override_source = ?,
          scope_override_at = ?,
          updated_at = ?
      WHERE id = ?
    `);
    const updateEpisode = this.db.prepare(`
      UPDATE episode_digest
      SET scope = ?,
          repository = ?,
          scope_source = ?,
          scope_override_actor = ?,
          scope_override_reason = ?,
          scope_override_source = ?,
          scope_override_at = ?,
          updated_at = ?
      WHERE id = ?
    `);

    for (const row of preview.rows) {
      const nextScopeSource = normalizedAction === "clear" ? SCOPE_SOURCE.AUTO : SCOPE_SOURCE.MANUAL;
      const overrideActor = normalizedAction === "clear" ? null : actor;
      const overrideReason = normalizedAction === "clear" ? null : reason;
      const overrideSource = normalizedAction === "clear" ? null : source;
      const overrideAt = normalizedAction === "clear" ? null : timestamp;
      if (targetType === "episode") {
        updateEpisode.run(
          row.next.scope,
          row.next.repository,
          nextScopeSource,
          overrideActor,
          overrideReason,
          overrideSource,
          overrideAt,
          timestamp,
          row.id,
        );
      } else {
        updateSemantic.run(
          row.next.scope,
          row.next.repository,
          nextScopeSource,
          overrideActor,
          overrideReason,
          overrideSource,
          overrideAt,
          timestamp,
          row.id,
        );
      }
      this.insertScopeOverrideAudit({
        targetType,
        targetId: row.id,
        action: normalizedAction,
        previousScope: row.current.scope,
        nextScope: row.next.scope,
        previousRepository: row.current.repository,
        nextRepository: row.next.repository,
        actor,
        reason,
        source,
      });
    }

    return preview;
  }

  listScopeOverrideAudit({ targetType, targetId, limit = 10 }) {
    this.ensureOpen();
    const params = [];
    const where = [];
    addStringFilter(where, params, "target_type", targetType);
    addStringFilter(where, params, "target_id", targetId);
    params.push(limit);
    return this.db.prepare(`
      SELECT
        id, target_type, target_id, action, previous_scope, next_scope,
        previous_repository, next_repository, actor, reason, source, created_at
      FROM scope_override_audit
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params);
  }

  upsertImprovementArtifact({
    sourceCaseId,
    sourceKind,
    title,
    summary,
    evidence = {},
    trace = {},
    linkedMemoryId = null,
  }) {
    this.ensureOpen();
    return upsertImprovementArtifactImpl(this.db, {
      sourceCaseId,
      sourceKind,
      title,
      summary,
      evidence,
      trace,
      linkedMemoryId,
    });
  }

  updateImprovementArtifactStatus({
    id,
    status,
    supersededBy = null,
  }) {
    this.ensureOpen();
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("id is required");
    }
    const nextStatus = normalizeImprovementStatus(status, IMPROVEMENT_STATUS.ACTIVE);
    const timestamp = nowIso();
    const resolvedAt = nextStatus === IMPROVEMENT_STATUS.RESOLVED ? timestamp : null;
    this.db.prepare(`
      UPDATE improvement_backlog
      SET status = ?,
          superseded_by = CASE
            WHEN ? = 'superseded' THEN COALESCE(?, superseded_by)
            ELSE NULL
          END,
          review_state = CASE
            WHEN ? = 'superseded' AND proposal_path IS NOT NULL THEN 'superseded'
            ELSE review_state
          END,
          resolved_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      nextStatus,
      supersededBy ?? null,
      nextStatus,
      resolvedAt,
      timestamp,
      normalizedId,
    );
  }

  getImprovementArtifact(id) {
    this.ensureOpen();
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT
        id,
        source_case_id,
        source_kind,
        title,
        summary,
        evidence_json,
        trace_json,
        status,
        linked_memory_id,
        superseded_by,
        proposal_type,
        proposal_path,
        proposal_hash,
        review_state,
        review_requested_at,
        review_requested_by,
        reviewer_decision,
        reviewer_notes_json,
        created_at,
        updated_at,
        resolved_at
      FROM improvement_backlog
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId);
    if (!row) {
      return null;
    }
    return {
      ...row,
      evidence: parseJsonObject(row.evidence_json),
      trace: parseJsonObject(row.trace_json),
      reviewer_notes: parseJsonObject(row.reviewer_notes_json),
    };
  }

  setImprovementArtifactProposal({
    id,
    proposalType,
    proposalPath,
    proposalHash,
    reviewState = IMPROVEMENT_REVIEW_STATE.DRAFT,
    reviewRequestedAt = null,
    reviewRequestedBy = null,
    reviewerDecision = null,
    reviewerNotes = {},
  }) {
    this.ensureOpen();
    setImprovementArtifactProposalImpl(this.db, {
      id,
      proposalType,
      proposalPath,
      proposalHash,
      reviewState,
      reviewRequestedAt,
      reviewRequestedBy,
      reviewerDecision,
      reviewerNotes,
    });
  }

  listImprovementArtifacts({
    sourceKind,
    sourceCaseId,
    status,
    reviewState,
    hasProposal,
    updatedBefore,
    sort = "updated_desc",
    limit = 10,
  } = {}) {
    this.ensureOpen();
    const { where, params } = buildImprovementArtifactFilters({
      sourceKind,
      sourceCaseId,
      status,
      reviewState,
      hasProposal,
      updatedBefore,
    });
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT
        id,
        source_case_id,
        source_kind,
        title,
        summary,
        evidence_json,
        trace_json,
        status,
        linked_memory_id,
        superseded_by,
        proposal_type,
        proposal_path,
        proposal_hash,
        review_state,
        review_requested_at,
        review_requested_by,
        reviewer_decision,
        reviewer_notes_json,
        created_at,
        updated_at,
        resolved_at
      FROM improvement_backlog
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at ${sort === "updated_asc" ? "ASC" : "DESC"}
      LIMIT ?
    `).all(...params);
    return rows.map((row) => ({
      ...row,
      evidence: parseJsonObject(row.evidence_json),
      trace: parseJsonObject(row.trace_json),
      reviewer_notes: parseJsonObject(row.reviewer_notes_json),
    }));
  }

  countGeneratedSemanticMemoriesBySession(sessionId) {
    this.ensureOpen();
    return this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM semantic_memory
      WHERE source_session_id = ?
        AND superseded_by IS NULL
        AND COALESCE(json_extract(metadata_json, '$.source'), '') != 'memory_save'
        AND COALESCE(json_extract(metadata_json, '$.source'), '') != 'onboarding'
    `).get(sessionId).count;
  }

  getEpisodeDigestBySession(sessionId) {
    this.ensureOpen();
    return this.db.prepare(`
      SELECT id, session_id, scope, scope_source, repository, updated_at
      FROM episode_digest
      WHERE session_id = ?
    `).get(sessionId);
  }

  createBackfillRun({
    strategy = "session_refresh",
    dryRun = false,
    repository = null,
    includeOtherRepositories = false,
    refreshExisting = true,
    batchSize = 10,
    totalCandidates = 0,
    snapshotPath = null,
    metadata = {},
  }) {
    this.ensureOpen();
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO backfill_run (
        id, strategy, status, dry_run, repository, include_other_repositories, refresh_existing,
        batch_size, total_candidates, snapshot_path, metadata_json, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      strategy,
      dryRun ? "preview" : "running",
      dryRun ? 1 : 0,
      normalizeRepository(repository),
      includeOtherRepositories ? 1 : 0,
      refreshExisting ? 1 : 0,
      batchSize,
      totalCandidates,
      snapshotPath,
      JSON.stringify(metadata),
      timestamp,
      timestamp,
    );
    return id;
  }

  insertBackfillRunItems(runId, items) {
    this.ensureOpen();
    const insert = this.db.prepare(`
      INSERT INTO backfill_run_item (
        run_id, session_id, repository, ordinal, planned_action, status
      ) VALUES (?, ?, ?, ?, ?, 'pending')
    `);
    for (const item of items) {
      insert.run(
        runId,
        item.sessionId,
        normalizeRepository(item.repository),
        item.ordinal,
        item.plannedAction,
      );
    }
  }

  getBackfillRun(runId) {
    this.ensureOpen();
    return this.db.prepare(`
      SELECT
        id, strategy, status, dry_run, repository, include_other_repositories,
        refresh_existing, batch_size, total_candidates, processed_count,
        created_episode_count, refreshed_episode_count, skipped_count,
        failed_count, snapshot_path, metadata_json, started_at, updated_at,
        completed_at, last_error
      FROM backfill_run
      WHERE id = ?
    `).get(runId);
  }

  listBackfillRunItems({ runId, statuses = [], limit = 10 }) {
    this.ensureOpen();
    const params = [runId];
    let sql = `
      SELECT
        run_id, session_id, repository, ordinal, planned_action, status,
        semantic_before_count, semantic_after_count, semantic_delta,
        episode_before_scope, episode_after_scope, processed_at, error
      FROM backfill_run_item
      WHERE run_id = ?
    `;
    if (Array.isArray(statuses) && statuses.length > 0) {
      sql += ` AND status IN (${statuses.map(() => "?").join(", ")}) `;
      params.push(...statuses);
    }
    sql += ` ORDER BY ordinal ASC LIMIT ? `;
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  updateBackfillRunItem({
    runId,
    sessionId,
    status,
    semanticBeforeCount = null,
    semanticAfterCount = null,
    semanticDelta = null,
    episodeBeforeScope = null,
    episodeAfterScope = null,
    error = null,
  }) {
    this.ensureOpen();
    this.db.prepare(`
      UPDATE backfill_run_item
      SET status = ?,
          semantic_before_count = ?,
          semantic_after_count = ?,
          semantic_delta = ?,
          episode_before_scope = ?,
          episode_after_scope = ?,
          processed_at = ?,
          error = ?
      WHERE run_id = ? AND session_id = ?
    `).run(
      status,
      semanticBeforeCount,
      semanticAfterCount,
      semanticDelta,
      episodeBeforeScope,
      episodeAfterScope,
      nowIso(),
      error,
      runId,
      sessionId,
    );
  }

  getBackfillRunCounts(runId) {
    return this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('completed', 'skipped', 'failed') THEN 1 ELSE 0 END) AS processed_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN planned_action = 'create' AND status = 'completed' THEN 1 ELSE 0 END) AS created_episode_count,
        SUM(CASE WHEN planned_action = 'refresh' AND status = 'completed' THEN 1 ELSE 0 END) AS refreshed_episode_count,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
      FROM backfill_run_item
      WHERE run_id = ?
    `).get(runId);
  }

  deriveBackfillRunStatus(counts) {
    if ((counts?.pending_count ?? 0) > 0) {
      return "running";
    }
    if ((counts?.failed_count ?? 0) > 0) {
      return "failed";
    }
    return "completed";
  }

  deriveBackfillRunLastError(runId, lastError) {
    if (typeof lastError === "string" && lastError.length > 0) {
      return lastError;
    }
    return this.db.prepare(`
      SELECT error
      FROM backfill_run_item
      WHERE run_id = ?
        AND status = 'failed'
        AND error IS NOT NULL
        AND error != ''
      ORDER BY COALESCE(processed_at, '') DESC, ordinal DESC
      LIMIT 1
    `).get(runId)?.error ?? null;
  }

  buildBackfillRunSummaryUpdate(runId, { lastError = null } = {}) {
    return buildBackfillRunSummaryUpdateImpl(this.db, runId, { lastError });
  }

  writeBackfillRunSummary(runId, summaryUpdate) {
    this.db.prepare(`
      UPDATE backfill_run
      SET status = ?,
          processed_count = ?,
          created_episode_count = ?,
          refreshed_episode_count = ?,
          skipped_count = ?,
          failed_count = ?,
          completed_at = COALESCE(?, completed_at),
          updated_at = ?,
          last_error = COALESCE(?, last_error)
      WHERE id = ?
    `).run(
      summaryUpdate.status,
      summaryUpdate.processedCount,
      summaryUpdate.createdEpisodeCount,
      summaryUpdate.refreshedEpisodeCount,
      summaryUpdate.skippedCount,
      summaryUpdate.failedCount,
      summaryUpdate.completedAt,
      summaryUpdate.updatedAt,
      summaryUpdate.lastError,
      runId,
    );
  }

  refreshBackfillRunSummary(runId, options = {}) {
    this.ensureOpen();
    const summaryUpdate = this.buildBackfillRunSummaryUpdate(runId, options);
    this.writeBackfillRunSummary(runId, summaryUpdate);
    return this.getBackfillRun(runId);
  }

  listBackfillRuns({ limit = 10 }) {
    this.ensureOpen();
    return this.db.prepare(`
      SELECT
        id, strategy, status, dry_run, repository, include_other_repositories,
        refresh_existing, batch_size, total_candidates, processed_count,
        created_episode_count, refreshed_episode_count, skipped_count,
        failed_count, snapshot_path, started_at, updated_at, completed_at, last_error
      FROM backfill_run
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit);
  }

  createMaintenanceRun({
    trigger,
    repository = null,
    dryRun = false,
    plannedTasks = [],
  }) {
    this.ensureOpen();
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO maintenance_run (
        id, trigger, repository, dry_run, status, planned_tasks_json, summary_json,
        started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(trigger || "manual"),
      normalizeRepository(repository),
      dryRun ? 1 : 0,
      dryRun ? "planned" : "running",
      JSON.stringify(ensureArray(plannedTasks)),
      JSON.stringify({}),
      timestamp,
      timestamp,
    );
    return id;
  }

  completeMaintenanceRun({
    runId,
    status,
    repository = null,
    completedAt = null,
    completedCount = 0,
    needsAttentionCount = 0,
    failedCount = 0,
    skippedCount = 0,
    summary = {},
  }) {
    this.ensureOpen();
    this.db.prepare(`
      UPDATE maintenance_run
      SET status = ?,
          summary_json = ?,
          completed_count = ?,
          needs_attention_count = ?,
          failed_count = ?,
          skipped_count = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      String(status || "completed"),
      JSON.stringify(summary ?? {}),
      completedCount,
      needsAttentionCount,
      failedCount,
      skippedCount,
      completedAt,
      nowIso(),
      runId,
    );
    if (completedAt) {
      this.upsertActivitySuccess({
        repository,
        updates: {
          lastMaintenanceCompletionAt: completedAt,
          lastMaintenanceStatus: String(status || "completed"),
          lastMaintenanceRunId: runId,
        },
      });
      this.upsertActivitySuccess({
        repository: null,
        updates: {
          lastMaintenanceCompletionAt: completedAt,
          lastMaintenanceStatus: String(status || "completed"),
          lastMaintenanceRunId: runId,
        },
      });
    }
  }

  listMaintenanceRuns({ limit = 10 } = {}) {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT
        id, trigger, repository, dry_run, status, planned_tasks_json, summary_json,
        completed_count, needs_attention_count, failed_count, skipped_count,
        started_at, updated_at, completed_at
      FROM maintenance_run
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit);
    return rows.map((row) => ({
      ...row,
      plannedTasks: parseJsonArray(row.planned_tasks_json),
      summary: parseJsonObject(row.summary_json),
    }));
  }

  listMaintenanceTaskStates() {
    this.ensureOpen();
    const rows = this.db.prepare(`
      SELECT
        task_name, last_status, last_trigger, last_repository, last_started_at,
        last_completed_at, last_duration_ms, cursor, total_runs, total_failures,
        total_needs_attention, last_summary_json, updated_at
      FROM maintenance_task_state
      ORDER BY task_name ASC
    `).all();
    return rows.map((row) => ({
      ...row,
      lastSummary: parseJsonObject(row.last_summary_json),
    }));
  }

  recordMaintenanceTaskStart({
    taskName,
    trigger,
    repository = null,
    startedAt = nowIso(),
  }) {
    this.ensureOpen();
    this.db.prepare(`
      INSERT INTO maintenance_task_state (
        task_name, last_status, last_trigger, last_repository, last_started_at,
        last_completed_at, last_duration_ms, cursor, total_runs, total_failures,
        total_needs_attention, last_summary_json, updated_at
      ) VALUES (?, 'running', ?, ?, ?, NULL, 0, 0, 0, 0, 0, '{}', ?)
      ON CONFLICT(task_name) DO UPDATE SET
        last_status = 'running',
        last_trigger = excluded.last_trigger,
        last_repository = excluded.last_repository,
        last_started_at = excluded.last_started_at,
        updated_at = excluded.updated_at
    `).run(
      taskName,
      String(trigger || "manual"),
      normalizeRepository(repository),
      startedAt,
      startedAt,
    );
  }

  recordMaintenanceTaskResult({
    taskName,
    status,
    trigger,
    repository = null,
    startedAt = null,
    completedAt = nowIso(),
    durationMs = 0,
    cursor = 0,
    summary = {},
  }) {
    this.ensureOpen();
    const normalizedStatus = String(status || "completed");
    this.db.prepare(`
      INSERT INTO maintenance_task_state (
        task_name, last_status, last_trigger, last_repository, last_started_at,
        last_completed_at, last_duration_ms, cursor, total_runs, total_failures,
        total_needs_attention, last_summary_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(task_name) DO UPDATE SET
        last_status = excluded.last_status,
        last_trigger = excluded.last_trigger,
        last_repository = excluded.last_repository,
        last_started_at = COALESCE(excluded.last_started_at, maintenance_task_state.last_started_at),
        last_completed_at = excluded.last_completed_at,
        last_duration_ms = excluded.last_duration_ms,
        cursor = excluded.cursor,
        total_runs = maintenance_task_state.total_runs + 1,
        total_failures = maintenance_task_state.total_failures
          + CASE WHEN excluded.last_status = 'failed' THEN 1 ELSE 0 END,
        total_needs_attention = maintenance_task_state.total_needs_attention
          + CASE WHEN excluded.last_status = 'needs_attention' THEN 1 ELSE 0 END,
        last_summary_json = excluded.last_summary_json,
        updated_at = excluded.updated_at
    `).run(
      taskName,
      normalizedStatus,
      String(trigger || "manual"),
      normalizeRepository(repository),
      startedAt,
      completedAt,
      clampInteger(durationMs, 0, { min: 0, max: 24 * 60 * 60 * 1000 }),
      clampInteger(cursor, 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
      normalizedStatus === "failed" ? 1 : 0,
      normalizedStatus === "needs_attention" ? 1 : 0,
      JSON.stringify(summary ?? {}),
      completedAt,
    );
  }

  buildSemanticMemoryWriteContext(memory, timestamp) {
    const classification = classifySemanticMemory(memory);
    return {
      id: memory.id ?? crypto.randomUUID(),
      classification,
      repository: normalizeRepository(classification.repository),
      scope: classification.scope,
      domainKey: normalizeText(memory.domainKey).toLowerCase() || null,
      tagsText: Array.isArray(memory.tags) ? memory.tags.join(" ") : "",
      sourceText: typeof classification.metadata?.source === "string" ? classification.metadata.source : "",
      canonicalKey: buildSemanticCanonicalKey({
        ...memory,
        metadata: classification.metadata,
        content: memory.content,
        type: memory.type,
      }),
      incomingReinforcement: Number.isInteger(memory.reinforcementCount)
        ? Math.max(1, memory.reinforcementCount)
        : 1,
      incomingLastSeenAt: memory.lastSeenAt ?? timestamp,
      incomingConfidence: typeof memory.confidence === "number" ? memory.confidence : 1.0,
      insertedUpdatedAt: resolveTimestamp(memory.updatedAt, timestamp),
    };
  }

  findManualSemanticMemoryMatch(memory, canonicalKey) {
    return this.db.prepare(`
      SELECT
        id, tags, metadata_json, scope, repository, scope_source, confidence,
        reinforcement_count, last_seen_at
      FROM semantic_memory
      WHERE superseded_by IS NULL
        AND type = ?
        AND (
          (? IS NOT NULL AND canonical_key = ?)
          OR (? IS NULL AND content = ?)
        )
        AND scope_source = 'manual'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(
      memory.type,
      canonicalKey,
      canonicalKey,
      canonicalKey,
      memory.content,
    );
  }

  findScopedSemanticMemoryMatch(memory, canonicalKey, scope, repository) {
    return this.db.prepare(`
      SELECT id, tags, metadata_json, scope_source, reinforcement_count, last_seen_at
      FROM semantic_memory
      WHERE superseded_by IS NULL
        AND type = ?
        AND (
          (? IS NOT NULL AND canonical_key = ?)
          OR (? IS NULL AND content = ?)
        )
        AND scope = ?
        AND IFNULL(repository, '') = IFNULL(?, '')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(
      memory.type,
      canonicalKey,
      canonicalKey,
      canonicalKey,
      memory.content,
      scope,
      repository,
    );
  }

  buildSemanticMemoryMetadata(existingMetadata, domainKey, classificationMetadata) {
    return {
      ...existingMetadata,
      ...(domainKey ? { domainKey } : {}),
      ...classificationMetadata,
    };
  }

  updateManualSemanticMemoryMatch(memory, write, timestamp, match) {
    const mergedMetadata = this.buildSemanticMemoryMetadata(
      parseJsonObject(match.metadata_json),
      write.domainKey,
      write.classification.metadata,
    );
    this.db.prepare(`
      UPDATE semantic_memory
      SET confidence = MAX(confidence, ?),
          updated_at = ?,
          source_session_id = COALESCE(?, source_session_id),
          source_turn_index = COALESCE(?, source_turn_index),
          domain_key = COALESCE(?, domain_key),
          tags = ?,
          metadata_json = ?,
          canonical_key = COALESCE(canonical_key, ?),
          reinforcement_count = MAX(1, COALESCE(reinforcement_count, 1) + ?),
          ${LAST_SEEN_AT_CASE_SQL}
      WHERE id = ?
    `).run(
      write.incomingConfidence,
      timestamp,
      memory.sourceSessionId ?? null,
      Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
      write.domainKey,
      mergeTagText(match.tags, write.tagsText),
      JSON.stringify(mergedMetadata),
      write.canonicalKey,
      write.incomingReinforcement,
      ...lastSeenAtParams(write.incomingLastSeenAt),
      match.id,
    );
    return match.id;
  }

  updateProtectedSemanticMemoryMatch(existing, write, timestamp) {
    this.db.prepare(`
      UPDATE semantic_memory
      SET updated_at = ?,
          confidence = MAX(confidence, ?),
          domain_key = COALESCE(?, domain_key),
          tags = ?,
          canonical_key = COALESCE(canonical_key, ?),
          reinforcement_count = MAX(1, COALESCE(reinforcement_count, 1) + ?),
          ${LAST_SEEN_AT_CASE_SQL}
      WHERE id = ?
    `).run(
      timestamp,
      write.incomingConfidence,
      write.domainKey,
      mergeTagText(existing.tags, write.tagsText),
      write.canonicalKey,
      write.incomingReinforcement,
      ...lastSeenAtParams(write.incomingLastSeenAt),
      existing.id,
    );
    return existing.id;
  }

  updateScopedSemanticMemoryMatch(memory, existing, write, timestamp) {
    const mergedMetadata = this.buildSemanticMemoryMetadata(
      parseJsonObject(existing.metadata_json),
      write.domainKey,
      write.classification.metadata,
    );
    this.db.prepare(`
      UPDATE semantic_memory
      SET confidence = ?,
          updated_at = ?,
          source_session_id = COALESCE(?, source_session_id),
          source_turn_index = COALESCE(?, source_turn_index),
          domain_key = COALESCE(?, domain_key),
          tags = ?,
          metadata_json = ?,
          canonical_key = COALESCE(canonical_key, ?),
          reinforcement_count = MAX(1, COALESCE(reinforcement_count, 1) + ?),
          ${LAST_SEEN_AT_CASE_SQL}
      WHERE id = ?
    `).run(
      write.incomingConfidence,
      timestamp,
      memory.sourceSessionId ?? null,
      Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
      write.domainKey,
      mergeTagText(existing.tags, write.tagsText),
      JSON.stringify(mergedMetadata),
      write.canonicalKey,
      write.incomingReinforcement,
      ...lastSeenAtParams(write.incomingLastSeenAt),
      existing.id,
    );
    return existing.id;
  }

  insertNewSemanticMemory(memory, write, timestamp) {
    this.db.prepare(`
      INSERT INTO semantic_memory (
        id, type, content, confidence, source_session_id, source_turn_index,
        scope, repository, domain_key, tags, created_at, updated_at, superseded_by, canonical_key,
        reinforcement_count, last_seen_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      write.id,
      memory.type,
      memory.content,
      write.incomingConfidence,
      memory.sourceSessionId ?? null,
      Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
      write.scope,
      write.repository,
      write.domainKey,
      write.tagsText,
      memory.createdAt ?? timestamp,
      write.insertedUpdatedAt,
      memory.supersededBy ?? null,
      write.canonicalKey,
      write.incomingReinforcement,
      write.incomingLastSeenAt,
      memory.expiresAt ?? null,
      JSON.stringify(this.buildSemanticMemoryMetadata({}, write.domainKey, write.classification.metadata)),
    );
    return write.id;
  }

  upsertManualSemanticMemory(memory, write, timestamp) {
    const manualScopeMatch = this.findManualSemanticMemoryMatch(memory, write.canonicalKey);
    return manualScopeMatch?.id
      ? this.updateManualSemanticMemoryMatch(memory, write, timestamp, manualScopeMatch)
      : null;
  }

  upsertScopedSemanticMemory(memory, write, timestamp) {
    const existing = this.findScopedSemanticMemoryMatch(
      memory,
      write.canonicalKey,
      write.scope,
      write.repository,
    );
    if (!existing?.id) {
      return null;
    }
    const existingMetadata = parseJsonObject(existing.metadata_json);
    const manualExisting = existingMetadata.source === "memory_save";
    const manualIncoming = write.sourceText === "memory_save";
    const lockedScope = normalizeScopeSource(existing.scope_source) === SCOPE_SOURCE.MANUAL;
    return (manualExisting || lockedScope) && !manualIncoming
      ? this.updateProtectedSemanticMemoryMatch(existing, write, timestamp)
      : this.updateScopedSemanticMemoryMatch(memory, existing, write, timestamp);
  }

  insertSemanticMemory(memory) {
    this.ensureOpen();
    const timestamp = nowIso();
    const write = this.buildSemanticMemoryWriteContext(memory, timestamp);
    return this.upsertManualSemanticMemory(memory, write, timestamp)
      ?? this.upsertScopedSemanticMemory(memory, write, timestamp)
      ?? this.insertNewSemanticMemory(memory, write, timestamp);
  }

  upsertMemoryDomain(domain) {
    this.ensureOpen();
    const normalized = buildMemoryDomain(domain);
    if (!normalized) {
      throw new Error("invalid memory domain");
    }
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO memory_domain (
        domain_key, kind, title, mission, scope, repository, directives_json,
        disposition_json, metadata_json, status, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain_key) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        mission = excluded.mission,
        scope = excluded.scope,
        repository = excluded.repository,
        directives_json = excluded.directives_json,
        disposition_json = excluded.disposition_json,
        metadata_json = excluded.metadata_json,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_used_at = COALESCE(excluded.last_used_at, memory_domain.last_used_at)
    `).run(
      normalized.domainKey,
      normalized.kind,
      normalized.title,
      normalized.mission,
      normalized.scope,
      normalized.repository,
      JSON.stringify(normalized.directives),
      JSON.stringify(normalized.disposition),
      JSON.stringify(normalized.metadata),
      normalized.status,
      timestamp,
      timestamp,
      domain.lastUsedAt ?? null,
    );
    return normalized.domainKey;
  }

  getMemoryDomain(domainKey) {
    this.ensureOpen();
    const normalizedDomainKey = normalizeText(domainKey).toLowerCase();
    if (!normalizedDomainKey) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT
        domain_key, kind, title, mission, scope, repository, directives_json,
        disposition_json, metadata_json, status, created_at, updated_at, last_used_at
      FROM memory_domain
      WHERE domain_key = ?
      LIMIT 1
    `).get(normalizedDomainKey);
    if (!row) {
      return null;
    }
    return mapMemoryDomainRow(row);
  }

  listMemoryDomains({ repository, includeOtherRepositories = false, scopes = [], status } = {}) {
    this.ensureOpen();
    const repo = normalizeRepository(repository);
    const params = [];
    let sql = `
      SELECT
        domain_key, kind, title, mission, scope, repository, directives_json,
        disposition_json, metadata_json, status, created_at, updated_at, last_used_at
      FROM memory_domain
      WHERE 1 = 1
    `;
    sql = applyScopeFilter(sql, params, repo, includeOtherRepositories);
    if (scopes.length > 0) {
      sql += ` AND scope IN (${scopes.map(() => "?").join(", ")}) `;
      params.push(...scopes);
    }
    if (status) {
      sql += ` AND status = ? `;
      params.push(normalizeText(status).toLowerCase());
    }
    sql += ` ORDER BY updated_at DESC, domain_key ASC `;
    return this.db.prepare(sql).all(...params).map(mapMemoryDomainRow);
  }

  upsertObservation(observation) {
    this.ensureOpen();
    const normalized = buildRefreshableObservation(observation);
    if (!normalized) {
      throw new Error("invalid refreshable observation");
    }
    const timestamp = nowIso();
    const lastRefreshedAt = observation.lastRefreshedAt ?? timestamp;
    this.db.prepare(`
      INSERT INTO refreshable_observation (
        observation_key, domain_key, title, prompt, focus, summary, confidence, scope,
        repository, freshness_hours, status, source, trace_json, metadata_json,
        created_at, updated_at, last_refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observation_key) DO UPDATE SET
        domain_key = excluded.domain_key,
        title = excluded.title,
        prompt = excluded.prompt,
        focus = excluded.focus,
        summary = excluded.summary,
        confidence = excluded.confidence,
        scope = excluded.scope,
        repository = excluded.repository,
        freshness_hours = excluded.freshness_hours,
        status = excluded.status,
        source = excluded.source,
        trace_json = excluded.trace_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at,
        last_refreshed_at = excluded.last_refreshed_at
    `).run(
      normalized.observationKey,
      normalized.domainKey,
      normalized.title,
      normalized.prompt,
      normalized.focus,
      normalized.summary,
      normalized.confidence,
      normalized.scope,
      normalized.repository,
      normalized.freshnessHours,
      normalized.status,
      normalized.source,
      JSON.stringify(normalized.trace),
      JSON.stringify(normalized.metadata),
      timestamp,
      timestamp,
      lastRefreshedAt,
    );
    return normalized.observationKey;
  }

  getObservation(observationKey) {
    this.ensureOpen();
    const normalizedObservationKey = normalizeText(observationKey).toLowerCase();
    if (!normalizedObservationKey) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT
        observation_key, domain_key, title, prompt, focus, summary, confidence, scope,
        repository, freshness_hours, status, source, trace_json, metadata_json,
        created_at, updated_at, last_refreshed_at
      FROM refreshable_observation
      WHERE observation_key = ?
      LIMIT 1
    `).get(normalizedObservationKey);
    if (!row) {
      return null;
    }
    return mapObservationRow(row);
  }

  listObservations({ repository, includeOtherRepositories = false, domainKey, scopes = [], status } = {}) {
    this.ensureOpen();
    const repo = normalizeRepository(repository);
    const normalizedDomainKey = normalizeText(domainKey).toLowerCase() || null;
    const params = [];
    let sql = `
      SELECT
        observation_key, domain_key, title, prompt, focus, summary, confidence, scope,
        repository, freshness_hours, status, source, trace_json, metadata_json,
        created_at, updated_at, last_refreshed_at
      FROM refreshable_observation
      WHERE 1 = 1
    `;
    sql = applyScopeFilter(sql, params, repo, includeOtherRepositories);
    if (normalizedDomainKey) {
      sql += ` AND domain_key = ? `;
      params.push(normalizedDomainKey);
    }
    if (scopes.length > 0) {
      sql += ` AND scope IN (${scopes.map(() => "?").join(", ")}) `;
      params.push(...scopes);
    }
    if (status) {
      sql += ` AND status = ? `;
      params.push(normalizeText(status).toLowerCase());
    }
    sql += ` ORDER BY updated_at DESC, observation_key ASC `;
    return this.db.prepare(sql).all(...params).map(mapObservationRow);
  }

  deleteGeneratedSemanticMemories(sessionId) {
    this.ensureOpen();
    this.db.prepare(`
      DELETE FROM semantic_memory
      WHERE source_session_id = ?
        AND COALESCE(json_extract(metadata_json, '$.source'), '') != 'memory_save'
        AND COALESCE(json_extract(metadata_json, '$.source'), '') != 'onboarding'
        AND COALESCE(scope_source, 'auto') != 'manual'
    `).run(sessionId);
  }

  enqueueDeferredExtraction({
    sessionId,
    repository,
    reason = "manual",
    priority = 0,
    delayMinutes = 0,
    metadata = {},
  }) {
    this.ensureOpen();
    const queuedAt = nowIso();
    const availableAt = new Date(Date.now() + (delayMinutes * 60 * 1000)).toISOString();
    this.db.prepare(`
      INSERT INTO deferred_extraction (
        session_id, repository, status, priority, reason, queued_at, available_at, metadata_json
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        repository = excluded.repository,
        status = CASE
          WHEN deferred_extraction.status = 'running' THEN deferred_extraction.status
          ELSE 'pending'
        END,
        priority = CASE
          WHEN excluded.priority > deferred_extraction.priority THEN excluded.priority
          ELSE deferred_extraction.priority
        END,
        reason = excluded.reason,
        queued_at = excluded.queued_at,
        available_at = CASE
          WHEN deferred_extraction.status = 'running' THEN deferred_extraction.available_at
          ELSE excluded.available_at
        END,
        last_error = NULL,
        metadata_json = excluded.metadata_json
    `).run(
      sessionId,
      normalizeRepository(repository),
      priority,
      reason,
      queuedAt,
      availableAt,
      JSON.stringify(metadata),
    );
  }

  listDeferredExtractions({ repository, limit = 2 }) {
    this.ensureOpen();
    const repo = normalizeRepository(repository);
    const now = nowIso();
    if (repo) {
      return this.db.prepare(`
        SELECT session_id, repository, status, priority, reason, queued_at, available_at, attempts, last_error, metadata_json
        FROM deferred_extraction
        WHERE repository = ?
          AND status IN ('pending', 'failed')
          AND available_at <= ?
        ORDER BY priority DESC, available_at ASC, queued_at ASC
        LIMIT ?
      `).all(repo, now, limit);
    }
    return this.db.prepare(`
      SELECT session_id, repository, status, priority, reason, queued_at, available_at, attempts, last_error, metadata_json
      FROM deferred_extraction
      WHERE status IN ('pending', 'failed')
        AND available_at <= ?
      ORDER BY priority DESC, available_at ASC, queued_at ASC
      LIMIT ?
    `).all(now, limit);
  }

  markDeferredExtractionRunning(sessionId) {
    this.ensureOpen();
    this.db.prepare(`
      UPDATE deferred_extraction
      SET status = 'running',
          attempts = attempts + 1,
          started_at = ?,
          last_error = NULL
      WHERE session_id = ?
    `).run(nowIso(), sessionId);
  }

  completeDeferredExtraction(sessionId) {
    this.ensureOpen();
    const completedAt = nowIso();
    const row = this.db.prepare(`
      SELECT repository
      FROM deferred_extraction
      WHERE session_id = ?
      LIMIT 1
    `).get(sessionId);
    this.db.prepare(`
      UPDATE deferred_extraction
      SET status = 'completed',
          completed_at = ?,
          last_error = NULL
      WHERE session_id = ?
    `).run(completedAt, sessionId);
    this.upsertActivitySuccess({
      repository: row?.repository ?? null,
      updates: {
        lastExtractionCompletionAt: completedAt,
        lastExtractionRepository: row?.repository ?? null,
      },
    });
    this.upsertActivitySuccess({
      repository: null,
      updates: {
        lastExtractionCompletionAt: completedAt,
        lastExtractionRepository: row?.repository ?? null,
      },
    });
  }

  failDeferredExtraction(sessionId, { errorMessage, retryDelayMinutes = 15 }) {
    this.ensureOpen();
    const availableAt = new Date(Date.now() + (retryDelayMinutes * 60 * 1000)).toISOString();
    this.db.prepare(`
      UPDATE deferred_extraction
      SET status = 'failed',
          available_at = ?,
          last_error = ?
      WHERE session_id = ?
    `).run(availableAt, errorMessage, sessionId);
  }

  forgetMemory({ id, supersededBy }) {
    this.ensureOpen();
    this.db.prepare(`
      UPDATE semantic_memory
      SET superseded_by = ?, updated_at = ?
      WHERE id = ?
    `).run(supersededBy ?? `manual:${nowIso()}`, nowIso(), id);
  }

  hasEpisodeDigest(sessionId) {
    this.ensureOpen();
    const row = this.db.prepare(`
      SELECT id FROM episode_digest WHERE session_id = ?
    `).get(sessionId);
    return !!row;
  }

  upsertEpisodeDigest(digest) {
    this.ensureOpen();
    const timestamp = nowIso();
    const classification = classifyEpisodeDigest(digest);
    this.db.prepare(`
      INSERT INTO episode_digest (
        id, session_id, scope, scope_source, repository, branch, summary, actions_json, decisions_json,
        learnings_json, files_changed_json, refs_json, significance, themes_json,
        open_items_json, source, date_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        scope = CASE
          WHEN episode_digest.scope_source = 'manual' THEN episode_digest.scope
          ELSE excluded.scope
        END,
        repository = CASE
          WHEN episode_digest.scope_source = 'manual' THEN episode_digest.repository
          ELSE excluded.repository
        END,
        branch = excluded.branch,
        summary = excluded.summary,
        actions_json = excluded.actions_json,
        decisions_json = excluded.decisions_json,
        learnings_json = excluded.learnings_json,
        files_changed_json = excluded.files_changed_json,
        refs_json = excluded.refs_json,
        significance = excluded.significance,
        themes_json = excluded.themes_json,
        open_items_json = excluded.open_items_json,
        source = excluded.source,
        date_key = excluded.date_key,
        updated_at = excluded.updated_at
    `).run(
      digest.id ?? digest.sessionId,
      digest.sessionId,
      classification.scope,
      SCOPE_SOURCE.AUTO,
      classification.repository,
      digest.branch ?? null,
      digest.summary,
      jsonText(digest.actions),
      jsonText(digest.decisions),
      jsonText(digest.learnings),
      jsonText(digest.filesChanged),
      jsonText(digest.refs),
      digest.significance ?? 5,
      jsonText(digest.themes),
      jsonText(digest.openItems),
      digest.source ?? "rule",
      digest.dateKey,
      digest.createdAt ?? timestamp,
      timestamp,
    );
  }

  refreshDaySummary({ date, repository }) {
    this.ensureOpen();
    const repo = normalizeDaySummaryRepository(repository);
    const rows = this.db.prepare(`
      SELECT session_id, summary
      FROM episode_digest
      WHERE date_key = ? AND (
        (? = '' AND (repository IS NULL OR repository = '')) OR repository = ?
      )
      ORDER BY updated_at DESC
      LIMIT 8
    `).all(date, repo, repo);

    const summaries = rows
      .map((row) => ({
        session_id: row.session_id,
        summary: normalizeText(row.summary),
      }))
      .filter((row) => row.summary.length > 0);

    const preferred = summaries.some((row) => !isGenericWorkSummary(row.summary) && !isPlaceholderSummary(row.summary) && !isToolInvocationSummary(row.summary))
      ? summaries.filter((row) => !isGenericWorkSummary(row.summary) && !isPlaceholderSummary(row.summary) && !isToolInvocationSummary(row.summary))
      : summaries;

    const summary = preferred.length === 0
      ? "No remembered activity."
      : preferred.map((row) => `- ${row.summary}`).join("\n");

    this.db.prepare(`
      INSERT INTO day_summary (date_key, repository, summary, episode_ids_json, computed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date_key, repository) DO UPDATE SET
        summary = excluded.summary,
        episode_ids_json = excluded.episode_ids_json,
        computed_at = excluded.computed_at
    `).run(
      date,
      repo,
      summary,
      JSON.stringify(preferred.map((row) => row.session_id)),
      nowIso(),
    );
  }

  searchSemantic({ query, repository, includeOtherRepositories = false, types = [], scopes = [], limit = 8 }) {
    this.ensureOpen();
    const sanitized = sanitizeNormalizedFtsQuery(query, {
      aliases: QUERY_ALIASES,
      normalize: normalizeFtsToken,
    });
    const repo = normalizeRepository(repository);
    const runSearch = (ftsQuery) => {
      const params = [];
      let sql = `
        SELECT
          sm.id,
          sm.type,
          sm.content,
          sm.scope,
          sm.scope_source,
          sm.confidence,
          sm.repository,
          sm.domain_key,
          sm.updated_at,
          sm.source_session_id,
          sm.canonical_key,
          sm.reinforcement_count,
          sm.last_seen_at,
          sm.metadata_json
        FROM semantic_memory sm
      `;

      if (ftsQuery) {
        sql += ` JOIN semantic_fts ON semantic_fts.rowid = sm.rowid `;
      }

      sql += ` WHERE sm.superseded_by IS NULL `;
      sql = applyScopeFilter(sql, params, repo, includeOtherRepositories, "sm");

      if (types.length > 0) {
        sql += ` AND sm.type IN (${types.map(() => "?").join(", ")}) `;
        params.push(...types);
      }

      if (scopes.length > 0) {
        sql += ` AND sm.scope IN (${scopes.map(() => "?").join(", ")}) `;
        params.push(...scopes);
      }

      if (ftsQuery) {
        sql += ` AND semantic_fts MATCH ? `;
        params.push(ftsQuery);
        sql += ` ORDER BY bm25(semantic_fts), sm.confidence DESC, sm.updated_at DESC `;
      } else {
        sql += ` ORDER BY sm.confidence DESC, sm.updated_at DESC `;
      }

      sql += ` LIMIT ? `;
      params.push(limit);
      return this.db.prepare(sql).all(...params);
    };

    const lexicalRows = runSearch(sanitized);
    const rows = types.length > 0 && sanitized
      ? dedupeSemanticRows([...lexicalRows, ...runSearch("")])
      : lexicalRows;

    return dedupeSemanticRows(rows).slice(0, limit)
      .map((row) => ({
        ...row,
        domainKey: row.domain_key ?? null,
        metadata: parseJsonObject(row.metadata_json),
      }));
  }

  searchEpisodes({ query, repository, includeOtherRepositories = false, scopes = [], limit = 5 }) {
    this.ensureOpen();
    const sanitized = sanitizeNormalizedFtsQuery(query, {
      aliases: QUERY_ALIASES,
      normalize: normalizeFtsToken,
    });
    const repo = normalizeRepository(repository);
    const params = [];
    let sql = `
      SELECT
        ed.id,
        ed.session_id,
        ed.scope,
        ed.scope_source,
        ed.repository,
        ed.summary,
        ed.actions_json,
        ed.decisions_json,
        ed.files_changed_json,
        ed.themes_json,
        ed.open_items_json,
        ed.significance,
        ed.date_key,
        ed.updated_at
      FROM episode_digest ed
    `;

    if (sanitized) {
      sql += ` JOIN episode_fts ON episode_fts.rowid = ed.rowid `;
    }

    sql += ` WHERE 1 = 1 `;

    sql = applyScopeFilter(sql, params, repo, includeOtherRepositories, "ed");

    if (scopes.length > 0) {
      sql += ` AND ed.scope IN (${scopes.map(() => "?").join(", ")}) `;
      params.push(...scopes);
    }

    if (sanitized) {
      sql += ` AND episode_fts MATCH ? `;
      params.push(sanitized);
      sql += ` ORDER BY bm25(episode_fts), ed.significance DESC, ed.updated_at DESC `;
    } else {
      sql += ` ORDER BY ed.updated_at DESC, ed.significance DESC `;
    }

    sql += ` LIMIT ? `;
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  findRelevantEpisodesDetailed({ prompt, repository, includeOtherRepositories = false, scopes = [], limit = 5 }) {
    const { entityTerms, hybridEnabled, effectivePrimaryTerms, effectiveTerms, lexicalQuery } =
      buildEpisodeQueryTermsets(prompt, this.config);
    const improvementRows = this.listImprovementArtifacts({
      sourceKind: IMPROVEMENT_SOURCE_KIND.REPLAY,
      status: IMPROVEMENT_STATUS.ACTIVE,
      limit: Math.max(limit * 3, 12),
    });
    const improvementEpisodes = improvementRows
      .filter((artifact) => {
        const evidence = parseJsonObject(artifact.evidence_json);
        return evidence.caseType === "ranking_target";
      })
      .map((artifact) => buildImprovementArtifactEpisode(artifact, repository));
    const rawExactMatches = this.searchEpisodes({
      query: lexicalQuery, repository, includeOtherRepositories, scopes, limit: Math.max(limit * 2, 8),
    });
    const { included: exactMatches, filtered: exactFiltered } =
      filterEpisodePoolWithTrace([...rawExactMatches, ...improvementEpisodes], "exact_matches", repository);

    const seen = new Set(exactMatches.map((episode) => episode.session_id));
    const rawFallbackPool = this.searchEpisodes({
      query: "", repository, includeOtherRepositories, scopes, limit: Math.max(limit * 8, 24),
    });
    const { included: fallbackPool, filtered: fallbackFiltered } =
      filterEpisodePoolWithTrace([...rawFallbackPool, ...improvementEpisodes], "fallback_pool", repository);

    const deduped = dedupeEpisodesWithTrace([...exactMatches, ...fallbackPool], repository);
    const candidatePool = deduped.rows;
    const exactMatchIds = new Set(exactMatches.map((episode) => episode.session_id));
    const termWeights = buildTermWeights(candidatePool, effectiveTerms);

    // Build rank maps for RRF fusion: preserve the FTS (BM25) order and the recency order
    // so the final scoring blends both signals rather than discarding FTS rank.
    const ftsRankMap = hybridEnabled
      ? new Map(rawExactMatches.map((ep, i) => [ep.session_id, i]))
      : new Map();
    const recencyRankMap = hybridEnabled
      ? new Map(rawFallbackPool.map((ep, i) => [ep.session_id, i]))
      : new Map();
    const ranked = scoreAndRankEpisodeCandidates({
      candidatePool, seen, exactMatchIds, effectiveTerms, effectivePrimaryTerms, termWeights,
      hybridEnabled, ftsRankMap, recencyRankMap,
      ftsMissRank: rawExactMatches.length, recencyMissRank: rawFallbackPool.length,
    });

    const ordered = ranked.map((entry) => entry.episode);
    const { preferred, genericFiltered } = separateGenericEpisodes(ordered, repository);
    const includedRows = preferred.slice(0, limit);
    return {
      episodes: includedRows,
      trace: {
        prompt,
        repository,
        includeOtherRepositories,
        eligibleScopes: scopes.length > 0 ? [...scopes] : buildLocalEligibility(repository),
        primaryTerms: effectivePrimaryTerms,
        entityTerms: hybridEnabled ? entityTerms : [],
        hybridEnabled,
        terms: effectiveTerms,
        lexicalQuery,
        rankedRows: ranked
          .slice(0, Math.max(limit * 3, 12))
          .map((entry) => ({
            ...serializeEpisodeTraceRow(entry.episode, repository),
            score: Number(entry.score.toFixed(2)),
          })),
        includedRows: includedRows.map((episode) => serializeEpisodeTraceRow(episode, repository)),
        filtered: [
          ...exactFiltered,
          ...fallbackFiltered,
          ...deduped.filtered,
          ...genericFiltered,
        ],
      },
    };
  }

  findRelevantEpisodes({ prompt, repository, includeOtherRepositories = false, scopes = [], limit = 5 }) {
    return this.findRelevantEpisodesDetailed({
      prompt,
      repository,
      includeOtherRepositories,
      scopes,
      limit,
    }).episodes;
  }

  getDaySummary({ date, repository }) {
    this.ensureOpen();
    const repo = normalizeDaySummaryRepository(repository);
    return this.db.prepare(`
      SELECT date_key, repository, summary, episode_ids_json, computed_at
      FROM day_summary
      WHERE date_key = ? AND (
        (? = '' AND repository = '') OR repository = ?
      )
    `).get(date, repo, repo);
  }

  getDaySummaries({ date, repository, includeOtherRepositories = false, limit = 4 }) {
    this.ensureOpen();
    const repo = normalizeRepository(repository);
    const params = [date];
    let sql = `
      SELECT date_key, repository, summary, episode_ids_json, computed_at
      FROM day_summary
      WHERE date_key = ?
    `;

    if (!includeOtherRepositories) {
      const scopedRepo = normalizeDaySummaryRepository(repository);
      sql += ` AND ((? = '' AND repository = '') OR repository = ?) `;
      params.push(scopedRepo, scopedRepo);
    }

    sql += `
      ORDER BY
        CASE
          WHEN ? IS NOT NULL AND repository = ? THEN 0
          WHEN repository IS NULL OR repository = '' THEN 1
          ELSE 2
        END,
        computed_at DESC,
        repository ASC
      LIMIT ?
    `;
    params.push(repo, repo, limit);
    return this.db.prepare(sql).all(...params);
  }

  findRelevantEpisodesByDateDetailed({ date, repository, includeOtherRepositories = false, limit = 5 }) {
    this.ensureOpen();
    const repo = normalizeRepository(repository);
    const params = [date];
    let sql = `
      SELECT
        ed.id,
        ed.session_id,
        ed.scope,
        ed.scope_source,
        ed.repository,
        ed.summary,
        ed.actions_json,
        ed.decisions_json,
        ed.files_changed_json,
        ed.themes_json,
        ed.open_items_json,
        ed.significance,
        ed.date_key,
        ed.updated_at
      FROM episode_digest ed
      WHERE ed.date_key = ?
    `;

    sql = applyScopeFilter(sql, params, repo, includeOtherRepositories, "ed");

    sql += `
      ORDER BY
        CASE
          WHEN ? IS NOT NULL AND ed.repository = ? THEN 0
          WHEN ed.scope = ? THEN 1
          ELSE 2
        END,
        ed.significance DESC,
        ed.updated_at DESC
      LIMIT ?
    `;
    params.push(repo, repo, MEMORY_SCOPE.GLOBAL, Math.max(limit * 3, 12));

    const rawRows = this.db.prepare(sql).all(...params);
    const filtered = [];
    const eligibleRows = rawRows.filter((episode) => {
      const reason = explainEpisodeExclusionReason(episode);
      if (!reason) {
        return true;
      }
      filtered.push({
        stage: "date_matches",
        reason,
        row: serializeEpisodeTraceRow(episode, repository),
      });
      return false;
    });

    const deduped = dedupeEpisodesWithTrace(eligibleRows, repository);
    const ordered = deduped.rows;
    const genericFiltered = ordered.some((episode) => !isGenericWorkSummary(episode.summary))
      ? ordered
          .filter((episode) => isGenericWorkSummary(episode.summary))
          .map((episode) => ({
            stage: "preference",
            reason: "generic_work_summary",
            row: serializeEpisodeTraceRow(episode, repository),
          }))
      : [];
    const preferred = ordered.some((episode) => !isGenericWorkSummary(episode.summary))
      ? ordered.filter((episode) => !isGenericWorkSummary(episode.summary))
      : ordered;
    const includedRows = preferred.slice(0, limit);

    return {
      episodes: includedRows,
      trace: {
        prompt: `date:${date}`,
        repository,
        includeOtherRepositories,
        eligibleScopes: includeOtherRepositories ? [] : buildLocalEligibility(repository),
        primaryTerms: [],
        terms: [],
        lexicalQuery: "",
        rankedRows: preferred
          .slice(0, Math.max(limit * 3, 12))
          .map((episode) => serializeEpisodeTraceRow(episode, repository)),
        includedRows: includedRows.map((episode) => serializeEpisodeTraceRow(episode, repository)),
        filtered: [
          ...filtered,
          ...deduped.filtered,
          ...genericFiltered,
        ],
      },
    };
  }

  searchPromptSemanticRows({
    query,
    repository,
    types,
    scopes,
    limit,
    includeOtherRepositories = false,
  }) {
    return withCurrentRepository(this.searchSemantic({
      query,
      repository,
      includeOtherRepositories,
      types,
      scopes,
      limit,
    }), repository);
  }

  buildPromptSemanticContext({ prompt, repository, limit, identityName, identityOnly }) {
    const memories = !identityOnly
      ? this.searchPromptSemanticRows({
          query: prompt,
          repository,
          includeOtherRepositories: false,
          types: ["commitment", "open_loop", "rejected_approach", "blocker", "user_preference", "assistant_identity", "user_identity", "assistant_goal", "recurring_mistake"],
          limit,
        })
      : [];
    const identityMemories = identityName
      ? this.searchPromptSemanticRows({
          query: "",
          repository,
          includeOtherRepositories: false,
          types: ["assistant_identity"],
          scopes: [MEMORY_SCOPE.GLOBAL],
          limit: 4,
        })
      : [];
    const assistantPersonaRows = this.searchPromptSemanticRows({
      query: identityName || "assistant preferred human name",
      repository,
      includeOtherRepositories: false,
      types: ["assistant_identity"],
      scopes: [MEMORY_SCOPE.GLOBAL],
      limit: 2,
    });
    const relationshipPreferenceRows = !identityOnly
      ? this.searchPromptSemanticRows({
          query: "",
          repository,
          includeOtherRepositories: false,
          types: ["interaction_style", "user_identity", "user_preference", "recurring_mistake"],
          scopes: [MEMORY_SCOPE.GLOBAL],
          limit: 6,
        }).filter((memory) => isStyleAddressingMemory(memory)).slice(0, 4)
      : [];

    return {
      memories,
      identityMemories,
      localMemories: dedupeSemanticContextRows([
        ...identityMemories,
        ...memories,
      ]).filter((memory) => !isStyleAddressingMemory(memory)),
      assistantPersonaRows,
      relationshipPreferenceRows,
    };
  }

  buildEffectivePromptStyleSection({
    prompt,
    need,
    assistantPersonaRows,
    relationshipPreferenceRows,
    pureTemporalRecall,
  }) {
    const styleSection = buildStyleAddressingSection({
      prompt,
      promptNeed: need,
      config: this.config,
      assistantPersonaRows,
      relationshipPreferenceRows,
      renderSemantic: formatSemanticContextLine,
    });
    return pureTemporalRecall && need.wantsStyleContext !== true
      ? {
          ...styleSection,
          text: "",
          trace: {
            ...styleSection.trace,
            enabled: false,
            includeAmbient: false,
            reason: "suppressed_for_pure_temporal_recall",
          },
        }
      : styleSection;
  }

  filterPromptDaySummaries(daySummaryRows, pureTemporalRecall, temporalContentTerms) {
    return daySummaryRows.filter((summary) => {
      if (pureTemporalRecall || temporalContentTerms.length === 0) {
        return true;
      }
      const summaryTokens = tokenizeText(summary.summary);
      return temporalContentTerms.some((term) => summaryTokens.has(term));
    });
  }

  buildIdentityOnlyEpisodeDetails(prompt, repository) {
    return {
      episodes: [],
      trace: {
        prompt,
        repository,
        includeOtherRepositories: false,
        eligibleScopes: buildLocalEligibility(repository),
        primaryTerms: [],
        terms: [],
        lexicalQuery: "",
        rankedRows: [],
        includedRows: [],
        filtered: [],
        reason: "identity_only_prompt",
      },
    };
  }

  buildPromptEpisodeContext({
    prompt,
    repository,
    limit,
    allowRepoLocalTaskContext,
    allowCrossRepoFallback,
    pureTemporalRecall,
    temporalDate,
    includedDaySummaryRows,
  }) {
    if (!allowRepoLocalTaskContext) {
      return this.buildIdentityOnlyEpisodeDetails(prompt, repository);
    }
    if (pureTemporalRecall && includedDaySummaryRows.length > 0) {
      return {
        episodes: [],
        trace: {
          prompt,
          repository,
          includeOtherRepositories: allowCrossRepoFallback,
          eligibleScopes: allowCrossRepoFallback ? [] : buildLocalEligibility(repository),
          primaryTerms: [],
          terms: [],
          lexicalQuery: "",
          rankedRows: [],
          includedRows: [],
          filtered: [],
          reason: "suppressed_by_day_summaries",
        },
      };
    }
    return pureTemporalRecall
      ? this.findRelevantEpisodesByDateDetailed({
          date: temporalDate,
          repository,
          includeOtherRepositories: allowCrossRepoFallback,
          limit: Math.max(2, Math.floor(limit / 2)),
        })
      : this.findRelevantEpisodesDetailed({
          prompt,
          repository,
          includeOtherRepositories: false,
          limit: Math.max(2, Math.floor(limit / 2)),
        });
  }

  buildPromptTemporalContext({
    prompt,
    repository,
    need,
    limit,
    allowRepoLocalTaskContext,
    allowCrossRepoFallback,
    assistantPersonaRows,
    relationshipPreferenceRows,
  }) {
    const temporalDate = need.hasTemporalSignal ? inferDateFromPrompt(prompt, this.config) : null;
    const temporalContentTerms = temporalDate ? extractTemporalContentTerms(prompt, this.config) : [];
    const pureTemporalRecall = temporalDate !== null && temporalContentTerms.length === 0;
    const daySummaryRows = temporalDate
      ? this.getDaySummaries({
          date: temporalDate,
          repository,
          includeOtherRepositories: allowCrossRepoFallback && pureTemporalRecall,
          limit: pureTemporalRecall && allowCrossRepoFallback
            ? Math.max(2, Math.min(limit, 4))
            : 1,
        })
      : [];
    const includedDaySummaryRows = this.filterPromptDaySummaries(
      daySummaryRows,
      pureTemporalRecall,
      temporalContentTerms,
    );
    const episodeDetails = this.buildPromptEpisodeContext({
      prompt,
      repository,
      limit,
      allowRepoLocalTaskContext,
      allowCrossRepoFallback,
      pureTemporalRecall,
      temporalDate,
      includedDaySummaryRows,
    });
    return {
      temporalDate,
      temporalContentTerms,
      pureTemporalRecall,
      daySummaryRows,
      includedDaySummaryRows,
      episodeDetails,
      episodes: withCurrentRepository(episodeDetails.episodes, repository),
      effectiveStyleSection: this.buildEffectivePromptStyleSection({
        prompt,
        need,
        assistantPersonaRows,
        relationshipPreferenceRows,
        pureTemporalRecall,
      }),
    };
  }

  buildPromptCrossRepoContext({
    lexicalPrompt,
    repository,
    allowCrossRepoFallback,
    pureTemporalRecall,
    sessionStore,
    limit,
  }) {
    const allowGenericCrossRepoFallback = allowCrossRepoFallback && !pureTemporalRecall;
    const crossRepoPreferenceLimit = Math.max(1, Math.min(2, Math.floor(limit / 2) || 1));
    const crossRepoPreferenceRows = allowGenericCrossRepoFallback
      ? this.searchSemantic({
          query: lexicalPrompt,
          repository,
          includeOtherRepositories: true,
          types: ["user_preference", "rejected_approach", "recurring_mistake"],
          scopes: [MEMORY_SCOPE.TRANSFERABLE],
          limit: Math.max(limit * 4, 8),
        })
      : [];
    const crossRepoPreferences = allowGenericCrossRepoFallback
      ? withCurrentRepository(
          crossRepoPreferenceRows
            .filter((memory) => isCrossRepoRow(memory, repository))
            .slice(0, crossRepoPreferenceLimit),
          repository,
        )
      : [];
    const crossRepoEpisodeDetails = allowGenericCrossRepoFallback
      ? this.findRelevantEpisodesDetailed({
          prompt: lexicalPrompt,
          repository,
          includeOtherRepositories: true,
          scopes: [MEMORY_SCOPE.TRANSFERABLE],
          limit: Math.max(limit * 4, 8),
        })
      : null;
    const crossRepoEpisodes = allowGenericCrossRepoFallback
      ? withCurrentRepository(
          crossRepoEpisodeDetails.episodes
            .filter((episode) => isCrossRepoRow(episode, repository))
            .slice(0, Math.max(1, Math.min(2, Math.floor(limit / 2) || 1))),
          repository,
        )
      : [];
    const crossRepoHints = allowGenericCrossRepoFallback && sessionStore
      ? withCurrentRepository(
          sessionStore.findRelevantSessions({
            prompt: lexicalPrompt,
            repository: null,
            limit: Math.max(limit * 4, 8),
          }).filter((session) => isCrossRepoRow(session, repository))
            .slice(0, Math.max(1, Math.min(2, Math.floor(limit / 2) || 1))),
          repository,
        )
      : [];
    return {
      allowGenericCrossRepoFallback,
      crossRepoPreferenceRows,
      crossRepoPreferences,
      crossRepoEpisodeDetails,
      crossRepoEpisodes,
      crossRepoHints,
    };
  }

  determinePromptDaySummaryReason({
    need,
    temporalDate,
    includedDaySummaryRows,
    daySummaryRows,
  }) {
    if (!need.hasTemporalSignal) {
      return "no_temporal_signal";
    }
    if (temporalDate === null) {
      return "unresolved_temporal_date";
    }
    if (includedDaySummaryRows.length === 0 && daySummaryRows.length === 0) {
      return "missing_day_summary";
    }
    return includedDaySummaryRows.length === 0
      ? "summary_did_not_match_prompt_terms"
      : null;
  }

  buildPromptTemporalVerifier({
    repository,
    sessionStore,
    temporalDate,
    pureTemporalRecall,
    allowCrossRepoFallback,
    limit,
    daySummaryReason,
    includedDaySummaryRows,
    episodes,
  }) {
    const temporalVerifierEnabled = !!sessionStore && temporalDate !== null && pureTemporalRecall;
    const shouldRunTemporalVerifier = temporalVerifierEnabled
      && includedDaySummaryRows.length === 0
      && episodes.length === 0
      && (daySummaryReason === "missing_day_summary" || daySummaryReason === "summary_did_not_match_prompt_terms");
    const temporalVerifierRows = shouldRunTemporalVerifier
      ? withCurrentRepository(
          sessionStore.findSessionsByDate({
            dateKey: temporalDate,
            repository,
            includeOtherRepositories: allowCrossRepoFallback,
            limit: Math.max(2, Math.min(limit, 3)),
          }).map((session) => ({
            ...session,
            source_type: "session_store_verifier",
            excerpt: session.workspaceSummary || session.summary,
          })),
          repository,
        )
      : [];
    return {
      temporalVerifierEnabled,
      shouldRunTemporalVerifier,
      temporalVerifierRows,
    };
  }

  buildPromptContextFlags(need) {
    return {
      allowRepoLocalTaskContext: need.wantsRepoLocalTaskContext === true
        && need.wantsCrossRepoExamples !== true,
      allowCrossRepoFallback: need.allowCrossRepoFallback === true,
      identityOnly: need.identityOnly === true,
    };
  }

  buildLexicalPrompt(prompt, promptTerms) {
    return promptTerms.length > 0 ? promptTerms.join(" ") : prompt;
  }

  resolvePromptRenderTerms(promptTerms, temporalContentTerms) {
    return temporalContentTerms.length > 0 ? temporalContentTerms : promptTerms;
  }

  finalizePromptContextResult(lines, trace, {
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

  buildExplainComputedState(trace, {
    need, temporalCtx, allowCrossRepoFallback, limit, repository, sessionStore, promptTerms,
  }) {
    const { temporalDate, temporalContentTerms, pureTemporalRecall, includedDaySummaryRows, daySummaryRows, episodes } = temporalCtx;
    const renderTerms = this.resolvePromptRenderTerms(promptTerms, temporalContentTerms);
    const hasIncludedDaySummary = includedDaySummaryRows.length > 0;
    const hasIncludedEpisodes = episodes.length > 0;
    const daySummaryReason = this.determinePromptDaySummaryReason({
      need, temporalDate, includedDaySummaryRows, daySummaryRows,
    });
    const {
      temporalVerifierEnabled,
      shouldRunTemporalVerifier,
      temporalVerifierRows,
    } = this.buildPromptTemporalVerifier({
      repository, sessionStore, temporalDate, pureTemporalRecall,
      allowCrossRepoFallback, limit, daySummaryReason, includedDaySummaryRows, episodes,
    });
    setPromptTemporalVerifierTraceState({
      trace, repository, sessionStore, temporalDate, pureTemporalRecall,
      temporalVerifierEnabled, shouldRunTemporalVerifier, temporalVerifierRows,
    });
    return { renderTerms, hasIncludedDaySummary, hasIncludedEpisodes, daySummaryReason, shouldRunTemporalVerifier, temporalVerifierRows };
  }

  explainPromptContext({
    prompt,
    repository,
    includeOtherRepositories = false,
    limit = 6,
    sessionStore = null,
    promptNeed = null,
  }) {
    this.ensureOpen();
    const promptTerms = extractNormalizedFtsTerms(prompt, {
      aliases: QUERY_ALIASES,
      normalize: normalizeFtsToken,
    });
    const lexicalPrompt = this.buildLexicalPrompt(prompt, promptTerms);
    const identityName = detectAssistantIdentityName(prompt);
    const need = promptNeed ?? buildDefaultPromptNeed(prompt, includeOtherRepositories);
    const { allowRepoLocalTaskContext, allowCrossRepoFallback, identityOnly } = this.buildPromptContextFlags(need);
    const semanticCtx = this.buildPromptSemanticContext({ prompt, repository, limit, identityName, identityOnly });
    const temporalCtx = this.buildPromptTemporalContext({
      prompt, repository, need, limit, allowRepoLocalTaskContext, allowCrossRepoFallback,
      assistantPersonaRows: semanticCtx.assistantPersonaRows,
      relationshipPreferenceRows: semanticCtx.relationshipPreferenceRows,
    });
    const crossRepoCtx = this.buildPromptCrossRepoContext({
      lexicalPrompt, repository, allowCrossRepoFallback,
      pureTemporalRecall: temporalCtx.pureTemporalRecall, sessionStore, limit,
    });

    const lines = [];
    const trace = buildExplainPromptTrace({
      prompt, repository, allowCrossRepoFallback, promptTerms, identityName,
      semanticCtx, temporalCtx, crossRepoCtx, sessionStore,
    });
    const state = this.buildExplainComputedState(trace, {
      need, temporalCtx, allowCrossRepoFallback, limit, repository, sessionStore, promptTerms,
    });
    appendExplainSections(lines, trace, {
      need, state, semanticCtx, temporalCtx, crossRepoCtx,
      allowRepoLocalTaskContext, allowCrossRepoFallback, repository, sessionStore, identityOnly, promptTerms,
    });
    return this.finalizePromptContextResult(lines, trace, {
      crossRepoEpisodes: crossRepoCtx.crossRepoEpisodes,
      allowGenericCrossRepoFallback: crossRepoCtx.allowGenericCrossRepoFallback,
      pureTemporalRecall: temporalCtx.pureTemporalRecall,
    });
  }

  buildPromptContext({
    prompt,
    repository,
    includeOtherRepositories = false,
    limit = 6,
    sessionStore = null,
    promptNeed = null,
  }) {
    return this.explainPromptContext({
      prompt,
      repository,
      includeOtherRepositories,
      limit,
      sessionStore,
      promptNeed,
    }).text;
  }
}

function inferDateFromPrompt(prompt, config = null) {
  if (!readTemporalQueryNormalizationEnabled(config)) {
    const text = String(prompt || "").toLowerCase();
    const now = new Date();
    const startOfUtcDay = new Date(now);
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    if (text.includes("today")) {
      return startOfUtcDay.toISOString().slice(0, 10);
    }
    if (text.includes("yesterday")) {
      const value = new Date(startOfUtcDay);
      value.setUTCDate(value.getUTCDate() - 1);
      return value.toISOString().slice(0, 10);
    }

    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const namedDay = weekdays.find((weekday) => text.includes(weekday));
    if (!namedDay) {
      return null;
    }

    const targetIndex = weekdays.indexOf(namedDay);
    const currentIndex = now.getUTCDay();
    const diff = (currentIndex - targetIndex + 7) % 7 || 7;
    const value = new Date(startOfUtcDay);
    value.setUTCDate(value.getUTCDate() - diff);
    return value.toISOString().slice(0, 10);
  }
  return inferNormalizedDateFromPrompt(prompt, { now: config?.now });
}

// --- Episode retrieval helpers (todo 6) ---

function dedupeEpisodesWithTrace(episodes, currentRepository = null) {
  const seenSummaries = new Set();
  const seenSessions = new Set();
  const deduped = [];
  const filtered = [];

  for (const episode of episodes) {
    if (seenSessions.has(episode.session_id)) {
      filtered.push({
        stage: "dedupe",
        reason: "duplicate_session",
        row: serializeEpisodeTraceRow(episode, currentRepository),
      });
      continue;
    }
    const summaryKey = normalizeText(episode.summary).toLowerCase();
    if (summaryKey && seenSummaries.has(summaryKey)) {
      filtered.push({
        stage: "dedupe",
        reason: "duplicate_summary",
        row: serializeEpisodeTraceRow(episode, currentRepository),
      });
      continue;
    }
    seenSessions.add(episode.session_id);
    if (summaryKey) {
      seenSummaries.add(summaryKey);
    }
    deduped.push(episode);
  }

  return {
    rows: deduped,
    filtered,
  };
}

function filterEpisodePoolWithTrace(pool, stageName, repository) {
  const included = [];
  const filtered = [];
  for (const episode of pool) {
    const reason = explainEpisodeExclusionReason(episode);
    if (!reason) {
      included.push(episode);
    } else {
      filtered.push({ stage: stageName, reason, row: serializeEpisodeTraceRow(episode, repository) });
    }
  }
  return { included, filtered };
}

function separateGenericEpisodes(ordered, repository) {
  const hasNonGeneric = ordered.some((episode) => !isGenericWorkSummary(episode.summary));
  const genericFiltered = hasNonGeneric
    ? ordered
      .filter((episode) => isGenericWorkSummary(episode.summary))
      .map((episode) => ({
        stage: "preference",
        reason: "generic_work_summary",
        row: serializeEpisodeTraceRow(episode, repository),
      }))
    : [];
  const preferred = hasNonGeneric
    ? ordered.filter((episode) => !isGenericWorkSummary(episode.summary))
    : ordered;
  return { preferred, genericFiltered };
}

// --- explainPromptContext helpers (todo 7) ---

function buildExplainPromptTrace({ prompt, repository, allowCrossRepoFallback, promptTerms, identityName, semanticCtx, temporalCtx, crossRepoCtx, sessionStore }) {
  return createPromptContextTrace({
    prompt,
    repository,
    allowCrossRepoFallback,
    allowGenericCrossRepoFallback: crossRepoCtx.allowGenericCrossRepoFallback,
    promptTerms,
    identityName,
    temporalDate: temporalCtx.temporalDate,
    memories: semanticCtx.memories,
    localMemories: semanticCtx.localMemories,
    identityMemories: semanticCtx.identityMemories,
    effectiveStyleSection: temporalCtx.effectiveStyleSection,
    assistantPersonaRows: semanticCtx.assistantPersonaRows,
    relationshipPreferenceRows: semanticCtx.relationshipPreferenceRows,
    daySummaryRows: temporalCtx.daySummaryRows,
    includedDaySummaryRows: temporalCtx.includedDaySummaryRows,
    episodeDetails: temporalCtx.episodeDetails,
    crossRepoPreferenceRows: crossRepoCtx.crossRepoPreferenceRows,
    crossRepoPreferences: crossRepoCtx.crossRepoPreferences,
    crossRepoEpisodeDetails: crossRepoCtx.crossRepoEpisodeDetails,
    crossRepoEpisodes: crossRepoCtx.crossRepoEpisodes,
    crossRepoHints: crossRepoCtx.crossRepoHints,
    sessionStore,
  });
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
