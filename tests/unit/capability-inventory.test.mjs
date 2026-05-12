import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  evaluateRouterAssertions,
  evaluateCapabilityRouter,
  renderCapabilityRecommendationReport,
  recommendCapabilityRoute,
  scanCapabilityInventory,
} from "../../lib/capability-inventory.mjs";

const CAPABILITY_INVENTORY_SOURCE = readFileSync(new URL("../../lib/capability-inventory.mjs", import.meta.url), "utf8");

function findBalancedIndex(source, start, openChar, closeChar) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char !== closeChar) {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  throw new Error(`could not find closing ${closeChar} for ${openChar} at ${start}`);
}

function extractFunctionSource(name) {
  const markers = [`async function ${name}`, `function ${name}`];
  const start = markers
    .map((marker) => CAPABILITY_INVENTORY_SOURCE.indexOf(marker))
    .find((index) => index !== -1);
  assert.notEqual(start, undefined, `expected ${name} to exist in capability-inventory.mjs`);

  const paramsStart = CAPABILITY_INVENTORY_SOURCE.indexOf("(", start);
  const paramsEnd = findBalancedIndex(CAPABILITY_INVENTORY_SOURCE, paramsStart, "(", ")");
  const braceStart = CAPABILITY_INVENTORY_SOURCE.indexOf("{", paramsEnd);
  const bodyEnd = findBalancedIndex(CAPABILITY_INVENTORY_SOURCE, braceStart, "{", "}");
  return CAPABILITY_INVENTORY_SOURCE.slice(start, bodyEnd + 1);
}

function loadCapabilityFunctions(names) {
  const functionSources = names.map((name) => extractFunctionSource(name)).join("\n\n");
  return Function(`"use strict"; ${functionSources}; return { ${names.join(", ")} };`)();
}

