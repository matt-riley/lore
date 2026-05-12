import { LORE_CAPABILITY_SPECS } from "./capability-manifest.mjs";
import {
  applySessionExtraction,
  summarizeBackfillPreviewProgress,
  summarizeBackfillRunProgress,
  previewControlledBackfill,
  processControlledBackfillRun,
  processDeferredExtractions,
  restoreControlledBackfillRun,
  startControlledBackfillRun,
} from "./backfill.mjs";
import {
  explainMemoryRetrieval,
  renderExplanationReport,
  renderReplayReport,
  renderValidationReport,
  runReplayCorpus,
  runValidationSet,
} from "./diagnostics.mjs";
import {
  evaluateCapabilityRouter,
  recommendCapabilityRoute,
  renderCapabilityEvaluationReport,
  renderCapabilityInventoryReport,
  renderCapabilityRecommendationReport,
  scanCapabilityInventory,
} from "./capability-inventory.mjs";
import {
  buildRecallEnvelope,
  recallMemory,
  reflectMemory,
  retainMemory,
} from "./memory-operations.mjs";
import {
  readOnboardingState,
  resolveOnboardingInput,
} from "./onboarding.mjs";
import {
  getMaintenanceStatus,
  runMaintenanceSweep,
} from "./maintenance-scheduler.mjs";
import {
  generateProposalArtifacts,
  verifyProposalArtifacts,
} from "./proposal-generator.mjs";
import {
  parseWorkstreamOverlayMemory,
  WORKSTREAM_MEMORY_TYPE,
} from "./workstream-overlays.mjs";
import {
  readMemoryDomainsEnabled,
  readEvolutionLedgerEnabled,
  readRefreshableObservationsEnabled,
  readGeneratedArtifactIntegrityEnabled,
  readMemoryOperationsEnabled,
  readProposalGenerationEnabled,
  readRetentionSanitizationEnabled,
  readTraceRecorderEnabled,
  readTemporalQueryNormalizationEnabled,
  readWorkstreamOverlaysEnabled,
  readLoreDoctorEnabled,
  readReviewGateEnabled,
  readDirectivesEnabled,
} from "./rollout-flags.mjs";
import { runDoctorObservation } from "./lore-doctor.mjs";
import { runReviewGate } from "./review-gate.mjs";
import { validateSkillsDirectory, formatValidationResults } from "./skill-validator.mjs";

import { observeSafetyGateActions } from "./external-safety-gates.mjs";

import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function formatRows(rows, render) {
  if (!rows || rows.length === 0) {
    return "No results.";
  }
  return rows.map(render).join("\n");
}

