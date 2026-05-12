import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderCapabilityRecommendationReport,
} from "../../lib/capability-inventory.mjs";
import { loadCapabilityFunctions } from "../helpers/capability-inventory-fixtures.mjs";

describe("capability inventory reporting", () => {
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
});
