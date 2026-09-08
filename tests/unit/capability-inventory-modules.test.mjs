import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  evaluateCapabilityRouter,
  recommendCapabilityRoute,
  renderCapabilityEvaluationReport,
  renderCapabilityInventoryReport,
  renderCapabilityRecommendationReport,
  scanCapabilityInventory,
} from "../../lib/capabilities/capability-inventory.mjs";
import { scanCapabilityInventory as scanCapabilityInventoryFromScanner } from "../../lib/capabilities/capability-scanner.mjs";
import {
  evaluateCapabilityRouter as evaluateCapabilityRouterFromRouter,
  recommendCapabilityRoute as recommendCapabilityRouteFromRouter,
} from "../../lib/capabilities/capability-router.mjs";
import {
  renderCapabilityEvaluationReport as renderCapabilityEvaluationReportFromRenderer,
  renderCapabilityInventoryReport as renderCapabilityInventoryReportFromRenderer,
  renderCapabilityRecommendationReport as renderCapabilityRecommendationReportFromRenderer,
} from "../../lib/capabilities/capability-renderer.mjs";
import { DEFAULT_REPO_ROOT } from "../../lib/capabilities/capability-utils.mjs";

describe("capability inventory module split", () => {
  test("barrel exports stay aligned with the split modules", () => {
    assert.equal(scanCapabilityInventory, scanCapabilityInventoryFromScanner);
    assert.equal(recommendCapabilityRoute, recommendCapabilityRouteFromRouter);
    assert.equal(evaluateCapabilityRouter, evaluateCapabilityRouterFromRouter);
    assert.equal(renderCapabilityEvaluationReport, renderCapabilityEvaluationReportFromRenderer);
    assert.equal(renderCapabilityInventoryReport, renderCapabilityInventoryReportFromRenderer);
    assert.equal(renderCapabilityRecommendationReport, renderCapabilityRecommendationReportFromRenderer);
  });

  test("scan default root is cwd, not a Copilot-shaped four-up path", () => {
    assert.equal(DEFAULT_REPO_ROOT, process.cwd());
  });
});
