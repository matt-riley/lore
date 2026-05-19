import {
  recommendCapabilityRoute,
  renderCapabilityEvaluationReport,
  renderCapabilityInventoryReport,
  renderCapabilityRecommendationReport,
  scanCapabilityInventory,
} from "./capability-inventory.mjs";
import {
  generateProposalArtifacts,
  verifyProposalArtifacts,
} from "./proposal-generator.mjs";
import {
  readMemoryDomainsEnabled,
  readEvolutionLedgerEnabled,
  readRefreshableObservationsEnabled,
  readGeneratedArtifactIntegrityEnabled,
  readProposalGenerationEnabled,
  readTraceRecorderEnabled,
} from "./rollout-flags.mjs";
export function formatRows(rows, render) {
  if (!rows || rows.length === 0) {
    return "No results.";
  }
  return rows.map(render).join("\n");
}

export function formatImprovementArtifactRows(rows) {
  return formatRows(rows, (row) => {
    const evidenceKeys = Object.keys(row.evidence ?? {});
    return [
      `- [${row.id}] ${row.source_kind}:${row.source_case_id}`,
      `status=${row.status}`,
      `title=${row.title}`,
      `summary=${row.summary}`,
      `linkedMemory=${row.linked_memory_id ?? "none"}`,
      `created=${row.created_at}`,
      `updated=${row.updated_at}`,
      row.resolved_at ? `resolved=${row.resolved_at}` : null,
      row.superseded_by ? `supersededBy=${row.superseded_by}` : null,
      row.proposal_path ? `proposal=${row.proposal_path}` : null,
      row.review_state && row.review_state !== "none" ? `reviewState=${row.review_state}` : null,
      evidenceKeys.length > 0 ? `evidenceKeys=${evidenceKeys.join(",")}` : null,
    ].filter(Boolean).join(" ");
  });
}

function formatProposalRows(rows) {
  return formatRows(rows, (row) => [
    `- [${row.id}] ${row.title}`,
    `type=${row.proposal_type ?? "unknown"}`,
    `reviewState=${row.review_state ?? "draft"}`,
    `path=${row.proposal_path ?? "none"}`,
    `updated=${row.updated_at}`,
    row.reviewer_decision ? `decision=${row.reviewer_decision}` : null,
  ].filter(Boolean).join(" "));
}

function normalizeImprovementEvidenceTag(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized || null;
}

function deriveReplayImprovementTheme(evidence) {
  const missCategory = normalizeImprovementEvidenceTag(evidence.missCategory);
  if (missCategory) {
    return `miss:${missCategory}`;
  }
  const rankingOutcome = normalizeImprovementEvidenceTag(evidence.rankingOutcome);
  return rankingOutcome ? `ranking:${rankingOutcome}` : null;
}

function deriveValidationImprovementTheme(evidence) {
  const firstAssertion = ensureArray(evidence.failedAssertions)[0];
  const assertionId = normalizeImprovementEvidenceTag(firstAssertion?.id ?? firstAssertion?.label);
  return assertionId ? `assertion:${assertionId}` : null;
}

function deriveSignalImprovementTheme(evidence) {
  const signalType = normalizeImprovementEvidenceTag(evidence.signalType);
  return signalType ? `signal:${signalType}` : null;
}

const IMPROVEMENT_THEME_DERIVERS = {
  replay: deriveReplayImprovementTheme,
  signal: deriveSignalImprovementTheme,
  validation: deriveValidationImprovementTheme,
};

function deriveImprovementFallbackTheme(evidence) {
  const firstEvidenceKey = Object.keys(evidence)[0];
  return firstEvidenceKey ? `evidence:${String(firstEvidenceKey).toLowerCase()}` : "general";
}

function deriveImprovementTheme(row) {
  const evidence = row?.evidence ?? {};
  const deriveTheme = IMPROVEMENT_THEME_DERIVERS[row?.source_kind];
  return (deriveTheme ? deriveTheme(evidence) : null) ?? deriveImprovementFallbackTheme(evidence);
}
function formatIntegrityIssues(issues) {
  return formatRows(issues, (issue) => [
    `- [${issue.id}] ${issue.type}`,
    `path=${issue.proposalPath ?? "none"}`,
  ].filter(Boolean).join(" "));
}

function formatProposalGenerationReport(result) {
  return [
    `enabled: ${result.enabled === true}`,
    `generatedCount: ${result.generatedCount ?? 0}`,
    `skippedCount: ${result.skippedCount ?? 0}`,
    `indexPath: ${result.indexPath ?? "none"}`,
    "",
    "## Generated",
    "",
    formatRows(result.generated, (row) => [
      `- [${row.id}] ${row.proposalType}`,
      `reviewState=${row.reviewState}`,
      `path=${row.proposalPath}`,
    ].join(" ")),
    "",
    "## Skipped",
    "",
    formatRows(result.skipped, (row) => [
      `- [${row.id}] ${row.reason}`,
      row.proposalPath ? `path=${row.proposalPath}` : null,
    ].filter(Boolean).join(" ")),
  ].join("\n");
}

