import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LORE_CAPABILITY_SPECS } from "./capability-manifest.mjs";
import { processDeferredExtractions } from "./backfill.mjs";
import {
  explainMemoryRetrieval,
  renderExplanationReport,
  renderReplayReport,
  renderValidationReport,
  runReplayCorpus,
  runValidationSet,
} from "./diagnostics.mjs";
import {
  recallMemory,
  reflectMemory,
  retainMemory,
} from "./memory-operations.mjs";
import {
  enhanceReflectionWithLocalInference,
  reflectionEvidenceCandidateLimit,
} from "./local-inference-reflection.mjs";
import {
  recallHasQueryEvidence,
  resolveRetrievalPrompt,
} from "./memory-tools-query-expansion.mjs";
import {
  readOnboardingState,
  resolveOnboardingInput,
} from "./onboarding.mjs";
import {
  getMaintenanceStatus,
  runMaintenanceSweep,
} from "./maintenance-scheduler.mjs";
import { rollbackMemoryHygiene } from "./memory-hygiene.mjs";
import {
  readLoreDoctorEnabled,
  readReviewGateEnabled,
} from "./rollout-flags.mjs";
import { runDoctorObservation } from "./lore-doctor.mjs";
import { runReviewGate } from "./review-gate.mjs";
import { validateSkillsDirectory, formatValidationResults } from "./skill-validator.mjs";
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

const _specByName = new Map(LORE_CAPABILITY_SPECS.map((s) => [s.name, s]));

function toolDef(name, rest) {
  const spec = _specByName.get(name);
  if (!spec) throw new Error(`No capability spec found for Lore tool: ${name}`);
  return { name: spec.name, description: spec.description, ...rest };
}

import { buildMemoryStatusTool } from "./memory-tool-builder-memory-status.mjs";
import { buildMemoryIntentJournalTool } from "./memory-tool-builder-memory-intent-journal.mjs";
import { buildMemoryPortableBundleTool } from "./memory-tool-builder-memory-portable-bundle.mjs";
import { buildMaintenanceScheduleRunTool } from "./memory-tool-builder-maintenance-schedule-run.mjs";
import { buildMemoryImprovementBacklogTool } from "./memory-tool-builder-memory-improvement-backlog.mjs";
import { buildMemoryEvolutionLedgerTool } from "./memory-tool-builder-memory-evolution-ledger.mjs";
import { buildMemoryCapabilityInventoryTool } from "./memory-tool-builder-memory-capability-inventory.mjs";
import { buildLoreRecallTool } from "./memory-tool-builder-lore-recall.mjs";
import { buildLoreOnboardTool } from "./memory-tool-builder-lore-onboard.mjs";
import { buildLoreRetainTool } from "./memory-tool-builder-lore-retain.mjs";
import { buildLoreReflectTool } from "./memory-tool-builder-lore-reflect.mjs";
import { buildMemorySearchTool } from "./memory-tool-builder-memory-search.mjs";
import { buildMemoryExplainTool } from "./memory-tool-builder-memory-explain.mjs";
import { buildMemoryValidateTool } from "./memory-tool-builder-memory-validate.mjs";
import { buildMemoryReplayTool } from "./memory-tool-builder-memory-replay.mjs";
import { buildMemoryScopeOverrideTool } from "./memory-tool-builder-memory-scope-override.mjs";
import { buildMemoryScopeAuditTool } from "./memory-tool-builder-memory-scope-audit.mjs";
import { buildMemorySaveTool } from "./memory-tool-builder-memory-save.mjs";
import { buildMemoryForgetTool } from "./memory-tool-builder-memory-forget.mjs";
import { buildMemoryDeferredProcessTool } from "./memory-tool-builder-memory-deferred-process.mjs";
import { buildMemoryBackfillTool } from "./memory-tool-builder-memory-backfill.mjs";
import { buildMemoryDoctorReportTool } from "./memory-tool-builder-memory-doctor-report.mjs";
import { buildMemoryReviewGateTool } from "./memory-tool-builder-memory-review-gate.mjs";
import { buildMemorySkillValidateTool } from "./memory-tool-builder-memory-skill-validate.mjs";

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
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  buildMemorySaveTool,
  buildMemoryForgetTool,
  buildMemoryDeferredProcessTool,
  buildMemoryBackfillTool,
  buildMemoryDoctorReportTool,
  buildMemoryReviewGateTool,
  buildMemorySkillValidateTool,
];

export function createMemoryTools({ getRuntime }) {
  return MEMORY_TOOL_BUILDERS.map((buildTool) => buildTool(getRuntime, MEMORY_TOOL_BUILDER_CONTEXT));
}
