import {
  ensureIds,
  ensureLimit,
  ensureObject,
  ensureString,
} from "./memory-tools-validation-utils.mjs";
import {
  readOptionalLowercaseString,
  readOptionalTrimmedString,
  resolveRepositoryArg,
} from "./memory-tools-input-utils.mjs";
import { formatLoreUnavailable as formatUnavailable } from "./memory-tools-runtime-utils.mjs";
import {
  formatRows,
} from "./memory-tools-render-utils.mjs";

export function buildIntentJournalContext(args, runtime, invocation) {
  return {
    action: typeof args.action === "string" ? args.action : "list",
    repository: resolveRepositoryArg(args.repository, runtime.repository),
    kind: readOptionalLowercaseString(args.kind),
    sessionId: readOptionalTrimmedString(args.sessionId),
    invocationSessionId: invocation.sessionId,
  };
}

export function recordIntentJournal(runtime, args, context) {
  const id = runtime.db.insertIntentJournalEntry({
    repository: context.repository,
    sessionId: context.sessionId ?? context.invocationSessionId,
    turnHint: typeof args.turnHint === "string" ? args.turnHint : null,
    intentKind: context.kind ?? "journal",
    summary: ensureString(args.summary, "summary"),
    rationale: typeof args.rationale === "string" ? args.rationale : null,
    context: ensureObject(args.context, "context"),
  });
  return `Recorded intent journal entry ${id} (${context.kind ?? "journal"}).`;
}

export function listIntentJournal(runtime, args, context) {
  const rows = runtime.db.listIntentJournalEntries({
    repository: context.repository,
    sessionId: context.sessionId ?? undefined,
    intentKind: context.kind,
    limit: ensureLimit(args.limit, 10, 20),
  });
  return [
    `repository: ${context.repository ?? "all"}`,
    `kindFilter: ${context.kind ?? "all"}`,
    "",
    "## Intent Journal",
    "",
    formatIntentJournalRows(rows),
  ].join("\n");
}

function formatIntentJournalRows(rows) {
  return formatRows(rows, (row) => {
    const contextKeys = Object.keys(row.context ?? {});
    return [
      `- [${row.id}] kind=${row.intent_kind}`,
      row.repository ? `repository=${row.repository}` : null,
      row.session_id ? `session=${row.session_id}` : null,
      row.turn_hint ? `turnHint=${row.turn_hint}` : null,
      `summary=${row.summary}`,
      row.rationale ? `rationale=${row.rationale}` : null,
      contextKeys.length > 0 ? `contextKeys=${contextKeys.join(",")}` : null,
      `created=${row.created_at}`,
    ].filter(Boolean).join(" ");
  });
}

export function buildScopeOverrideRequest(args, runtime, invocation) {
  const action = args.action === "clear" ? "clear" : "set";
  const dryRun = args.dryRun !== false;
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  const scope = readOptionalTrimmedString(args.scope);
  validateScopeOverrideRequest({ action, dryRun, reason, scope });
  return {
    targetType: args.targetType === "episode" ? "episode" : "semantic",
    ids: ensureIds(args.ids),
    action,
    dryRun,
    reason,
    scope,
    repository: resolveRepositoryArg(args.repository, runtime.repository),
    actor: readOptionalTrimmedString(args.actor) ?? `session:${invocation.sessionId}`,
    source: readOptionalTrimmedString(args.source) ?? "memory_scope_override",
  };
}

function validateScopeOverrideRequest({ action, dryRun, reason, scope }) {
  if (!dryRun && reason.length === 0) {
    throw new Error("reason is required when dryRun is false");
  }
  if (action === "set" && !scope) {
    throw new Error("scope is required when action is set");
  }
}

export function previewScopeOverride(runtime, request) {
  return runtime.db.previewScopeChanges({
    targetType: request.targetType,
    ids: request.ids,
    action: request.action,
    scope: request.scope,
    repository: request.repository,
  });
}

function formatScopePreview(preview) {
  const lines = [
    `action: ${preview.action}`,
    `targetType: ${preview.targetType}`,
    `requestedCount: ${preview.requestedCount}`,
    `matchedCount: ${preview.matchedCount}`,
    `missingIds: ${preview.missingIds.length > 0 ? preview.missingIds.join(", ") : "none"}`,
    "",
    "## Rows",
    "",
  ];
  lines.push(formatRows(preview.rows, (row) => [
    `- ${row.id}`,
    `current=${row.current.scope}/${row.current.scopeSource}`,
    `(${row.current.repository ?? "global"})`,
    `-> next=${row.next.scope}/${row.next.scopeSource}`,
    `(${row.next.repository ?? "global"})`,
    `changed=${row.changed}`,
  ].join(" ")));
  return lines.join("\n");
}

export function applyScopeOverride(runtime, request) {
  const applied = runtime.db.applyScopeChanges({
    targetType: request.targetType,
    ids: request.ids,
    action: request.action,
    scope: request.scope,
    repository: request.repository,
    actor: request.actor,
    reason: request.reason,
    source: request.source,
  });
  return [
    `Applied ${applied.action} override to ${applied.rows.length} ${request.targetType} row(s).`,
    "",
    formatScopePreview(applied),
  ].join("\n");
}

function buildOnboardingProfileArgs(args) {
  return {
    voice: typeof args.voice === "string" ? args.voice : undefined,
    warmth: typeof args.warmth === "string" ? args.warmth : undefined,
    humor: typeof args.humor === "string" ? args.humor : undefined,
    humorFrequency: typeof args.humorFrequency === "string" ? args.humorFrequency : undefined,
    collaborative: typeof args.collaborative === "boolean" ? args.collaborative : undefined,
    useNameNaturally: typeof args.useNameNaturally === "boolean" ? args.useNameNaturally : undefined,
  };
}

export function buildOnboardingInputArgs(args, onboardingState, sessionId) {
  return {
    existingState: onboardingState,
    userName: readOptionalTrimmedString(args.userName) ? ensureString(args.userName, "userName") : undefined,
    assistantName: readOptionalTrimmedString(args.assistantName) ?? undefined,
    profile: buildOnboardingProfileArgs(args),
    sessionId,
  };
}

export function persistOnboardingMemories(db, memories) {
  for (const memory of memories) {
    db.insertSemanticMemory(memory);
  }
}

export function formatOnboardingResult(args, built) {
  const autoNamed = !readOptionalTrimmedString(args.assistantName);
  return [
    "Lore onboarding saved.",
    `announceToUser=You can call me ${built.assistantName}.`,
    `assistantName=${built.assistantName}`,
    `assistantNameSource=${autoNamed ? "auto" : "custom"}`,
    `userName=${built.userName}`,
    `voice=${built.profile.voice}`,
    `warmth=${built.profile.warmth}`,
    `humor=${built.profile.humor}`,
    `humorFrequency=${built.profile.humorFrequency}`,
    `useNameNaturally=${built.profile.useNameNaturally === true ? "true" : "false"}`,
  ].join(" ");
}