function formatImprovementArtifactRows(rows) {
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

function normalizeImprovementStatus(value) {
  if (value === "resolved") {
    return "resolved";
  }
  if (value === "superseded") {
    return "superseded";
  }
  return "active";
}

function ensureString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function ensureLimit(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(20, Math.floor(value));
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

function ensureStringArray(value, fieldName) {
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

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRetainContext(args, runtime) {
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

function formatLoreUnavailable(runtime) {
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

function buildIntentJournalContext(args, runtime, invocation) {
  return {
    action: typeof args.action === "string" ? args.action : "list",
    repository: resolveRepositoryArg(args.repository, runtime.repository),
    kind: readOptionalLowercaseString(args.kind),
    sessionId: readOptionalTrimmedString(args.sessionId),
    invocationSessionId: invocation.sessionId,
  };
}

function recordIntentJournal(runtime, args, context) {
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

function listIntentJournal(runtime, args, context) {
  const rows = runtime.db.listIntentJournalEntries({
    repository: context.repository,
    sessionId: context.sessionId ?? undefined,
    intentKind: context.kind,
    limit: ensureLimit(args.limit, 10),
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

function ensureEvolutionLedgerAvailable(runtime) {
  const unavailable = formatLoreUnavailable(runtime);
  if (unavailable) {
    return unavailable;
  }
  if (!readEvolutionLedgerEnabled(runtime.config)) {
    return "evolution ledger disabled: rollout.evolutionLedger is false";
  }
  return null;
}

function captureEvolutionSignal(runtime, args) {
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

async function generateEvolutionLedgerProposals(runtime, args) {
  const result = await generateProposalArtifacts({
    runtime,
    ids: Array.isArray(args.ids) ? ensureIds(args.ids) : [],
    limit: ensureLimit(args.limit, 10),
    force: args.force === true,
    dryRun: args.dryRun === true,
  });
  return formatProposalGenerationReport(result);
}

async function verifyEvolutionLedgerIntegrity(runtime, args) {
  const result = await verifyProposalArtifacts({
    runtime,
    limit: ensureLimit(args.limit, 20),
    repair: args.repair === true,
    dryRun: args.dryRun === true,
  });
  return formatIntegrityReport(result);
}

function summarizeEvolutionLedger(runtime, args) {
  const limit = ensureLimit(args.limit, 10);
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

function buildScopeOverrideRequest(args, runtime, invocation) {
  const action = args.action === "clear" ? "clear" : "set";
  const dryRun = args.dryRun !== false;
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  const scope = readOptionalTrimmedString(args.scope);
  if (!dryRun && reason.length === 0) {
    throw new Error("reason is required when dryRun is false");
  }
  if (action === "set" && !scope) {
    throw new Error("scope is required when action is set");
  }
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

function previewScopeOverride(runtime, request) {
  return runtime.db.previewScopeChanges({
    targetType: request.targetType,
    ids: request.ids,
    action: request.action,
    scope: request.scope,
    repository: request.repository,
  });
}

function applyScopeOverride(runtime, request) {
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

function buildOnboardingInputArgs(args, onboardingState, sessionId) {
  return {
    existingState: onboardingState,
    userName: readOptionalTrimmedString(args.userName) ? ensureString(args.userName, "userName") : undefined,
    assistantName: readOptionalTrimmedString(args.assistantName) ?? undefined,
    profile: buildOnboardingProfileArgs(args),
    sessionId,
  };
}

function persistOnboardingMemories(db, memories) {
  for (const memory of memories) {
    db.insertSemanticMemory(memory);
  }
}

function formatOnboardingResult(args, built) {
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

function applyRetainDomainContext({ runtime, args, repository, scope, domainKey }) {
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

function buildWorkstreamRetainPayload(args, { repository, scope, invocation }) {
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

function buildSemanticRetainPayload(args, { repository, scope, domainKey, invocation }) {
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

function formatRetainResult(retained, kind) {
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

function normalizeReflectionRequest(args, runtime) {
  return {
    prompt: ensureString(args.prompt, "prompt"),
    detailLevel: args.detailLevel === "full" || args.detailLevel === "evidence"
      ? args.detailLevel
      : "summary",
    includeOtherRepositories: args.includeOtherRepositories === true,
    limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit),
    focus: typeof args.focus === "string" ? args.focus : null,
  };
}

function getReflectionDomainKey(args) {
  return typeof args.domainKey === "string" && args.domainKey.trim().length > 0
    ? args.domainKey.trim().toLowerCase()
    : null;
}

function maybePersistReflectionObservation({ runtime, reflection, request, args }) {
  if (args.persistObservation !== true) {
    return null;
  }
  if (!readRefreshableObservationsEnabled(runtime.config)) {
    return "refreshable observations rollout is disabled";
  }
  const domainKey = getReflectionDomainKey(args);
  if (domainKey && !readMemoryDomainsEnabled(runtime.config)) {
    return "memory domains rollout is disabled";
  }
  const observationKey = runtime.db.upsertObservation({
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
  });
  return `Saved observation ${observationKey}.`;
}

function normalizeBackfillRequest(args, runtime) {
  const mode = args.mode === "controlled" ? "controlled" : "legacy";
  return {
    mode,
    limit: ensureLimit(args.limit, mode === "controlled" ? 20 : runtime.config.limits.recentSessionsFallbackLimit),
    batchSize: ensureLimit(args.batchSize, 5),
    includeOtherRepositories: args.includeOtherRepositories === true,
    refreshExisting: mode === "controlled"
      ? args.refreshExisting !== false
      : args.refreshExisting === true,
  };
}

const PORTABLE_BUNDLE_VERSION = 1;
function formatRecallSummary(trace) {
  return Object.entries(trace?.lookups ?? {})
    .map(([name, lookup]) => {
      const matched = Array.isArray(lookup?.rows)
        ? lookup.rows.length
        : Array.isArray(lookup?.rankedRows)
          ? lookup.rankedRows.length
          : 0;
      const included = Array.isArray(lookup?.includedRows) ? lookup.includedRows.length : 0;
      return `- ${name}: matched=${matched} included=${included}${lookup?.reason ? ` reason=${lookup.reason}` : ""}`;
    })
    .join("\n");
}

function formatRecallReport(result, { includeTrace = false } = {}) {
  const lines = [
    `repository: ${result.repository ?? "global-only"}`,
    `estimatedTokens: ${result.estimatedTokens ?? 0}`,
    `sections: ${(result.trace?.output?.sectionTitles ?? []).join(", ") || "none"}`,
    "",
    "## Context",
    "",
    result.text || "No context.",
  ];
  if (includeTrace) {
    lines.push(
      "",
      "## Lookup Summary",
      "",
      formatRecallSummary(result.trace) || "- none",
    );
  }
  return lines.join("\n");
}

function formatRecallEnvelope(result, { detailLevel = "context", includeTrace = false } = {}) {
  const lines = [formatRecallReport(result, { includeTrace })];
  if (detailLevel === "context") {
    return lines.join("\n");
  }

  const envelope = buildRecallEnvelope(result);
  lines.push("", "## Supporting Facts", "");
  if (envelope.supportingFacts.length === 0) {
    lines.push("- none");
  } else {
    lines.push(...envelope.supportingFacts.map((fact) => `- ${fact}`));
  }

  lines.push("", "## Lookup Evidence", "");
  if (envelope.lookups.length === 0) {
    lines.push("- none");
  } else {
    for (const lookup of envelope.lookups) {
      lines.push(
        `- ${lookup.name}: matched=${lookup.matchedCount} included=${lookup.includedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
      );
      const samples = lookup.includedRows.length > 0 ? lookup.includedRows : lookup.matchedRows;
      for (const sample of samples.slice(0, 2)) {
        lines.push(`  - ${sample}`);
      }
      if (detailLevel === "full" && lookup.rankedRows.length > 0) {
        lines.push("  - ranking:");
        for (const sample of lookup.rankedRows.slice(0, 2)) {
          lines.push(`    - ${sample}`);
        }
      }
      if (lookup.filteredReasons.length > 0) {
        lines.push(`  - filtered: ${lookup.filteredReasons.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

function humanizeFocus(value) {
  return String(value || "summary")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function humanizeLookupLabel(value) {
  return String(value || "lookup")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

function formatReflectionReport(result, { detailLevel = "summary" } = {}) {
  const lines = [
    ...buildReflectionHeaderLines(result),
    ...buildReflectionInsightLines(result),
  ];

  if (detailLevel === "summary") {
    return lines.join("\n");
  }

  lines.push(...buildReflectionEvidenceLines(result));
  if (detailLevel !== "full") {
    return lines.join("\n");
  }

  lines.push(...buildReflectionLookupCoverageLines(result));
  return lines.join("\n");
}

function buildReflectionHeaderLines(result) {
  return [
    `repository: ${result.repository ?? "global-only"}`,
    `focus: ${humanizeFocus(result.focus)}`,
    `estimatedTokens: ${result.recall?.estimatedTokens ?? 0}`,
    `sections: ${(result.envelope?.sections ?? []).join(", ") || "none"}`,
    "",
    "## Reflection",
    "",
    result.summary,
    "",
    "## Key Insights",
    "",
  ];
}

function buildReflectionInsightLines(result) {
  if (!Array.isArray(result.insights) || result.insights.length === 0) {
    return ["- none"];
  }
  return result.insights.map((insight) => `- ${insight.text}${insight.source ? ` (${insight.source})` : ""}`);
}

function buildReflectionEvidenceLines(result) {
  return [
    "",
    "## Supporting Evidence",
    "",
    ...formatReflectionFactLines(result.envelope?.supportingFacts),
    "",
    "## Source Accounting",
    "",
    ...formatReflectionSourceAccountingLines(result.envelope?.sourceAccounting),
  ];
}

function formatReflectionFactLines(facts) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return ["- none"];
  }
  return facts.map((fact) => `- ${fact}`);
}

function formatReflectionSourceAccountingLines(sourceAccounting) {
  if (!Array.isArray(sourceAccounting) || sourceAccounting.length === 0) {
    return ["- none"];
  }
  return sourceAccounting.map((section) => (
    `- ${section.title}: source=${section.source ?? "unknown"} entries=${section.entryCount ?? 0} tokens=${section.usedTokens ?? 0}${section.budget ? `/${section.budget}` : ""}`
  ));
}

function buildReflectionLookupCoverageLines(result) {
  const lookups = Array.isArray(result.envelope?.lookups) ? result.envelope.lookups : [];
  return [
    "",
    "## Lookup Coverage",
    "",
    ...(lookups.length === 0 ? ["- none"] : lookups.flatMap((lookup) => formatReflectionLookupLines(lookup))),
  ];
}

function formatReflectionLookupLines(lookup) {
  return [
    `- ${humanizeLookupLabel(lookup.name)}: matched=${lookup.matchedCount} included=${lookup.includedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
    ...formatReflectionLookupSamples(lookup),
    ...(lookup.filteredReasons.length > 0 ? [`  - filtered: ${lookup.filteredReasons.join(", ")}`] : []),
  ];
}

function formatReflectionLookupSamples(lookup) {
  const includedEntries = lookup.includedEntries.slice(0, 2).map((sample) => `  - ${sample.text}`);
  if (includedEntries.length > 0) {
    return includedEntries;
  }
  return lookup.matchedEntries.slice(0, 1).map((sample) => `  - ${sample.text}`);
}

function formatAuditRows(rows) {
  return formatRows(rows, (row) => [
    `- [${row.action}] ${row.target_type}:${row.target_id}`,
    `prev=${row.previous_scope ?? "none"}(${row.previous_repository ?? "global"})`,
    `next=${row.next_scope ?? "none"}(${row.next_repository ?? "global"})`,
    `actor=${row.actor}`,
    `source=${row.source}`,
    `reason=${row.reason}`,
    `at=${row.created_at}`,
  ].join(" "));
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

function formatBackfillRunRows(rows) {
  return formatRows(rows, (row) => [
    ...formatBackfillProgressKeyValues(summarizeBackfillRunProgress(row)),
    `- ${row.id}`,
    `status=${row.status}`,
    `processed=${row.processed_count}/${row.total_candidates}`,
    `snapshot=${row.snapshot_path ?? "none"}`,
  ].join(" "));
}

function formatBackfillItems(rows) {
  return formatRows(rows, (row) => [
    `- ${row.session_id}`,
    `planned=${row.planned_action}`,
    `status=${row.status}`,
    row.episode_before_scope || row.episode_after_scope
      ? `episode=${row.episode_before_scope ?? "none"}->${row.episode_after_scope ?? "none"}`
      : null,
    Number.isInteger(row.semantic_delta) ? `semanticDelta=${row.semantic_delta}` : null,
    row.error ? `error=${row.error}` : null,
  ].filter(Boolean).join(" "));
}

function formatBackfillProgressKeyValues(progress) {
  return [
    `progressTotalCount: ${progress.totalCount}`,
    `progressCompletedCount: ${progress.completedCount}`,
    `progressCreatedCount: ${progress.createdCount}`,
    `progressRefreshedCount: ${progress.refreshedCount}`,
    `progressFailedCount: ${progress.failedCount}`,
    `progressSkippedCount: ${progress.skippedCount}`,
    `progressPendingCount: ${progress.pendingCount}`,
    `progressRunningCount: ${progress.runningCount}`,
    `progressPercent: ${progress.progressPercent}`,
    `currentPhase: ${progress.currentPhase}`,
  ];
}

function formatControlledBackfillPreview(preview) {
  const progress = summarizeBackfillPreviewProgress(preview);
  return [
    `dryRun: ${preview.dryRun === true}`,
    `repository: ${preview.repository ?? "all"}`,
    `inspected: ${preview.inspected}`,
    `skippedExisting: ${preview.skippedExisting}`,
    `candidateCount: ${preview.candidates.length}`,
    ...formatBackfillProgressKeyValues(progress),
    "",
    "## Candidates",
    "",
    formatRows(preview.candidates, (candidate) => [
      `- ${candidate.sessionId}`,
      `planned=${candidate.plannedAction}`,
      `repository=${candidate.repository ?? "unknown"}`,
      candidate.updatedAt ? `updated=${candidate.updatedAt}` : null,
      candidate.summary ? `summary=${candidate.summary}` : null,
    ].filter(Boolean).join(" ")),
  ].join("\n");
}

function determineMaintenancePhase(result) {
  if (result.dryRun === true) {
    return "planning";
  }
  switch (result.status) {
    case "disabled":
      return "disabled";
    case "failed":
      return "failed";
    case "needs_attention":
      return "attention";
    case "completed":
      return "complete";
    case "planned":
      return "planning";
    case "skipped":
      return "idle";
    default:
      return "processing";
  }
}

function summarizeMaintenanceProgress(result) {
  const totalCount = Number(result.taskCount ?? 0);
  const completedCount = Number(result.completedCount ?? 0);
  const needsAttentionCount = Number(result.needsAttentionCount ?? 0);
  const failedCount = Number(result.failedCount ?? 0);
  const skippedCount = Number(result.skippedCount ?? 0);
  const terminalCount = completedCount + needsAttentionCount + failedCount + skippedCount;
  const pendingCount = Math.max(0, totalCount - terminalCount);
  const progressPercent = totalCount > 0
    ? Math.min(100, Math.max(0, Math.round((terminalCount / totalCount) * 100)))
    : 100;
  const currentPhase = determineMaintenancePhase(result);
  return {
    totalCount,
    completedCount,
    needsAttentionCount,
    failedCount,
    skippedCount,
    pendingCount,
    progressPercent,
    currentPhase,
  };
}

function formatControlledBackfillRun(run, items = []) {
  const progress = summarizeBackfillRunProgress(run);
  return [
    `runId: ${run.id}`,
    `status: ${run.status}`,
    `repository: ${run.repository ?? "all"}`,
    ...formatBackfillProgressKeyValues(progress),
    `batchSize: ${run.batch_size}`,
    `snapshotPath: ${run.snapshot_path ?? "none"}`,
    `startedAt: ${run.started_at}`,
    `updatedAt: ${run.updated_at}`,
    `completedAt: ${run.completed_at ?? "not complete"}`,
    "",
    "## Item Summary",
    "",
    formatBackfillItems(items),
  ].join("\n");
}

function runControlledBackfillAction({ runtime, request, args }) {
  const action = typeof args.action === "string" ? args.action : "preview";
  if (action === "preview") {
    const preview = previewControlledBackfill({
      db: runtime.db,
      sessionStore: runtime.sessionStore,
      repository: runtime.repository,
      includeOtherRepositories: request.includeOtherRepositories,
      limit: request.limit,
      refreshExisting: request.refreshExisting,
    });
    return formatControlledBackfillPreview(preview);
  }
  if (action === "start") {
    const result = startControlledBackfillRun({
      db: runtime.db,
      sessionStore: runtime.sessionStore,
      repository: runtime.repository,
      includeOtherRepositories: request.includeOtherRepositories,
      limit: request.limit,
      refreshExisting: request.refreshExisting,
      batchSize: request.batchSize,
      snapshotPolicy: "auto",
    });
    return [
      `Started controlled backfill run ${result.runId}.`,
      "",
      formatControlledBackfillRun(result.run, result.items),
    ].join("\n");
  }
  if (action === "resume") {
    const runId = ensureString(args.runId, "runId");
    const result = processControlledBackfillRun({
      db: runtime.db,
      sessionStore: runtime.sessionStore,
      runId,
      limit: request.batchSize,
      retryFailed: args.retryFailed === true,
    });
    return [
      `Processed controlled backfill run ${runId}.`,
      "",
      formatControlledBackfillRun(result.run, result.items),
    ].join("\n");
  }
  if (action === "status") {
    return formatBackfillStatus(runtime, args, request.batchSize);
  }
  if (action === "restore") {
    const runId = ensureString(args.runId, "runId");
    const restored = restoreControlledBackfillRun({
      db: runtime.db,
      runId,
    });
    return [
      `Restored lore.db from snapshot for run ${runId}.`,
      `snapshotPath: ${restored.snapshotPath}`,
      `schemaVersion: ${restored.schemaVersion}`,
    ].join("\n");
  }
  throw new Error(`unsupported controlled backfill action: ${action}`);
}

function formatBackfillStatus(runtime, args, batchSize) {
  if (typeof args.runId === "string" && args.runId.trim().length > 0) {
    const runId = args.runId.trim();
    const run = runtime.db.getBackfillRun(runId);
    if (!run) {
      throw new Error(`backfill run not found: ${runId}`);
    }
    const items = runtime.db.listBackfillRunItems({ runId, limit: Math.max(batchSize, 10) });
    return formatControlledBackfillRun(run, items);
  }
  const runs = runtime.db.listBackfillRuns({ limit: Math.max(batchSize, 10) });
  return [
    "## Backfill Runs",
    "",
    formatBackfillRunRows(runs),
  ].join("\n");
}

function runLegacyBackfill({ runtime, request }) {
  const sessions = runtime.sessionStore.getRecentSessions({
    repository: request.includeOtherRepositories ? null : runtime.repository,
    limit: request.limit,
  });

  let created = 0;
  for (const candidate of sessions) {
    if (!request.refreshExisting && runtime.db.hasEpisodeDigest(candidate.id)) {
      continue;
    }
    const artifacts = runtime.sessionStore.getSessionArtifacts(candidate.id);
    if (!artifacts) {
      continue;
    }
    applySessionExtraction({
      db: runtime.db,
      sessionId: candidate.id,
      repository: candidate.repository ?? runtime.repository,
      sessionArtifacts: artifacts,
      workspace: { workspace: null },
    });
    created += 1;
  }

  return request.refreshExisting
    ? `Backfilled or refreshed ${created} session(s).`
    : `Backfilled ${created} session(s).`;
}

function compareOverlayState(left, right) {
  const leftActive = left.status !== "done";
  const rightActive = right.status !== "done";
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

function formatWorkstreamOverlayStatus(runtime) {
  const rows = runtime.db.searchSemantic({
    query: "",
    repository: runtime.repository,
    includeOtherRepositories: false,
    types: [WORKSTREAM_MEMORY_TYPE],
    limit: 5,
  });
  const overlays = rows
    .map(parseWorkstreamOverlayMemory)
    .sort(compareOverlayState)
    .slice(0, 3);
  if (overlays.length === 0) {
    return ["activeWorkstreams: none"];
  }
  return overlays.map((overlay, index) => [
    `activeWorkstream${index + 1}: ${overlay.title}`,
    `[${overlay.status}]`,
    overlay.blockers.length > 0 ? `blockers=${overlay.blockers.length}` : null,
    overlay.nextActions.length > 0 ? `nextActions=${overlay.nextActions.length}` : null,
  ].filter(Boolean).join(" "));
}

function formatLatencyMetric(prefix, metric) {
  const normalized = normalizeLatencyMetric(metric);
  return [
    formatLatencyMetricLine(prefix, "P50Ms", normalized.p50Ms),
    formatLatencyMetricLine(prefix, "P95Ms", normalized.p95Ms),
    formatLatencyMetricLine(prefix, "AverageMs", normalized.averageMs),
    formatLatencyMetricLine(prefix, "MaxMs", normalized.maxMs),
    formatLatencyMetricLine(prefix, "LatestMs", normalized.latestMs),
    formatLatencyMetricLine(prefix, "Samples", normalized.samples),
    formatLatencyMetricLine(prefix, "P95Readiness", normalized.readiness),
    formatLatencyMetricLine(prefix, "MinSamplesForP95", normalized.minSamples),
    formatLatencyMetricLine(prefix, "TargetMs", normalized.targetMs),
    formatLatencyMetricLine(prefix, "TargetStatus", normalized.targetStatus),
    formatLatencyMetricLine(prefix, "RecentAverageMs", normalized.recentAverageMs),
    formatLatencyMetricLine(prefix, "PreviousAverageMs", normalized.previousAverageMs),
    formatLatencyMetricLine(prefix, "Trend", normalized.trend),
    formatLatencyMetricLine(prefix, "TrendDeltaMs", normalized.trendDeltaMs),
  ];
}

function formatLatencyMetricLine(prefix, suffix, value) {
  return `${prefix}${suffix}: ${value}`;
}

function normalizeLatencyMetric(metric) {
  const {
    p50Ms = 0,
    p95Ms = 0,
    averageMs = 0,
    maxMs = 0,
    latestMs = 0,
    samples = 0,
    readiness = "unknown",
    minSamples = 0,
    targetMs = 0,
    targetStatus = "unknown",
    recentAverageMs = 0,
    previousAverageMs = 0,
    trend = "unknown",
    trendDeltaMs = 0,
  } = metric ?? {};
  return {
    p50Ms,
    p95Ms,
    averageMs,
    maxMs,
    latestMs,
    samples,
    readiness,
    minSamples,
    targetMs,
    targetStatus,
    recentAverageMs,
    previousAverageMs,
    trend,
    trendDeltaMs,
  };
}

function formatTraceRecorderRoutes(routes) {
  return ensureArray(routes).length > 0
    ? ensureArray(routes).map((entry) => `${entry.route} x${entry.count}`).join(", ")
    : "none";
}

function formatTraceRecorderLookups(lookups) {
  return ensureArray(lookups).length > 0
    ? ensureArray(lookups)
      .slice(0, 5)
      .map((entry) => `${entry.name} included=${entry.includedCount}/${entry.seenCount} matched=${entry.matchedCount}/${entry.seenCount} dropped=${entry.droppedCount}`)
      .join(" | ")
    : "none";
}

function formatTraceRecorderPatterns(patterns) {
  return ensureArray(patterns).length > 0
    ? ensureArray(patterns).slice(0, 5).map((entry) => `${entry.label} x${entry.count}`).join(", ")
    : "none";
}

function formatActivityStates(states) {
  if (ensureArray(states).length === 0) {
    return ["- none"]; 
  }
  return ensureArray(states).map((state) => {
    const sections = ensureArray(state.lastContextInjectionSections).join(", ") || "none";
    return [
      `- [${state.scopeKey}] scope=${state.scopeType}`,
      state.repository ? `repository=${state.repository}` : null,
      `lastContextInjectionAt=${state.lastContextInjectionAt ?? "none"}`,
      `lastContextHook=${state.lastContextInjectionHook ?? "none"}`,
      `lastContextSections=${sections}`,
      `lastExtractionCompletionAt=${state.lastExtractionCompletionAt ?? "none"}`,
      `lastMaintenanceCompletionAt=${state.lastMaintenanceCompletionAt ?? "none"}`,
      `lastMaintenanceStatus=${state.lastMaintenanceStatus ?? "none"}`,
      `lastTraceRecordedAt=${state.lastTraceRecordedAt ?? "none"}`,
      `lastTraceHook=${state.lastTraceHook ?? "none"}`,
      `updatedAt=${state.updatedAt ?? "none"}`,
    ].filter(Boolean).join(" ");
  });
}

function formatRetrievalTraceSampleRows(rows) {
  return formatRows(rows, (row) => [
    `- [${row.id}] hook=${row.hook}`,
    row.repository ? `repository=${row.repository}` : "repository=global",
    row.route ? `route=${row.route}` : null,
    row.routeReason ? `reason=${row.routeReason}` : null,
    `contextInjected=${row.contextInjected === true}`,
    row.latencyMs != null ? `latency=${row.latencyMs}ms` : null,
    `sections=${ensureArray(row.sectionTitles).join(",") || "none"}`,
    `recordedAt=${row.recordedAt}`,
    row.promptPreview ? `prompt=${row.promptPreview}` : null,
  ].filter(Boolean).join(" "));
}

function formatTrajectoryArtifactRows(rows) {
  return formatRows(rows, (row) => {
    const contextKeys = Object.keys(row.context ?? {});
    return [
      `- [${row.id}] kind=${row.kind}`,
      row.source_kind ? `source=${row.source_kind}:${row.source_case_id ?? "n/a"}` : null,
      `severity=${row.severity}`,
      `outcome=${row.outcome}`,
      row.latency_ms != null ? `latency=${row.latency_ms}ms` : null,
      row.target_ms != null ? `target=${row.target_ms}ms` : null,
      row.improvement_artifact_id ? `improvementArtifact=${row.improvement_artifact_id}` : null,
      row.event_key ? `event=${row.event_key}` : null,
      contextKeys.length > 0 ? `contextKeys=${contextKeys.join(",")}` : null,
      `summary=${row.summary}`,
      `created=${row.created_at}`,
    ].filter(Boolean).join(" ");
  });
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
function formatDoctorReport(result) {
  if (!result.incidentCount) {
    return [
      `# Lore Doctor Report`,
      `generatedAt: ${result.generatedAt}`,
      `repository: ${result.repository ?? "global"}`,
      `incidents: 0 — no incidents classified`,
      `signals: maintenanceTasks=${result.signals.maintenanceTaskCount} trajectoryScanned=${result.signals.trajectoryRecentCount}`,
    ].join("\n");
  }
  const header = [
    `# Lore Doctor Report`,
    `generatedAt: ${result.generatedAt}`,
    `repository: ${result.repository ?? "global"}`,
    `incidents: ${result.incidentCount} (critical=${result.criticalCount} warning=${result.warningCount} info=${result.infoCount})`,
    `signals: maintenanceTasks=${result.signals.maintenanceTaskCount} trajectoryScanned=${result.signals.trajectoryRecentCount} improvementActive=${result.signals.improvementActiveCount}`,
    result.recordedArtifactId ? `recordedArtifact: ${result.recordedArtifactId}` : null,
    ``,
    `## Incidents`,
    ``,
  ].filter((line) => line != null).join("\n");
  const incidentLines = result.incidents.map((inc) => {
    const contextPairs = Object.entries(inc.context ?? {})
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
      .join(" ");
    return `- [${inc.severity}] ${inc.kind}: ${inc.summary}${contextPairs ? `\n  context: ${contextPairs}` : ""}`;
  });
  return [header, ...incidentLines].join("\n");
}

function formatDoctorSafetyGateSection(result) {
  const lines = ["", "## Safety Gate (observe-only)", ""];
  if (!result || result.actionCount === 0) {
    lines.push("actions: 0");
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(`actions: ${result.actionCount}`);
  lines.push(`highestRisk: ${result.highestRisk}`);
  lines.push(
    `riskCounts: low=${result.riskCounts.low} moderate=${result.riskCounts.moderate} high=${result.riskCounts.high} critical=${result.riskCounts.critical}`,
  );
  lines.push("");
  for (const action of ensureArray(result.actions)) {
    const reasons = ensureArray(action.riskReasons).join(",");
    lines.push(
      [
        `- [${action.riskTier}] ${action.toolName}.${action.operation}`,
        `id=${action.id}`,
        action.target ? `target=${action.target}` : null,
        `mutability=${action.mutability}`,
        `reversibility=${action.reversibility}`,
        `scope=${action.scope}`,
        `riskScore=${action.riskScore}`,
        reasons ? `riskReasons=${reasons}` : null,
      ].filter(Boolean).join(" "),
    );
  }
  return lines.join("\n");
}

function formatReviewGateReport(result) {
  const lines = [
    `# Review Gate — proposal_doc`,
    `generatedAt: ${result.generatedAt}`,
    `wordCount: ${result.wordCount}`,
    result.findingCount === 0
      ? `findings: 0 — all required sections present`
      : `findings: ${result.findingCount}`,
    result.recordedArtifactId ? `recordedArtifact: ${result.recordedArtifactId}` : null,
  ].filter((l) => l != null);
  if (result.findingCount > 0) {
    lines.push(``, `## Findings`, ``);
    for (const f of result.findings) {
      lines.push(`- [${f.severity}] ${f.section}: ${f.detail}`);
    }
  }
  return lines.join("\n");
}

function buildMemoryStatusIdentityLines(runtime, stats) {
  return [
    `enabled: ${runtime.config.enabled}`,
    `repository: ${runtime.repository ?? "global-only"}`,
    `dbPath: ${stats.dbPath}`,
    `schemaVersion: ${stats.schemaVersion}`,
    `semanticCount: ${stats.semanticCount}`,
    `episodeCount: ${stats.episodeCount}`,
    `semanticGlobalCount: ${stats.semanticGlobalCount}`,
    `semanticTransferableCount: ${stats.semanticTransferableCount}`,
    `semanticRepoCount: ${stats.semanticRepoCount}`,
    `semanticManualCount: ${stats.semanticManualCount}`,
    `episodeTransferableCount: ${stats.episodeTransferableCount}`,
    `episodeRepoCount: ${stats.episodeRepoCount}`,
    `episodeManualCount: ${stats.episodeManualCount}`,
    `daySummaryCount: ${stats.daySummaryCount}`,
    `overrideAuditCount: ${stats.overrideAuditCount}`,
    `semanticCanonicalCount: ${stats.semanticCanonicalCount ?? 0}`,
    `semanticReinforcedCount: ${stats.semanticReinforcedCount ?? 0}`,
    `assistantGoalCount: ${stats.assistantGoalCount ?? 0}`,
    `recurringMistakeCount: ${stats.recurringMistakeCount ?? 0}`,
    `userIdentityCount: ${stats.userIdentityCount ?? 0}`,
    `workstreamOverlayCount: ${stats.workstreamOverlayCount ?? 0}`,
    `domainCount: ${stats.domainCount ?? 0}`,
    `observationCount: ${stats.observationCount ?? 0}`,
    `directiveCount: ${stats.directiveCount ?? 0}`,
  ];
}

function buildMemoryStatusRolloutLines(runtime, maintenance) {
  return [
    `memoryOperationsEnabled: ${readMemoryOperationsEnabled(runtime.config)}`,
    `memoryDomainsEnabled: ${readMemoryDomainsEnabled(runtime.config)}`,
    `refreshableObservationsEnabled: ${readRefreshableObservationsEnabled(runtime.config)}`,
    `workstreamOverlaysEnabled: ${readWorkstreamOverlaysEnabled(runtime.config)}`,
    `directivesEnabled: ${readDirectivesEnabled(runtime.config)}`,
    `temporalQueryNormalizationEnabled: ${readTemporalQueryNormalizationEnabled(runtime.config)}`,
    `retentionSanitizationEnabled: ${readRetentionSanitizationEnabled(runtime.config)}`,
    `traceRecorderEnabled: ${readTraceRecorderEnabled(runtime.config)}`,
    `evolutionLedgerEnabled: ${readEvolutionLedgerEnabled(runtime.config)}`,
    `proposalGenerationEnabled: ${readProposalGenerationEnabled(runtime.config)}`,
    `generatedArtifactIntegrityEnabled: ${readGeneratedArtifactIntegrityEnabled(runtime.config)}`,
    `maintenanceEnabled: ${maintenance.enabled}`,
    `maintenanceAutoRunOnSessionStart: ${maintenance.autoRunOnSessionStart}`,
    `maintenanceMaxTasksPerRun: ${maintenance.maxTasksPerRun}`,
    `maintenanceDueTaskCount: ${maintenance.dueTasks.length}`,
    `maintenanceSelectedTaskCount: ${maintenance.selectedTasks.length}`,
    `maintenanceSkippedDueToCap: ${maintenance.skippedDueToCap}`,
    ...formatWorkstreamOverlayStatus(runtime),
  ];
}

function deriveMemoryStatusActivityPhases(stats) {
  const deferredActionableCount = (stats.deferredPendingCount ?? 0) + (stats.deferredFailedCount ?? 0);
  const deferredCurrentPhase = (stats.deferredRunningCount ?? 0) > 0
    ? "processing"
    : deferredActionableCount > 0
      ? "queued"
      : "idle";
  const backfillCurrentPhase = (stats.backfillRunningCount ?? 0) > 0 ? "processing" : "idle";
  return {
    deferredActionableCount,
    deferredCurrentPhase,
    backfillCurrentPhase,
  };
}

function buildMemoryStatusLifecycleLines(stats, phases) {
  return [
    `backfillRunningCount: ${stats.backfillRunningCount}`,
    `backfillCompletedCount: ${stats.backfillCompletedCount}`,
    `backfillFailedCount: ${stats.backfillFailedCount}`,
    `backfillDryRunCount: ${stats.backfillDryRunCount}`,
    `backfillCurrentPhase: ${phases.backfillCurrentPhase}`,
    `deferredPendingCount: ${stats.deferredPendingCount}`,
    `deferredRunningCount: ${stats.deferredRunningCount}`,
    `deferredFailedCount: ${stats.deferredFailedCount}`,
    `deferredCompletedCount: ${stats.deferredCompletedCount}`,
    `deferredActionableCount: ${phases.deferredActionableCount}`,
    `deferredCurrentPhase: ${phases.deferredCurrentPhase}`,
  ];
}

const MEMORY_STATUS_IMPROVEMENT_FIELDS = [
  ["improvementCount", 0],
  ["improvementActiveCount", 0],
  ["improvementResolvedCount", 0],
  ["improvementSupersededCount", 0],
  ["improvementProposalCount", 0],
  ["draftProposalCount", 0],
  ["approvedProposalCount", 0],
  ["rejectedProposalCount", 0],
  ["supersededProposalCount", 0],
  ["maintenanceCompletedCount", 0],
  ["maintenanceNeedsAttentionCount", 0],
  ["maintenanceFailedCount", 0],
  ["maintenanceSkippedCount", 0],
  ["maintenanceTaskStateCount", 0],
  ["lastMaintenanceStatus", "none"],
  ["lastMaintenanceStartedAt", "none"],
  ["lastMaintenanceCompletedAt", "none"],
];

const MEMORY_STATUS_TRACE_ARTIFACT_FIELDS = [
  ["trajectoryArtifactCount", 0],
  ["trajectoryReplayFailureCount", 0],
  ["trajectoryValidationMissCount", 0],
  ["trajectoryProposalFailureCount", 0],
  ["trajectoryLatencyOutlierCount", 0],
  ["retrievalTraceSampleCount", 0],
  ["retrievalTraceSampleRepositoryCount", 0],
  ["retrievalTraceSampleGlobalCount", 0],
  ["intentJournalCount", 0],
  ["intentRoutingCount", 0],
  ["intentRolloutCount", 0],
  ["intentReviewerCount", 0],
  ["intentFallbackCount", 0],
  ["intentSerendipityCount", 0],
  ["lastBackupPath", "none"],
];

function formatStatusFieldLines(source, fields) {
  return fields.map(([label, fallback]) => `${label}: ${source[label] ?? fallback}`);
}

function buildMemoryStatusImprovementLines(stats) {
  return formatStatusFieldLines(stats, MEMORY_STATUS_IMPROVEMENT_FIELDS);
}

function buildMemoryStatusTraceArtifactLines(runtime, stats) {
  return [
    ...formatStatusFieldLines(stats, MEMORY_STATUS_TRACE_ARTIFACT_FIELDS),
    `configPath: ${runtime.config.configPath}`,
  ];
}

function buildMemoryStatusMetricLines(runtime) {
  return [
    ...formatLatencyMetric("sessionStart", runtime.metrics.sessionStart),
    ...formatLatencyMetric("userPromptSubmitted", runtime.metrics.userPromptSubmitted),
  ];
}

function formatTraceRecorderHooks(hooks) {
  return ensureArray(hooks).map((entry) => [
    `traceHook:${entry.hook}`,
    `samples=${entry.samples}`,
    `withContext=${entry.withContextCount}`,
    `withoutContext=${entry.withoutContextCount}`,
    `p50=${entry.p50Ms}`,
    `p95=${entry.p95Ms}`,
    `avg=${entry.averageMs}`,
    `max=${entry.maxMs}`,
    `trend=${entry.trend}`,
    `delta=${entry.trendDeltaMs}`,
  ].join(" "));
}

function formatTraceLookupSamples(rows) {
  return ensureArray(rows)
    .map((row) => {
      const label = row?.type ? `[${row.type}] ` : "";
      const repository = row?.repository ? ` (${row.repository})` : "";
      return `${label}${row?.text ?? ""}${repository}`;
    })
    .filter(Boolean);
}

function formatTracePromptNeedLines(promptNeed) {
  if (!promptNeed) {
    return [];
  }
  return [
    `- promptNeed.requiresLookup: ${promptNeed.requiresLookup === true}`,
    `- promptNeed.wantsContinuity: ${promptNeed.wantsContinuity === true}`,
    `- promptNeed.allowCrossRepoFallback: ${promptNeed.allowCrossRepoFallback === true}`,
    `- promptNeed.identityOnly: ${promptNeed.identityOnly === true}`,
  ];
}

function formatRecentTraceLookupLines(lookups) {
  const lookupEntries = Object.entries(lookups ?? {});
  if (lookupEntries.length === 0) {
    return ["  - none"];
  }
  return lookupEntries.flatMap(([name, lookup]) => {
    const lines = [
      `  - ${name}: matched=${lookup.matchedCount} included=${lookup.includedCount} dropped=${lookup.droppedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
    ];
    for (const sample of formatTraceLookupSamples(lookup.includedRows).slice(0, 2)) {
      lines.push(`    - included: ${sample}`);
    }
    for (const sample of formatTraceLookupSamples(lookup.matchedRows).slice(0, 1)) {
      lines.push(`    - matched: ${sample}`);
    }
    for (const dropped of ensureArray(lookup.droppedRows).slice(0, 1)) {
      const rowText = dropped?.row?.text ? ` — ${dropped.row.text}` : "";
      lines.push(`    - dropped: ${dropped.stage}:${dropped.reason}${rowText}`);
    }
    return lines;
  });
}

function buildRecentTraceHeaderLines(record) {
  return [
    `### ${record.id}`,
    `- hook: ${record.hook}`,
    `- recordedAt: ${record.recordedAt}`,
    `- repository: ${record.repository ?? "global-only"}`,
    `- prompt: ${record.promptPreview || "none"}`,
    `- latencyMs: ${record.latencyMs}`,
  ];
}

function formatRecentTraceList(values) {
  return ensureArray(values).join(", ") || "none";
}

function formatRecentTraceValue(value, fallback = "none") {
  return value ?? fallback;
}

function buildRecentTraceRoutingLines(record) {
  return [
    `- route: ${formatRecentTraceValue(record.routerDecision?.route, "unknown")}`,
    `- routeReason: ${formatRecentTraceValue(record.routerDecision?.reason)}`,
    `- contextInjected: ${record.output?.contextInjected === true}`,
    `- sectionTitles: ${formatRecentTraceList(record.output?.sectionTitles)}`,
    `- eligibility.local: ${formatRecentTraceList(record.eligibility?.local)}`,
    `- eligibility.crossRepo: ${formatRecentTraceList(record.eligibility?.crossRepo)}`,
  ];
}

function formatRecentTraceOptionalLines(record) {
  return [
    record.output?.injectedContextPreview
      ? `- injectedContextPreview: ${record.output.injectedContextPreview}`
      : null,
    ensureArray(record.omissions).length > 0
      ? `- omissions: ${ensureArray(record.omissions).map((item) => `${item.stage}:${item.reason}`).join(", ")}`
      : null,
  ].filter(Boolean);
}

function formatRecentTraceRecord(record) {
  return [
    ...buildRecentTraceHeaderLines(record),
    ...buildRecentTraceRoutingLines(record),
    ...formatTracePromptNeedLines(record.promptNeed),
    "- lookups:",
    ...formatRecentTraceLookupLines(record.lookups),
    ...formatRecentTraceOptionalLines(record),
  ];
}

function formatRecentTraceRecords(records) {
  if (ensureArray(records).length === 0) {
    return ["- none"];
  }

  const lines = [];
  for (const record of ensureArray(records)) {
    lines.push(...formatRecentTraceRecord(record));
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function formatMaintenanceTaskState(task) {
  return [
    `- ${task.label}`,
    `enabled=${task.enabled}`,
    `selected=${task.selected}`,
    `due=${task.due}`,
    `reason=${task.dueReason}`,
    `cadenceMinutes=${task.cadenceMinutes}`,
    task.lastRunMinutesAgo == null ? null : `lastRunMinutesAgo=${task.lastRunMinutesAgo}`,
    task.nextRunMinutes == null ? null : `nextRunMinutes=${task.nextRunMinutes}`,
    task.state?.last_status ? `lastStatus=${task.state.last_status}` : null,
    task.state?.last_completed_at ? `lastCompletedAt=${task.state.last_completed_at}` : null,
  ].filter(Boolean).join(" ");
}

function formatMaintenanceRunRows(runs) {
  return formatRows(runs, (run) => [
    `- ${run.id}`,
    `status=${run.status}`,
    `trigger=${run.trigger}`,
    `tasks=${ensureArray(run.plannedTasks).join(",") || "none"}`,
    `completed=${run.completed_count}`,
    `needsAttention=${run.needs_attention_count}`,
    `failed=${run.failed_count}`,
    `skipped=${run.skipped_count}`,
    `started=${run.started_at}`,
    run.completed_at ? `completedAt=${run.completed_at}` : null,
  ].filter(Boolean).join(" "));
}

function formatMaintenanceTaskResult(task) {
  const summary = task.summary ?? {};
  const caseIds = ensureArray(summary.caseIds);
  return [
    `- ${task.label}`,
    `status=${task.status}`,
    `durationMs=${task.durationMs}`,
    caseIds.length > 0 ? `cases=${caseIds.join(",")}` : null,
    typeof summary.processed === "number" ? `processed=${summary.processed}` : null,
    typeof summary.failed === "number" ? `failed=${summary.failed}` : null,
    typeof summary.staleCount === "number" ? `stale=${summary.staleCount}` : null,
    typeof summary.incidentCount === "number" ? `incidents=${summary.incidentCount}` : null,
    typeof summary.warningCount === "number" ? `warnings=${summary.warningCount}` : null,
    typeof summary.criticalCount === "number" ? `critical=${summary.criticalCount}` : null,
    summary.recordedArtifactId ? `artifactId=${summary.recordedArtifactId}` : null,
    summary.error ? `error=${summary.error}` : null,
  ].filter(Boolean).join(" ");
}

function formatMaintenanceReport(result, { includeRecentRuns = false } = {}) {
  const progress = summarizeMaintenanceProgress(result);
  const lines = [
    `status: ${result.status}`,
    `dryRun: ${result.dryRun === true}`,
    `trigger: ${result.trigger}`,
    `repository: ${result.repository ?? "all"}`,
    `taskCount: ${result.taskCount}`,
    `completedCount: ${result.completedCount}`,
    `needsAttentionCount: ${result.needsAttentionCount}`,
    `failedCount: ${result.failedCount}`,
    `skippedCount: ${result.skippedCount}`,
    `progressTotalCount: ${progress.totalCount}`,
    `progressCompletedCount: ${progress.completedCount}`,
    `progressNeedsAttentionCount: ${progress.needsAttentionCount}`,
    `progressFailedCount: ${progress.failedCount}`,
    `progressSkippedCount: ${progress.skippedCount}`,
    `progressPendingCount: ${progress.pendingCount}`,
    `progressPercent: ${progress.progressPercent}`,
    `currentPhase: ${progress.currentPhase}`,
  ];

  if (result.runId) {
    lines.push(`runId: ${result.runId}`);
  }

  lines.push(
    "",
    "## Tasks",
    "",
    result.tasks.length > 0 ? result.tasks.map(formatMaintenanceTaskResult).join("\n") : "- none",
  );

  if (result.plan) {
    lines.push(
      "",
      "## Scheduler Plan",
      "",
      `enabled: ${result.plan.enabled}`,
      `autoRunOnSessionStart: ${result.plan.autoRunOnSessionStart}`,
      `maxTasksPerRun: ${result.plan.maxTasksPerRun}`,
      `dueTaskCount: ${result.plan.dueTasks.length}`,
      `skippedDueToCap: ${result.plan.skippedDueToCap}`,
      "",
      "## Task State",
      "",
      result.plan.tasks.length > 0 ? result.plan.tasks.map(formatMaintenanceTaskState).join("\n") : "- none",
    );
  }

  if (includeRecentRuns && result.plan?.recentRuns) {
    lines.push("", "## Recent Runs", "", formatMaintenanceRunRows(result.plan.recentRuns));
  }

  return lines.join("\n");
}

function appendTraceRecorderStatusLines(lines, traceStats) {
  if (!traceStats) {
    return;
  }
  lines.push(
    `traceRecorderStoredRecords: ${traceStats.storedRecords}`,
    `traceRecorderTotalRecorded: ${traceStats.totalRecorded}`,
    `traceRecorderEvictedCount: ${traceStats.totalEvicted}`,
    `traceRecorderExpiredCount: ${traceStats.totalExpired}`,
    `traceRecorderMaxRecords: ${traceStats.maxRecords}`,
    `traceRecorderMaxAgeMs: ${traceStats.maxAgeMs}`,
    `traceRecorderLastRecordedAt: ${traceStats.lastRecordedAt ?? "none"}`,
    `traceRecorderRoutes: ${formatTraceRecorderRoutes(traceStats.routes)}`,
    `traceRecorderLookupLeaders: ${formatTraceRecorderLookups(traceStats.lookupHitRates)}`,
    `traceRecorderRepeatedWins: ${formatTraceRecorderPatterns(traceStats.repeatedWins)}`,
    `traceRecorderRepeatedMisses: ${formatTraceRecorderPatterns(traceStats.repeatedMisses)}`,
    ...formatTraceRecorderHooks(traceStats.hooks),
  );
}

function appendRecentTraceSection(lines, runtime, args) {
  if (args.includeRecentTraces !== true) {
    return;
  }
  const recentTraceLimit = ensureLimit(args.recentTraceLimit, 3);
  const recentRecords = runtime.traceRecorder?.getRecent?.(recentTraceLimit) ?? [];
  lines.push("", "## Recent Trace Records", "", ...formatRecentTraceRecords(recentRecords));
}

function appendRecentTrajectorySection(lines, runtime, args) {
  if (args.includeRecentTrajectoryArtifacts !== true) {
    return;
  }
  const recentTrajectoryLimit = ensureLimit(args.recentTrajectoryLimit, 5);
  const trajectoryRows = runtime.db.listTrajectoryArtifacts({
    repository: runtime.repository ?? undefined,
    limit: recentTrajectoryLimit,
  });
  lines.push("", "## Recent Trajectory Artifacts", "", formatTrajectoryArtifactRows(trajectoryRows));
}

function appendMaintenanceSections(lines, maintenance) {
  lines.push("", "## Maintenance Tasks", "", maintenance.tasks.map(formatMaintenanceTaskState).join("\n") || "- none");
  if (maintenance.recentRuns.length > 0) {
    lines.push("", "## Recent Maintenance Runs", "", formatMaintenanceRunRows(maintenance.recentRuns));
  }
}

function formatValidationErrors(errors) {
  if (!errors || errors.length === 0) {
    return "";
  }
  const lines = ["## Skill Validation Issues"];
  for (const error of errors) {
    lines.push(`- **${error.skill_dir}**: ${error.reason}`);
  }
  return lines.join("\n");
}

const _specByName = new Map(LORE_CAPABILITY_SPECS.map((s) => [s.name, s]));

function toolDef(name, rest) {
  const spec = _specByName.get(name);
  if (!spec) throw new Error(`No capability spec found for Lore tool: ${name}`);
  return { name: spec.name, description: spec.description, ...rest };
}

export function createMemoryTools({ getRuntime }) {
  return [
    toolDef("memory_status", {
      parameters: {
        type: "object",
        properties: {
          includeRecentTraces: {
            type: "boolean",
            description: "When true, append recent bounded trace-recorder entries",
          },
          recentTraceLimit: {
            type: "number",
            description: "Maximum recent trace entries to render when includeRecentTraces is true",
          },
          includeRecentTrajectoryArtifacts: {
            type: "boolean",
            description: "When true, append recent sampled durable trajectory artifacts",
          },
          recentTrajectoryLimit: {
            type: "number",
            description: "Maximum recent trajectory artifacts to render when includeRecentTrajectoryArtifacts is true",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const stats = runtime.db.getStats();
        const activityPhases = deriveMemoryStatusActivityPhases(stats);
        const traceStats = runtime.traceRecorder?.getStats?.() ?? null;
        const activityStates = runtime.db.getActivityState({
          repository: runtime.repository,
          includeGlobal: true,
        });
        const recentDurableTraceSamples = runtime.db.listRetrievalTraceSamples({
          repository: runtime.repository,
          includeGlobal: true,
          limit: 5,
        });
        const maintenance = getMaintenanceStatus({
          runtime,
          repository: runtime.repository,
        });
        const lines = [
          ...buildMemoryStatusIdentityLines(runtime, stats),
          ...buildMemoryStatusRolloutLines(runtime, maintenance),
          ...buildMemoryStatusLifecycleLines(stats, activityPhases),
          ...buildMemoryStatusImprovementLines(stats),
          ...buildMemoryStatusTraceArtifactLines(runtime, stats),
          ...buildMemoryStatusMetricLines(runtime),
        ];

        appendTraceRecorderStatusLines(lines, traceStats);
        appendRecentTraceSection(lines, runtime, args);

        lines.push("", "## Last Success Activity", "", ...formatActivityStates(activityStates));
        lines.push("", "## Durable Retrieval Trace Samples", "", formatRetrievalTraceSampleRows(recentDurableTraceSamples));
        appendRecentTrajectorySection(lines, runtime, args);
        appendMaintenanceSections(lines, maintenance);

        return lines.join("\n");
      },
    }),
    toolDef("memory_intent_journal", {
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "record"],
            description: "List recent entries or record a new entry",
          },
          kind: {
            type: "string",
            enum: ["journal", "routing", "rollout", "reviewer", "fallback", "serendipity"],
            description: "Intent kind for record/list filtering",
          },
          summary: {
            type: "string",
            description: "Short decision/discovery summary for record",
          },
          rationale: {
            type: "string",
            description: "Optional rationale for the decision or discovery",
          },
          turnHint: {
            type: "string",
            description: "Optional free-form turn marker such as 'after-memory_replay'",
          },
          sessionId: {
            type: "string",
            description: "Optional session id override for record/list",
          },
          context: {
            type: "object",
            description: "Optional structured metadata for record",
          },
          repository: {
            type: "string",
            description: "Optional repository override for record/list",
          },
          limit: {
            type: "number",
            description: "Maximum rows to return for list",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        const unavailable = formatLoreUnavailable(runtime);
        if (unavailable) {
          return unavailable;
        }
        const context = buildIntentJournalContext(args, runtime, invocation);
        return context.action === "record"
          ? recordIntentJournal(runtime, args, context)
          : listIntentJournal(runtime, args, context);
      },
    }),
    toolDef("memory_portable_bundle", {
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["export"],
            description: "Export a portable bundle",
          },
          repository: {
            type: "string",
            description: "Optional repository override",
          },
          bundlePath: {
            type: "string",
            description: "Optional repository-relative or absolute JSON path for reading/writing bundles",
          },
          limit: {
            type: "number",
            description: "Maximum records to export/import per dataset",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const action = typeof args.action === "string" ? args.action : "export";
        if (action !== "export") {
          throw new Error("memory_portable_bundle currently supports action=export only");
        }
        const repository = typeof args.repository === "string" && args.repository.trim().length > 0
          ? args.repository.trim()
          : runtime.repository;
        const limit = ensureLimit(args.limit, 20);
        const improvementArtifacts = runtime.db.listImprovementArtifacts({
          reviewState: "approved",
          hasProposal: true,
          limit,
        });
        const portableBundle = createPortableBundle({
          repository,
          improvementArtifacts,
        });
        const bundlePath = resolveBundlePath(args.bundlePath);
        if (args.bundlePath && !bundlePath) {
          throw new Error("bundlePath must be a non-empty path");
        }
        if (bundlePath) {
          await mkdir(path.dirname(bundlePath), { recursive: true });
          await writeFile(bundlePath, `${JSON.stringify(portableBundle, null, 2)}\n`, "utf8");
        }
        return formatPortableBundleReport({
          bundleId: portableBundle.bundleId,
          signature: portableBundle.signature.digest,
          bundlePath: bundlePath ? path.relative(repoRootFromModule(), bundlePath).replaceAll(path.sep, "/") : null,
          repository,
          exportedArtifactCount: portableBundle.data.improvementArtifacts.length,
        });
      },
    }),
    toolDef("maintenance_schedule_run", {
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "run"],
            description: "Show scheduler status or run a maintenance sweep",
          },
          dryRun: {
            type: "boolean",
            description: "When true, preview the sweep without mutating maintenance state",
          },
          force: {
            type: "boolean",
            description: "Ignore per-task cadence and force currently enabled tasks to be due",
          },
          includeRecentRuns: {
            type: "boolean",
            description: "When true, include recent maintenance runs in the report",
          },
          tasks: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "deferredExtraction",
                "validationCorpus",
                "replayCorpus",
                "backlogReview",
                "traceCompaction",
                "indexUpkeep",
                "doctorSnapshot",
              ],
            },
            description: "Optional subset of maintenance tasks to evaluate or run",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const action = typeof args.action === "string" ? args.action : "status";
        if (action === "status") {
          const maintenance = getMaintenanceStatus({
            runtime,
            repository: runtime.repository,
          });
          return formatMaintenanceReport({
            status: "status",
            dryRun: true,
            trigger: "status",
            repository: runtime.repository,
            taskCount: maintenance.selectedTasks.length,
            completedCount: 0,
            needsAttentionCount: 0,
            failedCount: 0,
            skippedCount: maintenance.skippedDueToCap,
            tasks: maintenance.selectedTasks.map((task) => ({
              taskName: task.taskName,
              label: task.label,
              status: "planned",
              durationMs: 0,
              summary: task.preview ? { caseIds: task.preview.caseIds } : null,
            })),
            plan: maintenance,
          }, {
            includeRecentRuns: args.includeRecentRuns === true,
          });
        }

        const result = await runMaintenanceSweep({
          runtime,
          repository: runtime.repository,
          trigger: "manual",
          requestedTasks: ensureArray(args.tasks),
          force: args.force === true,
          dryRun: args.dryRun === true,
        });
        return formatMaintenanceReport(result, {
          includeRecentRuns: args.includeRecentRuns === true,
        });
      },
    }),
    toolDef("memory_improvement_backlog", {
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "resolve", "supersede"],
            description: "List artifacts or update artifact lifecycle state",
          },
          id: { type: "string", description: "Artifact id for resolve or supersede" },
          supersededBy: { type: "string", description: "Required for supersede action" },
          sourceKind: {
            type: "string",
            enum: ["session", "validation", "replay", "signal"],
            description: "Optional source kind filter for list",
          },
          sourceCaseId: { type: "string", description: "Optional source case id filter for list" },
          status: {
            type: "string",
            enum: ["active", "resolved", "superseded"],
            description: "Optional status filter for list",
          },
          limit: {
            type: "number",
            description: "Maximum items to return",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }
        const action = typeof args.action === "string" ? args.action : "list";
        if (action === "resolve") {
          const id = ensureString(args.id, "id");
          runtime.db.updateImprovementArtifactStatus({
            id,
            status: "resolved",
          });
          return `Resolved improvement artifact ${id}.`;
        }
        if (action === "supersede") {
          const id = ensureString(args.id, "id");
          const supersededBy = ensureString(args.supersededBy, "supersededBy");
          runtime.db.updateImprovementArtifactStatus({
            id,
            status: "superseded",
            supersededBy,
          });
          return `Superseded improvement artifact ${id} with ${supersededBy}.`;
        }
        const rows = runtime.db.listImprovementArtifacts({
          sourceKind: typeof args.sourceKind === "string" ? args.sourceKind : undefined,
          sourceCaseId: typeof args.sourceCaseId === "string" ? args.sourceCaseId : undefined,
          status: typeof args.status === "string" ? normalizeImprovementStatus(args.status) : undefined,
          limit: ensureLimit(args.limit, 10),
        });
        return [
          "## Improvement Backlog",
          "",
          formatImprovementArtifactRows(rows),
        ].join("\n");
      },
    }),
    toolDef("memory_evolution_ledger", {
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["summary", "capture_signal", "generate_proposals", "verify_integrity"],
            description: "Inspect the ledger, capture a manual signal, generate proposals, or verify generated proposal artifacts",
          },
          limit: {
            type: "number",
            description: "Maximum items to inspect or generate",
          },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional backlog ids to target for proposal generation",
          },
          force: {
            type: "boolean",
            description: "When true, allow proposal generation to overwrite existing generated proposal artifacts",
          },
          dryRun: {
            type: "boolean",
            description: "When true, preview proposal or integrity work without writing files or DB updates",
          },
          repair: {
            type: "boolean",
            description: "When true, repair generated proposal artifacts that fail integrity verification",
          },
          sourceCaseId: {
            type: "string",
            description: "Optional explicit source case id for capture_signal",
          },
          signalType: {
            type: "string",
            enum: ["router", "maintenance", "trace"],
            description: "Signal family when capturing a manual ledger entry",
          },
          title: {
            type: "string",
            description: "Signal title for capture_signal",
          },
          summary: {
            type: "string",
            description: "Signal summary for capture_signal",
          },
          linkedMemoryId: {
            type: "string",
            description: "Optional related semantic memory id for capture_signal",
          },
          evidence: {
            type: "object",
            description: "Optional provenance/evidence object for capture_signal",
          },
          trace: {
            type: "object",
            description: "Optional trace metadata object for capture_signal",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        const unavailable = ensureEvolutionLedgerAvailable(runtime);
        if (unavailable) {
          return unavailable;
        }
        const action = typeof args.action === "string" ? args.action : "summary";
        if (action === "capture_signal") {
          return captureEvolutionSignal(runtime, args);
        }
        if (action === "generate_proposals") {
          return generateEvolutionLedgerProposals(runtime, args);
        }
        if (action === "verify_integrity") {
          return verifyEvolutionLedgerIntegrity(runtime, args);
        }
        return summarizeEvolutionLedger(runtime, args);
      },
    }),
    toolDef("memory_capability_inventory", {
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["summary", "recommend", "route", "evaluate", "json"],
            description: "Show the local inventory, run the recommendation-only router core, evaluate the router corpus, or return raw JSON",
          },
          prompt: {
            type: "string",
            description: "Prompt to score through the local-first router core when action is recommend or route",
          },
          caseIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional router evaluation case IDs to run when action is evaluate",
          },
          detailLevel: {
            type: "string",
            enum: ["summary", "full"],
            description: "How much inventory detail to render for summary mode",
          },
          limit: {
            type: "number",
            description: "Maximum route candidates or capabilities to show",
          },
        },
      },
      handler: async (args) => {
        const action = args.action === "recommend"
          || args.action === "route"
          || args.action === "evaluate"
          || args.action === "json"
          ? args.action
          : "summary";
        const limit = ensureLimit(args.limit, 5);

        if (action === "json") {
          const inventory = await scanCapabilityInventory();
          return JSON.stringify(inventory, null, 2);
        }

        if (action === "recommend" || action === "route") {
          const inventory = await scanCapabilityInventory();
          const prompt = ensureString(args.prompt, "prompt");
          const recommendation = recommendCapabilityRoute({
            prompt,
            inventory,
            limit,
          });
          return renderCapabilityRecommendationReport(recommendation, { limit });
        }

        if (action === "evaluate") {
          const result = await evaluateCapabilityRouter({
            caseIds: ensureArray(args.caseIds).map((item) => String(item)),
            limit,
          });
          return renderCapabilityEvaluationReport(result);
        }

        const inventory = await scanCapabilityInventory();
        const report = renderCapabilityInventoryReport(inventory, {
          detailLevel: args.detailLevel === "full" ? "full" : "summary",
          limit,
        });

        // Append validation errors to the report if any
        const validationSection = formatValidationErrors(inventory.validation?.errors);
        if (validationSection) {
          return report + "\n\n" + validationSection;
        }

        return report;
      },
    }),
    toolDef("lore_recall", {
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Prompt or question to recall context for" },
          includeOtherRepositories: {
            type: "boolean",
            description: "When true, allow transferable cross-repository fallback where applicable",
          },
          limit: { type: "number", description: "Optional result budget" },
          includeTrace: {
            type: "boolean",
            description: "When true, include a compact lookup summary",
          },
          detailLevel: {
            type: "string",
            enum: ["context", "evidence", "full"],
            description: "How much supporting retrieval evidence to render",
          },
        },
        required: ["prompt"],
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const prompt = ensureString(args.prompt, "prompt");
        const result = recallMemory({
          db: runtime.db,
          prompt,
          repository: runtime.repository,
          includeOtherRepositories: args.includeOtherRepositories === true,
          limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit),
          sessionStore: runtime.sessionStore,
        });
        return formatRecallEnvelope(result, {
          detailLevel: args.detailLevel === "full" || args.detailLevel === "evidence"
            ? args.detailLevel
            : "context",
          includeTrace: args.includeTrace === true,
        });
      },
    }),
    toolDef("lore_onboard", {
      parameters: {
        type: "object",
        properties: {
          userName: {
            type: "string",
            description: "The user's preferred name. Optional when Lore already knows it.",
          },
          assistantName: {
            type: "string",
            description: "Optional assistant self-name override; omitted means Lore chooses one during onboarding",
          },
          voice: {
            type: "string",
            enum: ["colleague", "collaborative", "friendly"],
            description: "Preferred assistant voice",
          },
          warmth: {
            type: "string",
            enum: ["warm", "balanced"],
            description: "Preferred assistant warmth",
          },
          humor: {
            type: "string",
            enum: ["light", "none"],
            description: "Whether Lore should use humor by default",
          },
          humorFrequency: {
            type: "string",
            enum: ["frequent", "occasional", "never"],
            description: "How often humor is welcome when humor is enabled",
          },
          collaborative: {
            type: "boolean",
            description: "Whether Lore should default to a collaborative teammate posture",
          },
          useNameNaturally: {
            type: "boolean",
            description: "Whether Lore should use the user's preferred name naturally when helpful",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        const unavailable = formatLoreUnavailable(runtime);
        if (unavailable) {
          return unavailable;
        }
        const onboardingState = readOnboardingState({ db: runtime.db });
        const built = resolveOnboardingInput(buildOnboardingInputArgs(args, onboardingState, invocation.sessionId));
        persistOnboardingMemories(runtime.db, built.memories);
        return formatOnboardingResult(args, built);
      },
    }),
    toolDef("lore_retain", {
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["semantic", "workstream"],
            description: "Whether to save a normal semantic memory or a workstream overlay",
          },
          type: { type: "string", description: "Semantic memory type when kind is semantic" },
          content: { type: "string", description: "Semantic memory content when kind is semantic" },
          repository: { type: "string", description: "Optional repository override" },
          scope: {
            type: "string",
            enum: ["global", "transferable", "repo"],
            description: "Optional explicit scope override",
          },
          confidence: { type: "number", description: "Optional confidence score" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional semantic memory tags",
          },
          domainKey: {
            type: "string",
            description: "Optional memory domain key for the retained semantic memory",
          },
          domainKind: {
            type: "string",
            enum: ["assistant", "user", "repo", "workstream", "person", "topic", "custom"],
            description: "Optional domain kind when creating/updating a domain alongside retain",
          },
          domainTitle: {
            type: "string",
            description: "Optional domain title when creating/updating a domain alongside retain",
          },
          domainMission: {
            type: "string",
            description: "Optional domain mission when creating/updating a domain alongside retain",
          },
          domainDirectives: {
            type: "array",
            items: { type: "string" },
            description: "Optional domain directives when creating/updating a domain alongside retain",
          },
          metadata: {
            type: "object",
            description: "Optional semantic memory metadata object",
          },
          workstreamId: { type: "string", description: "Stable identifier for the workstream overlay" },
          title: { type: "string", description: "Workstream title" },
          mission: { type: "string", description: "Workstream mission" },
          objective: { type: "string", description: "Current objective" },
          status: {
            type: "string",
            enum: ["active", "blocked", "paused", "done"],
            description: "Workstream status",
          },
          constraints: {
            type: "array",
            items: { type: "string" },
            description: "Active workstream constraints",
          },
          blockers: {
            type: "array",
            items: { type: "string" },
            description: "Current blockers",
          },
          nextActions: {
            type: "array",
            items: { type: "string" },
            description: "Next actions",
          },
          decisions: {
            type: "array",
            items: { type: "string" },
            description: "Retained high-salience decisions",
          },
          retainPriorities: {
            type: "array",
            items: { type: "string" },
            description: "Extraction steering priorities",
          },
          reflectPriorities: {
            type: "array",
            items: { type: "string" },
            description: "Synthesis steering priorities",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        const unavailable = formatLoreUnavailable(runtime);
        if (unavailable) {
          return unavailable;
        }

        const retainContext = normalizeRetainContext(args, runtime);
        const domainOutcome = applyRetainDomainContext({
          runtime,
          args,
          repository: retainContext.repository,
          scope: retainContext.scope,
          domainKey: retainContext.domainKey,
        });
        if (domainOutcome) {
          return domainOutcome;
        }

        if (retainContext.kind === "workstream") {
          return formatRetainResult(retainMemory({
            db: runtime.db,
            kind: retainContext.kind,
            overlay: buildWorkstreamRetainPayload(args, {
              repository: retainContext.repository,
              scope: retainContext.scope,
              invocation,
            }),
          }), retainContext.kind);
        }

        return formatRetainResult(retainMemory({
          db: runtime.db,
          kind: retainContext.kind,
          memory: buildSemanticRetainPayload(args, {
            repository: retainContext.repository,
            scope: retainContext.scope,
            domainKey: retainContext.domainKey,
            invocation,
          }),
        }), retainContext.kind);
      },
    }),
    toolDef("lore_reflect", {
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Question or reflection prompt to analyze" },
          focus: {
            type: "string",
            enum: ["summary", "patterns", "blockers", "decisions", "next_actions"],
            description: "Optional reflection focus override",
          },
          includeOtherRepositories: {
            type: "boolean",
            description: "When true, allow transferable cross-repository fallback where applicable",
          },
          limit: { type: "number", description: "Optional result budget" },
          detailLevel: {
            type: "string",
            enum: ["summary", "evidence", "full"],
            description: "How much supporting reflection evidence to render",
          },
          persistObservation: {
            type: "boolean",
            description: "When true, save the reflection result as a refreshable observation",
          },
          observationKey: {
            type: "string",
            description: "Optional stable key for the saved observation",
          },
          domainKey: {
            type: "string",
            description: "Optional memory domain key for a saved observation",
          },
          freshnessHours: {
            type: "number",
            description: "Optional freshness window for a saved observation",
          },
        },
        required: ["prompt"],
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        const unavailable = formatLoreUnavailable(runtime);
        if (unavailable) {
          return unavailable;
        }

        const request = normalizeReflectionRequest(args, runtime);
        const reflection = reflectMemory({
          db: runtime.db,
          prompt: request.prompt,
          repository: runtime.repository,
          includeOtherRepositories: request.includeOtherRepositories,
          limit: request.limit,
          sessionStore: runtime.sessionStore,
          focus: request.focus,
        });
        const observationLine = maybePersistReflectionObservation({
          runtime,
          reflection,
          request,
          args,
        });
        if (observationLine === "refreshable observations rollout is disabled" || observationLine === "memory domains rollout is disabled") {
          return observationLine;
        }
        return [
          observationLine,
          formatReflectionReport(reflection, { detailLevel: request.detailLevel }),
        ].filter(Boolean).join("\n\n");
      },
    }),
    toolDef("memory_search", {
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          type: { type: "string", description: "Optional semantic memory type filter" },
          limit: { type: "number", description: "Optional result limit" },
          includeOtherRepositories: {
            type: "boolean",
            description: "When true, search beyond the current repository scope",
          },
        },
        required: ["query"],
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const query = ensureString(args.query, "query");
        const limit = ensureLimit(args.limit, 6);
        const includeOtherRepositories = args.includeOtherRepositories === true;
        const types = typeof args.type === "string" && args.type.trim().length > 0
          ? [args.type.trim()]
          : [];

        const semantic = runtime.db.searchSemantic({
          query,
          repository: runtime.repository,
          includeOtherRepositories,
          types,
          limit,
        });
        const episodes = runtime.db.searchEpisodes({
          query,
          repository: runtime.repository,
          includeOtherRepositories,
          limit: Math.max(1, Math.floor(limit / 2)),
        });

        return [
          "## Semantic Memory",
          "",
          formatRows(
            semantic,
            (row) => [
              `- [${row.id} ${row.type}/${row.scope}/${row.scope_source}]`,
              row.content,
              `(${row.repository ?? "global"})`,
              row.canonical_key ? `canonical=${row.canonical_key}` : null,
              `reinforcement=${row.reinforcement_count ?? 1}`,
              row.last_seen_at ? `lastSeen=${row.last_seen_at}` : null,
            ].filter(Boolean).join(" "),
          ),
          "",
          "## Episodic Memory",
          "",
          formatRows(
            episodes,
            (row) => `- [${row.id} ${row.scope}/${row.scope_source}] ${row.summary} (${row.repository ?? "global"}, ${row.date_key})`,
          ),
        ].join("\n");
      },
    }),
    toolDef("memory_explain", {
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Prompt to explain" },
          mode: {
            type: "string",
            description: "Explain prompt-time retrieval or the session-start capsule",
            enum: ["prompt", "session_start"],
          },
        },
        required: ["prompt"],
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const prompt = ensureString(args.prompt, "prompt");
        const mode = args.mode === "session_start" ? "session_start" : "prompt";
        const explanation = await explainMemoryRetrieval({
          runtime,
          prompt,
          mode,
        });
        return renderExplanationReport(explanation);
      },
    }),
    toolDef("memory_validate", {
      parameters: {
        type: "object",
        properties: {
          caseIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional subset of validation case IDs to run",
          },
          verbose: {
            type: "boolean",
            description: "When true, show all assertions instead of only failed ones",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const caseIds = Array.isArray(args.caseIds)
          ? args.caseIds.filter((value) => typeof value === "string" && value.trim().length > 0)
          : [];
        const verbose = args.verbose === true;
        const result = await runValidationSet({
          runtime,
          caseIds,
        });
        return renderValidationReport(result, { verbose });
      },
    }),
    toolDef("memory_replay", {
      parameters: {
        type: "object",
        properties: {
          caseIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional subset of replay case IDs to run",
          },
          verbose: {
            type: "boolean",
            description: "When true, show all replay cases with evidence samples and lookup sources",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const caseIds = Array.isArray(args.caseIds)
          ? args.caseIds.filter((value) => typeof value === "string" && value.trim().length > 0)
          : [];
        const verbose = args.verbose === true;
        const result = await runReplayCorpus({
          runtime,
          caseIds,
        });
        return renderReplayReport(result, { verbose });
      },
    }),
    toolDef("memory_scope_override", {
      parameters: {
        type: "object",
        properties: {
          targetType: {
            type: "string",
            enum: ["semantic", "episode"],
            description: "Which memory table to modify",
          },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "One or more target row ids from memory_search output",
          },
          action: {
            type: "string",
            enum: ["set", "clear"],
            description: "Set a manual scope override or clear it back to auto classification",
          },
          scope: {
            type: "string",
            enum: ["global", "transferable", "repo"],
            description: "Required when action is set",
          },
          repository: {
            type: "string",
            description: "Optional repository fallback when assigning a non-global scope to a global row",
          },
          dryRun: {
            type: "boolean",
            description: "When true, preview the scope change without writing",
          },
          actor: {
            type: "string",
            description: "Optional actor label for audit history",
          },
          reason: {
            type: "string",
            description: "Reason for the override or clear action",
          },
          source: {
            type: "string",
            description: "Optional audit source label",
          },
        },
        required: ["targetType", "ids"],
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        const unavailable = formatLoreUnavailable(runtime);
        if (unavailable) {
          return unavailable;
        }

        const request = buildScopeOverrideRequest(args, runtime, invocation);
        const preview = previewScopeOverride(runtime, request);
        if (request.dryRun) {
          return formatScopePreview(preview);
        }
        return applyScopeOverride(runtime, request);
      },
    }),
    toolDef("memory_scope_audit", {
      parameters: {
        type: "object",
        properties: {
          targetType: {
            type: "string",
            enum: ["semantic", "episode"],
            description: "Optional audit filter by target type",
          },
          targetId: {
            type: "string",
            description: "Optional specific row id to inspect",
          },
          limit: {
            type: "number",
            description: "Maximum audit rows to show",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const rows = runtime.db.listScopeOverrideAudit({
          targetType: typeof args.targetType === "string" ? args.targetType : undefined,
          targetId: typeof args.targetId === "string" ? args.targetId : undefined,
          limit: ensureLimit(args.limit, 10),
        });
        return [
          "## Scope Override Audit",
          "",
          formatAuditRows(rows),
        ].join("\n");
      },
    }),
    toolDef("memory_save", {
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Memory content to persist" },
          type: { type: "string", description: "Semantic memory type" },
          repository: { type: "string", description: "Optional explicit repository scope" },
          scope: { type: "string", description: "Optional memory scope: global, transferable, or repo" },
          confidence: { type: "number", description: "Optional confidence score from 0 to 1" },
        },
        required: ["content", "type"],
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const content = ensureString(args.content, "content");
        const type = ensureString(args.type, "type");
        const confidence = typeof args.confidence === "number" ? args.confidence : 0.9;
        const retained = retainMemory({
          db: runtime.db,
          kind: "semantic",
          memory: {
            type,
            content,
            confidence,
            repository: typeof args.repository === "string" && args.repository.trim()
              ? args.repository.trim()
              : null,
            scope: typeof args.scope === "string" ? args.scope.trim() : undefined,
            sourceSessionId: invocation.sessionId,
            tags: [type, "manual"],
            metadata: { source: "memory_save" },
          },
        });

        return retained.id
          ? `Saved semantic memory ${retained.id}`
          : "Skipped semantic memory save: empty after sanitization.";
      },
    }),
    toolDef("memory_forget", {
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Semantic memory id" },
          supersededBy: { type: "string", description: "Optional replacement id or note" },
        },
        required: ["id"],
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const id = ensureString(args.id, "id");
        runtime.db.forgetMemory({
          id,
          supersededBy: typeof args.supersededBy === "string" ? args.supersededBy : undefined,
        });
        return `Marked memory ${id} as superseded.`;
      },
    }),
    toolDef("memory_deferred_process", {
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum queued jobs to process" },
          includeOtherRepositories: {
            type: "boolean",
            description: "When true, process queued jobs across repositories",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const limit = ensureLimit(args.limit, runtime.config.deferredExtraction?.maxJobsPerRun ?? 2);
        const includeOtherRepositories = args.includeOtherRepositories === true;
        const result = processDeferredExtractions({
          db: runtime.db,
          sessionStore: runtime.sessionStore,
          repository: includeOtherRepositories ? null : runtime.repository,
          limit,
          retryDelayMinutes: runtime.config.deferredExtraction?.retryDelayMinutes ?? 15,
        });
        return `Processed ${result.processed} deferred job(s), failed ${result.failed}, inspected ${result.inspected}.`;
      },
    }),
    toolDef("memory_backfill", {
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["legacy", "controlled"],
            description: "Legacy one-shot mode or controlled resumable mode",
          },
          action: {
            type: "string",
            enum: ["preview", "start", "resume", "status", "restore"],
            description: "Controlled-mode action",
          },
          limit: { type: "number", description: "Maximum recent sessions to inspect" },
          batchSize: { type: "number", description: "Maximum items to process per controlled batch" },
          includeOtherRepositories: {
            type: "boolean",
            description: "When true, backfill across repositories rather than current repo only",
          },
          refreshExisting: {
            type: "boolean",
            description: "When true, reprocess existing digests so improved extraction logic can refresh older summaries",
          },
          runId: {
            type: "string",
            description: "Controlled backfill run id for resume, status, or restore",
          },
          retryFailed: {
            type: "boolean",
            description: "When true, resume retries failed items as well as pending ones",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        const unavailable = formatLoreUnavailable(runtime);
        if (unavailable) {
          return unavailable;
        }

        const request = normalizeBackfillRequest(args, runtime);
        if (request.mode === "controlled") {
          return runControlledBackfillAction({ runtime, request, args });
        }

        return runLegacyBackfill({ runtime, request });
      },
    }),
    toolDef("memory_doctor_report", {
      parameters: {
        type: "object",
        properties: {
          dryRun: {
            type: "boolean",
            description: "When true, classify incidents but do not record a trajectory artifact",
          },
          trajectoryLimit: {
            type: "number",
            description: "Maximum recent trajectory artifacts to scan (default 20, max 50)",
          },
          plannedActions: {
            type: "array",
            description: "Optional hypothetical future tool actions for observe-only safety classification",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                toolName: { type: "string" },
                operation: { type: "string" },
                target: { type: "string" },
                mutability: { type: "string", enum: ["read_only", "append_only", "metadata_update", "destructive_write"] },
                reversibility: { type: "string", enum: ["reversible", "operator_reversible", "difficult", "irreversible"] },
                scope: { type: "string", enum: ["isolated", "repository", "workspace", "multi_workspace", "external_system"] },
                notes: { type: "string" },
              },
            },
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }
        if (!readLoreDoctorEnabled(runtime.config)) {
          return "memory_doctor_report: disabled — set rollout.loreDoctor: true in lore.json to enable";
        }
        const dryRun = args.dryRun === true;
        const trajectoryLimit = typeof args.trajectoryLimit === "number" ? args.trajectoryLimit : 20;
        const doctorResult = runDoctorObservation({
          runtime,
          repository: runtime.repository,
          dryRun,
          trajectoryLimit,
        });
        const doctorReport = formatDoctorReport(doctorResult);
        const safetyResult = observeSafetyGateActions({
          actions: ensureArray(args.plannedActions),
          repository: runtime.repository,
          actionSource: "doctor",
        });
        return `${doctorReport}${formatDoctorSafetyGateSection(safetyResult)}`;
      },
    }),
    toolDef("memory_review_gate", {
      parameters: {
        type: "object",
        required: ["text"],
        properties: {
          text: {
            type: "string",
            description: "Proposal-doc text to review",
          },
          dryRun: {
            type: "boolean",
            description: "When true, run checks but skip recording a trajectory artifact",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }
        if (!readReviewGateEnabled(runtime.config)) {
          return "memory_review_gate: disabled — set rollout.reviewGate: true in lore.json to enable";
        }
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          return "memory_review_gate: text must be a non-empty string";
        }
        const result = runReviewGate({
          runtime,
          text,
          repository: runtime.repository,
          dryRun: args.dryRun === true,
        });
        return formatReviewGateReport(result);
      },
    }),
    toolDef("memory_skill_validate", {
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Output format: 'summary' (default) or 'detailed'",
          },
        },
      },
      handler: async (args, invocation) => {
        const runtime = await getRuntime(invocation.sessionId);
        if (!runtime.initialized || runtime.lastError) {
          return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
        }

        const rootPath = runtime.workspaceRoot || process.cwd();
        const action = args.action === "detailed" ? "detailed" : "summary";

        try {
          const result = await validateSkillsDirectory(rootPath);
          return formatValidationResults(result, action);
        } catch (error) {
          return `skill validation error: ${error?.message ?? "unknown error"}`;
        }
      },
    }),
  ];
}

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

function createPortableBundle({
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
