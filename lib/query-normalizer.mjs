import { normalizeText } from "./text-normalizer.mjs";

export const GENERIC_QUERY_TERMS = new Set([
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

export const QUERY_ALIASES = {
  audit: ["auditable", "override", "scope"],
  auditable: ["audit", "override", "scope"],
  backfill: ["restore", "rollback", "snapshot"],
  chat: ["conversation", "session"],
  controlled: ["backfill", "rollback", "restore", "snapshot"],
  conversation: ["chat", "session", "history"],
  conversations: ["chat", "session", "history"],
  lore: ["memory", "history", "session"],
  memory: ["remember", "history", "lore"],
  override: ["scope", "audit", "manual"],
  past: ["history", "prior"],
  phase: ["slice", "stage", "shaping", "prompt"],
  previous: ["history", "prior"],
  prompt: ["shaping", "context", "classification"],
  recall: ["memory", "history", "remember"],
  remember: ["memory", "history", "lore"],
  remembering: ["memory", "history", "lore"],
  restore: ["rollback", "snapshot", "backfill"],
  retrieval: ["memory", "history", "lore"],
  rollback: ["restore", "snapshot", "backfill"],
  scope: ["override", "audit", "transferable", "global", "repo"],
  session: ["conversation", "history"],
  shaping: ["prompt", "context", "classification"],
  snapshot: ["restore", "rollback", "backfill"],
};

export function normalizeFtsToken(term) {
  return String(term || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractFtsDirectTerms(query, normalize = normalizeMatchTerm) {
  return String(query || "")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .map((term) => normalize(normalizeFtsToken(term)))
    .filter((term) => term.length > 2);
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const TEMPORAL_QUERY_SCAFFOLD_TERMS = new Set([
  "can",
  "config",
  "configuration",
  "did",
  "do",
  "for",
  "friday",
  "here",
  "in",
  "last",
  "monday",
  "night",
  "on",
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

export function normalizeMatchTerm(term) {
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

export function extractDirectTerms(
  query,
  { excludedTerms = TEMPORAL_QUERY_SCAFFOLD_TERMS } = {},
) {
  const excluded = excludedTerms && typeof excludedTerms.has === "function"
    ? excludedTerms
    : null;
  return String(query || "")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeMatchTerm)
    .filter((term) => term.length > 2)
    .filter((term) => !(excluded && excluded.has(term)));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function buildDate(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function includesWeekdayQualifier(text, qualifier, weekday) {
  return new RegExp(`\\b${qualifier}\\s+${weekday}\\b`).test(text);
}

function resolveWeekdayDifference({ currentIndex, targetIndex, hasLastQualifier, hasThisQualifier }) {
  const initialDiff = (currentIndex - targetIndex + 7) % 7;
  if (hasThisQualifier) {
    return initialDiff === 0 ? 0 : initialDiff;
  }
  if (hasLastQualifier || initialDiff === 0) {
    return initialDiff === 0 ? 7 : initialDiff;
  }
  return initialDiff;
}

function resolveWeekdayDate(text, now) {
  const matchedWeekday = WEEKDAYS.find((weekday) => text.includes(weekday));
  if (!matchedWeekday) {
    return null;
  }

  const targetIndex = WEEKDAYS.indexOf(matchedWeekday);
  const currentIndex = now.getUTCDay();
  const hasLastQualifier = includesWeekdayQualifier(text, "last", matchedWeekday);
  const hasThisQualifier = includesWeekdayQualifier(text, "this", matchedWeekday);
  const diff = resolveWeekdayDifference({
    currentIndex,
    targetIndex,
    hasLastQualifier,
    hasThisQualifier,
  });

  const value = startOfDay(now);
  value.setUTCDate(value.getUTCDate() - diff);
  return value;
}

function resolveMonthDay(text, now) {
  const monthPattern = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");
  const match = text.match(monthPattern);
  if (!match) {
    return null;
  }

  const monthIndex = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number.parseInt(match[2], 10);
  if (monthIndex < 0 || !Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }

  const today = startOfDay(now);
  const currentYearCandidate = buildDate(now.getUTCFullYear(), monthIndex, day);
  if (!currentYearCandidate) {
    return null;
  }
  const normalizedCurrentYear = startOfDay(currentYearCandidate);
  if (normalizedCurrentYear <= today) {
    return currentYearCandidate;
  }
  return buildDate(now.getUTCFullYear() - 1, monthIndex, day);
}

export function extractTemporalContentTerms(query) {
  return extractDirectTerms(query);
}

export function extractFtsTerms(
  query,
  {
    aliases = QUERY_ALIASES,
    genericTerms = GENERIC_QUERY_TERMS,
    normalize = normalizeMatchTerm,
  } = {},
) {
  const directTerms = extractFtsDirectTerms(query, normalize)
    .filter((term) => !genericTerms.has(term));

  const expandedTerms = [];
  for (const term of directTerms) {
    expandedTerms.push(term);
    for (const alias of aliases[term] ?? []) {
      const normalizedAlias = normalize(normalizeFtsToken(alias));
      if (normalizedAlias.length > 2 && !genericTerms.has(normalizedAlias)) {
        expandedTerms.push(normalizedAlias);
      }
    }
  }

  return [...new Set(expandedTerms)];
}

export function sanitizeFtsQuery(query, options) {
  const terms = extractFtsTerms(query, options);
  if (terms.length === 0) {
    return "";
  }
  return terms.join(" ");
}

export function inferDateFromPrompt(prompt, { now = new Date() } = {}) {
  const text = String(prompt || "").toLowerCase();

  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoDate) {
    return isoDate[1];
  }

  if (/\btoday\b/.test(text) || /\bthis (?:morning|afternoon|evening)\b/.test(text)) {
    return formatDate(startOfDay(now));
  }
  if (/\byesterday\b/.test(text) || /\blast night\b/.test(text)) {
    const value = startOfDay(now);
    value.setUTCDate(value.getUTCDate() - 1);
    return formatDate(value);
  }

  const monthDay = resolveMonthDay(text, now);
  if (monthDay) {
    return formatDate(monthDay);
  }

  const weekdayDate = resolveWeekdayDate(text, now);
  if (weekdayDate) {
    return formatDate(weekdayDate);
  }

  return null;
}

export function tokenizeText(value) {
  return new Set(
    normalizeText(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(normalizeMatchTerm)
      .filter((term) => term.length > 2),
  );
}
