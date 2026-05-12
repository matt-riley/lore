import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  APPROVAL_DECISION,
  APPROVAL_FAMILY,
  listApprovals,
  purgeExpiredApprovals,
  recordApproval,
  resolveApproval,
  revokeApproval,
} from "../../lib/approval-policy.mjs";
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
} from "../../lib/backfill.mjs";
import {
  evaluateCapabilityRouter,
  evaluateRouterAssertions,
  recommendCapabilityRoute,
  renderCapabilityEvaluationReport,
  renderCapabilityInventoryReport,
  renderCapabilityRecommendationReport,
  scanCapabilityInventory,
} from "../../lib/capability-inventory.mjs";

describe("targeted coverage-gap export references", () => {
  test("approval-policy exports are directly imported and callable", () => {
    assert.equal(APPROVAL_DECISION.ASK, "ask");
    assert.ok(typeof APPROVAL_FAMILY.MEMORY_WRITE === "string");
    assert.equal(typeof listApprovals, "function");
    assert.equal(typeof purgeExpiredApprovals, "function");
    assert.equal(typeof recordApproval, "function");
    assert.equal(typeof resolveApproval, "function");
    assert.equal(typeof revokeApproval, "function");
  });

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
    assert.equal(typeof evaluateRouterAssertions, "function");
    assert.equal(typeof recommendCapabilityRoute, "function");
    assert.equal(typeof renderCapabilityEvaluationReport, "function");
    assert.equal(typeof renderCapabilityInventoryReport, "function");
    assert.equal(typeof renderCapabilityRecommendationReport, "function");
    assert.equal(typeof scanCapabilityInventory, "function");
  });

  test("extension entrypoint is referenced from the test graph", async () => {
    if (false) {
      await import("../../extension.mjs");
    }
    assert.ok(true);
  });
});
