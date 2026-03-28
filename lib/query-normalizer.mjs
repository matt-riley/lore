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

function extractDirectTerms(query) {
  return String(query || "")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeMatchTerm)
    .filter((term) => term.length > 2)
    .filter((term) => !TEMPORAL_QUERY_SCAFFOLD_TERMS.has(term));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function buildDate(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveWeekdayDate(text, now) {
  const matchedWeekday = WEEKDAYS.find((weekday) => text.includes(weekday));
  if (!matchedWeekday) {
    return null;
  }

  const targetIndex = WEEKDAYS.indexOf(matchedWeekday);
  const currentIndex = now.getDay();
  const hasLastQualifier = new RegExp(`\\blast\\s+${matchedWeekday}\\b`).test(text);
  const hasThisQualifier = new RegExp(`\\bthis\\s+${matchedWeekday}\\b`).test(text);

  let diff = (currentIndex - targetIndex + 7) % 7;
  if (hasLastQualifier || (!hasThisQualifier && diff === 0)) {
    diff = diff === 0 ? 7 : diff;
  }
  if (hasThisQualifier && diff === 0) {
    diff = 0;
  }
  if (hasThisQualifier && diff < 0) {
    return null;
  }

  const value = new Date(now);
  value.setDate(value.getDate() - diff);
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

export function inferDateFromPrompt(prompt, { now = new Date() } = {}) {
  const text = String(prompt || "").toLowerCase();

  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoDate) {
    return isoDate[1];
  }

  if (/\btoday\b/.test(text) || /\bthis (?:morning|afternoon|evening)\b/.test(text)) {
    return formatDate(now);
  }
  if (/\byesterday\b/.test(text) || /\blast night\b/.test(text)) {
    const value = new Date(now);
    value.setDate(value.getDate() - 1);
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
