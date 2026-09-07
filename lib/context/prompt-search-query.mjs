// Prompt-only fallback. Explicit memory_search keeps its strict FTS semantics.
const SCAFFOLD = new Set("a an and are as at be but by for from had has have how i if in is it its just of on or our so that the they this to was we what when where which who why will with would you your about can could did do does me remind remember tell please decided decide decision decisions handled handle used use project repo again".split(" "));

const NEGATIVE_FRAMING = /\b(?:unrelated|irrelevant|instead of|rather than|do not|don't|without)\b/iu;

export function extractMeaningfulPromptTerms(prompt, { maxTerms = 12 } = {}) {
  const terms = [...new Set(String(prompt ?? "").toLowerCase().match(/[a-z0-9][a-z0-9_/-]*/g) ?? [])]
    .filter((term) => term.length > 3 && !SCAFFOLD.has(term))
    .filter((term) => !/^(?:please|could|would|should|remember|tell|show|explain)$/u.test(term))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  return terms.slice(0, Math.max(1, Math.min(16, Number(maxTerms) || 12)));
}

function normalizePromptToken(term) {
  const value = String(term ?? "").toLowerCase();
  if (value.length <= 4) return value;
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ches") || value.endsWith("shes") || value.endsWith("xes") || value.endsWith("zes")) return value.slice(0, -2);
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

export function scorePromptFallbackRows(rows, terms, { limit = 8 } = {}) {
  const wanted = new Set((Array.isArray(terms) ? terms : []).map((term) => String(term).toLowerCase()));
  if (wanted.size === 0) return [];
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const contentTerms = new Set((String(row?.content ?? "").toLowerCase().match(/[a-z0-9][a-z0-9_/-]*/g) ?? []).map(normalizePromptToken));
    const matchedTerms = [...wanted].filter((term) => contentTerms.has(normalizePromptToken(term)));
    const score = matchedTerms.reduce((sum, term) => sum + Math.min(3, term.length / 6), 0);
    return { ...row, promptScore: score, matchedTerms };
  }).filter((row) => row.promptScore > 0)
    .sort((left, right) => right.promptScore - left.promptScore || (right.confidence ?? 0) - (left.confidence ?? 0))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
}

export function promptSearchQuery(prompt) {
  return extractMeaningfulPromptTerms(prompt, { maxTerms: 16 })
    .join(" ");
}

export function promptContainsNegativeFraming(prompt) {
  return NEGATIVE_FRAMING.test(String(prompt ?? ""));
}
