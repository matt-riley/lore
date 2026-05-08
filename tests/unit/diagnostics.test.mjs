import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  renderExplanationReport,
  renderReplayReport,
  renderValidationReport,
  runValidationSet,
} from "../../lib/diagnostics.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("runValidationSet", () => {
  test("reports the latency snapshot with rounded summary fields and nested defaults", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
          directives: true,
          hybridRetrieval: true,
        },
      },
    });

    try {
      const result = await runValidationSet({
        runtime: {
          db,
          config,
          repository: "diagnostics/current-repo",
          sessionStore: null,
          metrics: {
            sessionStartP95: 3.6,
            userPromptSubmittedP95: 9.2,
            sampleSize: {
              sessionStart: 7,
            },
            sessionStart: {
              readiness: "warming",
              p50Ms: 1.1,
            },
          },
        },
        caseIds: ["identity-greeting"],
      });

      assert.equal(result.total, 1);
      assert.equal(result.passed, 1);
      assert.deepEqual(result.latency, {
        sessionStartP95Ms: 4,
        userPromptSubmittedP95Ms: 9,
        sessionStartSamples: 7,
        userPromptSubmittedSamples: 0,
        sessionStartP95Readiness: "warming",
        userPromptSubmittedP95Readiness: "unknown",
        sessionStartMinSamplesForP95: 0,
        userPromptSubmittedMinSamplesForP95: 0,
        sessionStart: {
          p50Ms: 1.1,
          p95Ms: 0,
          averageMs: 0,
          maxMs: 0,
          latestMs: 0,
          readiness: "warming",
          samples: 0,
          minSamples: 0,
          targetMs: 0,
          targetStatus: "unknown",
          recentAverageMs: 0,
          previousAverageMs: 0,
          trend: "unknown",
          trendDeltaMs: 0,
        },
        userPromptSubmitted: {
          p50Ms: 0,
          p95Ms: 0,
          averageMs: 0,
          maxMs: 0,
          latestMs: 0,
          readiness: "unknown",
          samples: 0,
          minSamples: 0,
          targetMs: 0,
          targetStatus: "unknown",
          recentAverageMs: 0,
          previousAverageMs: 0,
          trend: "unknown",
          trendDeltaMs: 0,
        },
      });
    } finally {
      cleanup();
    }
  });
});

