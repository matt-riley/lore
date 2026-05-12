import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRouterAssertions,
  evaluateCapabilityRouter,
  renderCapabilityRecommendationReport,
  recommendCapabilityRoute,
  scanCapabilityInventory,
} from "../../lib/capability-inventory.mjs";
import { loadCapabilityFunctions, createCapabilityFixtureRoot } from "../helpers/capability-inventory-fixtures.mjs";

describe("capability inventory heuristics", () => {
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
});
