/**
 * tests/unit/config.test.mjs
 *
 * Unit tests for lib/config.mjs.
 *
 * Covers:
 *   - loadConfig() throws an actionable error when the config file is malformed JSON.
 *   - The error message includes the resolved config path and the original parse message.
 *
 * Run:
 *   node --test tests/unit/config.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeRolloutConfig,
  USER_CONFIG_DEFAULTS,
} from "../../lib/config.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MALFORMED_FIXTURE = resolve(
  __dirname,
  "../fixtures/configs/malformed.json",
);

// Cache-bust counter so each test gets a fresh module evaluation.
let bust = 0;
async function freshConfig(envOverrides = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const url = new URL(`../../lib/config.mjs?v=${++bust}`, import.meta.url);
    return await import(url.href);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

describe("loadConfig", () => {
  test("local inference defaults keep every model-backed surface opt-in", () => {
    assert.deepStrictEqual(USER_CONFIG_DEFAULTS.localInference, {
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
    });
    assert.equal(USER_CONFIG_DEFAULTS.deferredExtraction.useLocalInference, false);
  });

  test("normalizeRolloutConfig coerces string booleans against rollout defaults", async () => {
    const mod = await freshConfig();

    assert.deepStrictEqual(
      mod.normalizeRolloutConfig({
        memoryOperations: "false",
        traceRecorder: "yes",
        hybridRetrieval: "off",
      }),
      {
        ambientPersonaMode: false,
        autoWriteImprovementGoals: false,
        memoryOperations: false,
        workstreamOverlays: true,
        temporalQueryNormalization: true,
        memoryDomains: true,
        refreshableObservations: true,
        retentionSanitization: true,
        directives: true,
        traceRecorder: true,
        evolutionLedger: true,
        proposalGeneration: true,
        generatedArtifactIntegrity: true,
        overlayAutoHydration: true,
        loreDoctor: true,
        reviewGate: true,
        approvalSubstrate: true,
        hybridRetrieval: false,
        ambientWorkingProfile: true,
      },
    );
  });

  test("throws an actionable error for a malformed config file", async () => {
    const mod = await freshConfig({ LORE_CONFIG: MALFORMED_FIXTURE });

    await assert.rejects(
      () => mod.loadConfig(),
      (err) => {
        assert.ok(
          err instanceof Error,
          "error should be an Error instance",
        );
        assert.ok(
          err.message.includes(MALFORMED_FIXTURE),
          `error message should include config path, got: ${err.message}`,
        );
        // The original JSON parse message should be present.
        assert.ok(
          err.message.toLowerCase().includes("json") ||
            err.message.includes("parse") ||
            err.message.includes("Unexpected") ||
            err.message.includes("token") ||
            err.message.includes("end of"),
          `error message should include parse details, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// Direct test of normalizeRolloutConfig using static import
// (ensures Fallow can detect the export is used)
describe("normalizeRolloutConfig", () => {
  test("normalizeRolloutConfig is exported and callable", () => {
    const result = normalizeRolloutConfig();
    assert.ok(result, "normalizeRolloutConfig should return an object");
    assert.ok(
      typeof result === "object",
      "normalizeRolloutConfig should return an object",
    );
  });
});
