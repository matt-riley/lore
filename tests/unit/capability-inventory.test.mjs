import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  evaluateCapabilityRouter,
  recommendCapabilityRoute,
  scanCapabilityInventory,
} from "../../lib/capability-inventory.mjs";

function createCapabilityFixtureRoot({
  includeReversePrompt = true,
  includeSkillCreator = true,
  includePlannerAgent = false,
} = {}) {
  const rootPath = mkdtempSync(path.join(os.tmpdir(), "lore-capability-inventory-"));
  const skillsDir = path.join(rootPath, "skills");
  mkdirSync(skillsDir, { recursive: true });

  if (includeReversePrompt) {
    writeSkillFixture(skillsDir, "reverse-prompt", {
      description: "Sharpen or rewrite a rough request into a repository-grounded brief before planning or implementation.",
      useWhen: [
        "The user explicitly asks to sharpen, rewrite, or improve a prompt before moving on.",
        "The user wants a repo-grounded brief before planning or implementation.",
      ],
      avoidWhen: [
        "The user is asking you to implement the change directly without prompt rewriting first.",
      ],
    });
  }

  if (includeSkillCreator) {
    writeSkillFixture(skillsDir, "skill-creator", {
      description: "Create or upgrade a local skill under ~/.copilot/skills when the user wants better triggers, validation, or support-file structure.",
      useWhen: [
        "The user asks to create a new skill under ~/.copilot/skills.",
        "The user wants a skill's trigger boundaries, validation steps, or support-file layout improved.",
      ],
      avoidWhen: [
        "The task is normal repo code instead of skill authoring.",
      ],
    });
  }

  if (includePlannerAgent) {
    const agentsDir = path.join(rootPath, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeAgentFixture(agentsDir, "implementation-planner", {
      description: "Manual-only planning agent for breaking work into a repo-grounded implementation plan.",
      summary: "Use this agent when the task needs planning, orchestration, or step-by-step implementation sequencing before editing.",
    });
  }

  return {
    rootPath,
    cleanup() {
      rmSync(rootPath, { recursive: true, force: true });
    },
  };
}

function writeSkillFixture(skillsDir, skillName, { description, useWhen, avoidWhen }) {
  const skillDir = path.join(skillsDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: ${skillName}
description: ${description}
---

## Use this skill when

${useWhen.map((item) => `- ${item}`).join("\n")}

## Do not use this skill when

${avoidWhen.map((item) => `- ${item}`).join("\n")}
`, "utf8");
}

function writeAgentFixture(agentsDir, agentName, { description, summary }) {
  writeFileSync(path.join(agentsDir, `${agentName}.agent.md`), `---
name: ${agentName}
description: ${description}
---

${summary}
`, "utf8");
}

describe("capability inventory routing", () => {
  it("prefers a local skill over a broad agent for explicit reverse-prompt requests", async () => {
    const fixture = createCapabilityFixtureRoot();
    try {
      const inventory = await scanCapabilityInventory({ rootPath: fixture.rootPath });

      const recommendation = recommendCapabilityRoute({
        prompt: "Before you start, sharpen this request into a repo-grounded brief and then move into planning: add a new skill under ~/.copilot/skills.",
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
        prompt: "Before you start, sharpen this request into a repo-grounded brief and then move into planning: add a new skill under ~/.copilot/skills.",
        inventory,
        limit: 10,
      });

      assert.equal(recommendation.primaryRoute.route, "agent");
      assert.equal(recommendation.primaryRoute.targetName, "implementation-planner");
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

      assert.notEqual(recommendation.primaryRoute.targetName, "reverse-prompt");
      assert.equal(recommendation.promptProfile.promptRewriteIntent, false);
    } finally {
      fixture.cleanup();
    }
  });
});
