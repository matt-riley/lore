import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// LORE_COPILOT_HOME overrides the default ~/.copilot home directory.
// Useful for test fixtures, CI, or non-standard installs.
// LORE_CONFIG overrides the config file path directly (takes priority).
const COPILOT_HOME =
  process.env.LORE_COPILOT_HOME?.trim() || path.join(os.homedir(), ".copilot");
const CONFIG_PATH =
  process.env.LORE_CONFIG?.trim() || path.join(COPILOT_HOME, "lore.json");

// Fields the user may set in lore.json.  `configPath` is the only
// runtime-only field — it is never read from the file.  `paths.*` entries have
// runtime-derived defaults but may be overridden in the file.
export const USER_CONFIG_DEFAULTS = Object.freeze({
  enabled: false,
  paths: {
    copilotHome: COPILOT_HOME,
    rawStorePath: path.join(COPILOT_HOME, "session-store.db"),
    derivedStorePath: path.join(COPILOT_HOME, "lore.db"),
    backupDir: path.join(COPILOT_HOME, "backups", "lore"),
    instructionsPath: path.join(COPILOT_HOME, "copilot-instructions.md"),
    scopedInstructionsDir: path.join(COPILOT_HOME, "instructions"),
  },
  budgets: {
    procedural: 220,
    semantic: 420,
    episodes: 320,
    commitments: 180,
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
  deferredExtraction: {
    enabled: true,
    autoEnqueueOnSessionEnd: true,
    autoProcessOnSessionStart: true,
    processCurrentRepositoryOnly: true,
    maxJobsPerRun: 2,
    retryDelayMinutes: 15,
  },
  maintenanceScheduler: {
    enabled: false,
    autoRunOnSessionStart: true,
    maxTasksPerRun: 4,
    validationCaseLimit: 3,
    replayCaseLimit: 2,
    backlogReviewLimit: 10,
    backlogStaleAfterHours: 72,
    tasks: {
      deferredExtraction: true,
      validationCorpus: true,
      replayCorpus: true,
      backlogReview: true,
      traceCompaction: false,
      indexUpkeep: false,
      doctorSnapshot: false,
    },
    taskCadenceMinutes: {
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
    memoryDomains: false,
    refreshableObservations: false,
    retentionSanitization: true,
    directives: true,
    traceRecorder: false,
    evolutionLedger: true,
    proposalGeneration: false,
    generatedArtifactIntegrity: true,
    overlayAutoHydration: true,
    loreDoctor: false,
    reviewGate: false,
    hybridRetrieval: true,
  },
});

// Keys that may legally appear in lore.json.  $schema is stripped before
// this check so editors can annotate files without triggering warnings.
// configPath is intentionally absent — it is runtime-only.
const SUPPORTED_USER_KEYS = new Set(Object.keys(USER_CONFIG_DEFAULTS));

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep(base, override) {
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

function normalizeBoolean(value, fallback) {
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

export async function loadConfig() {
  let fileConfig = {};
  if (existsSync(CONFIG_PATH)) {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    fileConfig = normalizeFileConfig(parsed);
  }

  const merged = mergeDeep(USER_CONFIG_DEFAULTS, fileConfig);
  const envEnabled = process.env.LORE_ENABLED;
  const normalizedRollout = {
    ambientPersonaMode: normalizeBoolean(
      merged.rollout?.ambientPersonaMode,
      USER_CONFIG_DEFAULTS.rollout.ambientPersonaMode,
    ),
    autoWriteImprovementGoals: normalizeBoolean(
      merged.rollout?.autoWriteImprovementGoals,
      USER_CONFIG_DEFAULTS.rollout.autoWriteImprovementGoals,
    ),
    memoryOperations: normalizeBoolean(
      merged.rollout?.memoryOperations,
      USER_CONFIG_DEFAULTS.rollout.memoryOperations,
    ),
    workstreamOverlays: normalizeBoolean(
      merged.rollout?.workstreamOverlays,
      USER_CONFIG_DEFAULTS.rollout.workstreamOverlays,
    ),
    temporalQueryNormalization: normalizeBoolean(
      merged.rollout?.temporalQueryNormalization,
      USER_CONFIG_DEFAULTS.rollout.temporalQueryNormalization,
    ),
    memoryDomains: normalizeBoolean(
      merged.rollout?.memoryDomains,
      USER_CONFIG_DEFAULTS.rollout.memoryDomains,
    ),
    refreshableObservations: normalizeBoolean(
      merged.rollout?.refreshableObservations,
      USER_CONFIG_DEFAULTS.rollout.refreshableObservations,
    ),
    retentionSanitization: normalizeBoolean(
      merged.rollout?.retentionSanitization,
      USER_CONFIG_DEFAULTS.rollout.retentionSanitization,
    ),
    directives: normalizeBoolean(
      merged.rollout?.directives,
      USER_CONFIG_DEFAULTS.rollout.directives,
    ),
    traceRecorder: normalizeBoolean(
      merged.rollout?.traceRecorder,
      USER_CONFIG_DEFAULTS.rollout.traceRecorder,
    ),
    evolutionLedger: normalizeBoolean(
      merged.rollout?.evolutionLedger,
      USER_CONFIG_DEFAULTS.rollout.evolutionLedger,
    ),
    proposalGeneration: normalizeBoolean(
      merged.rollout?.proposalGeneration,
      USER_CONFIG_DEFAULTS.rollout.proposalGeneration,
    ),
    generatedArtifactIntegrity: normalizeBoolean(
      merged.rollout?.generatedArtifactIntegrity,
      USER_CONFIG_DEFAULTS.rollout.generatedArtifactIntegrity,
    ),
    overlayAutoHydration: normalizeBoolean(
      merged.rollout?.overlayAutoHydration,
      USER_CONFIG_DEFAULTS.rollout.overlayAutoHydration,
    ),
    loreDoctor: normalizeBoolean(
      merged.rollout?.loreDoctor,
      USER_CONFIG_DEFAULTS.rollout.loreDoctor,
    ),
    reviewGate: normalizeBoolean(
      merged.rollout?.reviewGate,
      USER_CONFIG_DEFAULTS.rollout.reviewGate,
    ),
    hybridRetrieval: normalizeBoolean(
      merged.rollout?.hybridRetrieval,
      USER_CONFIG_DEFAULTS.rollout.hybridRetrieval,
    ),
  };

  return {
    ...merged,
    rollout: {
      ...merged.rollout,
      ...normalizedRollout,
    },
    enabled: normalizeBoolean(envEnabled, merged.enabled),
    // configPath is the only runtime-only field — always computed, never read from file.
    configPath: CONFIG_PATH,
  };
}
