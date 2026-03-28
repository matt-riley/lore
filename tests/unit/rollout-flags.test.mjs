/**
 * tests/unit/rollout-flags.test.mjs
 *
 * Unit tests for lib/rollout-flags.mjs.
 *
 * Covers:
 *   - Each flag reader returns the expected value for a fully-specified config.
 *   - Cascading dependencies: flags that require a parent flag also return
 *     false when the parent is disabled, even when the child flag itself is
 *     true.
 *   - Boolean coercion: string values "true"/"false"/"1"/"0"/"yes"/"no" etc.
 *     are correctly normalised by the underlying normalizeBoolean helper.
 *   - Graceful null/undefined config handling: no crash, sensible fallback.
 *
 * Run:
 *   node --test tests/unit/rollout-flags.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  readMemoryOperationsEnabled,
  readWorkstreamOverlaysEnabled,
  readTemporalQueryNormalizationEnabled,
  readRetentionSanitizationEnabled,
  readDirectivesEnabled,
  readTraceRecorderEnabled,
  readEvolutionLedgerEnabled,
  readProposalGenerationEnabled,
  readGeneratedArtifactIntegrityEnabled,
  readOverlayAutoHydrationEnabled,
  readLoreDoctorEnabled,
  readHybridRetrievalEnabled,
  readReviewGateEnabled,
} from "../../lib/rollout-flags.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal config with all rollout flags set explicitly. */
function cfg(rollout = {}) {
  return { rollout };
}

/** All flags on */
const ALL_ON = cfg({
  memoryOperations: true,
  workstreamOverlays: true,
  temporalQueryNormalization: true,
  retentionSanitization: true,
  directives: true,
  traceRecorder: true,
  evolutionLedger: true,
  proposalGeneration: true,
  generatedArtifactIntegrity: true,
  overlayAutoHydration: true,
  loreDoctor: true,
  hybridRetrieval: true,
  reviewGate: true,
});

/** All flags off */
const ALL_OFF = cfg({
  memoryOperations: false,
  workstreamOverlays: false,
  temporalQueryNormalization: false,
  retentionSanitization: false,
  directives: false,
  traceRecorder: false,
  evolutionLedger: false,
  proposalGeneration: false,
  generatedArtifactIntegrity: false,
  overlayAutoHydration: false,
  loreDoctor: false,
  hybridRetrieval: false,
  reviewGate: false,
});

// ---------------------------------------------------------------------------
// readMemoryOperationsEnabled
// ---------------------------------------------------------------------------

describe("readMemoryOperationsEnabled", () => {
  test("returns true when rollout.memoryOperations is true", () => {
    assert.strictEqual(readMemoryOperationsEnabled(ALL_ON), true);
  });

  test("returns false when rollout.memoryOperations is false", () => {
    assert.strictEqual(readMemoryOperationsEnabled(ALL_OFF), false);
  });

  test("falls back to true when rollout.memoryOperations is absent", () => {
    // The default fallback in the implementation is `true`.
    assert.strictEqual(readMemoryOperationsEnabled(cfg({})), true);
  });

  test("returns true for null/undefined config (resilient)", () => {
    assert.strictEqual(readMemoryOperationsEnabled(null), true);
    assert.strictEqual(readMemoryOperationsEnabled(undefined), true);
  });
});

// ---------------------------------------------------------------------------
// readWorkstreamOverlaysEnabled — requires memoryOperations
// ---------------------------------------------------------------------------

describe("readWorkstreamOverlaysEnabled — cascading", () => {
  test("returns true when both memoryOperations and workstreamOverlays are true", () => {
    assert.strictEqual(readWorkstreamOverlaysEnabled(ALL_ON), true);
  });

  test("returns false when workstreamOverlays is false (memoryOperations on)", () => {
    const c = cfg({ memoryOperations: true, workstreamOverlays: false });
    assert.strictEqual(readWorkstreamOverlaysEnabled(c), false);
  });

  test("returns false when memoryOperations is false (even if workstreamOverlays is true)", () => {
    const c = cfg({ memoryOperations: false, workstreamOverlays: true });
    assert.strictEqual(readWorkstreamOverlaysEnabled(c), false);
  });
});

// ---------------------------------------------------------------------------
// readTemporalQueryNormalizationEnabled — requires memoryOperations
// ---------------------------------------------------------------------------

describe("readTemporalQueryNormalizationEnabled — cascading", () => {
  test("returns true when both parent flags are true", () => {
    assert.strictEqual(readTemporalQueryNormalizationEnabled(ALL_ON), true);
  });

  test("returns false when memoryOperations is false", () => {
    const c = cfg({ memoryOperations: false, temporalQueryNormalization: true });
    assert.strictEqual(readTemporalQueryNormalizationEnabled(c), false);
  });

  test("returns false when temporalQueryNormalization is false", () => {
    const c = cfg({ memoryOperations: true, temporalQueryNormalization: false });
    assert.strictEqual(readTemporalQueryNormalizationEnabled(c), false);
  });
});

