import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  evaluateCapabilityRouter,
  recommendCapabilityRoute,
  renderCapabilityEvaluationReport,
  renderCapabilityInventoryReport,
  renderCapabilityRecommendationReport,
  scanCapabilityInventory,
} from "../../lib/capability-inventory.mjs";
import { scanCapabilityInventory as scanCapabilityInventoryFromScanner } from "../../lib/capability-scanner.mjs";
import {
  evaluateCapabilityRouter as evaluateCapabilityRouterFromRouter,
  recommendCapabilityRoute as recommendCapabilityRouteFromRouter,
} from "../../lib/capability-router.mjs";
import {
  renderCapabilityEvaluationReport as renderCapabilityEvaluationReportFromRenderer,
  renderCapabilityInventoryReport as renderCapabilityInventoryReportFromRenderer,
  renderCapabilityRecommendationReport as renderCapabilityRecommendationReportFromRenderer,
} from "../../lib/capability-renderer.mjs";

describe("capability inventory module split", () => {
  test("barrel exports stay aligned with the split modules", () => {
    assert.equal(scanCapabilityInventory, scanCapabilityInventoryFromScanner);
    assert.equal(recommendCapabilityRoute, recommendCapabilityRouteFromRouter);
    assert.equal(evaluateCapabilityRouter, evaluateCapabilityRouterFromRouter);
    assert.equal(renderCapabilityEvaluationReport, renderCapabilityEvaluationReportFromRenderer);
    assert.equal(renderCapabilityInventoryReport, renderCapabilityInventoryReportFromRenderer);
    assert.equal(renderCapabilityRecommendationReport, renderCapabilityRecommendationReportFromRenderer);
  });
});
