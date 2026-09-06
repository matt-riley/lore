import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { resolveLorePaths } from "./lore-paths.mjs";

const resolvedPaths = resolveLorePaths();
const COPILOT_HOME = resolvedPaths.copilotHome;
const CONFIG_PATH = resolvedPaths.configPath;

// Fields the user may set in lore.json.  `configPath` is the only
// runtime-only field — it is never read from the file.  `paths.*` entries have
// runtime-derived defaults but may be overridden in the file.
export const USER_CONFIG_DEFAULTS = Object.freeze({
  enabled: false,
  paths: {
    copilotHome: COPILOT_HOME,
    rawStorePath: path.join(COPILOT_HOME, "session-store.db"),
    derivedStorePath: resolvedPaths.derivedStorePath,
    backupDir: resolvedPaths.backupDir,
    instructionsPath: path.join(COPILOT_HOME, "copilot-instructions.md"),
    scopedInstructionsDir: path.join(COPILOT_HOME, "instructions"),
  },
  budgets: {
    procedural: 220,
    semantic: 420,
    episodes: 320,
    commitments: 180,
    workingProfile: 240,
    total: 1200,
  },
  limits: {
    semanticSearchLimit: 8,
    episodeSearchLimit: 5,
    promptContextLimit: 6,
    crossRepoPreferenceLimit: 2,
    crossRepoEpisodeLimit: 2,
    metricWindowSize: 200,
    recentSessionsFallbackLimit: 3,
  },
  latencyTargetsMs: {
    sessionStartP95: 100,
    userPromptSubmittedP95: 150,
  },
  latencyReadinessMinSamples: {
    sessionStart: 20,
    userPromptSubmitted: 50,
  },
  localInference: {
    enabled: false,
    baseUrl: "http://127.0.0.1:12434/v1",
    model: "",
    timeoutMs: 30000,
    maxInputChars: 24000,
    maxOutputTokens: 1200,
    temperature: 0,
    reflection: {
      enabledByDefault: false,
    },
    queryExpansion: {
      enabled: false,
      maxTerms: 8,
    },
    contextCompression: {
      enabled: false,
      minInputTokens: 900,
      targetTokens: 700,
      maxSections: 8,
    },
    analysis: {
      consolidation: {
        enabled: true,
        maxItems: 4,
      },
      contradictions: {
        enabled: true,
        maxItems: 4,
      },
      trends: {
        enabled: true,
        maxItems: 4,
        minOccurrences: 2,
      },
      qualityEvaluation: {
        enabled: false,
        minSupport: 0.8,
        minSpecificity: 0.6,
        minUsefulness: 0.6,
      },
    },
    embeddings: {
      enabled: false,
      model: "",
      maxInputs: 24,
      topK: 6,
      minSimilarity: 0.2,
      groundingMinSimilarity: 0.35,
    },
  },
  deferredExtraction: {
    enabled: true,
    autoEnqueueOnSessionEnd: true,
    autoProcessOnSessionStart: true,
    processCurrentRepositoryOnly: true,
    maxJobsPerRun: 2,
    retryDelayMinutes: 15,
    staleJobAfterMinutes: 30,
    useLocalInference: false,
  },
  maintenanceScheduler: {
    enabled: false,
    autoRunOnSessionStart: true,
    staleRunAfterMinutes: 30,
    maxTasksPerRun: 4,
    validationCaseLimit: 3,
    replayCaseLimit: 2,
    backlogReviewLimit: 10,
    backlogStaleAfterHours: 72,
    memoryHygiene: {
      mode: "off",
      maxItems: 50,
      includeGlobal: true,
    },
    sessionStartBackfill: {
      enabled: false,
      includeOtherRepositories: true,
      refreshExisting: false,
      batchSize: 25,
      maxCandidates: 250,
      maxInspected: 2000,
      notifyEveryItems: 50,
    },
    tasks: {
      memoryHygiene: true,
      deferredExtraction: true,
      validationCorpus: true,
      replayCorpus: true,
      backlogReview: true,
      traceCompaction: false,
      indexUpkeep: false,
      doctorSnapshot: false,
    },
    taskCadenceMinutes: {
      memoryHygiene: 0,
      deferredExtraction: 0,
      validationCorpus: 12 * 60,
      replayCorpus: 24 * 60,
      backlogReview: 6 * 60,
      traceCompaction: 60,
      indexUpkeep: 12 * 60,
      doctorSnapshot: 24 * 60,
    },
  },
  traceRecorder: {
    maxRecords: 40,
    maxAgeMs: 30 * 60 * 1000,
    maxRowsPerLookup: 3,
    maxFilteredRowsPerLookup: 3,
    maxPromptChars: 160,
    maxRowChars: 160,
    maxContextChars: 600,
    persistDurableSample: true,
    durableSampleRate: 0.25,
    durableMaxRowsPerRepository: 120,
    durableMaxRowsGlobal: 240,
    durableMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
  },
  rollout: {
    ambientPersonaMode: false,
    autoWriteImprovementGoals: false,
    memoryOperations: true,
    workstreamOverlays: true,
    temporalQueryNormalization: true,
    memoryDomains: true,
    refreshableObservations: true,
    retentionSanitization: true,
    directives: true,
    traceRecorder: false,
    evolutionLedger: true,
    proposalGeneration: true,
    generatedArtifactIntegrity: true,
    overlayAutoHydration: true,
    loreDoctor: true,
    reviewGate: true,
    approvalSubstrate: true,
    hybridRetrieval: true,
    ambientWorkingProfile: true,
    errorTelemetry: false,
    postToolUse: false,
    subagentScopeTracking: false,
    preToolUseGuardrail: false,
  },
});

