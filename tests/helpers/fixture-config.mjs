/**
 * tests/helpers/fixture-config.mjs
 *
 * Builds typed config objects for test fixtures.
 *
 * Lore's loadConfig() module resolves paths at import time from process.env,
 * which makes it tricky to call in unit tests (ES module caching means the
 * env vars must be set before the first import, and they stick for the whole
 * process).  This helper constructs the exact same config shape programmatically
 * so tests can create isolated configs without relying on environment variable
 * tricks.
 *
 * The shape mirrors USER_CONFIG_DEFAULTS from lib/config.mjs.  If defaults
 * change there, update the inline defaults here too.
 *
 * Usage:
 *   import { freshInstallConfig, enabledConfig } from '../helpers/fixture-config.mjs';
 *
 *   const config = freshInstallConfig(home);   // enabled: false
 *   const config = enabledConfig(home);        // enabled: true
 *   const config = buildFixtureConfig(home, { budgets: { total: 500 } });
 */

import path from "node:path";

/**
 * Build the Lore/Coherence runtime config object for a given temp home path.
 *
 * All path-derived fields are rooted under `home`.  Any keys supplied in
 * `overrides` are deep-merged on top of the defaults so callers only need to
 * specify the fields they care about.
 *
 * @param {string} home       - Absolute path to the temp Copilot home dir.
 * @param {object} [overrides] - Partial config to merge (shallow for top-level
 *                               keys, deep for nested objects like `paths`).
 * @returns {object} A complete config object suitable for new CoherenceDb(config).
 */
export function buildFixtureConfig(home, overrides = {}) {
  const defaults = {
    enabled: false,
    paths: {
      copilotHome: home,
      rawStorePath: path.join(home, "session-store.db"),
      derivedStorePath: path.join(home, "coherence.db"),
      backupDir: path.join(home, "backups", "coherence"),
      instructionsPath: path.join(home, "copilot-instructions.md"),
      scopedInstructionsDir: path.join(home, "instructions"),
    },
    // Runtime-only — never read from file.
    configPath: path.join(home, "coherence.json"),
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
      enabled: false,
      autoEnqueueOnSessionEnd: false,
      autoProcessOnSessionStart: false,
      processCurrentRepositoryOnly: true,
      maxJobsPerRun: 2,
      retryDelayMinutes: 15,
    },
    maintenanceScheduler: {
      enabled: false,
      autoRunOnSessionStart: false,
    },
    traceRecorder: {
      maxRecords: 40,
      maxAgeMs: 30 * 60 * 1000,
      maxRowsPerLookup: 3,
      maxFilteredRowsPerLookup: 3,
      maxPromptChars: 160,
      maxRowChars: 160,
      maxContextChars: 600,
      persistDurableSample: false,
      durableSampleRate: 0,
      durableMaxRowsPerRepository: 120,
      durableMaxRowsGlobal: 240,
      durableMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
    },
    rollout: {
      ambientPersonaMode: false,
      autoWriteImprovementGoals: false,
      memoryOperations: false,
      workstreamOverlays: false,
      temporalQueryNormalization: false,
      retentionSanitization: false,
      traceRecorder: false,
      evolutionLedger: false,
      proposalGeneration: false,
      generatedArtifactIntegrity: false,
      overlayAutoHydration: false,
      coherenceDoctor: false,
      reviewGate: false,
      hybridRetrieval: false,
    },
  };

  return deepMerge(defaults, overrides);
}

/**
 * Fresh-install fixture: all features disabled, pointing at `home`.
 * Represents a user who has just installed Lore and has not yet opted in.
 *
 * @param {string} home
 * @returns {object}
 */
export function freshInstallConfig(home) {
  return buildFixtureConfig(home, { enabled: false });
}

/**
 * Enabled fixture: enabled:true, basic rollout flags on, pointing at `home`.
 * Represents a user who has opted in with a default config.
 *
 * @param {string} home
 * @returns {object}
 */
export function enabledConfig(home) {
  return buildFixtureConfig(home, {
    enabled: true,
    rollout: {
      memoryOperations: true,
      workstreamOverlays: true,
      temporalQueryNormalization: true,
      hybridRetrieval: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `override` onto `base`.  Arrays and primitives in
 * `override` replace the corresponding `base` value; plain objects are
 * merged one level deeper.
 */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = deepMerge(base[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