function formatIntegrityReport(result) {
  return [
    `enabled: ${result.enabled === true}`,
    `issueCount: ${result.issueCount ?? 0}`,
    `repairedCount: ${result.repairedCount ?? 0}`,
    `indexPath: ${result.indexPath ?? "none"}`,
    "",
    "## Issues",
    "",
    formatIntegrityIssues(result.issues ?? []),
    "",
    "## Repaired",
    "",
    formatIntegrityIssues(result.repaired ?? []),
  ].join("\n");
}

export function normalizeImprovementStatus(value) {
  if (value === "resolved") {
    return "resolved";
  }
  if (value === "superseded") {
    return "superseded";
  }
  return "active";
}

export function ensureString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

export function ensureLimit(value, fallback, max = 50) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(max, Math.floor(value));
  }
  return fallback;
}

function ensureIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("ids must be a non-empty array");
  }
  const ids = [...new Set(
    value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  if (ids.length === 0) {
    throw new Error("ids must contain at least one non-empty string");
  }
  return ids;
}

function ensureStringArray(value, _fieldName) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureObject(value, fieldName) {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeRetainContext(args, runtime) {
  return {
    kind: args.kind === "workstream" ? "workstream" : "semantic",
    repository: typeof args.repository === "string" && args.repository.trim().length > 0
      ? args.repository.trim()
      : runtime.repository,
    scope: typeof args.scope === "string" ? args.scope.trim() : undefined,
    domainKey: typeof args.domainKey === "string" && args.domainKey.trim().length > 0
      ? args.domainKey.trim().toLowerCase()
      : null,
  };
}

export function formatLoreUnavailable(runtime) {
  if (runtime.initialized && !runtime.lastError) {
    return null;
  }
  return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
}

function readOptionalTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalLowercaseString(value) {
  const normalized = readOptionalTrimmedString(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

function resolveRepositoryArg(value, runtimeRepository) {
  return readOptionalTrimmedString(value) ?? runtimeRepository;
}

const PORTABLE_BUNDLE_EXPORT_ACTION = "export";
const CAPABILITY_INVENTORY_ACTIONS = new Set(["summary", "recommend", "route", "evaluate", "json"]);

function normalizePortableBundleAction(value) {
  return typeof value === "string" ? value : PORTABLE_BUNDLE_EXPORT_ACTION;
}

export function buildPortableBundleRequest(args, runtime) {
  const action = normalizePortableBundleAction(args.action);
  if (action !== PORTABLE_BUNDLE_EXPORT_ACTION) {
    throw new Error("memory_portable_bundle currently supports action=export only");
  }
  const bundlePath = resolveBundlePath(args.bundlePath);
  if (args.bundlePath && !bundlePath) {
    throw new Error("bundlePath must be a non-empty path");
  }
  return {
    repository: resolveRepositoryArg(args.repository, runtime.repository),
    limit: ensureLimit(args.limit, 20, 50),
    bundlePath,
  };
}

export async function writePortableBundle(bundlePath, portableBundle) {
  if (!bundlePath) {
    return;
  }
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, `${JSON.stringify(portableBundle, null, 2)}\n`, "utf8");
}

export function formatPortableBundleResult({ portableBundle, bundlePath, repository }) {
  return formatPortableBundleReport({
    bundleId: portableBundle.bundleId,
    signature: portableBundle.signature.digest,
    bundlePath: bundlePath ? path.relative(repoRootFromModule(), bundlePath).replaceAll(path.sep, "/") : null,
    repository,
    exportedArtifactCount: portableBundle.data.improvementArtifacts.length,
  });
}

export function normalizeCapabilityInventoryAction(value) {
  return CAPABILITY_INVENTORY_ACTIONS.has(value) ? value : "summary";
}

export async function renderCapabilityInventoryAction(args, limit, action) {
  if (action === "evaluate") {
    const result = await evaluateCapabilityRouter({
      caseIds: ensureArray(args.caseIds).map((item) => String(item)),
      limit,
    });
    return renderCapabilityEvaluationReport(result);
  }

  const inventory = await scanCapabilityInventory();
  if (action === "json") {
    return JSON.stringify(inventory, null, 2);
  }
  if (action === "recommend" || action === "route") {
    const prompt = ensureString(args.prompt, "prompt");
    const recommendation = recommendCapabilityRoute({
      prompt,
      inventory,
      limit,
    });
    return renderCapabilityRecommendationReport(recommendation, { limit });
  }

  const report = renderCapabilityInventoryReport(inventory, {
    detailLevel: args.detailLevel === "full" ? "full" : "summary",
    limit,
  });
  const validationSection = formatValidationErrors(inventory.validation?.errors);
  return validationSection ? `${report}\n\n${validationSection}` : report;
}

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

export function ensureEvolutionLedgerAvailable(runtime) {
  const unavailable = formatLoreUnavailable(runtime);
  if (unavailable) {
    return unavailable;
  }
  if (!readEvolutionLedgerEnabled(runtime.config)) {
    return "evolution ledger disabled: rollout.evolutionLedger is false";
  }
  return null;
}

export function captureEvolutionSignal(runtime, args) {
  const signalType = ensureString(args.signalType, "signalType");
  const artifactId = runtime.db.upsertImprovementArtifact({
    sourceCaseId: readOptionalTrimmedString(args.sourceCaseId) ?? `${signalType}:${Date.now()}`,
    sourceKind: "signal",
    title: ensureString(args.title, "title"),
    summary: ensureString(args.summary, "summary"),
    evidence: {
      signalType,
      ...ensureObject(args.evidence, "evidence"),
    },
    trace: ensureObject(args.trace, "trace"),
    linkedMemoryId: readOptionalTrimmedString(args.linkedMemoryId),
  });
  return `Captured evolution signal ${artifactId} (${signalType}).`;
}

export async function generateEvolutionLedgerProposals(runtime, args) {
  const result = await generateProposalArtifacts({
    runtime,
    ids: Array.isArray(args.ids) ? ensureIds(args.ids) : [],
    limit: ensureLimit(args.limit, 10, 20),
    force: args.force === true,
    dryRun: args.dryRun === true,
  });
  return formatProposalGenerationReport(result);
}

export async function verifyEvolutionLedgerIntegrity(runtime, args) {
  const result = await verifyProposalArtifacts({
    runtime,
    limit: ensureLimit(args.limit, 20, 50),
    repair: args.repair === true,
    dryRun: args.dryRun === true,
  });
  return formatIntegrityReport(result);
}

export function summarizeEvolutionLedger(runtime, args) {
  const limit = ensureLimit(args.limit, 10, 20);
  const stats = runtime.db.getStats();
  const artifacts = runtime.db.listImprovementArtifacts({ limit });
  const activeArtifacts = runtime.db.listImprovementArtifacts({
    status: "active",
    limit: 50,
  });
  const proposals = runtime.db.listImprovementArtifacts({
    hasProposal: true,
    limit,
  });
  const maintenanceRuns = runtime.db.listMaintenanceRuns({ limit: 5 });
  const clusters = summarizeImprovementClusters(activeArtifacts, {
    minClusterSize: 2,
    maxClusters: 5,
  });
  return [
    `evolutionLedgerEnabled: ${readEvolutionLedgerEnabled(runtime.config)}`,
    `proposalGenerationEnabled: ${readProposalGenerationEnabled(runtime.config)}`,
    `generatedArtifactIntegrityEnabled: ${readGeneratedArtifactIntegrityEnabled(runtime.config)}`,
    `improvementActiveCount: ${stats.improvementActiveCount ?? 0}`,
    `improvementResolvedCount: ${stats.improvementResolvedCount ?? 0}`,
    `improvementSupersededCount: ${stats.improvementSupersededCount ?? 0}`,
    `improvementProposalCount: ${stats.improvementProposalCount ?? 0}`,
    `draftProposalCount: ${stats.draftProposalCount ?? 0}`,
    `approvedProposalCount: ${stats.approvedProposalCount ?? 0}`,
    `rejectedProposalCount: ${stats.rejectedProposalCount ?? 0}`,
    `traceRecorderEnabled: ${readTraceRecorderEnabled(runtime.config)}`,
    "",
    "## Recent Ledger Artifacts",
    "",
    formatImprovementArtifactRows(artifacts),
    "",
    "## Active Artifact Clusters",
    "",
    formatRows(clusters, (cluster) => [
      `- ${cluster.sourceKind}:${cluster.theme}`,
      `count=${cluster.count}`,
      `latest=${cluster.latestUpdatedAt ?? "unknown"}`,
      `ids=${cluster.ids.join(",")}`,
    ].join(" ")),
    "",
    "## Recent Proposals",
    "",
    formatProposalRows(proposals),
    "",
    "## Recent Maintenance Runs",
    "",
    formatMaintenanceRunRows(maintenanceRuns),
  ].join("\n");
}

function formatMaintenanceRunRows(runs) {
  return formatRows(runs, (row) => [
    `- ${row.id}`,
    `status=${row.status}`,
    `trigger=${row.trigger}`,
    `tasks=${ensureArray(row.plannedTasks).join(",") || "none"}`,
    `completed=${row.completed_count}`,
    `needsAttention=${row.needs_attention_count}`,
    `failed=${row.failed_count}`,
    `skipped=${row.skipped_count}`,
    `started=${row.started_at}`,
    row.completed_at ? `completedAt=${row.completed_at}` : null,
  ].filter(Boolean).join(" "));
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
    directives: ensureStringArray(args.domainDirectives, "domainDirectives"),
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
    constraints: ensureStringArray(args.constraints, "constraints"),
    blockers: ensureStringArray(args.blockers, "blockers"),
    nextActions: ensureStringArray(args.nextActions, "nextActions"),
    decisions: ensureStringArray(args.decisions, "decisions"),
    retainPriorities: ensureStringArray(args.retainPriorities, "retainPriorities"),
    reflectPriorities: ensureStringArray(args.reflectPriorities, "reflectPriorities"),
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
    tags: ensureStringArray(args.tags, "tags"),
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

export function normalizeReflectionRequest(args, runtime) {
  return {
    prompt: ensureString(args.prompt, "prompt"),
    detailLevel: args.detailLevel === "full" || args.detailLevel === "evidence"
      ? args.detailLevel
      : "summary",
    includeOtherRepositories: args.includeOtherRepositories === true,
    limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
    focus: typeof args.focus === "string" ? args.focus : null,
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

const PORTABLE_BUNDLE_VERSION = 1;
function summarizeImprovementClusters(rows, { minClusterSize = 2, maxClusters = 5 } = {}) {
  const groups = new Map();
  for (const row of ensureArray(rows)) {
    if (row.status !== "active") {
      continue;
    }
    const theme = deriveImprovementTheme(row);
    const key = `${row.source_kind}:${theme}`;
    if (!groups.has(key)) {
      groups.set(key, {
        sourceKind: row.source_kind,
        theme,
        count: 0,
        latestUpdatedAt: row.updated_at,
        ids: [],
      });
    }
    const group = groups.get(key);
    group.count += 1;
    group.ids.push(row.id);
    if (String(row.updated_at ?? "") > String(group.latestUpdatedAt ?? "")) {
      group.latestUpdatedAt = row.updated_at;
    }
  }

  return [...groups.values()]
    .filter((group) => group.count >= minClusterSize)
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return String(right.latestUpdatedAt ?? "").localeCompare(String(left.latestUpdatedAt ?? ""));
    })
    .slice(0, maxClusters);
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
}

const PORTABLE_BUNDLE_TYPE = "lore-portable-improvement";

function formatPortableBundleReport({
  bundleId,
  signature,
  bundlePath,
  repository,
  exportedArtifactCount = 0,
}) {
  return [
    "action: export",
    `bundleId: ${bundleId}`,
    `signature: ${signature}`,
    `bundlePath: ${bundlePath ?? "inline"}`,
    `repository: ${repository ?? "global"}`,
    `exportedImprovementCount: ${exportedArtifactCount}`,
    "",
    "Notes:",
    "- portable bundles are local-first and review-gated",
    "- bundle includes approved improvement artifacts only",
    "- cloud/community sharing is not part of this surface",
  ].filter(Boolean).join("\n");
}

export function createPortableBundle({
  repository,
  improvementArtifacts,
}) {
  const selectedArtifacts = improvementArtifacts.map((row) => ({
    id: row.id,
    sourceCaseId: row.source_case_id,
    sourceKind: row.source_kind,
    title: row.title,
    summary: row.summary,
    status: row.status,
    reviewState: row.review_state ?? "none",
    proposal: {
      type: row.proposal_type ?? null,
      path: row.proposal_path ?? null,
      hash: row.proposal_hash ?? null,
    },
    evidence: row.evidence ?? {},
    trace: row.trace ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const exportedAt = new Date().toISOString();
  const bundleId = `portable-${exportedAt.replace(/[:.]/g, "-")}`;
  const payload = {
    bundleVersion: PORTABLE_BUNDLE_VERSION,
    bundleType: PORTABLE_BUNDLE_TYPE,
    bundleId,
    exportedAt,
    repository: repository ?? null,
    constraints: {
      localFirst: true,
      reviewGated: true,
      autoApply: false,
    },
    data: {
      improvementArtifacts: selectedArtifacts,
    },
  };
  return {
    ...payload,
    signature: {
      algorithm: "sha256",
      digest: sha256(JSON.stringify(payload)),
    },
  };
}

function repoRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function resolveBundlePath(rawPath) {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return null;
  }
  return path.isAbsolute(trimmed)
    ? trimmed
    : path.join(repoRootFromModule(), trimmed);
}