// Keys that may legally appear in lore.json.  $schema is stripped before
// this check so editors can annotate files without triggering warnings.
// configPath is intentionally absent — it is runtime-only.
const SUPPORTED_USER_KEYS = new Set(Object.keys(USER_CONFIG_DEFAULTS));

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeDeep(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeDeep(base[key], value);
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

export function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(lowered)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(lowered)) {
      return false;
    }
  }
  return fallback;
}

export function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function loadFileConfigSync(configPath) {
  if (!configPath || !existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

// Strip editor/schema metadata and warn on unrecognised keys.  Returns only
// the user-authorable subset so unknown keys never reach the merge step.
function normalizeFileConfig(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  // eslint-disable-next-line no-unused-vars
  const { $schema: _ignored, maintenance: legacyMaintenance, ...rest } = value;

  const cleaned = {};
  for (const [key, val] of Object.entries(rest)) {
    if (SUPPORTED_USER_KEYS.has(key)) {
      cleaned[key] = val;
    } else {
      console.warn(
        `[lore] lore.json: unsupported key "${key}" — ignored`,
      );
    }
  }
  if (isPlainObject(legacyMaintenance) && !("maintenanceScheduler" in cleaned)) {
    console.warn(
      "[lore] lore.json: \"maintenance\" is deprecated — use \"maintenanceScheduler\"",
    );
    cleaned.maintenanceScheduler = legacyMaintenance;
  }
  return cleaned;
}

async function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }

  const raw = await readFile(CONFIG_PATH, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `[lore] Failed to parse config file "${CONFIG_PATH}": ${cause.message}`,
      { cause },
    );
  }
  return normalizeFileConfig(parsed);
}

