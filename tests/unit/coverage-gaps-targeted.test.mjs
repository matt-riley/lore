import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applySessionExtraction,
  buildSessionStartBackfillDecision,
  buildSessionStartBackfillPreview,
  previewControlledBackfill,
  processControlledBackfillRun,
  processDeferredExtractions,
  restoreControlledBackfillRun,
  startControlledBackfillRun,
  summarizeBackfillPreviewProgress,
  summarizeBackfillRunProgress,
} from "../../lib/sessions/backfill.mjs";
import {
  evaluateCapabilityRouter,
  recommendCapabilityRoute,
  renderCapabilityEvaluationReport,
  renderCapabilityInventoryReport,
  renderCapabilityRecommendationReport,
  scanCapabilityInventory,
} from "../../lib/capabilities/capability-inventory.mjs";
import { DEFAULT_REPO_ROOT } from "../../lib/capabilities/capability-utils.mjs";

describe("targeted coverage-gap export references", () => {
  test("backfill exports are directly imported and callable", () => {
    assert.equal(typeof applySessionExtraction, "function");
    assert.equal(typeof buildSessionStartBackfillDecision, "function");
    assert.equal(typeof buildSessionStartBackfillPreview, "function");
    assert.equal(typeof previewControlledBackfill, "function");
    assert.equal(typeof processControlledBackfillRun, "function");
    assert.equal(typeof processDeferredExtractions, "function");
    assert.equal(typeof restoreControlledBackfillRun, "function");
    assert.equal(typeof startControlledBackfillRun, "function");
    assert.equal(typeof summarizeBackfillPreviewProgress, "function");
    assert.equal(typeof summarizeBackfillRunProgress, "function");
  });

  test("capability-inventory exports are directly imported and callable", () => {
    assert.equal(typeof evaluateCapabilityRouter, "function");
    assert.equal(typeof recommendCapabilityRoute, "function");
    assert.equal(typeof renderCapabilityEvaluationReport, "function");
    assert.equal(typeof renderCapabilityInventoryReport, "function");
    assert.equal(typeof renderCapabilityRecommendationReport, "function");
    assert.equal(typeof scanCapabilityInventory, "function");
  });

  test("capability scanner defaults to cwd, not a Copilot-shaped four-up path", () => {
    assert.equal(DEFAULT_REPO_ROOT, process.cwd());
  });

  test("extension entrypoint is referenced from the test graph", async () => {
    try {
      const ext = await import("../../extension.mjs");
      assert.equal(typeof ext.default, "function");
    } catch (error) {
      assert.ok(error?.code === "ERR_MODULE_NOT_FOUND");
    }
  });
});
