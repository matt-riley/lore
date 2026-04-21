import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateCapabilityRouter,
  recommendCapabilityRoute,
  scanCapabilityInventory,
} from "../../lib/capability-inventory.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../..");

describe("capability inventory routing", () => {
  it("prefers a local skill over a broad agent for explicit reverse-prompt requests", async () => {
    const inventory = await scanCapabilityInventory({ rootPath: WORKSPACE_ROOT });

    const recommendation = recommendCapabilityRoute({
      prompt: "Before you start, sharpen this request into a repo-grounded brief and then move into planning: add a new skill under /home/mattriley/.copilot/skills.",
      inventory,
      limit: 10,
    });

    assert.equal(recommendation.primaryRoute.route, "skill");
    assert.equal(recommendation.primaryRoute.targetName, "reverse-prompt");
    assert.equal(recommendation.primaryRoute.executionMode, "skill");
  });

  it("routes explicit local skill-authoring requests to skill-creator", async () => {
    const inventory = await scanCapabilityInventory({ rootPath: WORKSPACE_ROOT });

    const recommendation = recommendCapabilityRoute({
      prompt: "Create a new skill under /home/mattriley/.copilot/skills and make its trigger boundaries, validation steps, and support-file layout easier to use correctly.",
      inventory,
      limit: 10,
    });

    assert.equal(recommendation.primaryRoute.route, "skill");
    assert.equal(recommendation.primaryRoute.targetName, "skill-creator");
    assert.equal(recommendation.primaryRoute.executionMode, "skill");
  });

  it("keeps the reverse-prompt corpus case green", async () => {
    const evaluation = await evaluateCapabilityRouter({
      rootPath: WORKSPACE_ROOT,
      caseIds: ["skill-reverse-prompt-brief"],
      limit: 10,
    });

    assert.equal(evaluation.total, 1);
    assert.equal(evaluation.failed, 0);
    assert.equal(evaluation.cases[0]?.passed, true);
    assert.equal(evaluation.cases[0]?.recommendation.primaryRoute.targetName, "reverse-prompt");
  });
});