// ---------------------------------------------------------------------------
// readRetentionSanitizationEnabled — requires memoryOperations
// ---------------------------------------------------------------------------

describe("readRetentionSanitizationEnabled — cascading", () => {
  test("returns true when both flags are on", () => {
    assert.strictEqual(readRetentionSanitizationEnabled(ALL_ON), true);
  });

  test("returns false when memoryOperations is off", () => {
    const c = cfg({ memoryOperations: false, retentionSanitization: true });
    assert.strictEqual(readRetentionSanitizationEnabled(c), false);
  });
});

// ---------------------------------------------------------------------------
// readDirectivesEnabled — requires memoryOperations
// ---------------------------------------------------------------------------

describe("readDirectivesEnabled — cascading", () => {
  test("returns true when both flags are on", () => {
    assert.strictEqual(readDirectivesEnabled(ALL_ON), true);
  });

  test("returns false when memoryOperations is off", () => {
    const c = cfg({ memoryOperations: false, directives: true });
    assert.strictEqual(readDirectivesEnabled(c), false);
  });

  test("falls back to true when directives is absent and memoryOperations is on", () => {
    const c = cfg({ memoryOperations: true });
    assert.strictEqual(readDirectivesEnabled(c), true);
  });
});

// ---------------------------------------------------------------------------
// readTraceRecorderEnabled — standalone (no parent dependency)
// ---------------------------------------------------------------------------

describe("readTraceRecorderEnabled", () => {
  test("returns true when traceRecorder is true", () => {
    assert.strictEqual(readTraceRecorderEnabled(ALL_ON), true);
  });

  test("returns false when traceRecorder is false", () => {
    assert.strictEqual(readTraceRecorderEnabled(ALL_OFF), false);
  });

  test("falls back to false when traceRecorder is absent", () => {
    // The default fallback in the implementation is `false`.
    assert.strictEqual(readTraceRecorderEnabled(cfg({})), false);
  });

  test("is independent of memoryOperations", () => {
    const c = cfg({ memoryOperations: false, traceRecorder: true });
    assert.strictEqual(readTraceRecorderEnabled(c), true);
  });
});

// ---------------------------------------------------------------------------
// readEvolutionLedgerEnabled — standalone
// ---------------------------------------------------------------------------

describe("readEvolutionLedgerEnabled", () => {
  test("returns true when evolutionLedger is true", () => {
    assert.strictEqual(readEvolutionLedgerEnabled(ALL_ON), true);
  });

  test("returns false when evolutionLedger is false", () => {
    assert.strictEqual(readEvolutionLedgerEnabled(ALL_OFF), false);
  });

  test("falls back to true when absent", () => {
    assert.strictEqual(readEvolutionLedgerEnabled(cfg({})), true);
  });
});

// ---------------------------------------------------------------------------
// readProposalGenerationEnabled — requires evolutionLedger
// ---------------------------------------------------------------------------

describe("readProposalGenerationEnabled — cascading", () => {
  test("returns true when both are on", () => {
    assert.strictEqual(readProposalGenerationEnabled(ALL_ON), true);
  });

  test("returns false when evolutionLedger is off", () => {
    const c = cfg({ evolutionLedger: false, proposalGeneration: true });
    assert.strictEqual(readProposalGenerationEnabled(c), false);
  });

  test("returns false when proposalGeneration is off", () => {
    const c = cfg({ evolutionLedger: true, proposalGeneration: false });
    assert.strictEqual(readProposalGenerationEnabled(c), false);
  });

  test("falls back to false when proposalGeneration is absent", () => {
    const c = cfg({ evolutionLedger: true });
    assert.strictEqual(readProposalGenerationEnabled(c), false);
  });
});

// ---------------------------------------------------------------------------
// readGeneratedArtifactIntegrityEnabled — requires evolutionLedger
// ---------------------------------------------------------------------------

describe("readGeneratedArtifactIntegrityEnabled — cascading", () => {
  test("returns true when both are on", () => {
    assert.strictEqual(readGeneratedArtifactIntegrityEnabled(ALL_ON), true);
  });

  test("returns false when evolutionLedger is off", () => {
    const c = cfg({ evolutionLedger: false, generatedArtifactIntegrity: true });
    assert.strictEqual(readGeneratedArtifactIntegrityEnabled(c), false);
  });

  test("falls back to true for generatedArtifactIntegrity when absent", () => {
    const c = cfg({ evolutionLedger: true });
    assert.strictEqual(readGeneratedArtifactIntegrityEnabled(c), true);
  });
});

