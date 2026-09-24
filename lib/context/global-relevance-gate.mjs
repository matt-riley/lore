import { MEMORY_SCOPE } from "../memory/memory-scope.mjs";
import { GENERIC_TASK_REQUEST_TERMS, STOPWORDS, tokenizeText } from "../utils/query-normalizer.mjs";

// Identity/style rows are surfaced by dedicated identity-name or
// interaction-style lookups (see identityMemories/assistantPersonaRows/
// relationshipPreferenceRows below), not by generic prompt-term overlap, so
// they keep their current behaviour and are exempt from the gate below.
const GLOBAL_RELEVANCE_EXEMPT_TYPES = new Set(["assistant_identity", "user_identity", "interaction_style"]);

// A global row needs at least this many distinct non-generic prompt-term
// matches to be treated as relevant to *this* prompt.
const GLOBAL_RELEVANCE_MIN_TERM_MATCHES = 2;

// ...or, failing that, a single term long/specific enough on its own to
// stand in for two ordinary matches (a crude but principled proxy for "high
// IDF" absent real corpus statistics — this codebase already treats term
// length as a specificity signal, see scorePromptFallbackRows). Below this
// length a term is common enough ("push", "many") that one match alone isn't
// trusted; at or above it (real content words like "status", "example",
// "comment", "summary") a single shared term is genuine topical evidence.
const GLOBAL_RELEVANCE_HIGH_SPECIFICITY_MIN_LENGTH = 5;

function extractNonGenericPromptTerms(prompt) {
  return [...tokenizeText(prompt)].filter((term) => !STOPWORDS.has(term) && !GENERIC_TASK_REQUEST_TERMS.has(term));
}

/**
 * Global-scope memories that are not standing directives (those have their
 * own scoping rules in recall-assembler.mjs) and are not identity/style rows
 * need stronger evidence than repo-scoped rows before entering the
 * commitments section: sharing only generic task-request words ("review",
 * "code", "project", ...) with a stored global row must not resurrect it.
 * Repo-scoped rows are exempt outright — they keep their current,
 * FTS/fallback-scored behaviour. Embedding similarity (when configured) is
 * gated again after RRF fusion in recall-assembler.mjs: vector similarity
 * alone cannot re-admit a global row with no specific term overlap.
 */
function passesGlobalRelevanceGate(row, nonGenericPromptTerms) {
  if (row?.scope !== MEMORY_SCOPE.GLOBAL || GLOBAL_RELEVANCE_EXEMPT_TYPES.has(row?.type)) {
    return true;
  }
  if (nonGenericPromptTerms.length === 0) {
    return false;
  }
  const contentTerms = tokenizeText(row.content);
  const matchedTerms = nonGenericPromptTerms.filter((term) => contentTerms.has(term));
  return matchedTerms.length >= GLOBAL_RELEVANCE_MIN_TERM_MATCHES
    || (matchedTerms.length === 1 && matchedTerms[0].length >= GLOBAL_RELEVANCE_HIGH_SPECIFICITY_MIN_LENGTH);
}

export function applyGlobalRelevanceGate(rows, prompt) {
  const nonGenericPromptTerms = extractNonGenericPromptTerms(prompt);
  const kept = [];
  const filtered = [];
  for (const row of rows) {
    if (passesGlobalRelevanceGate(row, nonGenericPromptTerms)) {
      kept.push(row);
    } else {
      filtered.push(row);
    }
  }
  return { kept, filtered };
}