function createCapabilityFixtureRoot({
  includeReversePrompt = true,
  includeSkillCreator = true,
  includePlannerAgent = false,
  includeCiMigrationSkill = false,
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

  if (includeCiMigrationSkill) {
    writeSkillFixture(skillsDir, "circleci-to-github-actions-migration", {
      description: "Guide a CircleCI to GitHub Actions migration with repo-local guardrails and staged rollout advice.",
      useWhen: [
        "The user wants to migrate from CircleCI to GitHub Actions.",
        "The task needs a reusable migration workflow instead of ad-hoc edits.",
      ],
      avoidWhen: [
        "The prompt only asks a generic reference question without asking for a migration workflow.",
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
  it("buildSkillRouteHeuristicAdjustments preserves reverse-prompt boosts and conservative penalties", () => {
    const {
      buildSkillRewriteHeuristicAdjustments,
      buildSkillExplicitIntentHeuristicAdjustments,
      buildSkillTargetMatchHeuristicAdjustments,
      buildSkillConservativeHeuristicAdjustments,
      buildSkillLookupHeuristicAdjustments,
      buildSkillReferenceHeuristicAdjustments,
      buildSkillMigrationPlanningHeuristicAdjustments,
      buildSkillRouteHeuristicAdjustments,
    } = loadCapabilityFunctions([
      "buildSkillRewriteHeuristicAdjustments",
      "buildSkillExplicitIntentHeuristicAdjustments",
      "buildSkillTargetMatchHeuristicAdjustments",
      "buildSkillConservativeHeuristicAdjustments",
      "buildSkillLookupHeuristicAdjustments",
      "buildSkillReferenceHeuristicAdjustments",
      "buildSkillMigrationPlanningHeuristicAdjustments",
      "buildSkillRouteHeuristicAdjustments",
    ]);

    assert.deepStrictEqual(
      buildSkillRewriteHeuristicAdjustments(
        {
          promptRewriteIntent: true,
        },
        {
          targetName: "reverse-prompt",
        },
      ),
      [
        {
          scoreDelta: 18,
          reason: "Explicit prompt-sharpening requests should prefer the reverse-prompt skill.",
        },
      ],
    );

    assert.deepStrictEqual(buildSkillExplicitIntentHeuristicAdjustments(0), []);
    assert.deepStrictEqual(buildSkillTargetMatchHeuristicAdjustments({ targetName: "reverse-prompt" }, 0), []);
    assert.deepStrictEqual(buildSkillConservativeHeuristicAdjustments(8, 7), []);
    assert.deepStrictEqual(
      buildSkillLookupHeuristicAdjustments(
        {
          promptNeed: { requiresLookup: true },
        },
        0,
      ),
      [
        {
          scoreDelta: -6,
          reason: "Prompt looks more like recall/explanation than a skill workflow.",
        },
      ],
    );
    assert.deepStrictEqual(
      buildSkillReferenceHeuristicAdjustments(
        {
          referenceQuestion: true,
          promptNeed: { requiresLookup: false },
        },
        0,
        {
          nameMatched: false,
        },
      ),
      [
        {
          scoreDelta: -28,
          reason: "Generic reference questions should stay direct unless they clearly ask for a local workflow.",
        },
      ],
    );
    assert.deepStrictEqual(buildSkillMigrationPlanningHeuristicAdjustments({ planBeforeExecution: false, ciMigrationIntent: true }), []);

    assert.deepStrictEqual(
      buildSkillRouteHeuristicAdjustments({
        promptProfile: {
          promptRewriteIntent: true,
          promptNeed: { requiresLookup: false },
          referenceQuestion: false,
          planBeforeExecution: false,
          ciMigrationIntent: false,
        },
        selectedTarget: {
          targetName: "reverse-prompt",
          nameMatched: true,
        },
        explicitIntentScore: 3,
        targetMatchScore: 6,
      }),
      [
        {
          scoreDelta: 18,
          reason: "Explicit prompt-sharpening requests should prefer the reverse-prompt skill.",
        },
        {
          scoreDelta: 11,
          reason: "Prompt explicitly asks for a reusable workflow or skill-like playbook.",
        },
        {
          scoreDelta: 6,
          reason: "Matched skill target reverse-prompt.",
        },
      ],
    );

    assert.deepStrictEqual(
      buildSkillRouteHeuristicAdjustments({
        promptProfile: {
          promptRewriteIntent: false,
          promptNeed: { requiresLookup: true },
          referenceQuestion: true,
          planBeforeExecution: false,
          ciMigrationIntent: false,
        },
        selectedTarget: {
          targetName: "circleci-to-github-actions-migration",
          nameMatched: false,
        },
        explicitIntentScore: 0,
        targetMatchScore: 3,
      }),
      [
        {
          scoreDelta: 3,
          reason: "Matched skill target circleci-to-github-actions-migration.",
        },
        {
          scoreDelta: -8,
          reason: "Skill routing stays conservative without a clear workflow or skill signal.",
        },
        {
          scoreDelta: -6,
          reason: "Prompt looks more like recall/explanation than a skill workflow.",
        },
      ],
    );

    assert.deepStrictEqual(
      buildSkillRouteHeuristicAdjustments({
        promptProfile: {
          promptRewriteIntent: false,
          promptNeed: { requiresLookup: false },
          referenceQuestion: true,
          planBeforeExecution: false,
          ciMigrationIntent: false,
        },
        selectedTarget: {
          targetName: "circleci-to-github-actions-migration",
          nameMatched: false,
        },
        explicitIntentScore: 0,
        targetMatchScore: 0,
      }),
      [
        {
          scoreDelta: -8,
          reason: "Skill routing stays conservative without a clear workflow or skill signal.",
        },
        {
          scoreDelta: -28,
          reason: "Generic reference questions should stay direct unless they clearly ask for a local workflow.",
        },
      ],
    );

    assert.deepStrictEqual(
      buildSkillRouteHeuristicAdjustments({
        promptProfile: {
          promptRewriteIntent: false,
          promptNeed: { requiresLookup: false },
          referenceQuestion: false,
          planBeforeExecution: true,
          ciMigrationIntent: true,
        },
        selectedTarget: {
          targetName: "circleci-to-github-actions-migration",
          nameMatched: false,
        },
        explicitIntentScore: 0,
        targetMatchScore: 0,
      }),
      [
        {
          scoreDelta: -8,
          reason: "Skill routing stays conservative without a clear workflow or skill signal.",
        },
        {
          scoreDelta: -16,
          reason: "Prompt asks for migration planning before editing, so orchestration should outrank a direct migration skill.",
        },
      ],
    );
  });

  it("buildAgentRouteHeuristicAdjustments preserves reverse-prompt suppression and plan-first boosts", () => {
    const { buildAgentRouteHeuristicAdjustments } = loadCapabilityFunctions([
      "checkPromptResharpening",
      "checkExplicitIntentScore",
      "checkTargetMatch",
      "checkManualOnlyAgent",
      "checkConservativeRouting",
      "checkLookupIntent",
      "checkCiMigrationPlanFirst",
      "buildAgentRouteHeuristicAdjustments",
    ]);

    assert.deepStrictEqual(
      buildAgentRouteHeuristicAdjustments({
        promptProfile: {
          promptRewriteIntent: true,
          hasReversePromptSkill: true,
          promptNeed: { requiresLookup: false },
          planBeforeExecution: false,
          ciMigrationIntent: false,
        },
        selectedTarget: {
          targetName: "implementation-planner",
          manualOnly: true,
          nameMatched: false,
        },
        explicitIntentScore: 0,
        targetMatchScore: 0,
      }),
      [
        {
          scoreDelta: -18,
          reason: "Explicit prompt-sharpening requests should stay on the skill workflow path instead of agent delegation.",
        },
        {
          scoreDelta: -4,
          reason: "Manual-only agents need clearer delegation intent than this prompt provides.",
        },
        {
          scoreDelta: -8,
          reason: "Agent routing stays conservative without clear delegation intent.",
        },
      ],
    );

    assert.deepStrictEqual(
      buildAgentRouteHeuristicAdjustments({
        promptProfile: {
          promptRewriteIntent: false,
          hasReversePromptSkill: false,
          promptNeed: { requiresLookup: true },
          planBeforeExecution: true,
          ciMigrationIntent: true,
        },
        selectedTarget: {
          targetName: "implementation-planner",
          manualOnly: false,
          nameMatched: true,
        },
        explicitIntentScore: 5,
        targetMatchScore: 7,
      }),
      [
        {
          scoreDelta: 13,
          reason: "Prompt asks for planning, research, delegation, or orchestration.",
        },
        {
          scoreDelta: 7,
          reason: "Matched agent target implementation-planner.",
        },
        {
          scoreDelta: 28,
          reason: "Plan-first CI migration prompts should prefer the migration orchestrator before execution.",
        },
      ],
    );
  });

  it("buildCapabilityRecommendationReportSections preserves empty-match fallback and ranked sections", () => {
    const {
      takeLimited,
      buildRouteCandidateLines,
      buildCapabilityMatchLines,
      buildCapabilityRecommendationReportSections,
    } = loadCapabilityFunctions([
      "takeLimited",
      "buildRouteCandidateLines",
      "buildCapabilityMatchLines",
      "buildCapabilityRecommendationReportSections",
    ]);

    const sections = buildCapabilityRecommendationReportSections(
      {
        routeCandidates: [
          {
            route: "direct",
            score: 3,
            baseScore: 2,
            heuristicScore: 1,
            supportLevel: "ready",
            available: true,
            targetName: "direct_response",
            targetType: "direct",
            executionMode: "direct",
            matchedTokens: [],
            supportingMatches: [],
            reasons: ["fallback"],
            gaps: [],
          },
        ],
        capabilityMatches: [],
      },
      { limit: 3 },
    );

    assert.deepStrictEqual(sections, [
      "",
      "## Ranked Route Candidates",
      "",
      "- direct score=3 base=2 heuristic=1 support=ready available=true",
      "  target: direct_response (direct, direct)",
      "  matchedTokens: none",
      "  supportingMatches: none",
      "  reasons: fallback",
      "",
      "## Matched Local Capabilities",
      "",
      "- none",
      "",
      "## Recommendation Notes",
      "",
      "- This router core is recommendation-only; it does not invoke skills, agents, or background work automatically.",
      "- The inventory is local-first and scans repo-authored skills, agents, and extension/lore tool surfaces.",
      "- Retrieval targets are selected explicitly among lore_recall, lore_reflect, memory_search, and memory_explain.",
    ]);
  });

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

  it("renders recommendation reports with ranked candidates, matches, and notes", () => {
    const output = renderCapabilityRecommendationReport({
      mode: "recommend",
      prompt: "Help me choose the best local capability for this plan-first migration request.",
      promptTokens: ["plan", "migration"],
      promptNeed: {
        requiresLookup: true,
        hasTemporalSignal: false,
        wantsContinuity: true,
      },
      promptProfile: {
        greeting: false,
      },
      confidence: {
        label: "high",
        value: 0.92,
      },
      primaryRoute: {
        route: "skill",
        label: "circleci-to-github-actions-migration",
        targetName: "circleci-to-github-actions-migration",
        targetType: "skill",
        executionMode: "skill",
        score: 18,
        supportLevel: "strong",
        reasons: [
          "Matched migration trigger terms",
          "Local skill exists for this workflow",
        ],
      },
      routeCandidates: [
        {
          route: "skill",
          score: 18,
          baseScore: 12,
          heuristicScore: 6,
          supportLevel: "strong",
          available: true,
          targetName: "circleci-to-github-actions-migration",
          targetType: "skill",
          executionMode: "skill",
          matchedTokens: ["migration", "github actions"],
          supportingMatches: [{ name: "circleci-to-github-actions-migration" }],
          reasons: ["High-confidence route family match"],
          gaps: [],
        },
        {
          route: "agent",
          score: 9,
          baseScore: 8,
          heuristicScore: 1,
          supportLevel: "medium",
          available: true,
          targetName: "implementation-planner",
          targetType: "agent",
          executionMode: "background",
          matchedTokens: ["plan"],
          supportingMatches: [],
          reasons: [],
          gaps: ["No migration-specific workflow attached"],
        },
      ],
      capabilityMatches: [
        {
          capabilityType: "skill",
          name: "circleci-to-github-actions-migration",
          score: 18,
          routeKindHints: ["skill"],
          nameMatched: true,
          routeKind: "skill",
          executionMode: "skill",
          matchedTokens: ["migration"],
          triggerTerms: ["circleci", "github actions"],
          triggerCapabilities: ["migration workflow"],
          sourcePath: "skills/circleci-to-github-actions-migration/SKILL.md",
          description: "Guide a staged migration from CircleCI to GitHub Actions.",
        },
      ],
    }, { limit: 2 });

    assert.match(output, /## Capability Routing Recommendation/);
    assert.match(output, /primaryRoute: skill/);
    assert.match(output, /## Why This Route/);
    assert.match(output, /Matched migration trigger terms/);
    assert.match(output, /## Ranked Route Candidates/);
    assert.match(output, /- skill score=18 base=12 heuristic=6 support=strong available=true/);
    assert.match(output, /gaps: No migration-specific workflow attached/);
    assert.match(output, /## Matched Local Capabilities/);
    assert.match(output, /\[skill\] circleci-to-github-actions-migration score=18/);
    assert.match(output, /## Recommendation Notes/);
  });

  it("does not require capability matches for direct router assertions", () => {
    const evaluation = evaluateRouterAssertions(
      {
        expectedRouteKind: "direct",
        expectedTargetName: "direct_response",
        expectedExecutionMode: "direct",
        minConfidence: 0.45,
      },
      {
        primaryRoute: {
          route: "direct",
          targetName: "direct_response",
          executionMode: "direct",
          reasons: ["No stronger local route signal was detected."],
        },
        confidence: { value: 0.52 },
        routeCandidates: [
          {
            route: "direct",
            targetName: "direct_response",
          },
        ],
        capabilityMatches: [],
      },
    );

    assert.equal(evaluation.passed, true);
    assert.equal(
      evaluation.assertions.some((assertion) => assertion.label === "matched capabilities are present"),
      false,
    );
  });
});
