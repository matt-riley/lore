import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLoreCapabilitySpec,
  listCoreAliasToolNames,
} from "../capabilities/capability-manifest.mjs";
import { processDeferredExtractions } from "../sessions/backfill.mjs";
import {
  explainMemoryRetrieval,
  renderExplanationReport,
  renderReplayReport,
  renderValidationReport,
  runReplayCorpus,
  runValidationSet,
} from "../maintenance/diagnostics.mjs";
import {
  recallMemory,
  reflectMemory,
  retainMemory,
} from "../memory/memory-operations.mjs";
import {
  enhanceReflectionWithLocalInference,
  reflectionEvidenceCandidateLimit,
} from "../inference/local-inference-reflection.mjs";
import {
  recallHasQueryEvidence,
  resolveRetrievalPrompt,
} from "./memory-tools-query-expansion.mjs";
import {
  readOnboardingState,
  resolveOnboardingInput,
} from "../memory/onboarding.mjs";
import {
  getMaintenanceStatus,
  runMaintenanceSweep,
} from "../maintenance/maintenance-scheduler.mjs";
import { rollbackMemoryHygiene } from "../memory/memory-hygiene.mjs";
import {
  readLoreDoctorEnabled,
  readReviewGateEnabled,
} from "../rollout/rollout-flags.mjs";
import { runDoctorObservation } from "../maintenance/lore-doctor.mjs";
import { runReviewGate } from "../lifecycle/review-gate.mjs";
import { validateSkillsDirectory, formatValidationResults } from "../capabilities/skill-validator.mjs";
import * as helpers from "./memory-tools-helpers.mjs";
import * as reports from "./memory-tools-reports.mjs";

const {
  formatRows,
  formatImprovementArtifactRows,
  normalizeImprovementStatus,
  ensureString,
  ensureLimit,
  ensureArray,
  normalizeRetainContext,
  formatLoreUnavailable,
  buildPortableBundleRequest,
  writePortableBundle,
  formatPortableBundleResult,
  buildOkfBundleDocuments,
  writeOkfBundle,
  formatOkfBundleResult,
  readOkfBundle,
  buildOkfImportMemories,
  formatOkfImportResult,
  normalizeCapabilityInventoryAction,
  renderCapabilityInventoryAction,
  buildIntentJournalContext,
  recordIntentJournal,
  listIntentJournal,
  ensureEvolutionLedgerAvailable,
  captureEvolutionSignal,
  generateEvolutionLedgerProposals,
  verifyEvolutionLedgerIntegrity,
  summarizeEvolutionLedger,
  buildScopeOverrideRequest,
  previewScopeOverride,
  applyScopeOverride,
  buildOnboardingInputArgs,
  persistOnboardingMemories,
  formatOnboardingResult,
  applyRetainDomainContext,
  buildWorkstreamRetainPayload,
  buildSemanticRetainPayload,
  formatRetainResult,
  normalizeReflectionRequest,
  maybePersistReflectionObservation,
  normalizeBackfillRequest,
  createPortableBundle,
  mapImprovementArtifactRow,
} = helpers;

const {
  formatRecallEnvelope,
  formatReflectionReport,
  formatAuditRows,
  formatScopePreview,
  runControlledBackfillAction,
  runLegacyBackfill,
  formatActivityStates,
  formatRetrievalTraceSampleRows,
  formatDoctorReport,
  formatDoctorSafetyGateSection,
  formatReviewGateReport,
  buildMemoryStatusIdentityLines,
  buildMemoryStatusRolloutLines,
  deriveMemoryStatusActivityPhases,
  buildMemoryStatusLifecycleLines,
  buildMemoryStatusCaptureHealthLines,
  buildMemoryStatusImprovementLines,
  buildMemoryStatusTraceArtifactLines,
  buildMemoryStatusMetricLines,
  formatMaintenanceReport,
  appendTraceRecorderStatusLines,
  appendRecentTraceSection,
  appendRecentTrajectorySection,
  appendMaintenanceSections,
} = reports;

function withAvailableRuntime(getRuntime, handler) {
  return async (args, invocation) => {
    const runtime = await getRuntime(invocation.sessionId);
    if (!runtime.initialized || runtime.lastError) {
      return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
    }
    return handler({ args, invocation, runtime });
  };
}

function toolDef(name, rest) {
  const spec = getLoreCapabilitySpec(name);
  if (!spec) throw new Error(`No capability spec found for Lore tool: ${name}`);
  if (spec.name !== name) {
    throw new Error(`Lore tool builders must register canonical name ${spec.name}, not alias ${name}`);
  }
  const { parameters: _ignored, ...handlerRest } = rest;
  return {
    ...handlerRest,
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  };
}

