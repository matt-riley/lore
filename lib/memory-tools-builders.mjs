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

function buildMemoryStatusTool(getRuntime) {
  return toolDef("memory_status", {
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
  });
}

function buildMemoryIntentJournalTool(getRuntime) {
  return toolDef("memory_intent_journal", {
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
  });
}

function buildMemoryPortableBundleTool(getRuntime) {
  return toolDef("memory_portable_bundle", {
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["export", "import"],
          description: "Export a portable bundle, or import (format=okf only) an OKF bundle directory into semantic memory",
        },
        repository: {
          type: "string",
          description: "Optional repository override",
        },
        bundlePath: {
          type: "string",
          description: "Optional repository-relative or absolute path for reading/writing bundles. For format=okf this is a directory root; for format=json (default) this is a single file path. Required for action=import.",
        },
        limit: {
          type: "number",
          description: "Maximum records to export/import per dataset",
        },
        format: {
          type: "string",
          enum: ["json", "okf"],
          description: "Bundle output format. \"json\" (default) writes a single signed JSON file. \"okf\" writes an Open Knowledge Format v0.1 markdown+frontmatter bundle directory (one concept file per artifact plus an index.md) for human/agent-readable, git-diffable exchange. action=import currently supports format=okf only.",
        },
        confidence: {
          type: "number",
          description: "Optional confidence override for action=import (default 0.7 -- lower than self-authored memory_save's 0.9, since imported content is externally sourced)",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = formatLoreUnavailable(runtime);
      if (unavailable) {
        return unavailable;
      }

      const request = buildPortableBundleRequest(args, runtime);

      if (request.action === "import") {
        return importOkfPortableBundle({ runtime, invocation, request });
      }

      const improvementArtifacts = runtime.db.listImprovementArtifacts({
        reviewState: "approved",
        hasProposal: true,
        limit: request.limit,
      });

      if (request.format === "okf") {
        const documents = buildOkfBundleDocuments({
          repository: request.repository,
          improvementArtifacts: improvementArtifacts.map(mapImprovementArtifactRow),
        });
        await writeOkfBundle(request.bundlePath, documents);
        return formatOkfBundleResult({
          bundleDir: request.bundlePath,
          repository: request.repository,
          exportedArtifactCount: improvementArtifacts.length,
        });
      }

      const portableBundle = createPortableBundle({
        repository: request.repository,
        improvementArtifacts,
      });
      await writePortableBundle(request.bundlePath, portableBundle);
      return formatPortableBundleResult({
        portableBundle,
        bundlePath: request.bundlePath,
        repository: request.repository,
      });
    },
  });
}

/**
 * action=import handler for memory_portable_bundle (format=okf only). Reads
 * an OKF bundle directory from disk and retains each concept as a
 * type=okf_concept semantic memory row (see okf-bundle-import.mjs). Passes
 * maxConcepts=request.limit and includeGraph=false into readOkfBundle so a
 * large/malicious bundle directory can't force unbounded file reads,
 * parsing, or link-graph construction -- only up to request.limit concept
 * files are actually read, not just capped after the fact.
 */
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

function buildMaintenanceScheduleRunTool(getRuntime) {
  return toolDef("maintenance_schedule_run", {
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
  });
}

function buildMemoryImprovementBacklogTool(getRuntime) {
  return toolDef("memory_improvement_backlog", {
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
    handler: withAvailableRuntime(getRuntime, async ({ args, runtime }) => {
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
        limit: ensureLimit(args.limit, 10, 20),
      });
      return [
        "## Improvement Backlog",
        "",
        formatImprovementArtifactRows(rows),
      ].join("\n");
    }),
  });
}

function buildMemoryEvolutionLedgerTool(getRuntime) {
  return toolDef("memory_evolution_ledger", {
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
  });
}

function buildMemoryCapabilityInventoryTool(_getRuntime) {
  return toolDef("memory_capability_inventory", {
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
      const action = normalizeCapabilityInventoryAction(args.action);
      const limit = ensureLimit(args.limit, 5, 20);
      return renderCapabilityInventoryAction(args, limit, action);
    },
  });
}

function buildLoreRecallTool(getRuntime) {
  return toolDef("lore_recall", {
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
      const queryExpansion = await resolveRetrievalPrompt(runtime, prompt);
      let result = recallMemory({
        db: runtime.db,
        prompt,
        retrievalPrompt: queryExpansion.query,
        repository: runtime.repository,
        includeOtherRepositories: args.includeOtherRepositories === true,
        limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
        sessionStore: runtime.sessionStore,
      });
      if (queryExpansion.used && !recallHasQueryEvidence(result)) {
        result = recallMemory({
          db: runtime.db,
          prompt,
          retrievalPrompt: queryExpansion.deterministicQuery,
          repository: runtime.repository,
          includeOtherRepositories: args.includeOtherRepositories === true,
          limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
          sessionStore: runtime.sessionStore,
        });
        queryExpansion.fallbackUsed = true;
      }
      result.queryExpansion = queryExpansion;
      return formatRecallEnvelope(result, {
        detailLevel: args.detailLevel === "full" || args.detailLevel === "evidence"
          ? args.detailLevel
          : "context",
        includeTrace: args.includeTrace === true,
      });
    },
  });
}

function buildLoreOnboardTool(getRuntime) {
  return toolDef("lore_onboard", {
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
  });
}

function buildLoreRetainTool(getRuntime) {
  return toolDef("lore_retain", {
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
  });
}