export function normalizeRolloutConfig(rollout = {}) {
  return {
    ambientPersonaMode: normalizeBoolean(
      rollout.ambientPersonaMode,
      USER_CONFIG_DEFAULTS.rollout.ambientPersonaMode,
    ),
    autoWriteImprovementGoals: normalizeBoolean(
      rollout.autoWriteImprovementGoals,
      USER_CONFIG_DEFAULTS.rollout.autoWriteImprovementGoals,
    ),
    memoryOperations: normalizeBoolean(
      rollout.memoryOperations,
      USER_CONFIG_DEFAULTS.rollout.memoryOperations,
    ),
    workstreamOverlays: normalizeBoolean(
      rollout.workstreamOverlays,
      USER_CONFIG_DEFAULTS.rollout.workstreamOverlays,
    ),
    temporalQueryNormalization: normalizeBoolean(
      rollout.temporalQueryNormalization,
      USER_CONFIG_DEFAULTS.rollout.temporalQueryNormalization,
    ),
    memoryDomains: normalizeBoolean(
      rollout.memoryDomains,
      USER_CONFIG_DEFAULTS.rollout.memoryDomains,
    ),
    refreshableObservations: normalizeBoolean(
      rollout.refreshableObservations,
      USER_CONFIG_DEFAULTS.rollout.refreshableObservations,
    ),
    retentionSanitization: normalizeBoolean(
      rollout.retentionSanitization,
      USER_CONFIG_DEFAULTS.rollout.retentionSanitization,
    ),
    directives: normalizeBoolean(
      rollout.directives,
      USER_CONFIG_DEFAULTS.rollout.directives,
    ),
    traceRecorder: normalizeBoolean(
      rollout.traceRecorder,
      USER_CONFIG_DEFAULTS.rollout.traceRecorder,
    ),
    evolutionLedger: normalizeBoolean(
      rollout.evolutionLedger,
      USER_CONFIG_DEFAULTS.rollout.evolutionLedger,
    ),
    proposalGeneration: normalizeBoolean(
      rollout.proposalGeneration,
      USER_CONFIG_DEFAULTS.rollout.proposalGeneration,
    ),
    generatedArtifactIntegrity: normalizeBoolean(
      rollout.generatedArtifactIntegrity,
      USER_CONFIG_DEFAULTS.rollout.generatedArtifactIntegrity,
    ),
    overlayAutoHydration: normalizeBoolean(
      rollout.overlayAutoHydration,
      USER_CONFIG_DEFAULTS.rollout.overlayAutoHydration,
    ),
    loreDoctor: normalizeBoolean(
      rollout.loreDoctor,
      USER_CONFIG_DEFAULTS.rollout.loreDoctor,
    ),
    reviewGate: normalizeBoolean(
      rollout.reviewGate,
      USER_CONFIG_DEFAULTS.rollout.reviewGate,
    ),
    approvalSubstrate: normalizeBoolean(
      rollout.approvalSubstrate,
      USER_CONFIG_DEFAULTS.rollout.approvalSubstrate,
    ),
    hybridRetrieval: normalizeBoolean(
      rollout.hybridRetrieval,
      USER_CONFIG_DEFAULTS.rollout.hybridRetrieval,
    ),
    ambientWorkingProfile: normalizeBoolean(
      rollout.ambientWorkingProfile,
      USER_CONFIG_DEFAULTS.rollout.ambientWorkingProfile,
    ),
    errorTelemetry: normalizeBoolean(
      rollout.errorTelemetry,
      USER_CONFIG_DEFAULTS.rollout.errorTelemetry,
    ),
    postToolUse: normalizeBoolean(
      rollout.postToolUse,
      USER_CONFIG_DEFAULTS.rollout.postToolUse,
    ),
    subagentScopeTracking: normalizeBoolean(
      rollout.subagentScopeTracking,
      USER_CONFIG_DEFAULTS.rollout.subagentScopeTracking,
    ),
    preToolUseGuardrail: normalizeBoolean(
      rollout.preToolUseGuardrail,
      USER_CONFIG_DEFAULTS.rollout.preToolUseGuardrail,
    ),
  };
}

function buildLoadedConfig(merged, envEnabled) {
  return {
    ...merged,
    rollout: {
      ...merged.rollout,
      ...normalizeRolloutConfig(merged.rollout),
    },
    enabled: normalizeBoolean(envEnabled, merged.enabled),
    configPath: CONFIG_PATH,
  };
}

export async function loadConfig() {
  const fileConfig = await readConfigFile();
  const merged = mergeDeep(USER_CONFIG_DEFAULTS, fileConfig);
  return buildLoadedConfig(merged, process.env.LORE_ENABLED);
}
