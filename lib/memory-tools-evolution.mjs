import {
  generateProposalArtifacts,
  verifyProposalArtifacts,
} from "./proposal-generator.mjs";
import {
  readEvolutionLedgerEnabled,
  readGeneratedArtifactIntegrityEnabled,
  readProposalGenerationEnabled,
  readTraceRecorderEnabled,
} from "./rollout-flags.mjs";
import {
  ensureArray,
} from "./memory-tools-array-utils.mjs";
import {
  ensureIds,
  ensureLimit,
  ensureObject,
  ensureString,
} from "./memory-tools-validation-utils.mjs";
import {
  formatLoreUnavailable,
} from "./memory-tools-runtime-utils.mjs";
import {
  formatImprovementArtifactRows,
  formatRows,
} from "./memory-tools-render-utils.mjs";
import { readOptionalTrimmedString } from "./memory-tools-input-utils.mjs";

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
