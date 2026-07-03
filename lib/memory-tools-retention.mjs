import {
  readMemoryDomainsEnabled,
  readRefreshableObservationsEnabled,
} from "./rollout-flags.mjs";
import {
  ensureLimit,
  ensureObject,
  ensureString,
} from "./memory-tools-validation-utils.mjs";
import { ensureStringArray } from "./memory-tools-array-utils.mjs";

export function applyRetainDomainContext({ runtime, args, repository, scope, domainKey }) {
  if (!domainKey) {
    return null;
  }
  if (!readMemoryDomainsEnabled(runtime.config)) {
    return "Skipped semantic memory retain: memory domains rollout is disabled";
  }
  runtime.db.upsertMemoryDomain({
    domainKey,
    kind: typeof args.domainKind === "string" ? args.domainKind : undefined,
    title: typeof args.domainTitle === "string" ? args.domainTitle : domainKey,
    mission: typeof args.domainMission === "string" ? args.domainMission : undefined,
    directives: ensureStringArray(args.domainDirectives),
    repository,
    scope,
  });
  return null;
}

export function buildWorkstreamRetainPayload(args, { repository, scope, invocation }) {
  return {
    repository,
    scope,
    confidence: typeof args.confidence === "number" ? args.confidence : 0.94,
    overlayId: typeof args.workstreamId === "string" ? args.workstreamId : undefined,
    title: typeof args.title === "string" ? args.title : undefined,
    mission: typeof args.mission === "string" ? args.mission : undefined,
    objective: typeof args.objective === "string" ? args.objective : undefined,
    status: typeof args.status === "string" ? args.status : undefined,
    constraints: ensureStringArray(args.constraints),
    blockers: ensureStringArray(args.blockers),
    nextActions: ensureStringArray(args.nextActions),
    decisions: ensureStringArray(args.decisions),
    retainPriorities: ensureStringArray(args.retainPriorities),
    reflectPriorities: ensureStringArray(args.reflectPriorities),
    metadata: ensureObject(args.metadata, "metadata"),
    sourceSessionId: invocation.sessionId,
  };
}

export function buildSemanticRetainPayload(args, { repository, scope, domainKey, invocation }) {
  return {
    type: ensureString(args.type, "type"),
    content: ensureString(args.content, "content"),
    confidence: typeof args.confidence === "number" ? args.confidence : 0.9,
    repository,
    domainKey,
    scope,
    sourceSessionId: invocation.sessionId,
    tags: ensureStringArray(args.tags),
    metadata: {
      source: "lore_retain",
      ...ensureObject(args.metadata, "metadata"),
    },
  };
}

export function formatRetainResult(retained, kind) {
  if (!retained.id) {
    return kind === "workstream"
      ? `Skipped workstream overlay retain: ${retained.reason ?? "workstream_overlays_disabled"}`
      : `Skipped semantic memory retain: ${retained.reason ?? "empty_after_sanitization"}`;
  }
  if (kind === "workstream") {
    return [
      `Retained workstream overlay ${retained.id}.`,
      "",
      retained.text,
    ].join("\n");
  }
  return `Retained semantic memory ${retained.id}`;
}

const MIN_REFLECT_LOOKBACK_HOURS = 1;
const MAX_REFLECT_LOOKBACK_HOURS = 720;

function normalizeLookbackHours(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.min(MAX_REFLECT_LOOKBACK_HOURS, Math.max(MIN_REFLECT_LOOKBACK_HOURS, numeric));
}

export function normalizeReflectionRequest(args, runtime) {
  return {
    prompt: ensureString(args.prompt, "prompt"),
    detailLevel: args.detailLevel === "full" || args.detailLevel === "evidence"
      ? args.detailLevel
      : "summary",
    includeOtherRepositories: args.includeOtherRepositories === true,
    limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
    focus: typeof args.focus === "string" ? args.focus : null,
    lookbackHours: normalizeLookbackHours(args.lookbackHours),
  };
}

function getReflectionDomainKey(args) {
  return typeof args.domainKey === "string" && args.domainKey.trim().length > 0
    ? args.domainKey.trim().toLowerCase()
    : null;
}

function getObservationPersistSkipReason(runtime, domainKey) {
  if (!readRefreshableObservationsEnabled(runtime.config)) {
    return "refreshable observations rollout is disabled";
  }
  if (domainKey && !readMemoryDomainsEnabled(runtime.config)) {
    return "memory domains rollout is disabled";
  }
  return null;
}

function buildObservationUpsertInput({ runtime, reflection, request, args, domainKey }) {
  return {
    observationKey: typeof args.observationKey === "string" ? args.observationKey : undefined,
    domainKey,
    title: `${humanizeFocus(reflection.focus)} reflection`,
    prompt: request.prompt,
    focus: reflection.focus,
    summary: reflection.summary,
    confidence: 0.9,
    repository: runtime.repository,
    freshnessHours: typeof args.freshnessHours === "number" ? args.freshnessHours : undefined,
    source: "lore_reflect",
    trace: {
      sectionCount: Array.isArray(reflection.envelope?.sections) ? reflection.envelope.sections.length : 0,
      insightCount: Array.isArray(reflection.insights) ? reflection.insights.length : 0,
      lookbackHours: reflection.lookbackHours ?? null,
      recentSessionCount: reflection.recentSessionCount ?? 0,
      recentSessionCountCapped: Boolean(reflection.recentSessionCountCapped),
    },
    metadata: {
      prompt: request.prompt,
      detailLevel: args.detailLevel,
    },
    status: "current",
  };
}

export function maybePersistReflectionObservation({ runtime, reflection, request, args }) {
  if (args.persistObservation !== true) {
    return null;
  }
  const domainKey = getReflectionDomainKey(args);
  const skipReason = getObservationPersistSkipReason(runtime, domainKey);
  if (skipReason) {
    return skipReason;
  }
  const observationKey = runtime.db.upsertObservation(
    buildObservationUpsertInput({ runtime, reflection, request, args, domainKey }),
  );
  return `Saved observation ${observationKey}.`;
}

export function normalizeBackfillRequest(args, runtime) {
  const mode = args.mode === "controlled" ? "controlled" : "legacy";
  return {
    mode,
    limit: ensureLimit(
      args.limit,
      mode === "controlled" ? 20 : runtime.config.limits.recentSessionsFallbackLimit,
      mode === "controlled" ? 100 : 20,
    ),
    batchSize: ensureLimit(args.batchSize, 5, mode === "controlled" ? 100 : 20),
    includeOtherRepositories: args.includeOtherRepositories === true,
    refreshExisting: mode === "controlled"
      ? args.refreshExisting !== false
      : args.refreshExisting === true,
  };
}

function humanizeFocus(value) {
  return String(value || "summary")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
