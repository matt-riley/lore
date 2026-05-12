import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCapabilityRouter,
  recommendCapabilityRoute,
  scanCapabilityInventory,
} from "../../lib/capability-inventory.mjs";
import { createCapabilityFixtureRoot } from "../helpers/capability-inventory-fixtures.mjs";

describe("capability inventory routing", () => {
  it("prefers a local skill over a broad agent for explicit reverse-prompt requests", async () => {
    const fixture = createCapabilityFixtureRoot();
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Before you start, sharpen this prompt into a repo-grounded brief and then move into planning: add a new skill under ~/.copilot/skills.",
        inventory,
        limit: 10,
      });

      assert.equal(recommendation.primaryRoute.route, "skill");
      assert.equal(recommendation.primaryRoute.targetName, "reverse-prompt");
      assert.equal(recommendation.primaryRoute.executionMode, "skill");
      assert.equal(recommendation.promptProfile.promptRewriteIntent, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("routes explicit local skill-authoring requests to skill-creator", async () => {
    const fixture = createCapabilityFixtureRoot();
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Create a new skill under ~/.copilot/skills and make its trigger boundaries, validation steps, and support-file layout easier to use correctly.",
        inventory,
        limit: 10,
      });

      assert.equal(recommendation.primaryRoute.route, "skill");
      assert.equal(recommendation.primaryRoute.targetName, "skill-creator");
      assert.equal(recommendation.primaryRoute.executionMode, "skill");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the reverse-prompt corpus case green", async () => {
    const fixture = createCapabilityFixtureRoot();
    try {
      const evaluation = await evaluateCapabilityRouter({
        rootPath: fixture.rootPath,
        caseIds: ["skill-reverse-prompt-brief"],
        limit: 10,
      });

      assert.equal(evaluation.total, 1);
      assert.equal(evaluation.failed, 0);
      assert.equal(evaluation.cases[0]?.passed, true);
      assert.equal(evaluation.cases[0]?.recommendation.primaryRoute.targetName, "reverse-prompt");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps agent fallback available when reverse-prompt is not installed", async () => {
    const fixture = createCapabilityFixtureRoot({
      includeReversePrompt: false,
      includeSkillCreator: false,
      includePlannerAgent: true,
    });
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Before you start, sharpen this prompt into a repo-grounded brief and then move into planning: add a new skill under ~/.copilot/skills.",
        inventory,
        limit: 10,
      });

      assert.equal(recommendation.primaryRoute.route, "agent");
      assert.equal(recommendation.primaryRoute.targetName, "implementation-planner");
    } finally {
      fixture.cleanup();
    }
  });

  it("prefers reverse-prompt over implementation-planner for explicit prompt-sharpening requests", async () => {
    const fixture = createCapabilityFixtureRoot({
      includePlannerAgent: true,
    });
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Before you plan any implementation, sharpen this prompt into a concise repo-grounded brief with clarified scope and constraints.",
        inventory,
        limit: 10,
      });

      assert.equal(recommendation.primaryRoute.route, "skill");
      assert.equal(recommendation.primaryRoute.targetName, "reverse-prompt");
      assert.equal(recommendation.primaryRoute.executionMode, "skill");
    } finally {
      fixture.cleanup();
    }
  });

  it("does not treat code rewrite requests as reverse-prompt work", async () => {
    const fixture = createCapabilityFixtureRoot();
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Rewrite this function to use a map instead of a loop.",
        inventory,
        limit: 10,
      });

      assert.notStrictEqual(recommendation.primaryRoute.targetName, "reverse-prompt");
      assert.equal(recommendation.promptProfile.promptRewriteIntent, false);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not treat generic sharpen requests as reverse-prompt work", async () => {
    const fixture = createCapabilityFixtureRoot();
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Sharpen the documentation for the API endpoints.",
        inventory,
        limit: 10,
      });

      assert.notStrictEqual(recommendation.primaryRoute.targetName, "reverse-prompt");
      assert.equal(recommendation.promptProfile.promptRewriteIntent, false);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not treat request-handler rewrites as reverse-prompt work", async () => {
    const fixture = createCapabilityFixtureRoot();
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Rewrite this request handler to validate the payload before streaming the response.",
        inventory,
        limit: 10,
      });

      assert.notStrictEqual(recommendation.primaryRoute.targetName, "reverse-prompt");
      assert.equal(recommendation.promptProfile.promptRewriteIntent, false);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps generic reference questions on the direct path when no local workflow is requested", async () => {
    const fixture = createCapabilityFixtureRoot({
      includePlannerAgent: true,
      includeCiMigrationSkill: true,
    });
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "How does the local router choose a response path here?",
        inventory,
        limit: 10,
      });

      const skillRoute = recommendation.routeCandidates.find((candidate) => candidate.route === "skill");
      const directRoute = recommendation.routeCandidates.find((candidate) => candidate.route === "direct");

      assert.equal(recommendation.primaryRoute.route, "direct");
      assert.equal(directRoute?.targetName, "direct_response");
      assert.ok(skillRoute);
      assert.match(
        skillRoute.reasons.join("\n"),
        /Generic reference questions should stay direct unless they clearly ask for a local workflow\./,
      );
      assert.ok(skillRoute.heuristicScore < 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("prefers the planner agent over a migration skill for plan-first CircleCI migrations", async () => {
    const fixture = createCapabilityFixtureRoot({
      includePlannerAgent: true,
      includeCiMigrationSkill: true,
    });
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Before we start editing, plan the CircleCI to GitHub Actions migration.",
        inventory,
        limit: 10,
      });

      const agentRoute = recommendation.routeCandidates.find((candidate) => candidate.route === "agent");
      const skillRoute = recommendation.routeCandidates.find((candidate) => candidate.route === "skill");

      assert.equal(recommendation.primaryRoute.route, "agent");
      assert.equal(recommendation.primaryRoute.targetName, "implementation-planner");
      assert.ok(agentRoute);
      assert.ok(skillRoute);
      assert.match(
        agentRoute.reasons.join("\n"),
        /Plan-first CI migration prompts should prefer the migration orchestrator before execution\./,
      );
      assert.match(
        skillRoute.reasons.join("\n"),
        /Prompt asks for migration planning before editing, so orchestration should outrank a direct migration skill\./,
      );
      assert.ok(agentRoute.heuristicScore > skillRoute.heuristicScore);
    } finally {
      fixture.cleanup();
    }
  });
});