describe("renderExplanationReport", () => {
  test("renders optional sections, lookup samples, and omissions in order", () => {
    const output = renderExplanationReport({
      mode: "memory_recall",
      repository: "diagnostics/current-repo",
      prompt: "What did we do yesterday?",
      promptNeed: {
        requiresLookup: true,
        wantsContinuity: true,
        wantsStyleContext: false,
        wantsCrossRepoExamples: true,
        wantsRepoLocalTaskContext: false,
        identityOnly: false,
        directAddressed: true,
      },
      estimatedTokens: 42,
      text: "## Recent Related Work\n\n- Backfilled diagnostics coverage.",
      trace: {
        output: {
          sectionTitles: ["Recent Related Work"],
          sectionDetails: [
            {
              title: "Recent Related Work",
              source: "episode_digest",
              usedTokens: 18,
              budget: 120,
              entryCount: 2,
            },
          ],
        },
        eligibility: {
          local: ["global", "repo:diagnostics/current-repo"],
          crossRepo: ["transferable"],
        },
        routerDecision: {
          route: "memory_recall",
          reason: "temporal_recall",
          includeOtherRepositories: true,
          usedWorkstreamOverlays: false,
          usedLegacyPath: false,
          additionalContext: true,
          sectionCount: 1,
        },
        lookups: {
          localEpisodes: {
            enabled: true,
            query: "diagnostics coverage",
            scopes: ["repo"],
            eligibleScopes: ["global", "repo:diagnostics/current-repo"],
            rows: [
              {
                summary: "Backfilled diagnostics coverage",
                repository: "diagnostics/current-repo",
              },
            ],
            includedRows: [
              {
                summary: "Backfilled diagnostics coverage",
                repository: "diagnostics/current-repo",
              },
            ],
            filtered: [{ reason: "rank_cutoff" }],
            reason: "included_matching_episode",
          },
        },
        omissions: [
          { stage: "style", reason: "suppressed_for_temporal_prompt" },
        ],
      },
    });

    assert.match(output, /## Output Sections/);
    assert.match(output, /- Recent Related Work/);
    assert.match(output, /## Source Accounting/);
    assert.match(output, /Recent Related Work: source=episode_digest tokens=18 budget=120 entries=2/);
    assert.match(output, /## Scope Eligibility/);
    assert.match(output, /- Local: global, repo:diagnostics\/current-repo/);
    assert.match(output, /## Decision Trace/);
    assert.match(output, /- route: memory_recall/);
    assert.match(output, /## Lookups/);
    assert.match(output, /### Local Episodes/);
    assert.match(output, /- filtered: rank_cutoff x1/);
    assert.match(output, /## Omitted Or Suppressed/);
    assert.match(output, /- style: suppressed_for_temporal_prompt/);
    assert.match(output, /## Generated Context/);
  });
});

describe("renderReplayReport", () => {
  test("shows ranking targets and failing must-pass cases by default", () => {
    const output = renderReplayReport({
      total: 3,
      mustPassTotal: 2,
      mustPassPassed: 1,
      mustPassFailed: 1,
      rankingTargetTotal: 1,
      rankingTargetIncluded: 0,
      rankingTargetPartial: 1,
      rankingTargetMissing: 0,
      improvementArtifacts: [
        {
          id: "imp-1",
          sourceKind: "replay",
          sourceCaseId: "ranking-case",
          title: "Rank diagnostics memory higher",
          missCategory: "ranking_partial",
        },
      ],
      repository: "diagnostics/current-repo",
      latency: {
        sessionStartP95Ms: 4,
        userPromptSubmittedP95Ms: 8,
        sessionStartSamples: 5,
        userPromptSubmittedSamples: 5,
        sessionStartP95Readiness: "ready",
        userPromptSubmittedP95Readiness: "ready",
        sessionStartMinSamplesForP95: 5,
        userPromptSubmittedMinSamplesForP95: 5,
        sessionStart: {
          samples: 5,
          readiness: "ready",
          targetMs: 100,
          targetStatus: "meeting_target",
          p50Ms: 2,
          p95Ms: 4,
          averageMs: 3,
          maxMs: 5,
          latestMs: 4,
          recentAverageMs: 3,
          previousAverageMs: 2,
          trend: "up",
          trendDeltaMs: 1,
        },
        userPromptSubmitted: {
          samples: 5,
          readiness: "ready",
          targetMs: 150,
          targetStatus: "meeting_target",
          p50Ms: 3,
          p95Ms: 8,
          averageMs: 5,
          maxMs: 9,
          latestMs: 8,
          recentAverageMs: 5,
          previousAverageMs: 4,
          trend: "up",
          trendDeltaMs: 1,
        },
      },
      insights: {
        totalCases: 3,
        lookupHitRates: [
          {
            name: "localEpisodes",
            includedCases: 1,
            matchedCases: 2,
            seenCases: 3,
            filteredCases: 1,
          },
        ],
        sectionUsage: [
          { title: "Recent Related Work", count: 2 },
        ],
        repeatedWins: [
          { label: "local_episodes", count: 2 },
        ],
        repeatedMisses: [
          { label: "ranking_gap", count: 1 },
        ],
      },
      cases: [
        {
          id: "must-pass-ok",
          title: "Passing must-pass case",
          caseType: "must_pass",
          passed: true,
          mode: "memory_recall",
          sectionTitles: ["Recent Related Work"],
          assertions: [{ passed: true, label: "section present" }],
        },
        {
          id: "must-pass-fail",
          title: "Failing must-pass case",
          caseType: "must_pass",
          passed: false,
          mode: "memory_recall",
          sectionTitles: [],
          assertions: [{ passed: false, label: "section present", details: "Missing section" }],
        },
        {
          id: "ranking-case",
          title: "Ranking target case",
          caseType: "ranking_target",
          rankingOutcome: "partial",
          missCategory: "ranking_partial",
          mode: "memory_recall",
          sectionTitles: ["Recent Related Work"],
          evidence: {
            items: [
              {
                label: "diagnostics memory",
                outcome: "included",
                bestRankedPosition: 3,
                bestIncludedPosition: 1,
              },
            ],
          },
        },
      ],
    });

    assert.match(output, /## Cases/);
    assert.doesNotMatch(output, /PASS must-pass-ok/);
    assert.match(output, /FAIL must-pass-fail — Failing must-pass case/);
    assert.match(output, /TARGET PARTIAL ranking-case — Ranking target case/);
    assert.match(output, /- missCategory: ranking_partial/);
    assert.match(output, /evidence diagnostics memory: included ranked=3 included=1/);
    assert.match(output, /## Improvement Artifacts/);
    assert.match(output, /imp-1 \[replay\] ranking-case — Rank diagnostics memory higher \(missCategory=ranking_partial\)/);
  });
});

describe("renderValidationReport", () => {
  test("shows only failing cases by default and includes improvement artifacts", () => {
    const output = renderValidationReport({
      total: 2,
      passed: 1,
      failed: 1,
      improvementArtifacts: [
        {
          id: "imp-2",
          sourceKind: "validation",
          sourceCaseId: "identity-greeting",
          title: "Restore identity greeting evidence",
        },
      ],
      repository: "diagnostics/current-repo",
      latency: {
        sessionStartP95Ms: 4,
        userPromptSubmittedP95Ms: 7,
        sessionStartSamples: 5,
        userPromptSubmittedSamples: 5,
        sessionStartP95Readiness: "ready",
        userPromptSubmittedP95Readiness: "ready",
        sessionStartMinSamplesForP95: 5,
        userPromptSubmittedMinSamplesForP95: 5,
        sessionStart: {
          samples: 5,
          readiness: "ready",
          targetMs: 100,
          targetStatus: "meeting_target",
          p50Ms: 2,
          p95Ms: 4,
          averageMs: 3,
          maxMs: 5,
          latestMs: 4,
          recentAverageMs: 3,
          previousAverageMs: 2,
          trend: "up",
          trendDeltaMs: 1,
        },
        userPromptSubmitted: {
          samples: 5,
          readiness: "ready",
          targetMs: 150,
          targetStatus: "meeting_target",
          p50Ms: 3,
          p95Ms: 7,
          averageMs: 4,
          maxMs: 8,
          latestMs: 7,
          recentAverageMs: 4,
          previousAverageMs: 3,
          trend: "up",
          trendDeltaMs: 1,
        },
      },
      insights: {
        totalCases: 2,
        lookupHitRates: [{ name: "localEpisodes", includedCases: 1, matchedCases: 2, seenCases: 2, filteredCases: 1 }],
        sectionUsage: [{ title: "Recent Related Work", count: 1 }],
        repeatedWins: [{ label: "local_episodes", count: 1 }],
        repeatedMisses: [{ label: "missing_identity", count: 1 }],
      },
      cases: [
        {
          id: "identity-greeting",
          title: "Identity greeting",
          passed: false,
          mode: "memory_recall",
          sectionTitles: [],
          assertions: [{ passed: false, label: "assistant identity included", details: "No identity evidence found" }],
        },
        {
          id: "style-preference",
          title: "Style preference",
          passed: true,
          mode: "memory_recall",
          sectionTitles: ["Response Style And Addressing"],
          assertions: [{ passed: true, label: "style guidance included" }],
        },
      ],
    });

    assert.match(output, /FAIL identity-greeting — Identity greeting/);
    assert.doesNotMatch(output, /PASS style-preference/);
    assert.match(output, /assistant identity included/);
    assert.match(output, /## Improvement Artifacts/);
    assert.match(output, /imp-2 \[validation\] identity-greeting — Restore identity greeting evidence/);
    assert.match(output, /- sessionStart: samples=5 readiness=ready target=100ms status=meeting_target p50=2 p95=4 avg=3 max=5 latest=4 recentAvg=3 previousAvg=2 trend=up delta=1/);
  });
});