function buildLoreReflectTool(getRuntime) {
  return toolDef("lore_reflect", {
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
        lookbackHours: {
          type: "number",
          description: "Optional explicit time window (in hours) to directly pull real session activity from across repositories, bypassing free-text date detection. E.g. 24 for \"last day\".",
        },
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
        useLocalInference: {
          type: "boolean",
          description: "Override the configured default for synthesis with the local inference provider",
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
      const queryExpansion = await resolveRetrievalPrompt(runtime, request.prompt);
      const recentSessionCandidateLimit = reflectionEvidenceCandidateLimit(
        runtime.config?.localInference,
        request.useLocalInference,
      );
      let reflection = reflectMemory({
        db: runtime.db,
        prompt: request.prompt,
        retrievalPrompt: queryExpansion.query,
        repository: runtime.repository,
        includeOtherRepositories: request.includeOtherRepositories,
        limit: request.limit,
        sessionStore: runtime.sessionStore,
        focus: request.focus,
        lookbackHours: request.lookbackHours,
        recentSessionCandidateLimit,
      });
      if (queryExpansion.used && !recallHasQueryEvidence(reflection.recall)) {
        reflection = reflectMemory({
          db: runtime.db,
          prompt: request.prompt,
          retrievalPrompt: queryExpansion.deterministicQuery,
          repository: runtime.repository,
          includeOtherRepositories: request.includeOtherRepositories,
          limit: request.limit,
          sessionStore: runtime.sessionStore,
          focus: request.focus,
          lookbackHours: request.lookbackHours,
          recentSessionCandidateLimit,
        });
        queryExpansion.fallbackUsed = true;
      }
      reflection.queryExpansion = queryExpansion;
      if (request.useLocalInference) {
        if (runtime.config?.localInference?.enabled !== true) {
          reflection = {
            ...reflection,
            localInference: {
              requested: true,
              used: false,
              embeddingsUsed: false,
              embeddingError: null,
              error: "provider disabled",
            },
          };
        } else {
          try {
            reflection = await enhanceReflectionWithLocalInference({
              config: runtime.config.localInference,
              reflection,
              fetchImpl: runtime.localInferenceFetch,
            });
          } catch (error) {
            reflection = {
              ...reflection,
              localInference: {
                requested: true,
                used: false,
                embeddingsUsed: false,
                embeddingError: null,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }

        }
      }
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
  });
}

function buildMemorySearchTool(getRuntime) {
  return toolDef("memory_search", {
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
      const limit = ensureLimit(args.limit, 6, 50);
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
        includeTypedFallback: true,
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
  });
}

function buildMemoryExplainTool(getRuntime) {
  return toolDef("memory_explain", {
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
  });
}

function buildMemoryValidateTool(getRuntime) {
  return toolDef("memory_validate", {
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
  });
}

function buildMemoryReplayTool(getRuntime) {
  return toolDef("memory_replay", {
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
  });
}

function buildMemoryScopeOverrideTool(getRuntime) {
  return toolDef("memory_scope_override", {
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
  });
}

function buildMemoryScopeAuditTool(getRuntime) {
  return toolDef("memory_scope_audit", {
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
        limit: ensureLimit(args.limit, 10, 50),
      });
      return [
        "## Scope Override Audit",
        "",
        formatAuditRows(rows),
      ].join("\n");
    },
  });
}

function buildMemorySaveTool(getRuntime) {
  return toolDef("memory_save", {
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
    handler: withAvailableRuntime(getRuntime, async ({ args, invocation, runtime }) => {
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
    }),
  });
}

function buildMemoryForgetTool(getRuntime) {
  return toolDef("memory_forget", {
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
  });
}

function buildMemoryDeferredProcessTool(getRuntime) {
  return toolDef("memory_deferred_process", {
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
    handler: withAvailableRuntime(getRuntime, async ({ args, runtime }) => {
      const limit = ensureLimit(args.limit, runtime.config.deferredExtraction?.maxJobsPerRun ?? 2, 20);
      const includeOtherRepositories = args.includeOtherRepositories === true;
      const result = await processDeferredExtractions({
        db: runtime.db,
        sessionStore: runtime.sessionStore,
        repository: includeOtherRepositories ? null : runtime.repository,
        limit,
        retryDelayMinutes: runtime.config.deferredExtraction?.retryDelayMinutes ?? 15,
        fetchImpl: runtime.localInferenceFetch,
      });
      return [
        `Processed ${result.processed} deferred job(s), failed ${result.failed}, inspected ${result.inspected}.`,
        `Local inference used ${result.inferenceUsed}, fell back ${result.inferenceFailed}.`,
      ].join("\n");
    }),
  });
}

function buildMemoryBackfillTool(getRuntime) {
  return toolDef("memory_backfill", {
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
  });
}

function buildMemoryDoctorReportTool(getRuntime) {
  return toolDef("memory_doctor_report", {
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
  });
}

function buildMemoryReviewGateTool(getRuntime) {
  return toolDef("memory_review_gate", {
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
  });
}

function buildMemorySkillValidateTool(getRuntime) {
  return toolDef("memory_skill_validate", {
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
    handler: withAvailableRuntime(getRuntime, async ({ args, runtime }) => {
      const rootPath = runtime.workspaceRoot || process.cwd();
      const action = args.action === "detailed" ? "detailed" : "summary";

      try {
        const result = await validateSkillsDirectory(rootPath);
        return formatValidationResults(result, action);
      } catch (error) {
        return `skill validation error: ${error?.message ?? "unknown error"}`;
      }
    }),
  });
}

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
  return MEMORY_TOOL_BUILDERS.map((buildTool) => buildTool(getRuntime));
}
