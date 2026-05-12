import { detectAssistantIdentityName, MEMORY_SCOPE } from "./memory-scope.mjs";
import { buildOnboardingSection } from "./onboarding.mjs";
import {
  buildStyleAddressingSection,
  isStyleAddressingMemory,
} from "./style-addressing.mjs";
import { QUERY_ALIASES } from "./query-normalizer.mjs";
import { normalizeText } from "./text-normalizer.mjs";
import { estimateTokens } from "./token-estimator.mjs";

const STOP_WORDS = new Set([
  "about", "after", "also", "been", "before", "between", "both",
  "could", "does", "each", "even", "from", "have", "into",
  "just", "know", "like", "made", "make", "many", "most",
  "much", "must", "need", "only", "other", "over", "same",
  "some", "still", "such", "take", "than", "that", "their",
  "them", "then", "there", "these", "they", "this", "through",
  "very", "want", "well", "were", "what", "when", "where",
  "which", "while", "will", "with", "would", "your", "please",
  "implement", "build", "create", "update", "write", "check",
  "conversation", "conversations",
  "continue", "keep", "prior", "consistent", "decision", "decisions",
  "session", "sessions", "history", "apply",
]);

const DIRECT_ADDRESS_EXCLUSIONS = new Set([
  "hey", "hi", "ok", "okay", "please", "researching", "planning", "implementing", "continue", "update",
]);

const TEMPORAL_SIGNALS = [
  "today",
  "yesterday",
  "last week",
  "last thursday",
  "last friday",
  "last monday",
  "last tuesday",
  "last wednesday",
  "last saturday",
  "last sunday",
];

const CONSISTENCY_SIGNALS = [
  "remember",
  "again",
  "rejected",
  "don't propose",
  "do not propose",
  "continue",
  "blocker",
  "pending",
  "what did we do",
];

const TRANSFER_SIGNALS = [
  "example",
  "examples",
  "like before",
  "similar to",
  "same way",
  "other repo",
  "other repos",
  "other project",
  "other projects",
  "cross repo",
  "cross-repo",
  "reuse",
  "pattern",
  "playbook",
  "ci migration",
  "github actions",
  "circleci",
  "workflow migration",
];

const PHATIC_QUERY_TERMS = new Set([
  "help",
  "today",
  "there",
  "morning",
  "afternoon",
  "evening",
  "thanks",
  "thank",
]);

const STYLE_SIGNAL_PATTERNS = [
  /\b(?:be|sound|feel|write|respond|talk)(?:\s+to me)?\s+(?:a bit\s+)?(?:more\s+)?(?:conversational|conversationally|friendly|friendlier|warm|warmer|warmly|casual|casually|informal|informally)\b/i,
  /\b(?:use|keep|adopt|have)\s+(?:a\s+)?(?:more\s+)?(?:conversational|friendly|friendlier|warm|warmer|casual|informal)\s+tone\b/i,
  /\b(?:more\s+)?(?:conversational|friendly|friendlier|warm|warmer|casual|informal)\s+tone\b/i,
  /\bless\s+formal\b/i,
  /\b(?:like|as)\s+(?:a\s+)?(?:colleague|coworker|co-worker|teammate|peer)\b/i,
  /\bfriendly\s+(?:colleague|coworker|co-worker|teammate|peer)\b/i,
  /\bteammate[-\s]?like\b/i,
  /\bcollaborative\b/i,
  /\bwork\s+together\b/i,
  /\bsolve\s+(?:this|it|problems?)\s+together\b/i,
  /\bpair\s+(?:with|on)\s+me\b/i,
  /\bwe\s+(?:can|should|need to)?\s*solve\s+(?:this|it|problems?)\s+together\b/i,
  /\blight\s+(?:humou?r|jokes?)\b/i,
  /\blittle\s+(?:humou?r|jokes?)\b/i,
  /\b(?:bit|touch)\s+of\s+(?:humou?r|jokes?)\b/i,
  /\b(?:feel free|okay)\s+to\s+(?:use|add)\s+(?:a\s+)?(?:little\s+)?humou?r\b/i,
  /\bplayful\b/i,
  /\bno\s+jokes?\b/i,
  /\bwithout\s+jokes?\b/i,
  /\bskip\s+the\s+jokes?\b/i,
  /\b(?:don['’]?t|do not)\s+(?:joke|be funny|add humor)\b/i,
  /\bno\s+humou?r\b/i,
  /\bkeep\s+it\s+serious\b/i,
];

const ADDRESSING_SIGNAL_PATTERNS = [
  /\bcall me\s+[a-z][a-z0-9'_-]*(?:\s+[a-z][a-z0-9'_-]*){0,3}\b/i,
  /\buse my(?:\s+first)?\s+name\b/i,
  /\baddress me as\s+[a-z][a-z0-9'_-]*(?:\s+[a-z][a-z0-9'_-]*){0,3}\b/i,
  /\brefer to me as\s+[a-z][a-z0-9'_-]*(?:\s+[a-z][a-z0-9'_-]*){0,3}\b/i,
];

const COLLEAGUE_STYLE_PATTERNS = [
  /\b(?:like|as)\s+(?:a\s+)?(?:colleague|coworker|co-worker|teammate|peer)\b/i,
  /\bfriendly\s+(?:colleague|coworker|co-worker|teammate|peer)\b/i,
  /\bteammate[-\s]?like\b/i,
];

const COLLABORATIVE_STYLE_PATTERNS = [
  /\bcollaborative\b/i,
  /\bwork\s+together\b/i,
  /\bsolve\s+(?:this|it|problems?)\s+together\b/i,
  /\bpair\s+(?:with|on)\s+me\b/i,
  /\bwe\s+(?:can|should|need to)?\s*solve\s+(?:this|it|problems?)\s+together\b/i,
];

const LIGHT_HUMOR_STYLE_PATTERNS = [
  /\blight\s+(?:humou?r|jokes?)\b/i,
  /\blittle\s+(?:humou?r|jokes?)\b/i,
  /\b(?:bit|touch)\s+of\s+(?:humou?r|jokes?)\b/i,
  /\b(?:feel free|okay)\s+to\s+(?:use|add)\s+(?:a\s+)?(?:little\s+)?humou?r\b/i,
  /\bplayful\b/i,
];

