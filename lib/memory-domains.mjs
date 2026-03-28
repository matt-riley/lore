import { sanitizeRetainedList, sanitizeRetainedMetadata, sanitizeRetainedText } from "./retention-sanitizer.mjs";

export const MEMORY_DOMAIN_KIND = Object.freeze({
  ASSISTANT: "assistant",
  USER: "user",
  REPO: "repo",
  WORKSTREAM: "workstream",
  PERSON: "person",
  TOPIC: "topic",
  CUSTOM: "custom",
});

export const MEMORY_DOMAIN_STATUS = Object.freeze({
  ACTIVE: "active",
  ARCHIVED: "archived",
});

function normalizeDomainKey(value) {
  return sanitizeRetainedText(value).toLowerCase();
}

function normalizeDomainKind(value) {
  const normalized = sanitizeRetainedText(value).toLowerCase();
  return Object.values(MEMORY_DOMAIN_KIND).includes(normalized)
    ? normalized
    : MEMORY_DOMAIN_KIND.CUSTOM;
}

function normalizeDomainStatus(value) {
  const normalized = sanitizeRetainedText(value).toLowerCase();
  return normalized === MEMORY_DOMAIN_STATUS.ARCHIVED
    ? MEMORY_DOMAIN_STATUS.ARCHIVED
    : MEMORY_DOMAIN_STATUS.ACTIVE;
}

function normalizeScope(scope, repository) {
  const normalized = sanitizeRetainedText(scope).toLowerCase();
  if (normalized === "global" || normalized === "transferable" || normalized === "repo") {
    return normalized;
  }
  return repository ? "repo" : "global";
}

function normalizeRepository(repository) {
  const normalized = sanitizeRetainedText(repository);
  return normalized || null;
}

export function buildMemoryDomain({
  domainKey,
  kind,
  title,
  mission,
  scope,
  repository,
  directives = [],
  disposition = {},
  metadata = {},
  status,
} = {}) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedKey = normalizeDomainKey(domainKey);
  const normalizedTitle = sanitizeRetainedText(title) || normalizedKey;

  if (!normalizedKey || !normalizedTitle) {
    return null;
  }

  return {
    domainKey: normalizedKey,
    kind: normalizeDomainKind(kind),
    title: normalizedTitle,
    mission: sanitizeRetainedText(mission),
    scope: normalizeScope(scope, normalizedRepository),
    repository: normalizedRepository,
    directives: sanitizeRetainedList(directives, 16),
    disposition: sanitizeRetainedMetadata(disposition),
    metadata: sanitizeRetainedMetadata(metadata),
    status: normalizeDomainStatus(status),
  };
}