// ---------------------------------------------------------------------------
// readOverlayAutoHydrationEnabled — requires workstreamOverlays (and memoryOps)
// ---------------------------------------------------------------------------

describe("readOverlayAutoHydrationEnabled — cascading", () => {
  test("returns true when all ancestor flags are on", () => {
    assert.strictEqual(readOverlayAutoHydrationEnabled(ALL_ON), true);
  });

  test("returns false when memoryOperations is off", () => {
    const c = cfg({
      memoryOperations: false,
      workstreamOverlays: true,
      overlayAutoHydration: true,
    });
    assert.strictEqual(readOverlayAutoHydrationEnabled(c), false);
  });

  test("returns false when workstreamOverlays is off (memoryOperations on)", () => {
    const c = cfg({
      memoryOperations: true,
      workstreamOverlays: false,
      overlayAutoHydration: true,
    });
    assert.strictEqual(readOverlayAutoHydrationEnabled(c), false);
  });

  test("returns false when overlayAutoHydration is off (parents on)", () => {
    const c = cfg({
      memoryOperations: true,
      workstreamOverlays: true,
      overlayAutoHydration: false,
    });
    assert.strictEqual(readOverlayAutoHydrationEnabled(c), false);
  });
});

// ---------------------------------------------------------------------------
// readLoreDoctorEnabled — requires evolutionLedger
// ---------------------------------------------------------------------------

describe("readLoreDoctorEnabled — cascading", () => {
  test("returns true when both are on", () => {
    assert.strictEqual(readLoreDoctorEnabled(ALL_ON), true);
  });

  test("returns false when evolutionLedger is off", () => {
    const c = cfg({ evolutionLedger: false, loreDoctor: true });
    assert.strictEqual(readLoreDoctorEnabled(c), false);
  });

  test("falls back to false when loreDoctor is absent", () => {
    const c = cfg({ evolutionLedger: true });
    assert.strictEqual(readLoreDoctorEnabled(c), false);
  });
});

// ---------------------------------------------------------------------------
// readHybridRetrievalEnabled — requires memoryOperations
// ---------------------------------------------------------------------------

describe("readHybridRetrievalEnabled — cascading", () => {
  test("returns true when both are on", () => {
    assert.strictEqual(readHybridRetrievalEnabled(ALL_ON), true);
  });

  test("returns false when memoryOperations is off", () => {
    const c = cfg({ memoryOperations: false, hybridRetrieval: true });
    assert.strictEqual(readHybridRetrievalEnabled(c), false);
  });

  test("falls back to true when hybridRetrieval is absent", () => {
    const c = cfg({ memoryOperations: true });
    assert.strictEqual(readHybridRetrievalEnabled(c), true);
  });
});

// ---------------------------------------------------------------------------
// readReviewGateEnabled — requires evolutionLedger
// ---------------------------------------------------------------------------

describe("readReviewGateEnabled — cascading", () => {
  test("returns true when both are on", () => {
    assert.strictEqual(readReviewGateEnabled(ALL_ON), true);
  });

  test("returns false when evolutionLedger is off", () => {
    const c = cfg({ evolutionLedger: false, reviewGate: true });
    assert.strictEqual(readReviewGateEnabled(c), false);
  });

  test("falls back to false when reviewGate is absent", () => {
    const c = cfg({ evolutionLedger: true });
    assert.strictEqual(readReviewGateEnabled(c), false);
  });
});

// ---------------------------------------------------------------------------
// Boolean string coercion — tested via readTraceRecorderEnabled (standalone)
// ---------------------------------------------------------------------------

describe("string boolean coercion via rollout flags", () => {
  test('"true" string → true', () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "true" })), true);
  });

  test('"1" string → true', () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "1" })), true);
  });

  test('"yes" string → true', () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "yes" })), true);
  });

  test('"on" string → true', () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "on" })), true);
  });

  test('"false" string → false', () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "false" })), false);
  });

  test('"0" string → false', () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "0" })), false);
  });

  test('"no" string → false', () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "no" })), false);
  });

  test('"off" string → false', () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "off" })), false);
  });

  test("unrecognised string falls back to the module default (false for traceRecorder)", () => {
    assert.strictEqual(readTraceRecorderEnabled(cfg({ traceRecorder: "maybe" })), false);
  });

  test("memoryOperations 'true' string enables cascading flags", () => {
    const c = cfg({ memoryOperations: "true", workstreamOverlays: true });
    assert.strictEqual(readWorkstreamOverlaysEnabled(c), true);
  });

  test("memoryOperations '0' string disables cascading flags", () => {
    const c = cfg({ memoryOperations: "0", workstreamOverlays: true });
    assert.strictEqual(readWorkstreamOverlaysEnabled(c), false);
  });
});
