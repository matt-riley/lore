import crypto from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.mjs";
import {
  buildStyleAddressingSection,
  isStyleAddressingMemory,
} from "./style-addressing.mjs";
import { readHybridRetrievalEnabled, readTemporalQueryNormalizationEnabled } from "./rollout-flags.mjs";
import {
  extractTemporalContentTerms as extractNormalizedTemporalContentTerms,
  inferDateFromPrompt as inferNormalizedDateFromPrompt,
} from "./query-normalizer.mjs";

const SCOPE_SOURCE = Object.freeze({
  AUTO: "auto",
  MANUAL: "manual",
});

const IMPROVEMENT_SOURCE_KIND = Object.freeze({
  SESSION: "session",
  SIGNAL: "signal",
  VALIDATION: "validation",
  REPLAY: "replay",
});

const IMPROVEMENT_STATUS = Object.freeze({
  ACTIVE: "active",
  RESOLVED: "resolved",
  SUPERSEDED: "superseded",
});

const IMPROVEMENT_REVIEW_STATE = Object.freeze({
  NONE: "none",
  DRAFT: "draft",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
});

const PRIMARY_SCHEMA_VERSION_TABLE = "lore_schema_version";
const LEGACY_SCHEMA_VERSION_TABLES = Object.freeze(["coherence_schema_version"]);
const PRIMARY_ACTIVITY_STATE_TABLE = "lore_activity_state";
const LEGACY_ACTIVITY_STATE_TABLE = "coherence_activity_state";

function nowIso() {
  return new Date().toISOString();
}

