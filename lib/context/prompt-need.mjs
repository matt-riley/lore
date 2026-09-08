import { detectAssistantIdentityName } from "../memory/memory-scope.mjs";
import { QUERY_ALIASES, STOPWORDS, inferDateFromPrompt } from "../utils/query-normalizer.mjs";
import { normalizeText } from "../utils/text-normalizer.mjs";

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

export function extractQueryTerms(prompt) {
  const directTerms = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s./_-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .filter((word) => !STOPWORDS.has(word));

  const expandedTerms = [];
  for (const term of directTerms) {
    expandedTerms.push(term);
    for (const alias of QUERY_ALIASES[term] ?? []) {
      if (alias.length > 3 && !STOPWORDS.has(alias)) {
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
    rawTemporalSignal: includesSignal(text, TEMPORAL_SIGNALS) || inferDateFromPrompt(prompt) !== null,
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
  const hasTaskSignals = hasConsistencySignal || hasTransferSignal || contextualTaskTerms.length > 0;
  const hasTemporalSignal = rawTemporalSignal && (!directAddressed || hasTaskSignals);
  const identityOnly = directAddressed && !hasTemporalSignal && !hasTaskSignals && !wantsStyleContext;
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
