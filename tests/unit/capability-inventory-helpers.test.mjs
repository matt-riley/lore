import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadCapabilityFunctions } from "../helpers/capability-inventory-fixtures.mjs";

describe("capability inventory helpers", () => {
  it("does not require capability matches for direct router assertions", () => {
    const { evaluateRouterAssertions } = loadCapabilityFunctions([
      "buildRouterAssertion",
      "buildExpectedValueAssertion",
      "buildCountAssertion",
      "buildBaseRouterAssertions",
      "buildCapabilityPresenceAssertion",
      "evaluateRouterAssertions",
    ]);
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

  it("readDescription handles inline, multiline, and early-terminating descriptions", () => {
    const { readDescription } = loadCapabilityFunctions([
      "normalizeWhitespace",
      "quotedParts",
      "shouldStopDescriptionScan",
      "readDescription",
    ]);

    assert.equal(
      readDescription(['description: "Inline description",'], 0),
      "Inline description",
    );
    assert.equal(
      readDescription([
        "description:",
        '  "First sentence"',
        '  "Second sentence",',
        'notes: "stop"',
      ], 0),
      "First sentence Second sentence",
    );
    assert.equal(
      readDescription([
        "description:",
        'notes: "metadata line should terminate description parsing"',
      ], 0),
      "",
    );
  });

  it("selectRouteTarget handles retrieval, background, skill filtering, and direct fallback", () => {
    const { selectRouteTarget } = loadCapabilityFunctions([
      "capabilityForId",
      "capabilityForName",
      "buildTargetReference",
      "selectRetrievalTarget",
      "selectBackgroundTarget",
      "selectMatchedCapabilityTarget",
      "selectSkillRouteTarget",
      "buildDirectRouteTarget",
      "selectRouteTarget",
    ]);

    const capabilities = [
      {
        id: "skill-reverse",
        name: "reverse-prompt",
        targetName: "reverse-prompt",
        targetType: "skill",
        executionMode: "skill",
        sourcePath: "skills/reverse-prompt/SKILL.md",
        description: "Prompt rewrite helper.",
        manualOnly: false,
      },
      {
        id: "skill-creator",
        name: "skill-creator",
        targetName: "skill-creator",
        targetType: "skill",
        executionMode: "skill",
        sourcePath: "skills/skill-creator/SKILL.md",
        description: "Skill authoring helper.",
        manualOnly: false,
      },
      {
        id: "tool-explain",
        name: "memory_explain",
        targetName: "memory_explain",
        targetType: "tool",
        executionMode: "local_tool",
        sourcePath: "lib/memory-tools.mjs",
        description: "Explain retrieval decisions.",
        manualOnly: false,
      },
      {
        id: "tool-backfill",
        name: "memory_backfill",
        targetName: "memory_backfill",
        targetType: "tool",
        executionMode: "local_tool",
        sourcePath: "lib/memory-tools.mjs",
        description: "Run archive backfill.",
        manualOnly: false,
      },
    ];
    const matchMap = new Map([
      ["skill-reverse", { capabilityId: "skill-reverse", score: 12, nameMatched: true, name: "reverse-prompt" }],
      ["skill-creator", { capabilityId: "skill-creator", score: 9, nameMatched: false, name: "skill-creator" }],
      ["tool-explain", { capabilityId: "tool-explain", score: 8, nameMatched: false, name: "memory_explain" }],
      ["tool-backfill", { capabilityId: "tool-backfill", score: 7, nameMatched: false, name: "memory_backfill" }],
    ]);

    const rewriteSkillTarget = selectRouteTarget(
      capabilities,
      "skill",
      { promptRewriteIntent: true },
      [
        { capabilityId: "skill-reverse", score: 12, nameMatched: true, name: "reverse-prompt" },
        { capabilityId: "skill-creator", score: 9, nameMatched: false, name: "skill-creator" },
      ],
      matchMap,
    );
    assert.equal(rewriteSkillTarget?.targetName, "reverse-prompt");

    const nonRewriteSkillTarget = selectRouteTarget(
      capabilities,
      "skill",
      { promptRewriteIntent: false },
      [
        { capabilityId: "skill-reverse", score: 12, nameMatched: true, name: "reverse-prompt" },
        { capabilityId: "skill-creator", score: 9, nameMatched: false, name: "skill-creator" },
      ],
      matchMap,
    );
    assert.equal(nonRewriteSkillTarget?.targetName, "skill-creator");

    const retrievalTarget = selectRouteTarget(
      capabilities,
      "retrieval",
      {
        explainIntent: true,
        reflectIntent: false,
        searchIntent: false,
        promptNeed: { requiresLookup: true },
      },
      [],
      matchMap,
    );
    assert.equal(retrievalTarget?.targetName, "memory_explain");

    const backgroundTarget = selectRouteTarget(
      capabilities,
      "background_task",
      { normalizedPrompt: "start a full archive backfill import now" },
      [],
      matchMap,
    );
    assert.equal(backgroundTarget?.targetName, "memory_backfill");

    const directTarget = selectRouteTarget(capabilities, "direct", {}, [], matchMap);
    assert.equal(directTarget?.targetName, "direct_response");
    assert.equal(selectRouteTarget(capabilities, "unknown", {}, [], matchMap), null);
  });

  it("applyDirectRouteHeuristics adds positive and negative direct-routing adjustments", () => {
    const { applyDirectRouteHeuristics } = loadCapabilityFunctions([
      "addHeuristicReason",
      "addTargetRationale",
      "buildDirectRouteHeuristicAdjustments",
      "applyDirectRouteHeuristics",
    ]);

    const positiveState = { heuristicScore: 0, reasons: [] };
    applyDirectRouteHeuristics({
      promptProfile: {
        promptNeed: { identityOnly: true, requiresLookup: false },
        greeting: true,
        referenceQuestion: true,
        skillIntentScore: 0,
        agentIntentScore: 0,
        backgroundIntentScore: 0,
        simplePrompt: true,
      },
      selectedTarget: {
        rationale: "No stronger local capability needs to be recommended.",
      },
      state: positiveState,
    });
    assert.equal(positiveState.heuristicScore, 52);
    assert.match(positiveState.reasons.join("\n"), /Identity-only or direct-address prompt/);
    assert.match(positiveState.reasons.join("\n"), /Greeting-style prompt can be answered directly/);
    assert.match(positiveState.reasons.join("\n"), /Generic reference question does not need a local workflow recommendation/);
    assert.match(positiveState.reasons.join("\n"), /Short prompt with no recall\/delegation signal fits a direct response/);
    assert.match(positiveState.reasons.join("\n"), /No stronger local capability needs to be recommended/);

    const negativeState = { heuristicScore: 0, reasons: [] };
    applyDirectRouteHeuristics({
      promptProfile: {
        promptNeed: { identityOnly: false, requiresLookup: true },
        greeting: false,
        referenceQuestion: false,
        skillIntentScore: 2,
        agentIntentScore: 0,
        backgroundIntentScore: 1,
        simplePrompt: false,
      },
      selectedTarget: null,
      state: negativeState,
    });
    assert.equal(negativeState.heuristicScore, -14);
    assert.match(negativeState.reasons.join("\n"), /Prompt needs local context, so direct\/no-op is less appropriate/);
    assert.match(negativeState.reasons.join("\n"), /Prompt contains stronger routing signals than a direct\/no-op response/);
  });
});