function expandCoreAliasTools(tool) {
  const spec = getLoreCapabilitySpec(tool.name);
  return [
    tool,
    ...listCoreAliasToolNames(spec).map((alias) => ({ ...tool, name: alias })),
  ];
}

import { buildMemoryStatusTool } from "./builders/memory-tool-builder-memory-status.mjs";
import { buildMemoryIntentJournalTool } from "./builders/memory-tool-builder-memory-intent-journal.mjs";
import { buildMemoryPortableBundleTool } from "./builders/memory-tool-builder-memory-portable-bundle.mjs";
import { buildMaintenanceScheduleRunTool } from "./builders/memory-tool-builder-maintenance-schedule-run.mjs";
import { buildMemoryImprovementBacklogTool } from "./builders/memory-tool-builder-memory-improvement-backlog.mjs";
import { buildMemoryEvolutionLedgerTool } from "./builders/memory-tool-builder-memory-evolution-ledger.mjs";
import { buildMemoryCapabilityInventoryTool } from "./builders/memory-tool-builder-memory-capability-inventory.mjs";
import { buildLoreRecallTool } from "./builders/memory-tool-builder-lore-recall.mjs";
import { buildLoreOnboardTool } from "./builders/memory-tool-builder-lore-onboard.mjs";
import { buildLoreRetainTool } from "./builders/memory-tool-builder-lore-retain.mjs";
import { buildLoreReflectTool } from "./builders/memory-tool-builder-lore-reflect.mjs";
import { buildMemorySearchTool } from "./builders/memory-tool-builder-memory-search.mjs";
import { buildMemoryExplainTool } from "./builders/memory-tool-builder-memory-explain.mjs";
import { buildMemoryValidateTool } from "./builders/memory-tool-builder-memory-validate.mjs";
import { buildMemoryReplayTool } from "./builders/memory-tool-builder-memory-replay.mjs";
import { buildMemoryScopeOverrideTool } from "./builders/memory-tool-builder-memory-scope-override.mjs";
import { buildMemoryScopeAuditTool } from "./builders/memory-tool-builder-memory-scope-audit.mjs";
import { buildMemoryForgetTool } from "./builders/memory-tool-builder-memory-forget.mjs";
import { buildMemoryDeferredProcessTool } from "./builders/memory-tool-builder-memory-deferred-process.mjs";
import { buildMemoryBackfillTool } from "./builders/memory-tool-builder-memory-backfill.mjs";
import { buildMemoryDoctorReportTool } from "./builders/memory-tool-builder-memory-doctor-report.mjs";
import { buildMemoryReviewGateTool } from "./builders/memory-tool-builder-memory-review-gate.mjs";
import { buildMemorySkillValidateTool } from "./builders/memory-tool-builder-memory-skill-validate.mjs";
import { buildMemoryCorrectTool } from "./builders/memory-tool-builder-memory-correct.mjs";
import { buildMemoryRepairTool } from "./builders/memory-tool-builder-memory-repair.mjs";
import { buildMemoryPurgeTool } from "./builders/memory-tool-builder-memory-purge.mjs";

async function importOkfPortableBundle({ runtime, invocation, request }) {
  const bundleStat = await stat(request.bundlePath).catch(() => null);
  if (!bundleStat || !bundleStat.isDirectory()) {
    throw new Error(`bundlePath ${request.bundlePath} is not a directory`);
  }

  const { concepts, totalConceptFileCount } = await readOkfBundle(request.bundlePath, {
    maxConcepts: request.limit,
    includeGraph: false,
  });
  const memories = buildOkfImportMemories({
    concepts,
    repository: request.repository,
    confidence: request.confidence,
    sourceSessionId: invocation.sessionId,
  });

  let importedCount = 0;
  let skippedCount = 0;
  for (const memory of memories) {
    const retained = retainMemory({ db: runtime.db, kind: "semantic", memory });
    if (retained.id) {
      importedCount += 1;
    } else {
      skippedCount += 1;
    }
  }

  return formatOkfImportResult({
    bundleDir: path.relative(repoRootFromBuildersModule(), request.bundlePath).replaceAll(path.sep, "/"),
    repository: request.repository,
    importedCount,
    skippedCount,
    totalConceptCount: totalConceptFileCount,
  });
}