const JOKE_SUPPRESSION_PATTERNS = [
  /\bno\s+jokes?\b/i,
  /\bwithout\s+jokes?\b/i,
  /\bskip\s+the\s+jokes?\b/i,
  /\b(?:don['’]?t|do not)\s+(?:joke|be funny|add humor)\b/i,
  /\bno\s+humou?r\b/i,
  /\bkeep\s+it\s+serious\b/i,
];

const SERIOUS_PROMPT_PATTERNS = [
  /\bblocker\b/i,
  /\bincident\b/i,
  /\bsev(?:erity)?[-\s]?(?:0|1|2)\b/i,
  /\bproduction\s+(?:issue|incident|outage|bug)\b/i,
  /\boutage\b/i,
  /\bon[-\s]?call\b/i,
  /\bsecurity\s+(?:issue|incident|alert|review)\b/i,
  /\bvulnerabilit(?:y|ies)\b/i,
  /\bbreach\b/i,
  /\broot cause\b/i,
];

function parseJsonArray(value) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => normalizeText(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function isPlaceholderEpisodeSummary(summary) {
  return /^Session [0-9a-f-]{8,}$/i.test(normalizeText(summary));
}

function extractQueryTerms(prompt) {
  const directTerms = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s./_-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .filter((word) => !STOP_WORDS.has(word));

  const expandedTerms = [];
  for (const term of directTerms) {
    expandedTerms.push(term);
    for (const alias of QUERY_ALIASES[term] ?? []) {
      if (alias.length > 3 && !STOP_WORDS.has(alias)) {
        expandedTerms.push(alias);
      }
    }
  }

  return [...new Set(expandedTerms)];
}

function extractMeaningfulTaskTerms(prompt) {
  const assistantName = detectAssistantIdentityName(prompt)?.toLowerCase() ?? null;
  return extractQueryTerms(prompt).filter((term) => !PHATIC_QUERY_TERMS.has(term) && term !== assistantName);
}

function matchesPatternBucket(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function stripPromptFraming(prompt) {
  return normalizeText(prompt)
    .replace(/^([a-z][a-z0-9_-]{2,20})[,:]\s+/i, "")
    .replace(/^(?:hi|hello|hey)\s+[a-z][a-z0-9_-]{2,20}(?:[!?,.]\s*|\s+)/i, "")
    .replace(/^(?:hi|hello|hey)[!?,.\s]+/i, "");
}

function stripPatternBucket(text, patterns) {
  return patterns.reduce((value, pattern) => value.replace(pattern, " "), text);
}

function extractContextualTaskTerms(prompt) {
  const withoutFraming = stripPromptFraming(prompt);
  const withoutStyleSignals = stripPatternBucket(withoutFraming, STYLE_SIGNAL_PATTERNS);
  const withoutAddressingSignals = stripPatternBucket(withoutStyleSignals, ADDRESSING_SIGNAL_PATTERNS);
  return extractMeaningfulTaskTerms(withoutAddressingSignals);
}

function includesSignal(text, signals) {
  return signals.some((signal) => text.includes(signal));
}

function buildStyleSignalMatches(prompt) {
  return {
    colleagueLike: matchesPatternBucket(prompt, COLLEAGUE_STYLE_PATTERNS),
    collaborative: matchesPatternBucket(prompt, COLLABORATIVE_STYLE_PATTERNS),
    lightHumor: matchesPatternBucket(prompt, LIGHT_HUMOR_STYLE_PATTERNS),
    jokeSuppression: matchesPatternBucket(prompt, JOKE_SUPPRESSION_PATTERNS),
  };
}

function detectDirectAddressed(prompt) {
  const directAddressMatch = prompt.match(/^([a-z][a-z0-9_-]{2,20})[,:]\s/i);
  const greetingAddressMatch = prompt.match(/^(?:hi|hello|hey)\s+([a-z][a-z0-9_-]{2,20})(?:[!?,.]|\s|$)/i);
  return !!(
    ((directAddressMatch && !DIRECT_ADDRESS_EXCLUSIONS.has(directAddressMatch[1].toLowerCase()))
      || (greetingAddressMatch && !DIRECT_ADDRESS_EXCLUSIONS.has(greetingAddressMatch[1].toLowerCase()))
      || detectAssistantIdentityName(prompt))
  );
}

function collectPromptNeedSignals(prompt) {
  const text = prompt.toLowerCase();
  const styleSignalMatches = buildStyleSignalMatches(prompt);
  const explicitStyleRequest = Object.values(styleSignalMatches).some(Boolean);
  const wantsStyleContext = matchesPatternBucket(prompt, STYLE_SIGNAL_PATTERNS)
    || matchesPatternBucket(prompt, ADDRESSING_SIGNAL_PATTERNS)
    || explicitStyleRequest;

  return {
    styleSignalMatches,
    explicitStyleRequest,
    wantsStyleContext,
    hasConsistencySignal: includesSignal(text, CONSISTENCY_SIGNALS) || text.includes("as usual"),
    hasTransferSignal: includesSignal(text, TRANSFER_SIGNALS),
    rawTemporalSignal: includesSignal(text, TEMPORAL_SIGNALS),
    explicitLocalTemporalScope: hasExplicitLocalTemporalScope(prompt),
    seriousPrompt: matchesPatternBucket(prompt, SERIOUS_PROMPT_PATTERNS),
    directAddressed: detectDirectAddressed(prompt),
    contextualTaskTerms: extractContextualTaskTerms(prompt),
  };
}

function derivePromptNeedTemporalFlags({
  rawTemporalSignal,
  directAddressed,
  hasConsistencySignal,
  hasTransferSignal,
  contextualTaskTerms,
  wantsStyleContext,
}) {
  const hasTemporalSignal = rawTemporalSignal
    && (
      !directAddressed
      || hasConsistencySignal
      || hasTransferSignal
      || contextualTaskTerms.length > 0
    );
  const identityOnly = directAddressed
    && !hasTemporalSignal
    && !hasConsistencySignal
    && !hasTransferSignal
    && !wantsStyleContext
    && contextualTaskTerms.length === 0;
  return {
    hasTemporalSignal,
    identityOnly,
  };
}

function derivePromptNeedLookupFlags({
  identityOnly,
  hasTemporalSignal,
  hasConsistencySignal,
  wantsCrossRepoExamples,
  contextualTaskTerms,
  explicitLocalTemporalScope,
}) {
  return {
    wantsRepoLocalTaskContext: !identityOnly
      && (hasTemporalSignal || hasConsistencySignal || contextualTaskTerms.length > 0),
    allowCrossRepoFallback: wantsCrossRepoExamples
      || (hasTemporalSignal && !explicitLocalTemporalScope),
  };
}

function derivePromptNeedState(signals) {
  const {
    styleSignalMatches,
    explicitStyleRequest,
    wantsStyleContext,
    hasConsistencySignal,
    hasTransferSignal,
    rawTemporalSignal,
    explicitLocalTemporalScope,
    seriousPrompt,
    directAddressed,
    contextualTaskTerms,
  } = signals;

  const { hasTemporalSignal, identityOnly } = derivePromptNeedTemporalFlags({
    rawTemporalSignal,
    directAddressed,
    hasConsistencySignal,
    hasTransferSignal,
    contextualTaskTerms,
    wantsStyleContext,
  });
  const wantsContinuity = hasConsistencySignal;
  const wantsCrossRepoExamples = hasTransferSignal;
  const { wantsRepoLocalTaskContext, allowCrossRepoFallback } = derivePromptNeedLookupFlags({
    identityOnly,
    hasTemporalSignal,
    hasConsistencySignal,
    wantsCrossRepoExamples,
    contextualTaskTerms,
    explicitLocalTemporalScope,
  });

  return {
    wantsContinuity,
    wantsStyleContext,
    wantsCrossRepoExamples,
    wantsRepoLocalTaskContext,
    allowCrossRepoFallback,
    identityOnly,
    hasTemporalSignal,
    directAddressed,
    explicitStyleRequest,
    seriousPrompt,
    suppressHumor: styleSignalMatches.jokeSuppression
      || (!styleSignalMatches.lightHumor && seriousPrompt),
    styleSignalMatches,
  };
}

function hasExplicitLocalTemporalScope(prompt) {
  const text = normalizeText(prompt).toLowerCase();
  return /\b(?:in|for|within)\s+this\s+(?:repo|repository|workspace|project|config|configuration)\b/.test(text)
    || /\bwith\s+this\s+(?:repo|repository|workspace|project|config|configuration)\b/.test(text)
    || /\bhere\s+in\s+this\s+(?:repo|repository|workspace|project|config|configuration)\b/.test(text)
    || /\bthis\s+(?:repo|repository|workspace|project|config|configuration)\s+only\b/.test(text)
    || /\bcurrent\s+(?:repo|repository|workspace|project|config|configuration)\s+only\b/.test(text)
    || /\brepo[-\s]local\b/.test(text);
}

function takeWithinBudget(items, budget, render) {
  const selected = [];
  let tokens = 0;
  for (const item of items) {
    const text = render(item, selected.length);
    if (!text) {
      continue;
    }
    const cost = estimateTokens(text);
    if (tokens + cost > budget) {
      break;
    }
    selected.push(text);
    tokens += cost;
  }
  return selected;
}

function renderSemantic(memory, index) {
  const fromOtherRepository = memory.currentRepository
    && memory.repository
    && memory.repository !== memory.currentRepository;
  const scopeLabel = memory.scope === MEMORY_SCOPE.GLOBAL
    ? "global"
    : memory.scope === MEMORY_SCOPE.TRANSFERABLE
      ? "transferable"
      : null;
  const labelParts = [memory.type];
  if (scopeLabel) {
    labelParts.push(scopeLabel);
  }
  if (fromOtherRepository) {
    labelParts.push(`from ${memory.repository}`);
  }
  const label = labelParts.join(", ");
  if (index < 3) {
    return `- [${label}] ${memory.content}`;
  }
  if (fromOtherRepository) {
    return `- ${memory.content} (${memory.repository})`;
  }
  return `- ${memory.content}`;
}

function parseEpisodeDetailGroups(episode) {
  return {
    decisions: parseJsonArray(episode.decisions_json),
    openItems: parseJsonArray(episode.open_items_json),
    actions: parseJsonArray(episode.actions_json),
    themes: parseJsonArray(episode.themes_json),
  };
}

function buildLeadingEpisodeDetails({ decisions, openItems, actions, themes }) {
  const details = [];
  if (decisions.length > 0) {
    details.push(`decision: ${decisions[0]}`);
  }
  if (openItems.length > 0) {
    details.push(`open: ${openItems[0]}`);
  }
  if (details.length === 0 && actions.length > 0) {
    details.push(`actions: ${actions.slice(0, 2).join(", ")}`);
  }
  if (themes.length > 0) {
    details.push(`themes: ${themes.slice(0, 3).join(", ")}`);
  }
  return details;
}

function buildEpisodeDetails(detailGroups, index) {
  if (index < 2) {
    return buildLeadingEpisodeDetails(detailGroups);
  }
  return detailGroups.themes.length > 0
    ? [`themes: ${detailGroups.themes.slice(0, 2).join(", ")}`]
    : [];
}

function buildEpisodeRepositoryLabel(episode) {
  return episode.currentRepository
    && episode.repository
    && episode.repository !== episode.currentRepository
    ? ` [example from ${episode.repository}]`
    : "";
}

export function renderEpisode(episode, index) {
  const summary = normalizeText(episode.summary);
  if (!summary || isPlaceholderEpisodeSummary(summary)) {
    return "";
  }
  const prefix = episode.date_key ? `${episode.date_key}: ` : "";
  const details = buildEpisodeDetails(parseEpisodeDetailGroups(episode), index);
  const repositoryLabel = buildEpisodeRepositoryLabel(episode);
  if (details.length === 0) {
    return `- ${prefix}${summary}${repositoryLabel}`;
  }
  return `- ${prefix}${summary}${repositoryLabel} — ${details.slice(0, 2).join(" | ")}`;
}

function renderRawSession(session) {
  const prefix = session.updated_at ? `${session.updated_at.slice(0, 10)}: ` : "";
  const summary = normalizeText(session.summary);
  if (summary && !isPlaceholderEpisodeSummary(summary)) {
    return `- ${prefix}${summary}`;
  }

  const repository = normalizeText(session.repository);
  if (!repository) {
    return "";
  }
  const branch = normalizeText(session.branch);
  return `- ${prefix}Worked in ${repository}${branch ? ` on ${branch}` : ""}`;
}

function renderSearchHit(hit, index) {
  const text = normalizeText(hit.content);
  if (!text) {
    return "";
  }
  const label = index === 0 ? `[${hit.source_type}] ` : "";
  const trimmed = text.length > 180 ? `${text.slice(0, 179).trimEnd()}…` : text;
  const repositoryLabel = hit.currentRepository
    && hit.repository
    && hit.repository !== hit.currentRepository
    ? ` [example from ${hit.repository}]`
    : "";
  return `- ${label}${trimmed}${repositoryLabel}`;
}

function renderSessionHint(hit, index) {
  const text = normalizeText(hit.excerpt);
  if (!text) {
    return "";
  }
  const prefix = hit.updated_at ? `${String(hit.updated_at).slice(0, 10)}: ` : "";
  const label = index === 0 ? `[${hit.source_type}] ` : "";
  const repositoryLabel = hit.currentRepository
    && hit.repository
    && hit.repository !== hit.currentRepository
    ? ` [example from ${hit.repository}]`
    : "";
  return `- ${prefix}${label}${text}${repositoryLabel}`;
}

function describeSemanticRow(memory, currentRepository = null) {
  return {
    id: memory.id ?? null,
    type: memory.type ?? null,
    scope: memory.scope ?? null,
    repository: memory.repository ?? null,
    updatedAt: memory.updated_at ?? null,
    crossRepo: !!(
      currentRepository
      && memory.repository
      && memory.repository !== currentRepository
    ),
    content: normalizeText(memory.content),
  };
}

function describeEpisodeRow(episode, currentRepository = null) {
  return {
    id: episode.id ?? null,
    sessionId: episode.session_id ?? null,
    scope: episode.scope ?? null,
    repository: episode.repository ?? null,
    updatedAt: episode.updated_at ?? null,
    dateKey: episode.date_key ?? null,
    significance: episode.significance ?? 0,
    crossRepo: !!(
      currentRepository
      && episode.repository
      && episode.repository !== currentRepository
    ),
    summary: normalizeText(episode.summary),
  };
}

function describeSearchHit(hit, currentRepository = null) {
  return {
    sourceType: hit.source_type ?? null,
    repository: hit.repository ?? null,
    updatedAt: hit.updated_at ?? null,
    crossRepo: !!(
      currentRepository
      && hit.repository
      && hit.repository !== currentRepository
    ),
    content: normalizeText(hit.content),
  };
}

function describeSessionHint(hit, currentRepository = null) {
  return {
    sessionId: hit.session_id ?? null,
    sourceType: hit.source_type ?? null,
    repository: hit.repository ?? null,
    updatedAt: hit.updated_at ?? null,
    crossRepo: !!(
      currentRepository
      && hit.repository
      && hit.repository !== currentRepository
    ),
    excerpt: normalizeText(hit.excerpt),
  };
}

function describeRawSession(session, currentRepository = null) {
  return {
    repository: session.repository ?? null,
    branch: session.branch ?? null,
    updatedAt: session.updated_at ?? null,
    crossRepo: !!(
      currentRepository
      && session.repository
      && session.repository !== currentRepository
    ),
    summary: normalizeText(session.summary),
  };
}

function describeImprovementArtifactRow(artifact) {
  return {
    id: artifact.id ?? null,
    sourceCaseId: artifact.source_case_id ?? null,
    sourceKind: artifact.source_kind ?? null,
    proposalPath: artifact.proposal_path ?? null,
    reviewState: artifact.review_state ?? null,
    updatedAt: artifact.updated_at ?? null,
    title: normalizeText(artifact.title),
    summary: normalizeText(artifact.summary),
  };
}

function buildSection(title, entries) {
  if (entries.length === 0) {
    return "";
  }
  return `## ${title}\n\n${entries.join("\n")}`;
}

function recordOutputSection(trace, {
  title,
  text,
  source,
  budget = null,
  entryCount = null,
}) {
  if (!trace) {
    return;
  }
  trace.output.sectionTitles.push(title);
  trace.output.sectionDetails.push({
    title,
    source,
    budget,
    usedTokens: estimateTokens(text),
    entryCount,
  });
}

function dedupeSemanticEntries(entries) {
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    const key = `${entry.type}::${normalizeText(entry.content).toLowerCase()}::${entry.scope ?? ""}::${entry.repository ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function detectPromptContextNeed(prompt) {
  const trimmedPrompt = String(prompt || "").trim();
  const derived = derivePromptNeedState(collectPromptNeedSignals(trimmedPrompt));

  return {
    requiresLookup: derived.hasTemporalSignal
      || derived.directAddressed
      || derived.wantsContinuity
      || derived.wantsStyleContext
      || derived.wantsCrossRepoExamples,
    ...derived,
  };
}

function isCrossRepoRow(row, repository) {
  return !!(
    row
    && row.repository
    && repository
    && row.repository !== repository
  );
}

function findCrossRepoSemanticFallback({ db, query, repository, limit }) {
  return db.searchSemantic({
    query,
    repository,
    includeOtherRepositories: true,
    types: ["user_preference", "rejected_approach"],
    scopes: [MEMORY_SCOPE.TRANSFERABLE],
    limit: Math.max(limit * 4, 8),
  })
    .filter((memory) => isCrossRepoRow(memory, repository))
    .slice(0, limit)
    .map((memory) => ({
      ...memory,
      currentRepository: repository,
    }));
}

function findCrossRepoEpisodeFallback({ db, prompt, repository, limit }) {
  return db.findRelevantEpisodes({
    prompt,
    repository,
    includeOtherRepositories: true,
    scopes: [MEMORY_SCOPE.TRANSFERABLE],
    limit: Math.max(limit * 4, 8),
  })
    .filter((episode) => isCrossRepoRow(episode, repository))
    .slice(0, limit)
    .map((episode) => ({
      ...episode,
      currentRepository: repository,
    }));
}

function findCrossRepoSessionHints({ sessionStore, prompt, repository, limit }) {
  if (!sessionStore) {
    return [];
  }
  return sessionStore.findRelevantSessions({
    prompt,
    repository: null,
    limit: Math.max(limit * 4, 8),
  })
    .filter((session) => isCrossRepoRow(session, repository))
    .slice(0, limit)
    .map((session) => ({
      ...session,
      currentRepository: repository,
    }));
}

function findStyleAddressingMemories({ db, repository, limit }) {
  return db.searchSemantic({
    query: "",
    repository,
    includeOtherRepositories: false,
    types: ["interaction_style", "user_identity", "user_preference", "recurring_mistake"],
    scopes: [MEMORY_SCOPE.GLOBAL],
    limit: Math.max(limit * 2, 6),
  })
    .filter((memory) => isStyleAddressingMemory(memory))
    .slice(0, limit)
    .map((memory) => ({
      ...memory,
      currentRepository: repository,
    }));
}

function shouldIncludeStyleAddressingContext(promptNeed) {
  if (promptNeed?.identityOnly === true || promptNeed?.wantsStyleContext === true) {
    return true;
  }
  return promptNeed?.hasTemporalSignal !== true && promptNeed?.seriousPrompt !== true;
}

function renderProposalArtifact(artifact, index) {
  const datePrefix = artifact.updated_at ? `${String(artifact.updated_at).slice(0, 10)}: ` : "";
  const pathSuffix = artifact.proposal_path ? ` (\`${artifact.proposal_path}\`)` : "";
  if (index < 2 && artifact.summary) {
    return `- ${datePrefix}${artifact.title} — ${normalizeText(artifact.summary)}${pathSuffix}`;
  }
  return `- ${datePrefix}${artifact.title}${pathSuffix}`;
}

function findRecentDraftProposalArtifacts({ db, limit = 2 }) {
  return db.listImprovementArtifacts({
    status: "active",
    reviewState: "draft",
    hasProposal: true,
    limit: Math.max(limit + 1, 3),
  });
}

function searchCapsuleSemanticRows({
  db,
  query = "",
  repository,
  types,
  scopes,
  limit,
}) {
  return withCurrentRepository(
    db.searchSemantic({
      query,
      repository,
      includeOtherRepositories: false,
      ...(Array.isArray(types) && types.length > 0 ? { types } : {}),
      ...(Array.isArray(scopes) && scopes.length > 0 ? { scopes } : {}),
      limit,
    }),
    repository,
  );
}

function appendProceduralProfileSection({
  state,
  proceduralProfile,
  config,
}) {
  if (proceduralProfile) {
    const tokens = estimateTokens(proceduralProfile);
    if (tokens <= config.budgets.procedural) {
      appendCapsuleSection(state, {
        title: "Procedural Profile",
        text: proceduralProfile,
        source: "procedural_profile",
        budget: config.budgets.procedural,
      });
      return;
    }
    if (state.trace) {
      state.trace.omissions.push({ stage: "procedural_profile", reason: "exceeded_budget" });
    }
    return;
  }
  if (state.trace) {
    state.trace.omissions.push({ stage: "procedural_profile", reason: "not_available" });
  }
}

function fetchSemanticKnowledgeRows({ db, query, repository, identityName, identityOnly, config }) {
  const semanticEntries = identityOnly
    ? []
    : searchCapsuleSemanticRows({
        db,
        query,
        repository,
        limit: config.limits.semanticSearchLimit,
      });
  const identityEntries = identityName
    ? searchCapsuleSemanticRows({
        db,
        repository,
        types: ["assistant_identity"],
        scopes: [MEMORY_SCOPE.GLOBAL],
        limit: 4,
      })
    : [];
  return { semanticEntries, identityEntries };
}

function fetchStyleContextRows({ db, query, repository, identityName, includeStyleAddressingContext, identityOnly }) {
  const assistantPersonaRows = includeStyleAddressingContext
    ? searchCapsuleSemanticRows({
        db,
        query: identityName || "assistant preferred human name",
        repository,
        types: ["assistant_identity"],
        scopes: [MEMORY_SCOPE.GLOBAL],
        limit: 2,
      })
    : [];
  const relationshipPreferenceRows = includeStyleAddressingContext && !identityOnly
    ? findStyleAddressingMemories({ db, repository, limit: 4 })
    : [];
  return { assistantPersonaRows, relationshipPreferenceRows };
}

function buildCommitmentContext({ db, query, repository, identityEntries, identityOnly, config }) {
  const commitmentEntries = identityOnly
    ? []
    : searchCapsuleSemanticRows({
        db,
        query,
        repository,
        types: [
          "commitment",
          "open_loop",
          "rejected_approach",
          "blocker",
          "user_preference",
          "assistant_identity",
          "user_identity",
          "assistant_goal",
          "recurring_mistake",
        ],
        limit: config.limits.promptContextLimit,
      });
  const allCommitments = dedupeSemanticEntries([
    ...identityEntries,
    ...commitmentEntries,
  ]).filter((memory) => !isStyleAddressingMemory(memory));
  const commitmentLines = takeWithinBudget(
    allCommitments,
    config.budgets.commitments,
    renderSemantic,
  );
  return { commitmentEntries, allCommitments, commitmentLines };
}

function buildCapsuleKnowledgeContext({
  prompt,
  query,
  identityName,
  promptNeed,
  repository,
  db,
  config,
}) {
  const identityOnly = promptNeed.identityOnly === true;
  const includeStyleAddressingContext = shouldIncludeStyleAddressingContext(promptNeed);
  const { semanticEntries, identityEntries } = fetchSemanticKnowledgeRows({
    db,
    query,
    repository,
    identityName,
    identityOnly,
    config,
  });
  const { assistantPersonaRows, relationshipPreferenceRows } = fetchStyleContextRows({
    db,
    query,
    repository,
    identityName,
    includeStyleAddressingContext,
    identityOnly,
  });
  const styleSection = buildStyleAddressingSection({
    prompt,
    promptNeed,
    config,
    assistantPersonaRows,
    relationshipPreferenceRows,
    renderSemantic,
  });
  const onboardingSection = buildOnboardingSection({
    db,
    promptNeed,
  });
  const knowledgeEntries = identityOnly
    ? []
    : dedupeSemanticEntries([...identityEntries, ...semanticEntries]);
  const semanticLines = takeWithinBudget(
    knowledgeEntries,
    config.budgets.semantic,
    renderSemantic,
  );
  const { commitmentEntries, allCommitments, commitmentLines } = buildCommitmentContext({
    db,
    query,
    repository,
    identityEntries,
    identityOnly,
    config,
  });

  return {
    semanticEntries,
    assistantPersonaRows,
    relationshipPreferenceRows,
    styleSection,
    onboardingSection,
    knowledgeEntries,
    semanticLines,
    commitmentEntries,
    allCommitments,
    commitmentLines,
  };
}

function recordCapsuleKnowledgeLookups({
  state,
  repository,
  query,
  semanticEntries,
  knowledgeEntries,
  semanticLines,
  styleSection,
  assistantPersonaRows,
  relationshipPreferenceRows,
  onboardingSection,
  commitmentEntries,
  allCommitments,
  commitmentLines,
}) {
  if (!state.trace) {
    return;
  }

  state.trace.lookups.relevantKnowledge = {
    query,
    rows: semanticEntries.map((memory) => describeSemanticRow(memory, repository)),
    includedRows: knowledgeEntries.map((memory) => describeSemanticRow(memory, repository)),
    reason: semanticLines.length > 0 ? null : "no_matching_semantic_rows",
  };
  state.trace.lookups.styleAddressing = {
    enabled: styleSection.trace.enabled,
    ambientEnabled: styleSection.trace.ambientEnabled,
    includeAmbient: styleSection.trace.includeAmbient,
    promptLocal: styleSection.trace.promptLocal,
    reason: styleSection.trace.reason,
    rows: [
      ...assistantPersonaRows.map((memory) => describeSemanticRow(memory, repository)),
      ...relationshipPreferenceRows.map((memory) => describeSemanticRow(memory, repository)),
    ],
    includedRows: styleSection.trace.includeAmbient
      ? [
          ...assistantPersonaRows.map((memory) => describeSemanticRow(memory, repository)),
          ...relationshipPreferenceRows.map((memory) => describeSemanticRow(memory, repository)),
        ]
      : [],
  };
  state.trace.lookups.onboarding = onboardingSection.trace;
  state.trace.lookups.commitments = {
    query,
    rows: commitmentEntries.map((memory) => describeSemanticRow(memory, repository)),
    includedRows: allCommitments.map((memory) => describeSemanticRow(memory, repository)),
    reason: commitmentLines.length > 0 ? null : "no_matching_commitments",
  };
}

function appendProposalAwarenessSection({
  db,
  includeProposalAwareness,
  state,
}) {
  appendProposalAwarenessSection({
    db,
    includeProposalAwareness,
    state,
  });
}

function buildIdentityOnlyEpisodeTrace({ prompt, repository }) {
  return {
    prompt,
    repository,
    includeOtherRepositories: false,
    eligibleScopes: repository ? [MEMORY_SCOPE.GLOBAL, `${MEMORY_SCOPE.REPO}:${repository}`] : [MEMORY_SCOPE.GLOBAL],
    primaryTerms: [],
    terms: [],
    lexicalQuery: "",
    rankedRows: [],
    includedRows: [],
    filtered: [],
    reason: "identity_only_prompt",
  };
}

function createCapsuleState({
  repository,
  query,
  identityName,
  promptNeed,
  includeTrace,
}) {
  return {
    sections: [],
    totalTokens: 0,
    trace: includeTrace
      ? {
          mode: "session_start_capsule",
          repository,
          query,
          identityName: identityName ?? null,
          promptNeed,
          eligibility: {
            local: repository ? [MEMORY_SCOPE.GLOBAL, `${MEMORY_SCOPE.REPO}:${repository}`] : [MEMORY_SCOPE.GLOBAL],
            crossRepo: [MEMORY_SCOPE.TRANSFERABLE],
          },
          lookups: {},
          omissions: [],
          output: {
            sectionTitles: [],
            sectionDetails: [],
            estimatedTokens: 0,
          },
        }
      : null,
  };
}

function appendCapsuleSection(state, {
  title,
  text,
  source,
  budget = null,
  entryCount = null,
}) {
  state.sections.push(text);
  state.totalTokens += estimateTokens(text);
  recordOutputSection(state.trace, {
    title,
    text,
    source,
    budget,
    entryCount,
  });
}

function appendBudgetedCapsuleSection(state, {
  title,
  entries,
  source,
  budget = null,
}) {
  if (entries.length === 0) {
    return false;
  }
  appendCapsuleSection(state, {
    title,
    text: buildSection(title, entries),
    source,
    budget,
    entryCount: entries.length,
  });
  return true;
}

function recordCapsuleLookup(state, key, lookup) {
  if (state.trace) {
    state.trace.lookups[key] = lookup;
  }
}

function buildEmptyCapsuleLookup(enabled, reason) {
  return {
    enabled,
    rows: [],
    includedRows: [],
    reason,
  };
}

function withCurrentRepository(rows, repository) {
  return rows.map((row) => ({
    ...row,
    currentRepository: repository,
  }));
}

function resolveLocalEpisodeLines({
  db,
  prompt,
  repository,
  allowRepoLocalTaskContext,
  config,
  state,
}) {
  const localEpisodeDetails = allowRepoLocalTaskContext
    ? db.findRelevantEpisodesDetailed({
        prompt,
        repository,
        includeOtherRepositories: false,
        limit: config.limits.episodeSearchLimit,
      })
    : {
        episodes: [],
        trace: buildIdentityOnlyEpisodeTrace({ prompt, repository }),
      };
  const episodeEntries = withCurrentRepository(localEpisodeDetails.episodes, repository);
  recordCapsuleLookup(state, "localEpisodes", localEpisodeDetails.trace);
  return {
    episodeLines: takeWithinBudget(
      episodeEntries.filter((episode) => !isPlaceholderEpisodeSummary(episode.summary)),
      config.budgets.episodes,
      renderEpisode,
    ),
    relatedTitle: "Recent Related Work",
  };
}

function resolveHistoryHintLines({
  allowRepoLocalTaskContext,
  sessionStore,
  query,
  repository,
  config,
  state,
  episodeLines,
  relatedTitle,
}) {
  if (!allowRepoLocalTaskContext || !sessionStore || !query || episodeLines.length > 0) {
    recordCapsuleLookup(
      state,
      "historyHints",
      buildEmptyCapsuleLookup(
        !!(sessionStore && query),
        sessionStore && query ? "local_episode_results_present" : "history_lookup_disabled",
      ),
    );
    return { episodeLines, relatedTitle };
  }

  const historyHits = withCurrentRepository(
    sessionStore.searchIndex({
      query,
      repository,
      limit: config.limits.episodeSearchLimit,
    }),
    repository,
  );
  const nextEpisodeLines = takeWithinBudget(historyHits, config.budgets.episodes, renderSearchHit);
  recordCapsuleLookup(state, "historyHints", {
    enabled: true,
    rows: historyHits.map((hit) => describeSearchHit(hit, repository)),
    includedRows: nextEpisodeLines.length > 0
      ? historyHits.slice(0, nextEpisodeLines.length).map((hit) => describeSearchHit(hit, repository))
      : [],
    reason: nextEpisodeLines.length > 0 ? null : "no_history_hits",
  });
  return {
    episodeLines: nextEpisodeLines,
    relatedTitle: nextEpisodeLines.length > 0 ? "Relevant History Hints" : relatedTitle,
  };
}

function appendLongRangeRelatedHints({
  allowRepoLocalTaskContext,
  sessionStore,
  query,
  prompt,
  repository,
  config,
  state,
  episodeLines,
}) {
  if (!allowRepoLocalTaskContext || !sessionStore || !query) {
    recordCapsuleLookup(state, "longRangeHints", buildEmptyCapsuleLookup(false, "history_lookup_disabled"));
    return;
  }
  if (episodeLines.length >= Math.min(3, config.limits.episodeSearchLimit)) {
    recordCapsuleLookup(state, "longRangeHints", buildEmptyCapsuleLookup(true, "local_episode_results_sufficient"));
    return;
  }

  const sessionHints = withCurrentRepository(
    sessionStore.findRelevantSessions({
      prompt,
      repository,
      limit: Math.max(2, config.limits.recentSessionsFallbackLimit),
    }),
    repository,
  );
  const budget = Math.max(80, Math.floor(config.budgets.episodes / 2));
  const hintLines = takeWithinBudget(sessionHints, budget, renderSessionHint);
  recordCapsuleLookup(state, "longRangeHints", {
    enabled: true,
    rows: sessionHints.map((hit) => describeSessionHint(hit, repository)),
    includedRows: hintLines.length > 0
      ? sessionHints.slice(0, hintLines.length).map((hit) => describeSessionHint(hit, repository))
      : [],
    reason: hintLines.length > 0 ? null : "no_long_range_hints",
  });
  appendBudgetedCapsuleSection(state, {
    title: "Long-Range Related Hints",
    entries: hintLines,
    source: "long_range_hints",
    budget,
  });
}

function resolveRawSessionLines({
  allowRepoLocalTaskContext,
  sessionStore,
  repository,
  config,
  state,
  episodeLines,
  relatedTitle,
}) {
  if (!allowRepoLocalTaskContext || episodeLines.length > 0 || !sessionStore) {
    recordCapsuleLookup(
      state,
      "rawSessions",
      buildEmptyCapsuleLookup(
        !!sessionStore,
        !allowRepoLocalTaskContext
          ? "identity_only_prompt"
          : sessionStore
            ? "higher_priority_results_present"
            : "session_store_unavailable",
      ),
    );
    return { episodeLines, relatedTitle };
  }

  const rawSessions = withCurrentRepository(
    sessionStore.getRecentSessions({
      repository,
      limit: config.limits.recentSessionsFallbackLimit,
    }),
    repository,
  );
  const nextEpisodeLines = takeWithinBudget(rawSessions, config.budgets.episodes, renderRawSession);
  recordCapsuleLookup(state, "rawSessions", {
    enabled: true,
    rows: rawSessions.map((sessionItem) => describeRawSession(sessionItem, repository)),
    includedRows: nextEpisodeLines.length > 0
      ? rawSessions.slice(0, nextEpisodeLines.length).map((sessionItem) => describeRawSession(sessionItem, repository))
      : [],
    reason: nextEpisodeLines.length > 0 ? null : "no_recent_sessions",
  });
  return {
    episodeLines: nextEpisodeLines,
    relatedTitle: nextEpisodeLines.length > 0 ? "Recent Workspace Activity" : relatedTitle,
  };
}

function resolveLocalRelatedWork({
  db,
  sessionStore,
  prompt,
  query,
  repository,
  allowRepoLocalTaskContext,
  config,
  state,
}) {
  let { episodeLines, relatedTitle } = resolveLocalEpisodeLines({
    db,
    prompt,
    repository,
    allowRepoLocalTaskContext,
    config,
    state,
  });

  ({ episodeLines, relatedTitle } = resolveHistoryHintLines({
    allowRepoLocalTaskContext,
    sessionStore,
    query,
    repository,
    config,
    state,
    episodeLines,
    relatedTitle,
  }));

  appendLongRangeRelatedHints({
    allowRepoLocalTaskContext,
    sessionStore,
    query,
    prompt,
    repository,
    config,
    state,
    episodeLines,
  });

  ({ episodeLines, relatedTitle } = resolveRawSessionLines({
    allowRepoLocalTaskContext,
    sessionStore,
    repository,
    config,
    state,
    episodeLines,
    relatedTitle,
  }));

  if (appendBudgetedCapsuleSection(state, {
    title: relatedTitle,
    entries: episodeLines,
    source: relatedTitle === "Relevant History Hints"
      ? "history_hints"
      : relatedTitle === "Recent Workspace Activity"
        ? "recent_workspace_activity"
        : "related_work",
    budget: config.budgets.episodes,
  })) {
    return;
  }
  if (state.trace) {
    state.trace.omissions.push({
      stage: "related_work",
      reason: allowRepoLocalTaskContext ? "no_related_work" : "identity_only_prompt",
    });
  }
}

function appendCrossRepoCapsuleSections({
  db,
  sessionStore,
  prompt,
  query,
  repository,
  allowCrossRepoFallback,
  config,
  state,
}) {
  appendCrossRepoPreferenceSection({
    db,
    query,
    repository,
    allowCrossRepoFallback,
    config,
    state,
  });
  if (!allowCrossRepoFallback) {
    recordCrossRepoFallbackDisabled(state);
    return;
  }
  const episodeBudget = Math.max(80, Math.floor(config.budgets.episodes / 2));
  const episodeLimit = config.limits.crossRepoEpisodeLimit ?? 2;
  if (appendCrossRepoExampleSection({
    db,
    prompt,
    repository,
    episodeLimit,
    episodeBudget,
    config,
    state,
  })) {
    return;
  }
  appendCrossRepoHintSection({
    sessionStore,
    prompt,
    query,
    repository,
    episodeLimit,
    episodeBudget,
    state,
  });
}

function appendCrossRepoPreferenceSection({
  db,
  query,
  repository,
  allowCrossRepoFallback,
  config,
  state,
}) {
  if (!query || !allowCrossRepoFallback) {
    if (state.trace) {
      state.trace.lookups.crossRepoPreferences = {
        enabled: false,
        scopes: [MEMORY_SCOPE.TRANSFERABLE],
        rows: [],
        includedRows: [],
        reason: allowCrossRepoFallback ? "no_transferable_preferences" : "cross_repo_signal_not_present",
      };
    }
    return;
  }

  const budget = Math.max(80, Math.floor(config.budgets.commitments / 2));
  const limit = config.limits.crossRepoPreferenceLimit ?? 2;
  const preferences = findCrossRepoSemanticFallback({
    db,
    query,
    repository,
    limit,
  });
  const preferenceLines = takeWithinBudget(preferences, budget, renderSemantic);
  if (state.trace) {
    state.trace.lookups.crossRepoPreferences = {
      enabled: true,
      scopes: [MEMORY_SCOPE.TRANSFERABLE],
      rows: preferences.map((memory) => describeSemanticRow(memory, repository)),
      includedRows: preferenceLines.length > 0
        ? preferences.slice(0, preferenceLines.length).map((memory) => describeSemanticRow(memory, repository))
        : [],
      reason: preferenceLines.length > 0 ? null : "no_transferable_preferences",
    };
  }
  appendBudgetedCapsuleSection(state, {
    title: "Transferable Cross-Repo Preferences",
    entries: preferenceLines,
    source: "cross_repo_preferences",
    budget,
  });
}

function appendCrossRepoExampleSection({
  db,
  prompt,
  repository,
  episodeLimit,
  episodeBudget,
  state,
}) {
  const episodes = findCrossRepoEpisodeFallback({
    db,
    prompt,
    repository,
    limit: episodeLimit,
  });
  const lines = takeWithinBudget(episodes, episodeBudget, renderEpisode);
  if (state.trace) {
    state.trace.lookups.crossRepoExamples = {
      enabled: true,
      scopes: [MEMORY_SCOPE.TRANSFERABLE],
      rows: episodes.map((episode) => describeEpisodeRow(episode, repository)),
      includedRows: lines.length > 0
        ? episodes.slice(0, lines.length).map((episode) => describeEpisodeRow(episode, repository))
        : [],
      reason: lines.length > 0 ? null : "no_cross_repo_examples",
    };
  }
  return appendBudgetedCapsuleSection(state, {
    title: "Cross-Repo Examples",
    entries: lines,
    source: "cross_repo_examples",
    budget: episodeBudget,
  });
}

function appendCrossRepoHintSection({
  sessionStore,
  prompt,
  query,
  repository,
  episodeLimit,
  episodeBudget,
  state,
}) {
  if (!query) {
    if (state.trace) {
      state.trace.lookups.crossRepoHints = {
        enabled: false,
        rows: [],
        includedRows: [],
        reason: "query_not_available",
      };
    }
    return;
  }

  const hints = findCrossRepoSessionHints({
    sessionStore,
    prompt,
    repository,
    limit: Math.max(1, episodeLimit),
  });
  const hintLines = takeWithinBudget(hints, episodeBudget, renderSessionHint);
  if (state.trace) {
    state.trace.lookups.crossRepoHints = {
      enabled: true,
      rows: hints.map((hit) => describeSessionHint(hit, repository)),
      includedRows: hintLines.length > 0
        ? hints.slice(0, hintLines.length).map((hit) => describeSessionHint(hit, repository))
        : [],
      reason: hintLines.length > 0 ? null : "no_cross_repo_hints",
    };
  }
  appendBudgetedCapsuleSection(state, {
    title: "Cross-Repo Hints",
    entries: hintLines,
    source: "cross_repo_hints",
    budget: episodeBudget,
  });
}

function recordCrossRepoFallbackDisabled(state) {
  if (!state.trace) {
    return;
  }
  state.trace.lookups.crossRepoExamples = {
    enabled: false,
    scopes: [MEMORY_SCOPE.TRANSFERABLE],
    rows: [],
    includedRows: [],
    reason: "cross_repo_signal_not_present",
  };
  state.trace.lookups.crossRepoHints = {
    enabled: false,
    rows: [],
    includedRows: [],
    reason: "cross_repo_signal_not_present",
  };
}

function appendSemanticCapsulePhase(state, {
  semanticLines,
  styleSection,
  onboardingSection,
  commitmentLines,
  config,
}) {
  appendBudgetedCapsuleSection(state, {
    title: "Relevant Knowledge",
    entries: semanticLines,
    source: "relevant_knowledge",
    budget: config.budgets.semantic,
  });
  if (styleSection.text) {
    appendCapsuleSection(state, {
      title: styleSection.title,
      text: styleSection.text,
      source: "style_addressing",
    });
  } else if (state.trace) {
    state.trace.omissions.push({ stage: "style_addressing", reason: styleSection.trace.reason });
  }
  if (onboardingSection.text) {
    appendCapsuleSection(state, {
      title: onboardingSection.title,
      text: onboardingSection.text,
      source: "onboarding",
    });
  } else if (state.trace) {
    state.trace.omissions.push({ stage: "onboarding", reason: onboardingSection.trace.reason });
  }
  appendBudgetedCapsuleSection(state, {
    title: "Commitments, Preferences, And Identity",
    entries: commitmentLines,
    source: "commitments",
    budget: config.budgets.commitments,
  });
}

function appendProposalCapsulePhase(state, { db, includeProposalAwareness }) {
  const proposalArtifacts = includeProposalAwareness
    ? findRecentDraftProposalArtifacts({
        db,
        limit: 2,
      })
    : [];
  const proposalLines = proposalArtifacts
    .slice(0, 2)
    .map((artifact, index) => renderProposalArtifact(artifact, index));
  if (proposalArtifacts.length > proposalLines.length) {
    proposalLines.push(`- ${proposalArtifacts.length - proposalLines.length} more draft proposal(s) pending review`);
  }
  if (state.trace) {
    state.trace.lookups.pendingProposalReview = {
      enabled: includeProposalAwareness,
      rows: proposalArtifacts.map((artifact) => describeImprovementArtifactRow(artifact)),
      includedRows: proposalLines.length > 0
        ? proposalArtifacts.slice(0, Math.min(2, proposalArtifacts.length)).map((artifact) => describeImprovementArtifactRow(artifact))
        : [],
      reason: includeProposalAwareness
        ? (proposalLines.length > 0 ? null : "no_draft_proposals")
        : "session_start_proposal_awareness_disabled",
    };
  }
  appendBudgetedCapsuleSection(state, {
    title: "Pending Proposal Review",
    entries: proposalLines,
    source: "proposal_awareness",
    budget: 120,
  });
}

function finalizeCapsuleTrace(state, { identityOnly, allowCrossRepoFallback, text }) {
  if (!state.trace) {
    return;
  }
  state.trace.output.estimatedTokens = state.totalTokens;
  state.trace.routerDecision = {
    route: "session_start_capsule",
    reason: identityOnly ? "identity_only_prompt" : "session_start_context",
    includeOtherRepositories: allowCrossRepoFallback,
    usedWorkstreamOverlays: false,
    usedLegacyPath: false,
    additionalContext: text.length > 0,
    sectionCount: state.trace.output.sectionTitles.length,
  };
}

export async function assembleMemoryCapsule({
  prompt,
  repository,
  proceduralProfile,
  db,
  sessionStore,
  config,
  includeTrace = false,
  includeProposalAwareness = false,
}) {
  const query = extractQueryTerms(prompt).join(" ");
  const identityName = detectAssistantIdentityName(prompt);
  const promptNeed = detectPromptContextNeed(prompt);
  const allowRepoLocalTaskContext = promptNeed.wantsRepoLocalTaskContext === true
    && promptNeed.wantsCrossRepoExamples !== true;
  const allowCrossRepoFallback = promptNeed.allowCrossRepoFallback === true;
  const identityOnly = promptNeed.identityOnly === true;
  const state = createCapsuleState({
    repository,
    query,
    identityName,
    promptNeed,
    includeTrace,
  });

  appendProceduralProfileSection({ state, proceduralProfile, config });

  const knowledgeContext = buildCapsuleKnowledgeContext({
    prompt,
    query,
    identityName,
    promptNeed,
    repository,
    db,
    config,
  });
  recordCapsuleKnowledgeLookups({ state, repository, query, ...knowledgeContext });
  appendSemanticCapsulePhase(state, { ...knowledgeContext, config });
  appendProposalCapsulePhase(state, { db, includeProposalAwareness });
  resolveLocalRelatedWork({
    db,
    sessionStore,
    prompt,
    query,
    repository,
    allowRepoLocalTaskContext,
    config,
    state,
  });
  appendCrossRepoCapsuleSections({
    db,
    sessionStore,
    prompt,
    query,
    repository,
    allowCrossRepoFallback,
    config,
    state,
  });

  const text = state.sections
    .filter(Boolean)
    .join("\n\n")
    .trim();
  finalizeCapsuleTrace(state, { identityOnly, allowCrossRepoFallback, text });

  return {
    text,
    sections: state.sections,
    estimatedTokens: state.totalTokens,
    trace: state.trace,
  };
}
