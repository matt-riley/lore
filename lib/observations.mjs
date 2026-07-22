import { sanitizeRetainedMetadata, sanitizeRetainedText } from "./retention-sanitizer.mjs";

const OBSERVATION_STATUS = Object.freeze({
  CURRENT: "current",
  STALE: "stale",
  ERROR: "error",
});

function normalizeLowercase(value) {
  return sanitizeRetainedText(value).toLowerCase();
}

function normalizeObservationStatus(value) {
  const normalized = sanitizeRetainedText(value).toLowerCase();
  return Object.values(OBSERVATION_STATUS).includes(normalized)
    ? normalized
    : OBSERVATION_STATUS.CURRENT;
}

function normalizeScope(scope, repository) {
  const normalized = sanitizeRetainedText(scope).toLowerCase();
  if (normalized === "global" || normalized === "transferable" || normalized === "repo") {
    return normalized;
  }
  return repository ? "repo" : "global";
}

function normalizeFreshnessHours(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(24 * 365, Math.floor(value)));
  }
  return 72;
}

export function buildRefreshableObservation({
  observationKey,
  domainKey,
  title,
  prompt,
  focus,
  summary,
  confidence,
  repository,
  scope,
  freshnessHours,
  source,
  trace = {},
  metadata = {},
  status,
} = {}) {
  const normalizedRepository = sanitizeRetainedText(repository) || null;
  const normalizedDomainKey = sanitizeRetainedText(domainKey).toLowerCase() || null;
  const normalizedFocus = normalizeLowercase(focus) || "summary";
  const normalizedPrompt = sanitizeRetainedText(prompt);
  const normalizedSummary = sanitizeRetainedText(summary);
  const normalizedTitle = sanitizeRetainedText(title)
    || sanitizeRetainedText(`${normalizedFocus} observation`)
    || "Observation";
  const normalizedSource = normalizeLowercase(source) || "reflection";
  const fallbackKey = [normalizedDomainKey || normalizedRepository || "global", normalizedSource, normalizedFocus]
    .filter(Boolean)
    .join(":");
  const normalizedObservationKey = normalizeLowercase(observationKey || fallbackKey);

  if (!normalizedObservationKey || !normalizedSummary) {
    return null;
  }

  return {
    observationKey: normalizedObservationKey,
    domainKey: normalizedDomainKey,
    title: normalizedTitle,
    prompt: normalizedPrompt,
    focus: normalizedFocus,
    summary: normalizedSummary,
    confidence: typeof confidence === "number" && Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.9,
    repository: normalizedRepository,
    scope: normalizeScope(scope, normalizedRepository),
    freshnessHours: normalizeFreshnessHours(freshnessHours),
    source: normalizedSource,
    trace: sanitizeRetainedMetadata(trace),
    metadata: sanitizeRetainedMetadata(metadata),
    status: normalizeObservationStatus(status),
  };
}