function repoRootFromBuildersModule() {
  // This module lives at <repo>/lib/memory-tools-builders.mjs, so one level
  // up from its directory is the actual repository root (mirrors
  // repoRootFromModule() in memory-tools-portable-bundle.mjs /
  // memory-tools-okf-bundle.mjs).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

const MEMORY_TOOL_BUILDER_CONTEXT = Object.freeze({
  toolDef,
  withAvailableRuntime,
  formatRows,
  formatImprovementArtifactRows,
  normalizeImprovementStatus,
  ensureString,
  ensureLimit,
  ensureArray,
  normalizeRetainContext,
  formatLoreUnavailable,
  buildPortableBundleRequest,
  writePortableBundle,
  formatPortableBundleResult,
  buildOkfBundleDocuments,
  writeOkfBundle,
  formatOkfBundleResult,
  readOkfBundle,
  buildOkfImportMemories,
  formatOkfImportResult,
  normalizeCapabilityInventoryAction,
  renderCapabilityInventoryAction,
  buildIntentJournalContext,
  recordIntentJournal,
  listIntentJournal,
  ensureEvolutionLedgerAvailable,
  captureEvolutionSignal,
  generateEvolutionLedgerProposals,
  verifyEvolutionLedgerIntegrity,
  summarizeEvolutionLedger,
  buildScopeOverrideRequest,
  previewScopeOverride,
  applyScopeOverride,
  buildOnboardingInputArgs,
  persistOnboardingMemories,
  formatOnboardingResult,
  applyRetainDomainContext,
  buildWorkstreamRetainPayload,
  buildSemanticRetainPayload,
  formatRetainResult,
  normalizeReflectionRequest,
  maybePersistReflectionObservation,
  normalizeBackfillRequest,
  createPortableBundle,
  mapImprovementArtifactRow,
  formatRecallEnvelope,
  formatReflectionReport,
  formatAuditRows,
  formatScopePreview,
  runControlledBackfillAction,
  runLegacyBackfill,
  formatActivityStates,
  formatRetrievalTraceSampleRows,
  formatDoctorReport,
  formatDoctorSafetyGateSection,
  formatReviewGateReport,
  buildMemoryStatusIdentityLines,
  buildMemoryStatusRolloutLines,
  deriveMemoryStatusActivityPhases,
  buildMemoryStatusLifecycleLines,
  buildMemoryStatusCaptureHealthLines,
  buildMemoryStatusImprovementLines,
  buildMemoryStatusTraceArtifactLines,
  buildMemoryStatusMetricLines,
  formatMaintenanceReport,
  appendTraceRecorderStatusLines,
  appendRecentTraceSection,
  appendRecentTrajectorySection,
  appendMaintenanceSections,
  processDeferredExtractions,
  explainMemoryRetrieval,
  renderExplanationReport,
  renderReplayReport,
  renderValidationReport,
  runReplayCorpus,
  runValidationSet,
  recallMemory,
  reflectMemory,
  retainMemory,
  enhanceReflectionWithLocalInference,
  reflectionEvidenceCandidateLimit,
  recallHasQueryEvidence,
  resolveRetrievalPrompt,
  readOnboardingState,
  resolveOnboardingInput,
  getMaintenanceStatus,
  rollbackMemoryHygiene,
  runMaintenanceSweep,
  readLoreDoctorEnabled,
  readReviewGateEnabled,
  runDoctorObservation,
  runReviewGate,
  validateSkillsDirectory,
  formatValidationResults,
  importOkfPortableBundle,
  repoRootFromBuildersModule,
});

const MEMORY_TOOL_BUILDERS = [
  buildMemoryStatusTool,
  buildMemoryIntentJournalTool,
  buildMemoryPortableBundleTool,
  buildMaintenanceScheduleRunTool,
  buildMemoryImprovementBacklogTool,
  buildMemoryEvolutionLedgerTool,
  buildMemoryCapabilityInventoryTool,
  buildLoreRecallTool,
  buildLoreOnboardTool,
  buildLoreRetainTool,
  buildLoreReflectTool,
  buildMemorySearchTool,
  buildMemoryExplainTool,
  buildMemoryValidateTool,
  buildMemoryReplayTool,
  buildMemoryScopeOverrideTool,
  buildMemoryScopeAuditTool,
  buildMemoryForgetTool,
  buildMemoryDeferredProcessTool,
  buildMemoryBackfillTool,
  buildMemoryDoctorReportTool,
  buildMemoryReviewGateTool,
  buildMemorySkillValidateTool,
  buildMemoryCorrectTool,
  buildMemoryRepairTool,
  buildMemoryPurgeTool,
];

export function createMemoryTools({ getRuntime }) {
  return MEMORY_TOOL_BUILDERS.flatMap((buildTool) => (
    expandCoreAliasTools(buildTool(getRuntime, MEMORY_TOOL_BUILDER_CONTEXT))
  ));
}