function escapeSqlString(value) {
  return String(value || "").replace(/'/g, "''");
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function normalizeImprovementReviewState(value, fallback = IMPROVEMENT_REVIEW_STATE.NONE) {
  switch (String(value || "").trim().toLowerCase()) {
    case IMPROVEMENT_REVIEW_STATE.DRAFT:
      return IMPROVEMENT_REVIEW_STATE.DRAFT;
    case IMPROVEMENT_REVIEW_STATE.APPROVED:
      return IMPROVEMENT_REVIEW_STATE.APPROVED;
    case IMPROVEMENT_REVIEW_STATE.REJECTED:
      return IMPROVEMENT_REVIEW_STATE.REJECTED;
    case IMPROVEMENT_REVIEW_STATE.SUPERSEDED:
      return IMPROVEMENT_REVIEW_STATE.SUPERSEDED;
    case IMPROVEMENT_REVIEW_STATE.NONE:
      return IMPROVEMENT_REVIEW_STATE.NONE;
    default:
      return fallback;
  }
}

function mapPromptSectionSource(title) {
  switch (String(title || "")) {
    case "Relevant Day Summary":
      return "day_summary";
    case "Relevant Prior Work":
      return "related_work";
    case "Response Style And Addressing":
      return "style_addressing";
    case "Relevant Commitments, Preferences, And Identity":
      return "commitments";
    case "Cross-Repo Examples":
      return "cross_repo_examples";
    case "Cross-Repo Hints":
      return "cross_repo_hints";
    case "Transferable Cross-Repo Preferences":
      return "cross_repo_preferences";
    case "Active Workstream":
      return "workstream_overlays";
    case "Pending Proposal Review":
      return "proposal_awareness";
    default:
      return "context";
  }
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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const GENERIC_QUERY_TERMS = new Set([
  "again",
  "apply",
  "consistent",
  "conversation",
  "conversations",
  "continue",
  "decision",
  "decisions",
  "history",
  "keep",
  "prior",
  "problem",
  "session",
  "sessions",
  "task",
  "tasks",
  "thing",
  "things",
  "work",
  "worked",
  "working",
]);

const TEMPORAL_QUERY_SCAFFOLD_TERMS = new Set([
  "can",
  "config",
  "configuration",
  "did",
  "do",
  "for",
  "friday",
  "here",
  "last",
  "monday",
  "our",
  "ours",
  "project",
  "recall",
  "remember",
  "repo",
  "repository",
  "saturday",
  "setup",
  "sunday",
  "thursday",
  "this",
  "today",
  "tuesday",
  "wednesday",
  "week",
  "what",
  "when",
  "where",
  "which",
  "with",
  "workspace",
  "you",
  "your",
  "yesterday",
]);

const QUERY_ALIASES = {
  audit: ["auditable", "override", "scope"],
  auditable: ["audit", "override", "scope"],
  backfill: ["restore", "rollback", "snapshot"],
  chat: ["conversation", "session"],
  lore: ["memory", "history", "session"],
  conversation: ["chat", "session", "history"],
  conversations: ["chat", "session", "history"],
  memory: ["remember", "history", "lore"],
  override: ["scope", "audit", "manual"],
  past: ["history", "prior"],
  previous: ["history", "prior"],
  prompt: ["shaping", "context", "classification"],
  phase: ["slice", "stage", "shaping", "prompt"],
  recall: ["memory", "history", "remember"],
  remember: ["memory", "history", "lore"],
  remembering: ["memory", "history", "lore"],
  restore: ["rollback", "snapshot", "backfill"],
  retrieval: ["memory", "history", "lore"],
  rollback: ["restore", "snapshot", "backfill"],
  controlled: ["backfill", "rollback", "restore", "snapshot"],
  scope: ["override", "audit", "transferable", "global", "repo"],
  session: ["conversation", "history"],
  shaping: ["prompt", "context", "classification"],
  snapshot: ["restore", "rollback", "backfill"],
};

function normalizeMatchTerm(term) {
  let value = String(term || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (value.endsWith("ies") && value.length > 4) {
    value = `${value.slice(0, -3)}y`;
  } else if (value.endsWith("ing") && value.length > 5) {
    value = value.slice(0, -3);
  } else if (value.endsWith("ed") && value.length > 4) {
    value = value.slice(0, -2);
  } else if (value.endsWith("s") && value.length > 4) {
    value = value.slice(0, -1);
  }
  return value;
}

function normalizeFtsToken(term) {
  return String(term || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractFtsTerms(query) {
  const directTerms = String(query || "")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeFtsToken)
    .filter((term) => term.length > 2)
    .filter((term) => !GENERIC_QUERY_TERMS.has(normalizeMatchTerm(term)));

  const expandedTerms = [];
  for (const term of directTerms) {
    expandedTerms.push(term);
    for (const alias of QUERY_ALIASES[term] ?? []) {
      const normalizedAlias = normalizeFtsToken(alias);
      if (normalizedAlias.length > 2 && !GENERIC_QUERY_TERMS.has(normalizeMatchTerm(normalizedAlias))) {
        expandedTerms.push(normalizedAlias);
      }
    }
  }

  return [...new Set(expandedTerms)];
}

function extractDirectTerms(query) {
  return String(query || "")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeMatchTerm)
    .filter((term) => term.length > 2)
    .filter((term) => !GENERIC_QUERY_TERMS.has(term));
}

function extractTemporalContentTerms(query, config = null) {
  if (!readTemporalQueryNormalizationEnabled(config)) {
    return extractDirectTerms(query)
      .filter((term) => !TEMPORAL_QUERY_SCAFFOLD_TERMS.has(term));
  }
  return extractNormalizedTemporalContentTerms(query);
}

function sanitizeFtsQuery(query) {
  const terms = extractFtsTerms(query);
  if (terms.length === 0) {
    return "";
  }
  return terms.join(" ");
}

function jsonText(value) {
  return JSON.stringify(value ?? []);
}

function parseJsonArray(value) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeImprovementSourceKind(value) {
  if (value === IMPROVEMENT_SOURCE_KIND.SESSION) {
    return IMPROVEMENT_SOURCE_KIND.SESSION;
  }
  if (value === IMPROVEMENT_SOURCE_KIND.SIGNAL) {
    return IMPROVEMENT_SOURCE_KIND.SIGNAL;
  }
  return value === IMPROVEMENT_SOURCE_KIND.REPLAY
    ? IMPROVEMENT_SOURCE_KIND.REPLAY
    : IMPROVEMENT_SOURCE_KIND.VALIDATION;
}

function normalizeImprovementStatus(value, fallback = IMPROVEMENT_STATUS.ACTIVE) {
  if (value === IMPROVEMENT_STATUS.RESOLVED) {
    return IMPROVEMENT_STATUS.RESOLVED;
  }
  if (value === IMPROVEMENT_STATUS.SUPERSEDED) {
    return IMPROVEMENT_STATUS.SUPERSEDED;
  }
  return fallback;
}

function normalizeRepository(repository) {
  return typeof repository === "string" && repository.trim().length > 0
    ? repository.trim()
    : null;
}

function normalizeDaySummaryRepository(repository) {
  return normalizeRepository(repository) ?? "";
}

function normalizeScopeSource(value, fallback = SCOPE_SOURCE.AUTO) {
  return value === SCOPE_SOURCE.MANUAL ? SCOPE_SOURCE.MANUAL : fallback;
}

function isPlaceholderSummary(summary) {
  return /^Session [0-9a-f-]{8,}$/i.test(normalizeText(summary));
}

function isGenericWorkSummary(summary) {
  return /^Worked in .+ \([0-9a-f-]{8,}\)$/i.test(normalizeText(summary));
}

function isToolInvocationSummary(summary) {
  const text = normalizeText(summary);
  return /^Call the tool\b/i.test(text)
    || /\breturn only the tool output\b/i.test(text)
    || /^Using only local repo files\b/i.test(text);
}

function tokenizeText(value) {
  return new Set(
    normalizeText(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(normalizeMatchTerm)
      .filter((term) => term.length > 2),
  );
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

function formatEpisodeContextLine(episode, { terms = [], index = 0 } = {}) {
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

function formatSessionHintLine(session) {
  const excerpt = normalizeText(session.excerpt);
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

function shouldIncludeStyleAddressingContext(need) {
  if (need?.identityOnly === true || need?.wantsStyleContext === true) {
    return true;
  }
  return need?.hasTemporalSignal !== true && need?.seriousPrompt !== true;
}

function serializeSessionTraceRow(session, currentRepository = null) {
  return {
    sessionId: session.session_id ?? null,
    sourceType: session.source_type ?? null,
    repository: session.repository ?? null,
    updatedAt: session.updated_at ?? null,
    crossRepo: isCrossRepoRow(session, currentRepository),
    excerpt: normalizeText(session.excerpt),
  };
}

function buildLocalEligibility(repository) {
  if (repository) {
    return [MEMORY_SCOPE.GLOBAL, `${MEMORY_SCOPE.REPO}:${repository}`];
  }
  return [MEMORY_SCOPE.GLOBAL];
}

function explainEpisodeExclusionReason(episode) {
  if (isPlaceholderSummary(episode.summary)) {
    return "placeholder_summary";
  }
  if (isToolInvocationSummary(episode.summary)) {
    return "tool_invocation_summary";
  }
  return null;
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

function isCrossRepoRow(row, repository) {
  return !!(
    row
    && row.repository
    && (!repository || row.repository !== repository)
  );
}

function scoreEpisodeAgainstTerms(episode, terms) {
  if (terms.length === 0) {
    return 0;
  }

  const tokens = tokenizeText([
    episode.summary,
    episode.actions_json,
    episode.decisions_json,
    episode.files_changed_json,
    episode.themes_json,
    episode.open_items_json,
  ].join(" "));

  let score = 0;
  let matchedTerms = 0;
  for (const term of terms) {
    if (tokens.has(term)) {
      score += 1;
      matchedTerms += 1;
    }
  }

  if (matchedTerms === 0) {
    return 0;
  }

  if (!isGenericWorkSummary(episode.summary)) {
    score += 0.4;
  }
  if (!isToolInvocationSummary(episode.summary)) {
    score += 0.3;
  }
  score += Math.min((episode.significance ?? 0) / 10, 1);
  return score;
}

function buildTermWeights(episodes, terms) {
  const weights = new Map();
  if (terms.length === 0 || episodes.length === 0) {
    return weights;
  }

  const documentFrequency = new Map();
  for (const episode of episodes) {
    const tokens = tokenizeText([
      episode.summary,
      episode.actions_json,
      episode.decisions_json,
      episode.files_changed_json,
      episode.themes_json,
      episode.open_items_json,
    ].join(" "));
    for (const term of terms) {
      if (tokens.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  for (const term of terms) {
    const frequency = documentFrequency.get(term) ?? 0;
    weights.set(term, frequency === 0 ? 1.5 : 1 + ((episodes.length - frequency) / episodes.length));
  }

  return weights;
}

function scoreEpisodeAgainstWeightedTerms(episode, terms, primaryTerms, termWeights, exactMatchIds) {
  if (terms.length === 0) {
    return 0;
  }

  const tokens = tokenizeText([
    episode.summary,
    episode.actions_json,
    episode.decisions_json,
    episode.files_changed_json,
    episode.themes_json,
    episode.open_items_json,
  ].join(" "));

  let score = 0;
  let matchedTerms = 0;
  let matchedPrimaryTerms = 0;
  for (const term of terms) {
    if (tokens.has(term)) {
      score += termWeights.get(term) ?? 1;
      matchedTerms += 1;
      if (primaryTerms.includes(term)) {
        matchedPrimaryTerms += 1;
      }
    }
  }

  if (matchedTerms === 0 || (matchedPrimaryTerms === 0 && matchedTerms < 2)) {
    return 0;
  }

  score += matchedTerms * 0.35;
  score += matchedPrimaryTerms * 1.25;
  if (exactMatchIds.has(episode.session_id)) {
    score += 2;
  }
  if (!isGenericWorkSummary(episode.summary)) {
    score += 0.5;
  }
  score += Math.min((episode.significance ?? 0) / 10, 1);
  return score;
}

function dedupeEpisodes(episodes) {
  const seenSummaries = new Set();
  const seenSessions = new Set();
  const deduped = [];

  for (const episode of episodes) {
    if (seenSessions.has(episode.session_id)) {
      continue;
    }
    const summaryKey = normalizeText(episode.summary).toLowerCase();
    if (summaryKey && seenSummaries.has(summaryKey)) {
      continue;
    }
    seenSessions.add(episode.session_id);
    if (summaryKey) {
      seenSummaries.add(summaryKey);
    }
    deduped.push(episode);
  }

  return deduped;
}

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

function extractEntityTerms(query) {
  const raw = String(query || "");
  const entities = [];

  // Backtick-quoted identifiers (e.g., `memory-operations.mjs`, `QueryNormalizer`)
  for (const match of raw.matchAll(/`([^`]+)`/g)) {
    const stem = match[1].replace(/\.[a-z]+$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (stem.length > 2) {
      entities.push(stem);
    }
  }

  // File names with common code extensions (e.g., memory-operations.mjs → memoryoperations)
  for (const match of raw.matchAll(/\b([\w-]+)\.(mjs|cjs|js|ts|tsx|json|md|yaml|yml)\b/gi)) {
    const stem = match[1].replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (stem.length > 2) {
      entities.push(stem);
    }
  }

  // CamelCase or PascalCase identifiers (contain an internal uppercase letter)
  for (const match of raw.matchAll(/\b([A-Za-z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    const full = normalizeMatchTerm(match[0].toLowerCase());
    if (full.length > 2) {
      entities.push(full);
    }
    for (const part of match[0].replace(/([A-Z])/g, " $1").trim().split(/\s+/)) {
      const normalized = normalizeMatchTerm(part.toLowerCase());
      if (normalized.length > 2 && !GENERIC_QUERY_TERMS.has(normalized)) {
        entities.push(normalized);
      }
    }
  }

  return [...new Set(entities.map(normalizeMatchTerm).filter((t) => t.length > 2 && !GENERIC_QUERY_TERMS.has(t)))];
}
function buildImprovementArtifactEpisode(artifact, repository) {
  const evidence = parseJsonObject(artifact.evidence_json);
  const expectedEvidence = typeof evidence.expectedEvidence === "object"
    && evidence.expectedEvidence !== null
    && !Array.isArray(evidence.expectedEvidence)
    ? evidence.expectedEvidence
    : parseJsonObject(evidence.expectedEvidence);
  const expectedItems = Array.isArray(expectedEvidence.items)
    ? expectedEvidence.items
    : parseJsonArray(expectedEvidence.items);
  const expectedSnippets = expectedItems
    .flatMap((item) => parseJsonArray(item?.includesAny))
    .map(normalizeText)
    .filter(Boolean);
  const rankedOutcome = normalizeText(evidence.rankingOutcome);
  const missCategory = normalizeText(evidence.missCategory);
  const prompt = normalizeText(evidence.prompt);
  const caseId = normalizeText(artifact.source_case_id);
  const summary = normalizeText(artifact.summary);
  const title = normalizeText(artifact.title);
  const updatedAt = artifact.updated_at ?? nowIso();
  const dateKey = String(updatedAt).slice(0, 10);
  const normalizedRepository = normalizeRepository(repository);

  const decisions = [
    title,
    summary,
    rankedOutcome ? `ranking outcome: ${rankedOutcome}` : "",
    missCategory ? `miss category: ${missCategory}` : "",
    ...expectedSnippets.slice(0, 8),
  ].map(normalizeText).filter(Boolean);

  const actions = [
    prompt ? `prompt: ${prompt}` : "",
    caseId ? `case: ${caseId}` : "",
    `source kind: ${normalizeText(artifact.source_kind) || IMPROVEMENT_SOURCE_KIND.REPLAY}`,
  ].map(normalizeText).filter(Boolean);

  return {
    id: `improvement:${artifact.id}`,
    session_id: `improvement:${caseId || artifact.id}`,
    scope: MEMORY_SCOPE.GLOBAL,
    scope_source: SCOPE_SOURCE.AUTO,
    repository: normalizedRepository,
    summary: `Replay improvement artifact: ${title}${summary ? ` — ${summary}` : ""}`,
    actions_json: jsonText(actions),
    decisions_json: jsonText(decisions),
    files_changed_json: jsonText([]),
    themes_json: jsonText([
      "replay",
      "improvement",
      caseId,
      ...expectedSnippets.slice(0, 4),
    ].map(normalizeText).filter(Boolean)),
    open_items_json: jsonText([
      `Need durable retrieval evidence for ${caseId || "replay target"}`,
    ]),
    significance: 8,
    date_key: dateKey,
    updated_at: updatedAt,
  };
}

export class LoreDb {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.lastBackupPath = null;
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
    const dbPath = this.config.paths.derivedStorePath;
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
    const optimizeRows = this.db.prepare(`PRAGMA optimize`).all();
    const checkpoint = this.db.prepare(`PRAGMA wal_checkpoint(PASSIVE)`).get();
    return {
      optimizeRows,
      checkpoint,
      completedAt: nowIso(),
    };
  }

  getCurrentVersion() {
    return this.getCurrentVersionInfo().version;
  }

  getCurrentVersionInfo() {
    for (const tableName of [PRIMARY_SCHEMA_VERSION_TABLE, ...LEGACY_SCHEMA_VERSION_TABLES]) {
      const hasVersionTable = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(tableName);
      if (!hasVersionTable) {
        continue;
      }
      const row = this.db.prepare(`SELECT MAX(version) AS version FROM ${tableName}`).get();
      const version = typeof row?.version === "number" ? row.version : 0;
      return { tableName, version };
    }
    return { tableName: null, version: 0 };
  }

  adoptSchemaVersion(version) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${PRIMARY_SCHEMA_VERSION_TABLE} (
        version INTEGER NOT NULL
      );
    `);
    this.db.exec(`DELETE FROM ${PRIMARY_SCHEMA_VERSION_TABLE};`);
    this.db.prepare(`INSERT INTO ${PRIMARY_SCHEMA_VERSION_TABLE} (version) VALUES (?)`).run(version);
  }

  tableExists(tableName) {
    return Boolean(
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(tableName),
    );
  }

  adoptLegacyActivityStateTable() {
    if (this.tableExists(PRIMARY_ACTIVITY_STATE_TABLE) || !this.tableExists(LEGACY_ACTIVITY_STATE_TABLE)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${LEGACY_ACTIVITY_STATE_TABLE} RENAME TO ${PRIMARY_ACTIVITY_STATE_TABLE}`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_lore_activity_state_scope_type_repository
        ON ${PRIMARY_ACTIVITY_STATE_TABLE}(scope_type, repository);
    `);
  }

  runMigrations(currentVersion) {
    if (currentVersion >= SCHEMA_VERSION) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      if (currentVersion > 0 && currentVersion < 3) {
        this.ensureColumn("semantic_memory", "scope", `TEXT NOT NULL DEFAULT 'repo'`);
        this.ensureColumn("episode_digest", "scope", `TEXT NOT NULL DEFAULT 'repo'`);
      }
      if (currentVersion > 0 && currentVersion < 5) {
        this.ensureColumn("semantic_memory", "scope_source", `TEXT NOT NULL DEFAULT 'auto'`);
        this.ensureColumn("semantic_memory", "scope_override_actor", `TEXT`);
        this.ensureColumn("semantic_memory", "scope_override_reason", `TEXT`);
        this.ensureColumn("semantic_memory", "scope_override_source", `TEXT`);
        this.ensureColumn("semantic_memory", "scope_override_at", `TEXT`);
        this.ensureColumn("episode_digest", "scope_source", `TEXT NOT NULL DEFAULT 'auto'`);
        this.ensureColumn("episode_digest", "scope_override_actor", `TEXT`);
        this.ensureColumn("episode_digest", "scope_override_reason", `TEXT`);
        this.ensureColumn("episode_digest", "scope_override_source", `TEXT`);
        this.ensureColumn("episode_digest", "scope_override_at", `TEXT`);
      }
      if (currentVersion > 0 && currentVersion < 7) {
        this.ensureColumn("semantic_memory", "canonical_key", "TEXT");
        this.ensureColumn("semantic_memory", "reinforcement_count", "INTEGER NOT NULL DEFAULT 1");
        this.ensureColumn("semantic_memory", "last_seen_at", "TEXT");
      }
      if (currentVersion > 0 && currentVersion < 10) {
        this.applyPhase5ImprovementLoopMigration();
      }
      if (currentVersion > 0 && currentVersion < 11) {
        this.applyTrajectoryArtifactsMigration();
      }
      if (currentVersion > 0 && currentVersion < 12) {
        this.applyIntentJournalMigration();
      }
      for (const statement of SCHEMA_STATEMENTS) {
        this.db.exec(statement);
      }
      if (currentVersion < 4) {
        this.applyScopeMigration();
      }
      if (currentVersion < 5) {
        this.applyScopeGovernanceMigration();
      }
      if (currentVersion < 7) {
        this.applyGrowthMemoryMigration();
      }
      if (currentVersion < 8) {
        this.applyImprovementBacklogMigration();
      }
      if (currentVersion < 13) {
        this.applyLoreVisibilitySubstrateMigration();
      }
      if (currentVersion < 14) {
        this.applyMemoryDomainObservationMigration();
      }
      if (currentVersion < 15) {
        this.applyApprovalSubstrateMigration();
      }
      this.adoptSchemaVersion(SCHEMA_VERSION);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tableHasColumn(tableName, columnName) {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    return rows.some((row) => row.name === columnName);
  }

  ensureColumn(tableName, columnName, definitionSql) {
    if (this.tableHasColumn(tableName, columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
  }

  applyScopeMigration() {
    this.ensureColumn("semantic_memory", "scope", `TEXT NOT NULL DEFAULT 'repo'`);
    this.ensureColumn("episode_digest", "scope", `TEXT NOT NULL DEFAULT 'repo'`);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_scope
        ON semantic_memory(scope);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_episode_digest_scope
        ON episode_digest(scope);
    `);

    const updateSemantic = this.db.prepare(`
      UPDATE semantic_memory
      SET scope = ?, repository = ?, metadata_json = ?
      WHERE id = ?
    `);
    const semanticRows = this.db.prepare(`
      SELECT id, type, content, scope, repository, tags, metadata_json
      FROM semantic_memory
    `).all();
    for (const row of semanticRows) {
      const classification = classifySemanticMemory({
        type: row.type,
        content: row.content,
        scope: null,
        repository: row.repository,
        tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
        metadata: parseJsonObject(row.metadata_json),
      });
      updateSemantic.run(
        classification.scope,
        classification.repository,
        JSON.stringify(classification.metadata),
        row.id,
      );
    }

    const updateEpisode = this.db.prepare(`
      UPDATE episode_digest
      SET scope = ?, repository = ?
      WHERE id = ?
    `);
    const episodeRows = this.db.prepare(`
      SELECT
        id,
        scope,
        repository,
        summary,
        actions_json,
        decisions_json,
        learnings_json,
        refs_json,
        themes_json,
        open_items_json
      FROM episode_digest
    `).all();
    for (const row of episodeRows) {
      const classification = classifyEpisodeDigest({
        scope: null,
        repository: row.repository,
        summary: row.summary,
        actions: parseJsonArray(row.actions_json),
        decisions: parseJsonArray(row.decisions_json),
        learnings: parseJsonArray(row.learnings_json),
        refs: parseJsonArray(row.refs_json),
        themes: parseJsonArray(row.themes_json),
        openItems: parseJsonArray(row.open_items_json),
      });
      updateEpisode.run(
        classification.scope,
        classification.repository,
        row.id,
      );
    }
  }

  applyScopeGovernanceMigration() {
    this.ensureColumn("semantic_memory", "scope_source", `TEXT NOT NULL DEFAULT 'auto'`);
    this.ensureColumn("semantic_memory", "scope_override_actor", `TEXT`);
    this.ensureColumn("semantic_memory", "scope_override_reason", `TEXT`);
    this.ensureColumn("semantic_memory", "scope_override_source", `TEXT`);
    this.ensureColumn("semantic_memory", "scope_override_at", `TEXT`);
    this.ensureColumn("episode_digest", "scope_source", `TEXT NOT NULL DEFAULT 'auto'`);
    this.ensureColumn("episode_digest", "scope_override_actor", `TEXT`);
    this.ensureColumn("episode_digest", "scope_override_reason", `TEXT`);
    this.ensureColumn("episode_digest", "scope_override_source", `TEXT`);
    this.ensureColumn("episode_digest", "scope_override_at", `TEXT`);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_scope_source
        ON semantic_memory(scope_source);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_episode_digest_scope_source
        ON episode_digest(scope_source);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scope_override_audit (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL,
        previous_scope TEXT,
        next_scope TEXT,
        previous_repository TEXT,
        next_repository TEXT,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scope_override_audit_target
        ON scope_override_audit(target_type, target_id, created_at DESC);
    `);

    this.db.prepare(`
      UPDATE semantic_memory
      SET scope_source = COALESCE(scope_source, 'auto')
    `).run();
    this.db.prepare(`
      UPDATE episode_digest
      SET scope_source = COALESCE(scope_source, 'auto')
    `).run();
  }

  applyGrowthMemoryMigration() {
    this.ensureColumn("semantic_memory", "canonical_key", "TEXT");
    this.ensureColumn("semantic_memory", "reinforcement_count", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("semantic_memory", "last_seen_at", "TEXT");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_canonical_key
        ON semantic_memory(canonical_key);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_user_identity_canonical
        ON semantic_memory(type, canonical_key, superseded_by, updated_at DESC);
    `);
    try {
      this.db.exec(`INSERT INTO semantic_fts(semantic_fts) VALUES('rebuild');`);
    } catch {
      // best-effort rebuild for legacy DBs before bulk updates
    }

    this.db.prepare(`
      UPDATE semantic_memory
      SET reinforcement_count = CASE
        WHEN reinforcement_count IS NULL OR reinforcement_count < 1 THEN 1
        ELSE reinforcement_count
      END
    `).run();
    this.db.prepare(`
      UPDATE semantic_memory
      SET last_seen_at = COALESCE(last_seen_at, updated_at, created_at)
      WHERE last_seen_at IS NULL
    `).run();

    const semanticRows = this.db.prepare(`
      SELECT id, type, content, metadata_json
      FROM semantic_memory
      WHERE superseded_by IS NULL
        AND type IN ('user_identity', 'assistant_goal', 'recurring_mistake', 'workstream_overlay')
    `).all();
    const updateCanonical = this.db.prepare(`
      UPDATE semantic_memory
      SET canonical_key = ?
      WHERE id = ?
    `);
    for (const row of semanticRows) {
      const canonicalKey = buildSemanticCanonicalKey({
        type: row.type,
        content: row.content,
        metadata: parseJsonObject(row.metadata_json),
      });
      if (!canonicalKey) {
        continue;
      }
      updateCanonical.run(canonicalKey, row.id);
    }

    const duplicateKeys = this.db.prepare(`
      SELECT canonical_key
      FROM semantic_memory
      WHERE superseded_by IS NULL
        AND type = 'user_identity'
        AND canonical_key IS NOT NULL
      GROUP BY canonical_key
      HAVING COUNT(*) > 1
    `).all();

    for (const { canonical_key: canonicalKey } of duplicateKeys) {
      const candidates = this.db.prepare(`
        SELECT
          id,
          confidence,
          reinforcement_count,
          last_seen_at,
          updated_at,
          tags,
          metadata_json,
          scope_source
        FROM semantic_memory
        WHERE superseded_by IS NULL
          AND type = 'user_identity'
          AND canonical_key = ?
        ORDER BY
          CASE WHEN COALESCE(scope_source, 'auto') = 'manual' THEN 0 ELSE 1 END,
          confidence DESC,
          reinforcement_count DESC,
          updated_at DESC
      `).all(canonicalKey);
      if (candidates.length <= 1) {
        continue;
      }

      const [winner, ...losers] = candidates;
      let reinforcementTotal = 0;
      let latestSeen = winner.last_seen_at || winner.updated_at || nowIso();
      let mergedTags = winner.tags || "";
      let mergedMetadata = parseJsonObject(winner.metadata_json);
      let maxConfidence = Number.isFinite(winner.confidence) ? winner.confidence : 1.0;

      for (const candidate of candidates) {
        reinforcementTotal += Number.isInteger(candidate.reinforcement_count)
          ? candidate.reinforcement_count
          : 1;
        if (candidate.last_seen_at && candidate.last_seen_at > latestSeen) {
          latestSeen = candidate.last_seen_at;
        }
        mergedTags = mergeTagText(mergedTags, candidate.tags);
        mergedMetadata = {
          ...parseJsonObject(candidate.metadata_json),
          ...mergedMetadata,
        };
        const candidateConfidence = Number.isFinite(candidate.confidence) ? candidate.confidence : 1.0;
        if (candidateConfidence > maxConfidence) {
          maxConfidence = candidateConfidence;
        }
      }

      this.db.prepare(`
        UPDATE semantic_memory
        SET confidence = ?,
            reinforcement_count = ?,
            last_seen_at = ?,
            tags = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        maxConfidence,
        Math.max(reinforcementTotal, 1),
        latestSeen,
        mergedTags,
        JSON.stringify(mergedMetadata),
        nowIso(),
        winner.id,
      );

      const supersededAt = nowIso();
      const supersedeStatement = this.db.prepare(`
        UPDATE semantic_memory
        SET superseded_by = ?, updated_at = ?
        WHERE id = ?
      `);
      for (const loser of losers) {
        supersedeStatement.run(winner.id, supersededAt, loser.id);
      }
    }
  }

  applyImprovementBacklogMigration() {
    this.ensureColumn("improvement_backlog", "linked_memory_id", "TEXT");
  }

  applyPhase5ImprovementLoopMigration() {
    this.ensureColumn("improvement_backlog", "proposal_type", "TEXT");
    this.ensureColumn("improvement_backlog", "proposal_path", "TEXT");
    this.ensureColumn("improvement_backlog", "proposal_hash", "TEXT");
    this.ensureColumn("improvement_backlog", "review_state", `TEXT NOT NULL DEFAULT 'none'`);
    this.ensureColumn("improvement_backlog", "review_requested_at", "TEXT");
    this.ensureColumn("improvement_backlog", "review_requested_by", "TEXT");
    this.ensureColumn("improvement_backlog", "reviewer_decision", "TEXT");
    this.ensureColumn("improvement_backlog", "reviewer_notes_json", `TEXT NOT NULL DEFAULT '{}'`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_improvement_backlog_review_state_updated
        ON improvement_backlog(review_state, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_improvement_backlog_proposal_path
        ON improvement_backlog(proposal_path);
    `);
  }

  applyTrajectoryArtifactsMigration() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_artifact (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        repository TEXT,
        source_case_id TEXT,
        source_kind TEXT,
        improvement_artifact_id TEXT,
        event_key TEXT,
        summary TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        outcome TEXT NOT NULL DEFAULT 'captured',
        latency_ms INTEGER,
        target_ms INTEGER,
        context_json TEXT NOT NULL DEFAULT '{}',
        trace_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_kind_created
        ON trajectory_artifact(kind, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_source_created
        ON trajectory_artifact(source_kind, source_case_id, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_repository_kind_created
        ON trajectory_artifact(repository, kind, created_at DESC);
    `);
  }

  applyIntentJournalMigration() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intent_journal (
        id TEXT PRIMARY KEY,
        repository TEXT,
        session_id TEXT,
        turn_hint TEXT,
        intent_kind TEXT NOT NULL DEFAULT 'journal',
        summary TEXT NOT NULL,
        rationale TEXT,
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_journal_repository_created
        ON intent_journal(repository, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_journal_kind_created
        ON intent_journal(intent_kind, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_journal_session_created
        ON intent_journal(session_id, created_at DESC);
    `);
  }

  applyLoreVisibilitySubstrateMigration() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lore_activity_state (
        scope_key TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        repository TEXT,
        last_context_injection_at TEXT,
        last_context_injection_hook TEXT,
        last_context_injection_sections_json TEXT NOT NULL DEFAULT '[]',
        last_context_injection_trace_id TEXT,
        last_context_injection_duration_ms INTEGER,
        last_extraction_completion_at TEXT,
        last_extraction_repository TEXT,
        last_maintenance_completion_at TEXT,
        last_maintenance_status TEXT,
        last_maintenance_run_id TEXT,
        last_trace_recorded_at TEXT,
        last_trace_hook TEXT,
        last_trace_id TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_lore_activity_state_scope_type_repository
        ON lore_activity_state(scope_type, repository);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_trace_sample (
        id TEXT PRIMARY KEY,
        repository TEXT,
        scope_type TEXT NOT NULL DEFAULT 'repo',
        hook TEXT NOT NULL,
        route TEXT,
        route_reason TEXT,
        context_injected INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        prompt_preview TEXT,
        section_titles_json TEXT NOT NULL DEFAULT '[]',
        prompt_need_json TEXT NOT NULL DEFAULT '{}',
        eligibility_json TEXT NOT NULL DEFAULT '{}',
        lookups_json TEXT NOT NULL DEFAULT '{}',
        omissions_json TEXT NOT NULL DEFAULT '[]',
        output_json TEXT NOT NULL DEFAULT '{}',
        trace_json TEXT NOT NULL DEFAULT '{}',
        recorded_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_retrieval_trace_sample_repository_recorded
        ON retrieval_trace_sample(repository, recorded_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_retrieval_trace_sample_scope_recorded
        ON retrieval_trace_sample(scope_type, recorded_at DESC);
    `);
  }

  applyApprovalSubstrateMigration() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_approval (
        id TEXT PRIMARY KEY,
        action_family TEXT NOT NULL,
        repository TEXT,
        target_identity TEXT,
        decision TEXT NOT NULL DEFAULT 'ask',
        durable INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        granted_by TEXT NOT NULL DEFAULT 'user',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_action_approval_family_repo
        ON action_approval(action_family, repository, decision, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_action_approval_family_target
        ON action_approval(action_family, target_identity, decision, updated_at DESC);
    `);
  }

  applyMemoryDomainObservationMigration() {
    if (this.tableExists("semantic_memory")) {
      this.ensureColumn("semantic_memory", "domain_key", "TEXT");
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_semantic_memory_domain_key
          ON semantic_memory(domain_key);
      `);
    }
  }

  ensureOpen() {
    if (!this.db) {
      throw new Error("lore database is not initialized");
    }
  }

  getStats() {
    this.ensureOpen();
    const semanticCount = this.db.prepare(`SELECT COUNT(*) AS count FROM semantic_memory`).get().count;
    const episodeCount = this.db.prepare(`SELECT COUNT(*) AS count FROM episode_digest`).get().count;
    const domainCount = this.db.prepare(`SELECT COUNT(*) AS count FROM memory_domain`).get().count;
    const observationCount = this.db.prepare(`SELECT COUNT(*) AS count FROM refreshable_observation`).get().count;
    const semanticGrowth = this.db.prepare(`
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
    const semanticScopes = this.db.prepare(`
      SELECT
        SUM(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) AS global_count,
        SUM(CASE WHEN scope = 'transferable' THEN 1 ELSE 0 END) AS transferable_count,
        SUM(CASE WHEN scope = 'repo' THEN 1 ELSE 0 END) AS repo_count,
        SUM(CASE WHEN scope_source = 'manual' THEN 1 ELSE 0 END) AS manual_count
      FROM semantic_memory
    `).get();
    const episodeScopes = this.db.prepare(`
      SELECT
        SUM(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) AS global_count,
        SUM(CASE WHEN scope = 'transferable' THEN 1 ELSE 0 END) AS transferable_count,
        SUM(CASE WHEN scope = 'repo' THEN 1 ELSE 0 END) AS repo_count,
        SUM(CASE WHEN scope_source = 'manual' THEN 1 ELSE 0 END) AS manual_count
      FROM episode_digest
    `).get();
    const daySummaryCount = this.db.prepare(`SELECT COUNT(*) AS count FROM day_summary`).get().count;
    const deferredCounts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count
      FROM deferred_extraction
    `).get();
    const backfillCounts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN dry_run = 1 THEN 1 ELSE 0 END) AS dry_run_count
      FROM backfill_run
    `).get();
    const schemaVersion = this.getCurrentVersion();
    const overrideAuditCount = this.db.prepare(`SELECT COUNT(*) AS count FROM scope_override_audit`).get().count;
    const improvementCounts = this.db.prepare(`
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
    const maintenanceCounts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'needs_attention' THEN 1 ELSE 0 END) AS needs_attention_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count
      FROM maintenance_run
      WHERE dry_run = 0
    `).get();
    const maintenanceLatest = this.db.prepare(`
      SELECT status, started_at, completed_at
      FROM maintenance_run
      WHERE dry_run = 0
      ORDER BY updated_at DESC
      LIMIT 1
    `).get();
    const maintenanceTaskCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM maintenance_task_state
    `).get().count;
    const trajectoryCounts = this.db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN kind = 'replay_failure' THEN 1 ELSE 0 END) AS replay_failure_count,
        SUM(CASE WHEN kind = 'validation_miss' THEN 1 ELSE 0 END) AS validation_miss_count,
        SUM(CASE WHEN kind = 'proposal_failure' THEN 1 ELSE 0 END) AS proposal_failure_count,
        SUM(CASE WHEN kind = 'latency_outlier' THEN 1 ELSE 0 END) AS latency_outlier_count
      FROM trajectory_artifact
    `).get();
    const intentJournalCounts = this.db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN intent_kind = 'routing' THEN 1 ELSE 0 END) AS routing_count,
        SUM(CASE WHEN intent_kind = 'rollout' THEN 1 ELSE 0 END) AS rollout_count,
        SUM(CASE WHEN intent_kind = 'reviewer' THEN 1 ELSE 0 END) AS reviewer_count,
        SUM(CASE WHEN intent_kind = 'fallback' THEN 1 ELSE 0 END) AS fallback_count,
        SUM(CASE WHEN intent_kind = 'serendipity' THEN 1 ELSE 0 END) AS serendipity_count
      FROM intent_journal
    `).get();
    const retrievalTraceSampleCounts = this.db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN repository IS NULL OR repository = '' THEN 1 ELSE 0 END) AS global_count,
        SUM(CASE WHEN repository IS NOT NULL AND repository != '' THEN 1 ELSE 0 END) AS repository_count
      FROM retrieval_trace_sample
    `).get();
    const latestActivity = this.db.prepare(`
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
      LIMIT 1
    `).get('global');

    return {
      semanticCount,
      episodeCount,
      domainCount,
      observationCount,
      semanticGlobalCount: semanticScopes?.global_count ?? 0,
      semanticTransferableCount: semanticScopes?.transferable_count ?? 0,
      semanticRepoCount: semanticScopes?.repo_count ?? 0,
      semanticManualCount: semanticScopes?.manual_count ?? 0,
      episodeGlobalCount: episodeScopes?.global_count ?? 0,
      episodeTransferableCount: episodeScopes?.transferable_count ?? 0,
      episodeRepoCount: episodeScopes?.repo_count ?? 0,
      episodeManualCount: episodeScopes?.manual_count ?? 0,
      daySummaryCount,
      schemaVersion,
      dbPath: this.config.paths.derivedStorePath,
      backupDir: this.config.paths.backupDir,
      lastBackupPath: this.lastBackupPath,
      overrideAuditCount,
      semanticCanonicalCount: semanticGrowth?.canonical_count ?? 0,
      semanticReinforcedCount: semanticGrowth?.reinforced_count ?? 0,
      assistantGoalCount: semanticGrowth?.assistant_goal_count ?? 0,
      recurringMistakeCount: semanticGrowth?.recurring_mistake_count ?? 0,
      userIdentityCount: semanticGrowth?.user_identity_count ?? 0,
      workstreamOverlayCount: semanticGrowth?.workstream_overlay_count ?? 0,
      directiveCount: semanticGrowth?.directive_count ?? 0,
      improvementActiveCount: improvementCounts?.active_count ?? 0,
      improvementResolvedCount: improvementCounts?.resolved_count ?? 0,
      improvementSupersededCount: improvementCounts?.superseded_count ?? 0,
      improvementProposalCount: improvementCounts?.proposal_count ?? 0,
      draftProposalCount: improvementCounts?.draft_proposal_count ?? 0,
      approvedProposalCount: improvementCounts?.approved_proposal_count ?? 0,
      rejectedProposalCount: improvementCounts?.rejected_proposal_count ?? 0,
      supersededProposalCount: improvementCounts?.superseded_proposal_count ?? 0,
      backfillRunningCount: backfillCounts?.running_count ?? 0,
      backfillCompletedCount: backfillCounts?.completed_count ?? 0,
      backfillFailedCount: backfillCounts?.failed_count ?? 0,
      backfillDryRunCount: backfillCounts?.dry_run_count ?? 0,
      deferredPendingCount: deferredCounts?.pending_count ?? 0,
      deferredRunningCount: deferredCounts?.running_count ?? 0,
      deferredFailedCount: deferredCounts?.failed_count ?? 0,
      deferredCompletedCount: deferredCounts?.completed_count ?? 0,
      improvementCount: improvementCounts?.total_count ?? 0,
      improvementActiveCount: improvementCounts?.active_count ?? 0,
      improvementResolvedCount: improvementCounts?.resolved_count ?? 0,
      improvementSupersededCount: improvementCounts?.superseded_count ?? 0,
      maintenanceCompletedCount: maintenanceCounts?.completed_count ?? 0,
      maintenanceNeedsAttentionCount: maintenanceCounts?.needs_attention_count ?? 0,
      maintenanceFailedCount: maintenanceCounts?.failed_count ?? 0,
      maintenanceSkippedCount: maintenanceCounts?.skipped_count ?? 0,
      maintenanceTaskStateCount: maintenanceTaskCount,
      lastMaintenanceStatus: maintenanceLatest?.status ?? null,
      lastMaintenanceStartedAt: maintenanceLatest?.started_at ?? null,
      lastMaintenanceCompletedAt: maintenanceLatest?.completed_at ?? null,
      trajectoryArtifactCount: trajectoryCounts?.total_count ?? 0,
      trajectoryReplayFailureCount: trajectoryCounts?.replay_failure_count ?? 0,
      trajectoryValidationMissCount: trajectoryCounts?.validation_miss_count ?? 0,
      trajectoryProposalFailureCount: trajectoryCounts?.proposal_failure_count ?? 0,
      trajectoryLatencyOutlierCount: trajectoryCounts?.latency_outlier_count ?? 0,
      intentJournalCount: intentJournalCounts?.total_count ?? 0,
      intentRoutingCount: intentJournalCounts?.routing_count ?? 0,
      intentRolloutCount: intentJournalCounts?.rollout_count ?? 0,
      intentReviewerCount: intentJournalCounts?.reviewer_count ?? 0,
      intentFallbackCount: intentJournalCounts?.fallback_count ?? 0,
      intentSerendipityCount: intentJournalCounts?.serendipity_count ?? 0,
      retrievalTraceSampleCount: retrievalTraceSampleCounts?.total_count ?? 0,
      retrievalTraceSampleGlobalCount: retrievalTraceSampleCounts?.global_count ?? 0,
      retrievalTraceSampleRepositoryCount: retrievalTraceSampleCounts?.repository_count ?? 0,
      lastSuccessActivity: latestActivity
        ? {
          scopeKey: latestActivity.scope_key,
          scopeType: latestActivity.scope_type,
          repository: latestActivity.repository,
          lastContextInjectionAt: latestActivity.last_context_injection_at,
          lastContextInjectionHook: latestActivity.last_context_injection_hook,
          lastContextInjectionSections: parseJsonArray(latestActivity.last_context_injection_sections_json),
          lastContextInjectionTraceId: latestActivity.last_context_injection_trace_id,
          lastContextInjectionDurationMs: latestActivity.last_context_injection_duration_ms,
          lastExtractionCompletionAt: latestActivity.last_extraction_completion_at,
          lastExtractionRepository: latestActivity.last_extraction_repository,
          lastMaintenanceCompletionAt: latestActivity.last_maintenance_completion_at,
          lastMaintenanceStatus: latestActivity.last_maintenance_status,
          lastMaintenanceRunId: latestActivity.last_maintenance_run_id,
          lastTraceRecordedAt: latestActivity.last_trace_recorded_at,
          lastTraceHook: latestActivity.last_trace_hook,
          lastTraceId: latestActivity.last_trace_id,
          updatedAt: latestActivity.updated_at,
        }
        : null,
    };
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
    if (typeof repository === "string" && repository.trim().length > 0) {
      where.push("repository = ?");
      params.push(repository.trim());
    }
    if (typeof sessionId === "string" && sessionId.trim().length > 0) {
      where.push("session_id = ?");
      params.push(sessionId.trim());
    }
    if (typeof intentKind === "string" && intentKind.trim().length > 0) {
      where.push("intent_kind = ?");
      params.push(intentKind.trim().toLowerCase());
    }
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
    const normalizedKind = String(kind || "").trim();
    const normalizedSummary = String(summary || "").trim();
    if (!normalizedKind) {
      throw new Error("kind is required");
    }
    if (!normalizedSummary) {
      throw new Error("summary is required");
    }
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
    if (typeof kind === "string" && kind.trim().length > 0) {
      where.push("kind = ?");
      params.push(kind.trim());
    }
    if (typeof sourceKind === "string" && sourceKind.trim().length > 0) {
      where.push("source_kind = ?");
      params.push(sourceKind.trim());
    }
    if (typeof sourceCaseId === "string" && sourceCaseId.trim().length > 0) {
      where.push("source_case_id = ?");
      params.push(sourceCaseId.trim());
    }
    if (typeof repository === "string" && repository.trim().length > 0) {
      where.push("repository = ?");
      params.push(repository.trim());
    }
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

    const next = {
      last_context_injection_at: normalizedUpdates.lastContextInjectionAt ?? existing?.last_context_injection_at ?? null,
      last_context_injection_hook: normalizedUpdates.lastContextInjectionHook ?? existing?.last_context_injection_hook ?? null,
      last_context_injection_sections_json: JSON.stringify(
        Array.isArray(normalizedUpdates.lastContextInjectionSections)
          ? normalizedUpdates.lastContextInjectionSections.slice(0, 8)
          : parseJsonArray(existing?.last_context_injection_sections_json),
      ),
      last_context_injection_trace_id: normalizedUpdates.lastContextInjectionTraceId ?? existing?.last_context_injection_trace_id ?? null,
      last_context_injection_duration_ms: Number.isFinite(normalizedUpdates.lastContextInjectionDurationMs)
        ? Math.round(normalizedUpdates.lastContextInjectionDurationMs)
        : (existing?.last_context_injection_duration_ms ?? null),
      last_extraction_completion_at: normalizedUpdates.lastExtractionCompletionAt ?? existing?.last_extraction_completion_at ?? null,
      last_extraction_repository: normalizeRepository(normalizedUpdates.lastExtractionRepository)
        ?? existing?.last_extraction_repository
        ?? repo,
      last_maintenance_completion_at: normalizedUpdates.lastMaintenanceCompletionAt ?? existing?.last_maintenance_completion_at ?? null,
      last_maintenance_status: normalizedUpdates.lastMaintenanceStatus ?? existing?.last_maintenance_status ?? null,
      last_maintenance_run_id: normalizedUpdates.lastMaintenanceRunId ?? existing?.last_maintenance_run_id ?? null,
      last_trace_recorded_at: normalizedUpdates.lastTraceRecordedAt ?? existing?.last_trace_recorded_at ?? null,
      last_trace_hook: normalizedUpdates.lastTraceHook ?? existing?.last_trace_hook ?? null,
      last_trace_id: normalizedUpdates.lastTraceId ?? existing?.last_trace_id ?? null,
    };

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
      next.last_context_injection_at,
      next.last_context_injection_hook,
      next.last_context_injection_sections_json,
      next.last_context_injection_trace_id,
      next.last_context_injection_duration_ms,
      next.last_extraction_completion_at,
      next.last_extraction_repository,
      next.last_maintenance_completion_at,
      next.last_maintenance_status,
      next.last_maintenance_run_id,
      next.last_trace_recorded_at,
      next.last_trace_hook,
      next.last_trace_id,
      timestamp,
    );

    return this.getActivityState({ repository: repo, includeGlobal: false });
  }

  getActivityState({ repository = null, includeGlobal = true } = {}) {
    this.ensureOpen();
    const rows = [];
    const repo = normalizeRepository(repository);
    if (repo) {
      const repoRow = this.db.prepare(`
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
      `).get(`repo:${repo}`);
      if (repoRow) {
        rows.push(repoRow);
      }
    }
    if (includeGlobal) {
      const globalRow = this.db.prepare(`
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
        WHERE scope_key = 'global'
      `).get();
      if (globalRow) {
        rows.push(globalRow);
      }
    }

    if (rows.length === 0) {
      if (repo) {
        const repoFallback = this.deriveActivityStateFallback({
          repository: repo,
          scopeKey: `repo:${repo}`,
          scopeType: "repo",
        });
        if (repoFallback) {
          rows.push(repoFallback);
        }
      }
      if (includeGlobal) {
        const globalFallback = this.deriveActivityStateFallback({
          repository: null,
          scopeKey: "global",
          scopeType: "global",
        });
        if (globalFallback) {
          rows.push(globalFallback);
        }
      }
    }

    return rows.map((row) => ({
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
    }));
  }

  deriveActivityStateFallback({
    repository = null,
    scopeKey,
    scopeType,
  } = {}) {
    this.ensureOpen();
    const repo = normalizeRepository(repository);
    const scopedWhere = repo ? "WHERE repository = ?" : "";
    const scopedParams = repo ? [repo] : [];

    const latestContextRow = this.db.prepare(`
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

    const latestTraceRow = this.db.prepare(`
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

    const latestMaintenanceRow = this.db.prepare(`
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

    const latestExtractionRow = this.db.prepare(`
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

    const timestamps = [
      latestContextRow?.recorded_at,
      latestTraceRow?.recorded_at,
      latestMaintenanceRow?.completed_at,
      latestExtractionRow?.updated_at,
    ].filter((value) => typeof value === "string" && value.length > 0);

    if (timestamps.length === 0) {
      return null;
    }

    return {
      scope_key: scopeKey,
      scope_type: scopeType,
      repository: repo,
      last_context_injection_at: latestContextRow?.recorded_at ?? null,
      last_context_injection_hook: latestContextRow?.hook ?? null,
      last_context_injection_sections_json: JSON.stringify(
        parseJsonArray(latestContextRow?.section_titles_json),
      ),
      last_context_injection_trace_id: latestContextRow?.id ?? null,
      last_context_injection_duration_ms: latestContextRow?.latency_ms ?? null,
      last_extraction_completion_at: latestExtractionRow?.updated_at ?? null,
      last_extraction_repository: normalizeRepository(latestExtractionRow?.repository) ?? repo,
      last_maintenance_completion_at: latestMaintenanceRow?.completed_at ?? null,
      last_maintenance_status: latestMaintenanceRow?.status ?? null,
      last_maintenance_run_id: latestMaintenanceRow?.id ?? null,
      last_trace_recorded_at: latestTraceRow?.recorded_at ?? null,
      last_trace_hook: latestTraceRow?.hook ?? null,
      last_trace_id: latestTraceRow?.id ?? null,
      updated_at: timestamps.sort().at(-1) ?? nowIso(),
    };
  }

  insertRetrievalTraceSample({
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
    this.ensureOpen();
    const normalizedHook = String(hook || "").trim();
    if (!normalizedHook) {
      throw new Error("hook is required");
    }
    const sampleId = id || crypto.randomUUID();
    const repo = normalizeRepository(repository);
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
      sampleId,
      repo,
      scopeType === "global" ? "global" : "repo",
      normalizedHook,
      route ? String(route) : null,
      routeReason ? String(routeReason) : null,
      contextInjected ? 1 : 0,
      Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
      String(promptPreview || ""),
      JSON.stringify(Array.isArray(sectionTitles) ? sectionTitles.slice(0, 8) : []),
      JSON.stringify(promptNeed ?? {}),
      JSON.stringify(eligibility ?? {}),
      JSON.stringify(lookups ?? {}),
      JSON.stringify(Array.isArray(omissions) ? omissions : []),
      JSON.stringify(output ?? {}),
      JSON.stringify(trace ?? {}),
      recordedAt,
    );
    return sampleId;
  }

  pruneRetrievalTraceSamples({
    repository = null,
    maxRowsPerRepository = 120,
    maxRowsGlobal = 240,
    maxAgeMs = 14 * 24 * 60 * 60 * 1000,
  } = {}) {
    this.ensureOpen();
    let removed = 0;
    const cutoffIso = new Date(Date.now() - clampInteger(maxAgeMs, 14 * 24 * 60 * 60 * 1000, {
      min: 60 * 60 * 1000,
      max: 365 * 24 * 60 * 60 * 1000,
    })).toISOString();
    const ageRemoved = this.db.prepare(`
      DELETE FROM retrieval_trace_sample
      WHERE recorded_at < ?
    `).run(cutoffIso).changes ?? 0;
    removed += ageRemoved;

    const repo = normalizeRepository(repository);
    if (repo) {
      const over = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM retrieval_trace_sample
        WHERE repository = ?
      `).get(repo)?.count ?? 0;
      const limit = clampInteger(maxRowsPerRepository, 120, { min: 10, max: 2000 });
      if (over > limit) {
        const extra = over - limit;
        removed += this.db.prepare(`
          DELETE FROM retrieval_trace_sample
          WHERE id IN (
            SELECT id
            FROM retrieval_trace_sample
            WHERE repository = ?
            ORDER BY recorded_at DESC
            LIMIT -1 OFFSET ?
          )
        `).run(repo, limit).changes ?? 0;
      }
    }

    const globalCount = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM retrieval_trace_sample
      WHERE repository IS NULL OR repository = ''
    `).get()?.count ?? 0;
    const globalLimit = clampInteger(maxRowsGlobal, 240, { min: 20, max: 5000 });
    if (globalCount > globalLimit) {
      const extra = globalCount - globalLimit;
      removed += this.db.prepare(`
        DELETE FROM retrieval_trace_sample
        WHERE id IN (
          SELECT id
          FROM retrieval_trace_sample
          WHERE repository IS NULL OR repository = ''
          ORDER BY recorded_at DESC
          LIMIT -1 OFFSET ?
        )
      `).run(globalLimit).changes ?? 0;
    }

    return { removed };
  }

  listRetrievalTraceSamples({
    repository,
    includeGlobal = true,
    limit = 10,
  } = {}) {
    this.ensureOpen();
    const where = [];
    const params = [];
    const repo = normalizeRepository(repository);
    if (repo && includeGlobal) {
      where.push("(repository = ? OR repository IS NULL OR repository = '')");
      params.push(repo);
    } else if (repo) {
      where.push("repository = ?");
      params.push(repo);
    } else if (includeGlobal) {
      // no filter
    } else {
      where.push("repository IS NOT NULL AND repository != ''");
    }
    params.push(clampInteger(limit, 10, { min: 1, max: 100 }));
    const rows = this.db.prepare(`
      SELECT
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
      FROM retrieval_trace_sample
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(...params);

    return rows.map((row) => ({
      id: row.id,
      repository: row.repository,
      scopeType: row.scope_type,
      hook: row.hook,
      route: row.route,
      routeReason: row.route_reason,
      contextInjected: row.context_injected === 1,
      latencyMs: row.latency_ms,
      promptPreview: row.prompt_preview,
      sectionTitles: parseJsonArray(row.section_titles_json),
      promptNeed: parseJsonObject(row.prompt_need_json),
      eligibility: parseJsonObject(row.eligibility_json),
      lookups: parseJsonObject(row.lookups_json),
      omissions: parseJsonArray(row.omissions_json),
      output: parseJsonObject(row.output_json),
      trace: parseJsonObject(row.trace_json),
      recordedAt: row.recorded_at,
    }));
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
    if (typeof targetType === "string" && targetType.trim().length > 0) {
      where.push("target_type = ?");
      params.push(targetType.trim());
    }
    if (typeof targetId === "string" && targetId.trim().length > 0) {
      where.push("target_id = ?");
      params.push(targetId.trim());
    }
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
    const normalizedSourceCaseId = String(sourceCaseId || "").trim();
    const normalizedTitle = String(title || "").trim();
    const normalizedSummary = String(summary || "").trim();
    if (!normalizedSourceCaseId) {
      throw new Error("sourceCaseId is required");
    }
    if (!normalizedTitle) {
      throw new Error("title is required");
    }
    if (!normalizedSummary) {
      throw new Error("summary is required");
    }
    const normalizedSourceKind = normalizeImprovementSourceKind(sourceKind);
    const timestamp = nowIso();
    const activeExisting = this.db.prepare(`
      SELECT id
      FROM improvement_backlog
      WHERE source_case_id = ?
        AND source_kind = ?
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(normalizedSourceCaseId, normalizedSourceKind);
    if (activeExisting?.id) {
      this.db.prepare(`
        UPDATE improvement_backlog
        SET title = ?,
            summary = ?,
            evidence_json = ?,
            trace_json = ?,
            linked_memory_id = COALESCE(?, linked_memory_id),
            updated_at = ?
        WHERE id = ?
      `).run(
        normalizedTitle,
        normalizedSummary,
        JSON.stringify(evidence ?? {}),
        JSON.stringify(trace ?? {}),
        linkedMemoryId ?? null,
        timestamp,
        activeExisting.id,
      );
      return activeExisting.id;
    }

    const artifactId = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO improvement_backlog (
        id, source_case_id, source_kind, title, summary, evidence_json, trace_json,
        status, linked_memory_id, superseded_by, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)
    `).run(
      artifactId,
      normalizedSourceCaseId,
      normalizedSourceKind,
      normalizedTitle,
      normalizedSummary,
      JSON.stringify(evidence ?? {}),
      JSON.stringify(trace ?? {}),
      linkedMemoryId ?? null,
      timestamp,
      timestamp,
    );
    return artifactId;
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
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("id is required");
    }
    const nextReviewState = normalizeImprovementReviewState(reviewState, IMPROVEMENT_REVIEW_STATE.DRAFT);
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE improvement_backlog
      SET proposal_type = ?,
          proposal_path = ?,
          proposal_hash = ?,
          review_state = ?,
          review_requested_at = ?,
          review_requested_by = ?,
          reviewer_decision = ?,
          reviewer_notes_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      proposalType ?? null,
      proposalPath ?? null,
      proposalHash ?? null,
      nextReviewState,
      reviewRequestedAt ?? null,
      reviewRequestedBy ?? null,
      reviewerDecision ?? null,
      JSON.stringify(reviewerNotes ?? {}),
      timestamp,
      normalizedId,
    );
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
    const where = [];
    const params = [];
    if (typeof sourceKind === "string" && sourceKind.trim().length > 0) {
      where.push("source_kind = ?");
      params.push(normalizeImprovementSourceKind(sourceKind));
    }
    if (typeof sourceCaseId === "string" && sourceCaseId.trim().length > 0) {
      where.push("source_case_id = ?");
      params.push(sourceCaseId.trim());
    }
    if (typeof status === "string" && status.trim().length > 0) {
      where.push("status = ?");
      params.push(normalizeImprovementStatus(status.trim(), IMPROVEMENT_STATUS.ACTIVE));
    }
    if (typeof reviewState === "string" && reviewState.trim().length > 0) {
      where.push("review_state = ?");
      params.push(normalizeImprovementReviewState(reviewState.trim()));
    }
    if (hasProposal === true) {
      where.push("proposal_path IS NOT NULL");
    } else if (hasProposal === false) {
      where.push("proposal_path IS NULL");
    }
    if (typeof updatedBefore === "string" && updatedBefore.trim().length > 0) {
      where.push("updated_at <= ?");
      params.push(updatedBefore.trim());
    }
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

  refreshBackfillRunSummary(runId, { lastError = null } = {}) {
    this.ensureOpen();
    const counts = this.db.prepare(`
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
    const status = (counts?.pending_count ?? 0) > 0
      ? "running"
      : (counts?.failed_count ?? 0) > 0
        ? "failed"
        : "completed";
    const completedAt = status === "running" ? null : nowIso();
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
      status,
      counts?.processed_count ?? 0,
      counts?.created_episode_count ?? 0,
      counts?.refreshed_episode_count ?? 0,
      counts?.skipped_count ?? 0,
      counts?.failed_count ?? 0,
      completedAt,
      nowIso(),
      lastError,
      runId,
    );
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

  insertSemanticMemory(memory) {
    this.ensureOpen();
    const timestamp = nowIso();
    const id = memory.id ?? crypto.randomUUID();
    const classification = classifySemanticMemory(memory);
    const repository = normalizeRepository(classification.repository);
    const scope = classification.scope;
    const domainKey = normalizeText(memory.domainKey).toLowerCase() || null;
    const tagsText = Array.isArray(memory.tags) ? memory.tags.join(" ") : "";
    const sourceText = typeof classification.metadata?.source === "string" ? classification.metadata.source : "";
    const canonicalKey = buildSemanticCanonicalKey({
      ...memory,
      metadata: classification.metadata,
      content: memory.content,
      type: memory.type,
    });
    const incomingReinforcement = Number.isInteger(memory.reinforcementCount)
      ? Math.max(1, memory.reinforcementCount)
      : 1;
    const incomingLastSeenAt = memory.lastSeenAt ?? timestamp;
    const manualScopeMatch = this.db.prepare(`
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
    if (manualScopeMatch?.id) {
      const existingMetadata = parseJsonObject(manualScopeMatch.metadata_json);
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
            last_seen_at = CASE
              WHEN ? IS NULL THEN COALESCE(last_seen_at, ?)
              WHEN last_seen_at IS NULL OR ? > last_seen_at THEN ?
              ELSE last_seen_at
            END
        WHERE id = ?
      `).run(
        typeof memory.confidence === "number" ? memory.confidence : 1.0,
        timestamp,
        memory.sourceSessionId ?? null,
        Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
        domainKey,
        mergeTagText(manualScopeMatch.tags, tagsText),
        JSON.stringify({
          ...existingMetadata,
          ...(domainKey ? { domainKey } : {}),
          ...classification.metadata,
        }),
        canonicalKey,
        incomingReinforcement,
        incomingLastSeenAt,
        incomingLastSeenAt,
        incomingLastSeenAt,
        incomingLastSeenAt,
        manualScopeMatch.id,
      );
      return manualScopeMatch.id;
    }
    const existing = this.db.prepare(`
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

    if (existing?.id) {
      let existingMetadata = {};
      try {
        existingMetadata = JSON.parse(existing.metadata_json ?? "{}");
      } catch {
        existingMetadata = {};
      }

      const manualExisting = existingMetadata.source === "memory_save";
      const manualIncoming = sourceText === "memory_save";
      const lockedScope = normalizeScopeSource(existing.scope_source) === SCOPE_SOURCE.MANUAL;
      if ((manualExisting || lockedScope) && !manualIncoming) {
        this.db.prepare(`
          UPDATE semantic_memory
          SET updated_at = ?,
              confidence = MAX(confidence, ?),
              domain_key = COALESCE(?, domain_key),
              tags = ?,
              canonical_key = COALESCE(canonical_key, ?),
              reinforcement_count = MAX(1, COALESCE(reinforcement_count, 1) + ?),
              last_seen_at = CASE
                WHEN ? IS NULL THEN COALESCE(last_seen_at, ?)
                WHEN last_seen_at IS NULL OR ? > last_seen_at THEN ?
                ELSE last_seen_at
              END
          WHERE id = ?
        `).run(
          timestamp,
          typeof memory.confidence === "number" ? memory.confidence : 1.0,
          domainKey,
          mergeTagText(existing.tags, tagsText),
          canonicalKey,
          incomingReinforcement,
          incomingLastSeenAt,
          incomingLastSeenAt,
          incomingLastSeenAt,
          incomingLastSeenAt,
          existing.id,
        );
        return existing.id;
      }

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
            last_seen_at = CASE
              WHEN ? IS NULL THEN COALESCE(last_seen_at, ?)
              WHEN last_seen_at IS NULL OR ? > last_seen_at THEN ?
              ELSE last_seen_at
            END
        WHERE id = ?
      `).run(
        typeof memory.confidence === "number" ? memory.confidence : 1.0,
        timestamp,
        memory.sourceSessionId ?? null,
        Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
        domainKey,
        mergeTagText(existing.tags, tagsText),
        JSON.stringify({
          ...existingMetadata,
          ...(domainKey ? { domainKey } : {}),
          ...classification.metadata,
        }),
        canonicalKey,
        incomingReinforcement,
        incomingLastSeenAt,
        incomingLastSeenAt,
        incomingLastSeenAt,
        incomingLastSeenAt,
        existing.id,
      );
      return existing.id;
    }

    this.db.prepare(`
      INSERT INTO semantic_memory (
        id, type, content, confidence, source_session_id, source_turn_index,
        scope, repository, domain_key, tags, created_at, updated_at, superseded_by, canonical_key,
        reinforcement_count, last_seen_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      memory.type,
      memory.content,
      typeof memory.confidence === "number" ? memory.confidence : 1.0,
      memory.sourceSessionId ?? null,
      Number.isInteger(memory.sourceTurnIndex) ? memory.sourceTurnIndex : null,
      scope,
      repository,
      domainKey,
      tagsText,
      memory.createdAt ?? timestamp,
      timestamp,
      memory.supersededBy ?? null,
      canonicalKey,
      incomingReinforcement,
      incomingLastSeenAt,
      memory.expiresAt ?? null,
      JSON.stringify({
        ...(domainKey ? { domainKey } : {}),
        ...classification.metadata,
      }),
    );

    return id;
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
    if (!includeOtherRepositories) {
      if (repo) {
        sql += ` AND (scope = ? OR repository = ?) `;
        params.push(MEMORY_SCOPE.GLOBAL, repo);
      } else {
        sql += ` AND scope = ? `;
        params.push(MEMORY_SCOPE.GLOBAL);
      }
    }
    if (scopes.length > 0) {
      sql += ` AND scope IN (${scopes.map(() => "?").join(", ")}) `;
      params.push(...scopes);
    }
    if (status) {
      sql += ` AND status = ? `;
      params.push(normalizeText(status).toLowerCase());
    }
    sql += ` ORDER BY updated_at DESC, domain_key ASC `;
    return this.db.prepare(sql).all(...params).map((row) => ({
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
    }));
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
    if (!includeOtherRepositories) {
      if (repo) {
        sql += ` AND (scope = ? OR repository = ?) `;
        params.push(MEMORY_SCOPE.GLOBAL, repo);
      } else {
        sql += ` AND scope = ? `;
        params.push(MEMORY_SCOPE.GLOBAL);
      }
    }
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
    return this.db.prepare(sql).all(...params).map((row) => ({
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
    }));
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
    const sanitized = sanitizeFtsQuery(query);
    const repo = normalizeRepository(repository);

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

    if (sanitized) {
      sql += ` JOIN semantic_fts ON semantic_fts.rowid = sm.rowid `;
    }

    sql += ` WHERE sm.superseded_by IS NULL `;

    if (!includeOtherRepositories) {
      if (repo) {
        sql += ` AND (sm.scope = ? OR sm.repository = ?) `;
        params.push(MEMORY_SCOPE.GLOBAL, repo);
      } else {
        sql += ` AND sm.scope = ? `;
        params.push(MEMORY_SCOPE.GLOBAL);
      }
    }

    if (types.length > 0) {
      sql += ` AND sm.type IN (${types.map(() => "?").join(", ")}) `;
      params.push(...types);
    }

    if (scopes.length > 0) {
      sql += ` AND sm.scope IN (${scopes.map(() => "?").join(", ")}) `;
      params.push(...scopes);
    }

    if (sanitized) {
      sql += ` AND semantic_fts MATCH ? `;
      params.push(sanitized);
      sql += ` ORDER BY bm25(semantic_fts), sm.confidence DESC, sm.updated_at DESC `;
    } else {
      sql += ` ORDER BY sm.confidence DESC, sm.updated_at DESC `;
    }

    sql += ` LIMIT ? `;
    params.push(limit);

    return dedupeSemanticRows(this.db.prepare(sql).all(...params))
      .map((row) => ({
        ...row,
        domainKey: row.domain_key ?? null,
        metadata: parseJsonObject(row.metadata_json),
      }));
  }

  searchEpisodes({ query, repository, includeOtherRepositories = false, scopes = [], limit = 5 }) {
    this.ensureOpen();
    const sanitized = sanitizeFtsQuery(query);
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

    if (!includeOtherRepositories) {
      if (repo) {
        sql += ` AND (ed.scope = ? OR ed.repository = ?) `;
        params.push(MEMORY_SCOPE.GLOBAL, repo);
      } else {
        sql += ` AND ed.scope = ? `;
        params.push(MEMORY_SCOPE.GLOBAL);
      }
    }

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
    const primaryTerms = extractDirectTerms(prompt);
    const terms = extractFtsTerms(prompt);
    const hybridEnabled = readHybridRetrievalEnabled(this.config);
    const entityTerms = hybridEnabled ? extractEntityTerms(prompt) : [];
    // Merge entity terms into both the primary and general term sets so they receive
    // both the per-term weight contribution and the primary-term boost in scoring.
    const effectivePrimaryTerms = hybridEnabled
      ? [...new Set([...primaryTerms, ...entityTerms])]
      : primaryTerms;
    const effectiveTerms = hybridEnabled
      ? [...new Set([...terms, ...entityTerms])]
      : terms;
    const lexicalQuery = (primaryTerms.length > 0 ? primaryTerms : terms).join(" ");
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
      query: lexicalQuery,
      repository,
      includeOtherRepositories,
      scopes,
      limit: Math.max(limit * 2, 8),
    });
    const rawExactPool = [
      ...rawExactMatches,
      ...improvementEpisodes,
    ];
    const exactFiltered = [];
    const exactMatches = rawExactPool.filter((episode) => {
      const reason = explainEpisodeExclusionReason(episode);
      if (!reason) {
        return true;
      }
      exactFiltered.push({
        stage: "exact_matches",
        reason,
        row: serializeEpisodeTraceRow(episode, repository),
      });
      return false;
    });

    const seen = new Set(exactMatches.map((episode) => episode.session_id));
    const rawFallbackPool = this.searchEpisodes({
      query: "",
      repository,
      includeOtherRepositories,
      scopes,
      limit: Math.max(limit * 8, 24),
    });
    const fallbackSource = [
      ...rawFallbackPool,
      ...improvementEpisodes,
    ];
    const fallbackFiltered = [];
    const fallbackPool = fallbackSource.filter((episode) => {
      const reason = explainEpisodeExclusionReason(episode);
      if (!reason) {
        return true;
      }
      fallbackFiltered.push({
        stage: "fallback_pool",
        reason,
        row: serializeEpisodeTraceRow(episode, repository),
      });
      return false;
    });

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
    const ftsMissRank = rawExactMatches.length;
    const recencyMissRank = rawFallbackPool.length;

    const ranked = candidatePool
      .filter((episode) => !seen.has(episode.session_id) || exactMatchIds.has(episode.session_id))
      .map((episode) => {
        const termScore = scoreEpisodeAgainstWeightedTerms(episode, effectiveTerms, effectivePrimaryTerms, termWeights, exactMatchIds);
        const rrfBoost = hybridEnabled
          ? computeRrfScore(episode.session_id, ftsRankMap, recencyRankMap, ftsMissRank, recencyMissRank) * RRF_SCALE
          : 0;
        return {
          episode,
          score: termScore + rrfBoost,
          termScore,
        };
      })
      .filter((entry) => entry.termScore > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if ((right.significance ?? right.episode.significance) !== (left.significance ?? left.episode.significance)) {
          return (right.episode.significance ?? 0) - (left.episode.significance ?? 0);
        }
        return String(right.episode.updated_at).localeCompare(String(left.episode.updated_at));
      });

    const ordered = ranked.map((entry) => entry.episode);
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

    if (!includeOtherRepositories) {
      if (repo) {
        sql += ` AND (ed.scope = ? OR ed.repository = ?) `;
        params.push(MEMORY_SCOPE.GLOBAL, repo);
      } else {
        sql += ` AND ed.scope = ? `;
        params.push(MEMORY_SCOPE.GLOBAL);
      }
    }

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

  explainPromptContext({
    prompt,
    repository,
    includeOtherRepositories = false,
    limit = 6,
    sessionStore = null,
    promptNeed = null,
  }) {
    this.ensureOpen();
    const promptTerms = extractFtsTerms(prompt);
    const lexicalPrompt = promptTerms.length > 0 ? promptTerms.join(" ") : prompt;
    const identityName = detectAssistantIdentityName(prompt);
    const need = promptNeed ?? {
      identityOnly: false,
      directAddressed: false,
      wantsContinuity: false,
      wantsStyleContext: false,
      wantsCrossRepoExamples: false,
      wantsRepoLocalTaskContext: true,
      allowCrossRepoFallback: includeOtherRepositories,
      hasTemporalSignal: Boolean(promptTerms.length > 0),
    };
    const allowRepoLocalTaskContext = need.wantsRepoLocalTaskContext === true
      && need.wantsCrossRepoExamples !== true;
    const allowCrossRepoFallback = need.allowCrossRepoFallback === true;
    const identityOnly = need.identityOnly === true;
    const memories = !identityOnly
      ? this.searchSemantic({
          query: prompt,
          repository,
          includeOtherRepositories: false,
          types: ["commitment", "open_loop", "rejected_approach", "blocker", "user_preference", "assistant_identity", "user_identity", "assistant_goal", "recurring_mistake"],
          limit,
        }).map((memory) => ({
          ...memory,
          currentRepository: repository,
        }))
      : [];
    const identityMemories = identityName
      ? this.searchSemantic({
          query: "",
          repository,
          includeOtherRepositories: false,
          types: ["assistant_identity"],
          scopes: [MEMORY_SCOPE.GLOBAL],
          limit: 4,
      }).map((memory) => ({
          ...memory,
          currentRepository: repository,
        }))
      : [];
    const localMemories = dedupeSemanticContextRows([
      ...identityMemories,
      ...memories,
    ]).filter((memory) => !isStyleAddressingMemory(memory));
    const assistantPersonaRows = this.searchSemantic({
      query: identityName || "assistant preferred human name",
      repository,
      includeOtherRepositories: false,
      types: ["assistant_identity"],
      scopes: [MEMORY_SCOPE.GLOBAL],
      limit: 2,
    }).map((memory) => ({
      ...memory,
      currentRepository: repository,
    }));
    const relationshipPreferenceRows = !identityOnly
      ? this.searchSemantic({
          query: "",
          repository,
          includeOtherRepositories: false,
          types: ["interaction_style", "user_identity", "user_preference", "recurring_mistake"],
          scopes: [MEMORY_SCOPE.GLOBAL],
          limit: 6,
        }).map((memory) => ({
          ...memory,
          currentRepository: repository,
        }))
          .filter((memory) => isStyleAddressingMemory(memory))
          .slice(0, 4)
      : [];
    const styleSection = buildStyleAddressingSection({
      prompt,
      promptNeed: need,
      config: this.config,
      assistantPersonaRows,
      relationshipPreferenceRows,
      renderSemantic: formatSemanticContextLine,
    });

    const temporalDate = need.hasTemporalSignal ? inferDateFromPrompt(prompt, this.config) : null;
    const temporalContentTerms = temporalDate ? extractTemporalContentTerms(prompt, this.config) : [];
    const pureTemporalRecall = temporalDate !== null && temporalContentTerms.length === 0;
    const effectiveStyleSection = pureTemporalRecall && need.wantsStyleContext !== true
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
    const includedDaySummaryRows = daySummaryRows.filter((summary) => {
      if (pureTemporalRecall || temporalContentTerms.length === 0) {
        return true;
      }
      const summaryTokens = tokenizeText(summary.summary);
      return temporalContentTerms.some((term) => summaryTokens.has(term));
    });
    const shouldSuppressEpisodesForTemporalSummaries = pureTemporalRecall && includedDaySummaryRows.length > 0;
    const episodeDetails = allowRepoLocalTaskContext
      ? shouldSuppressEpisodesForTemporalSummaries
        ? {
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
          }
        : pureTemporalRecall
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
            })
      : {
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
    const episodes = episodeDetails.episodes
      .map((episode) => ({
        ...episode,
        currentRepository: repository,
      }));
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
      ? crossRepoPreferenceRows
          .filter((memory) => isCrossRepoRow(memory, repository))
          .slice(0, crossRepoPreferenceLimit)
          .map((memory) => ({
            ...memory,
            currentRepository: repository,
          }))
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
      ? crossRepoEpisodeDetails.episodes
          .filter((episode) => isCrossRepoRow(episode, repository))
          .slice(0, Math.max(1, Math.min(2, Math.floor(limit / 2) || 1)))
          .map((episode) => ({
            ...episode,
            currentRepository: repository,
          }))
      : [];
    const crossRepoHints = allowGenericCrossRepoFallback && sessionStore
      ? sessionStore.findRelevantSessions({
          prompt: lexicalPrompt,
          repository: null,
          limit: Math.max(limit * 4, 8),
        })
          .filter((session) => isCrossRepoRow(session, repository))
          .slice(0, Math.max(1, Math.min(2, Math.floor(limit / 2) || 1)))
          .map((session) => ({
            ...session,
            currentRepository: repository,
          }))
      : [];

    const lines = [];
    const trace = {
      mode: "prompt_context",
      repository,
        includeOtherRepositories: allowCrossRepoFallback,
      promptTerms,
      identityName: identityName ?? null,
      temporalDate,
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
      },
      omissions: [],
      output: {
        sectionTitles: [],
        sectionDetails: [],
        estimatedTokens: 0,
      },
    };
    const renderTerms = temporalContentTerms.length > 0 ? temporalContentTerms : promptTerms;
    if (includedDaySummaryRows.length > 0) {
      trace.lookups.daySummary.included = true;
      lines.push("## Relevant Day Summary", "");
      includedDaySummaryRows.forEach((summary, index) => {
        if (index > 0) {
          lines.push("");
        }
        lines.push(formatDaySummaryContextLine(summary, repository));
      });
      trace.output.sectionTitles.push("Relevant Day Summary");
    } else if (!need.hasTemporalSignal || !temporalDate) {
      trace.lookups.daySummary.reason = "no_temporal_signal";
      trace.omissions.push({ stage: "day_summary", reason: "no_temporal_signal" });
    } else if (daySummaryRows.length === 0) {
      trace.lookups.daySummary.reason = "missing_day_summary";
      trace.omissions.push({ stage: "day_summary", reason: "missing_day_summary", date: temporalDate });
    } else {
      trace.lookups.daySummary.reason = "summary_did_not_match_prompt_terms";
      trace.omissions.push({ stage: "day_summary", reason: "summary_did_not_match_prompt_terms", date: temporalDate });
    }

    if (episodes.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("## Relevant Prior Work", "");
      for (const [index, episode] of episodes.entries()) {
        const line = formatEpisodeContextLine(episode, { terms: renderTerms, index });
        if (line) {
          lines.push(line);
        }
      }
      trace.output.sectionTitles.push("Relevant Prior Work");
    } else {
      trace.omissions.push({
        stage: "local_episodes",
        reason: allowRepoLocalTaskContext
          ? episodeDetails.trace?.reason ?? "no_relevant_episode_matches"
          : "identity_only_prompt",
      });
    }

    if (effectiveStyleSection.text) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(effectiveStyleSection.text);
      trace.output.sectionTitles.push(effectiveStyleSection.title);
    } else {
      trace.omissions.push({ stage: "style_addressing", reason: effectiveStyleSection.trace.reason });
    }

    if (localMemories.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("## Relevant Commitments, Preferences, And Identity", "");
      for (const memory of localMemories) {
        lines.push(formatSemanticContextLine(memory));
      }
      trace.output.sectionTitles.push("Relevant Commitments, Preferences, And Identity");
    } else {
      trace.omissions.push({ stage: "local_memories", reason: identityOnly ? "identity_only_prompt" : "no_matching_memories" });
    }

    if (crossRepoEpisodes.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("## Cross-Repo Examples", "");
      for (const [index, episode] of crossRepoEpisodes.entries()) {
        const line = formatEpisodeContextLine(episode, { terms: promptTerms, index });
        if (line) {
          lines.push(line);
        }
      }
      trace.output.sectionTitles.push("Cross-Repo Examples");
    }

    if (crossRepoEpisodes.length === 0 && crossRepoHints.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("## Cross-Repo Hints", "");
      for (const session of crossRepoHints) {
        const line = formatSessionHintLine(session);
        if (line) {
          lines.push(line);
        }
      }
      trace.lookups.crossRepoHints.includedRows = crossRepoHints.map((session) => serializeSessionTraceRow(session, repository));
      trace.output.sectionTitles.push("Cross-Repo Hints");
    } else if (!allowGenericCrossRepoFallback) {
      trace.lookups.crossRepoHints.reason = pureTemporalRecall
        ? "handled_by_temporal_day_summaries"
        : "cross_repo_lookup_disabled";
      trace.omissions.push({
        stage: "cross_repo_hints",
        reason: pureTemporalRecall ? "handled_by_temporal_day_summaries" : "cross_repo_lookup_disabled",
      });
    } else if (!sessionStore) {
      trace.lookups.crossRepoHints.reason = "session_store_unavailable";
      trace.omissions.push({ stage: "cross_repo_hints", reason: "session_store_unavailable" });
    } else if (crossRepoEpisodes.length > 0) {
      trace.lookups.crossRepoHints.reason = "suppressed_by_cross_repo_examples";
      trace.omissions.push({ stage: "cross_repo_hints", reason: "suppressed_by_cross_repo_examples" });
    } else {
      trace.lookups.crossRepoHints.reason = "no_cross_repo_hints";
      trace.omissions.push({ stage: "cross_repo_hints", reason: "no_cross_repo_hints" });
    }

    if (crossRepoPreferences.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("## Transferable Cross-Repo Preferences", "");
      for (const memory of crossRepoPreferences) {
        lines.push(formatSemanticContextLine(memory));
      }
      trace.output.sectionTitles.push("Transferable Cross-Repo Preferences");
    } else if (!allowGenericCrossRepoFallback) {
      trace.lookups.crossRepoPreferences.reason = pureTemporalRecall
        ? "handled_by_temporal_day_summaries"
        : "cross_repo_lookup_disabled";
    } else {
      trace.lookups.crossRepoPreferences.reason = "no_transferable_preferences";
    }

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
    return {
      text,
      trace,
    };
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

    if (text.includes("today")) {
      return now.toISOString().slice(0, 10);
    }
    if (text.includes("yesterday")) {
      const value = new Date(now);
      value.setDate(value.getDate() - 1);
      return value.toISOString().slice(0, 10);
    }

    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const namedDay = weekdays.find((weekday) => text.includes(weekday));
    if (!namedDay) {
      return null;
    }

    const targetIndex = weekdays.indexOf(namedDay);
    const currentIndex = now.getDay();
    const diff = (currentIndex - targetIndex + 7) % 7 || 7;
    const value = new Date(now);
    value.setDate(value.getDate() - diff);
    return value.toISOString().slice(0, 10);
  }
  return inferNormalizedDateFromPrompt(prompt);
}

const RRF_K = 60;

const RRF_SCALE = 30;

function computeRrfScore(sessionId, ftsRankMap, recencyRankMap, ftsMissRank, recencyMissRank) {
  const ftsRank = ftsRankMap.has(sessionId) ? ftsRankMap.get(sessionId) : ftsMissRank;
  const recencyRank = recencyRankMap.has(sessionId) ? recencyRankMap.get(sessionId) : recencyMissRank;
  return (1 / (RRF_K + ftsRank)) + (1 / (RRF_K + recencyRank));
}
