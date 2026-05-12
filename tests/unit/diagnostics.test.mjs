import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  renderExplanationReport,
  renderReplayReport,
  renderValidationReport,
  runValidationSet,
} from "../../lib/diagnostics.mjs";
import { collectFilteredReasonSummaries } from "../../lib/text-utils.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { makeSourceExtractor } from "../helpers/source-parser.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;
const DIAGNOSTICS_PATH = "/Users/matthew.riley/.copilot/extensions/lore/lib/diagnostics.mjs";
const DIAGNOSTICS_SOURCE = readFileSync(DIAGNOSTICS_PATH, "utf8");
const extractFunctionSource = makeSourceExtractor(DIAGNOSTICS_SOURCE);

let diagnosticsHotspotsPromise = null;

function loadFunctions(names, dependencies = {}) {
  const functionSources = names.map((name) => extractFunctionSource(name)).join("\n\n");
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; ${functionSources}; return { ${names.join(", ")} };`,
  )(...Object.values(dependencies));
}

function countLines(source) {
  return source.trim().split("\n").length;
}

async function loadDiagnosticsHotspots() {
  if (!diagnosticsHotspotsPromise) {
    const diagnosticsUrl = pathToFileURL(DIAGNOSTICS_PATH).href;
    const source = DIAGNOSTICS_SOURCE
      .replace(/from "\.\/capsule-assembler\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/capsule-assembler.mjs").href}"`)
      .replace(/from "\.\/memory-operations\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/memory-operations.mjs").href}"`)
      .replace(/from "\.\/procedural-memory\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/procedural-memory.mjs").href}"`)
      .replace(/from "\.\/text-utils\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/text-utils.mjs").href}"`)
      .replace("function evaluateCase(definition, explanation) {", "export function evaluateCase(definition, explanation) {")
      .replace("function classifyReplayMiss(definition, explanation, evidence) {", "export function classifyReplayMiss(definition, explanation, evidence) {")
      .replace("function persistReplayFailureArtifact({", "export function persistReplayFailureArtifact({");
    diagnosticsHotspotsPromise = import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=${diagnosticsUrl}\n`).toString("base64")}`);
  }
  return diagnosticsHotspotsPromise;
}

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

describe("diagnostics hotspot helpers", () => {
  test("keeps classifyReplayMiss compact enough for hotspot maintenance", () => {
    assert.ok(countLines(extractFunctionSource("classifyReplayMiss")) <= 20, "classifyReplayMiss should stay within 20 lines");
    assert.ok(countLines(extractFunctionSource("renderLookup")) <= 24, "renderLookup should stay within 24 lines");
    assert.ok(countLines(extractFunctionSource("buildDiagnosticInsights")) <= 36, "buildDiagnosticInsights should stay within 36 lines");
    assert.ok(countLines(extractFunctionSource("runReplayCorpus")) <= 48, "runReplayCorpus should stay within 48 lines");
  });

  test("renderLookup preserves lookup summaries, filtered reasons, and samples", () => {
    const { renderLookup } = loadFunctions([
      "ensureArray",
      "summarizeTraceRow",
      "formatLookupLabel",
      "aggregateFilteredReasons",
      "normalizeLookupCounts",
      "buildLookupMetadataLines",
      "buildLookupCountLines",
      "buildLookupSampleLines",
      "renderLookup",
    ], {
      collectFilteredReasonSummaries,
    });

    const output = renderLookup("localEpisodes", {
      enabled: true,
      query: "prompt shaping",
      scopes: ["repo"],
      eligibleScopes: ["repo:fixture-repo"],
      rows: [{ type: "episode", summary: "Prompt shaping summary" }],
      includedRows: [{ type: "episode", summary: "Prompt shaping summary" }],
      filtered: [
        { reason: "cutoff" },
        { reason: "cutoff" },
        { reason: "scope" },
      ],
      reason: "included_match",
    });

    assert.match(output, /### Local Episodes/);
    assert.match(output, /- enabled: true/);
    assert.match(output, /- query: prompt shaping/);
    assert.match(output, /- scopes: repo/);
    assert.match(output, /- eligibleScopes: repo:fixture-repo/);
    assert.match(output, /- matched: 1/);
    assert.match(output, /- included: 1/);
    assert.match(output, /- dropped: 3/);
    assert.match(output, /- filtered: cutoff x2, scope x1/);
    assert.match(output, /  - Prompt shaping summary/);
  });

  test("buildDiagnosticInsights aggregates lookup hit rates, sections, and omissions", () => {
    const { buildDiagnosticInsights } = loadFunctions([
      "ensureArray",
      "countTraceRows",
      "incrementCount",
      "lookupInsightEntry",
      "collectLookupInsight",
      "collectDiagnosticMaps",
      "sortLookupHitRates",
      "buildLookupHitRates",
      "buildSectionUsage",
      "buildRepeatedWins",
      "buildRepeatedMisses",
      "buildDiagnosticInsights",
    ]);

    const insights = buildDiagnosticInsights([
      {
        caseType: "must_pass",
        sectionTitles: ["Relevant Prior Work", "Recent Related Work"],
        trace: {
          omissions: [{ stage: "rank", reason: "cutoff" }],
          lookups: {
            localEpisodes: {
              rows: [{ summary: "one" }],
              includedRows: [{ summary: "one" }],
              filtered: [{ reason: "cutoff" }],
            },
          },
        },
      },
      {
        sectionTitles: ["Relevant Prior Work"],
        trace: {
          omissions: [{ stage: "rank", reason: "cutoff" }],
          lookups: {
            localEpisodes: {
              rankedRows: [{ summary: "two" }],
              includedRows: [],
            },
            localMemories: {
              includedRows: [{ summary: "memory" }],
            },
          },
        },
      },
    ]);

    assert.equal(insights.totalCases, 2);
    assert.deepEqual(insights.sectionUsage[0], {
      title: "Relevant Prior Work",
      count: 2,
      rate: 1,
    });
    const localEpisodes = insights.lookupHitRates.find((entry) => entry.name === "localEpisodes");
    assert.deepEqual(localEpisodes, {
      name: "localEpisodes",
      seenCases: 2,
      matchedCases: 2,
      includedCases: 1,
      filteredCases: 1,
      matchedRows: 2,
      includedRows: 1,
      matchedRate: 1,
      includedRate: 0.5,
    });
    assert.deepEqual(insights.repeatedMisses, [{ label: "rank:cutoff", count: 2 }]);
    assert.deepEqual(insights.repeatedWins, []);
  });

  test("runReplayCorpus summarizes replay cases and records failed artifacts", async () => {
    const persisted = [];
    const cleaned = [];
    const { runReplayCorpus } = loadFunctions([
      "deriveReplayRankingOutcome",
      "buildReplayCaseResult",
      "replayCaseFailed",
      "buildReplayImprovementArtifact",
      "runReplayDefinition",
      "collectReplayCases",
      "summarizeReplayCaseTotals",
      "buildReplayCorpusResult",
      "runReplayCorpus",
    ], {
      REPLAY_CASES: [
        { id: "must-pass", caseType: "must_pass", title: "Must pass", mode: "prompt", prompt: "prompt 1" },
        { id: "ranking", caseType: "ranking_target", title: "Ranking", mode: "prompt", prompt: "prompt 2" },
      ],
      seedDiagnosticsMemories() {
        return ["seed-base"];
      },
      seedExtraDiagnosticsMemories(_runtime, memories) {
        return memories.map((memory) => memory.id);
      },
      cleanupSeedDiagnosticsMemories(_runtime, ids) {
        cleaned.push(ids);
      },
      async explainMemoryRetrieval({ prompt }) {
        return {
          text: `explanation for ${prompt}`,
          trace: { output: { sectionTitles: ["Relevant Prior Work"] } },
          estimatedTokens: 12,
          promptNeed: { wantsCrossRepoExamples: false },
        };
      },
      evaluateCase(definition) {
        return {
          passed: definition.id === "must-pass",
          assertions: [{ label: definition.id, passed: definition.id === "must-pass" }],
          sectionTitles: ["Relevant Prior Work"],
        };
      },
      evaluateExpectedEvidence(definition) {
        return definition.id === "ranking"
          ? { expectedCount: 1, missingCount: 1, includedCount: 0, rankedOnlyCount: 1 }
          : { expectedCount: 0, missingCount: 0, includedCount: 0, rankedOnlyCount: 0 };
      },
      classifyReplayMiss(definition) {
        return definition.id === "ranking" ? "lexical_ranking" : null;
      },
      persistReplayFailureArtifact({ definition, rankingOutcome, missCategory }) {
        persisted.push({ id: definition.id, rankingOutcome, missCategory });
        return `artifact-${definition.id}`;
      },
      latencySnapshot() {
        return { sessionStartP95Ms: 0, userPromptSubmittedP95Ms: 0 };
      },
      buildDiagnosticInsights(cases) {
        return { totalCases: cases.length, lookupHitRates: [], sectionUsage: [], repeatedWins: [], repeatedMisses: [] };
      },
    });

    const result = await runReplayCorpus({
      runtime: { repository: "fixture-repo", metrics: {} },
    });

    assert.equal(result.total, 2);
    assert.equal(result.mustPassFailed, 0);
    assert.equal(result.rankingTargetPartial, 1);
    assert.deepEqual(result.improvementArtifacts, [
      {
        id: "artifact-ranking",
        sourceKind: "replay",
        sourceCaseId: "ranking",
        title: "Ranking",
        missCategory: "lexical_ranking",
      },
    ]);
    assert.deepEqual(persisted, [{ id: "ranking", rankingOutcome: "partial", missCategory: "lexical_ranking" }]);
    assert.deepEqual(cleaned, [[], [], ["seed-base"]]);
  });

  test("evaluateCase records the configured expectation checks", async () => {
    const { evaluateCase } = await loadDiagnosticsHotspots();
    const evaluation = evaluateCase({
      expect: {
        promptNeed: {
          requiresLookup: true,
          wantsContinuity: false,
        },
        traceTruthyPaths: ["output.sectionTitles", "routerDecision.route"],
        traceMinCounts: {
          "lookups.localEpisodes.includedRows": 1,
        },
        traceEquals: {
          "routerDecision.route": "memory_recall",
        },
        mustIncludeSections: ["Relevant Prior Work"],
        mustNotIncludeSections: ["Cross-Repo Examples"],
        mustIncludeOneOfSections: ["Relevant Prior Work", "Cross-Repo Hints"],
        textMustIncludeAny: ["scope override audit", "manual overrides"],
        textMustIncludeAll: ["Relevant Prior Work"],
        textMustNotInclude: ["Cross-Repo Examples"],
      },
    }, {
      promptNeed: {
        requiresLookup: true,
        wantsContinuity: false,
      },
      text: "## Relevant Prior Work\n\nWe added scope override audit coverage for manual overrides.",
      trace: {
        output: {
          sectionTitles: ["Relevant Prior Work"],
        },
        routerDecision: {
          route: "memory_recall",
        },
        lookups: {
          localEpisodes: {
            includedRows: [{ summary: "Added scope override audit coverage." }],
          },
        },
      },
    });

    assert.equal(evaluation.passed, true);
    assert.equal(evaluation.assertions.length, 12);
    assert.deepEqual(evaluation.sectionTitles, ["Relevant Prior Work"]);
  });

  test("classifyReplayMiss distinguishes cross-repo leaks from extraction-shape misses", async () => {
    const { classifyReplayMiss } = await loadDiagnosticsHotspots();

    const scopeMiss = classifyReplayMiss(
      { caseType: "ranking_target" },
      {
        text: "## Cross-Repo Examples",
        promptNeed: { wantsCrossRepoExamples: false },
        trace: {
          output: {
            sectionTitles: ["Cross-Repo Examples"],
          },
        },
      },
      { missingCount: 1 },
    );
    const extractionMiss = classifyReplayMiss(
      { caseType: "ranking_target" },
      {
        text: "",
        promptNeed: { wantsCrossRepoExamples: false },
        trace: {
          lookups: {
            localEpisodes: {
              rankedRows: [{ summary: "files created remaining work" }],
            },
            localMemories: {
              includedRows: [],
            },
          },
        },
      },
      { missingCount: 1 },
    );

    assert.equal(scopeMiss, "scope_classification");
    assert.equal(extractionMiss, "extraction_shape");
  });

  test("persistReplayFailureArtifact preserves ranking-miss artifact and trajectory content", async () => {
    const { persistReplayFailureArtifact } = await loadDiagnosticsHotspots();
    const inserted = {
      memory: null,
      artifact: null,
      trajectory: null,
    };
    const artifactId = persistReplayFailureArtifact({
      runtime: {
        repository: "diagnostics/current-repo",
        config: {
          rollout: {
            autoWriteImprovementGoals: true,
          },
        },
        db: {
          insertSemanticMemory(memory) {
            inserted.memory = memory;
            return "mem-1";
          },
          upsertImprovementArtifact(artifact) {
            inserted.artifact = artifact;
            return "imp-1";
          },
          insertTrajectoryArtifact(artifact) {
            inserted.trajectory = artifact;
          },
        },
      },
      definition: {
        id: "ranking-controlled-backfill-rollback",
        title: "Controlled backfill rollback details are retrievable",
        mode: "prompt",
        prompt: "How does the controlled backfill rollback work in lore?",
        caseType: "ranking_target",
      },
      evaluation: {
        assertions: [{ label: "unused", passed: true }],
      },
      explanation: {
        estimatedTokens: 44,
        trace: {
          output: {
            sectionTitles: ["Relevant Prior Work"],
          },
        },
      },
      evidence: {
        expectedCount: 1,
        includedCount: 0,
        rankedOnlyCount: 1,
      },
      rankingOutcome: "partial",
      missCategory: "lexical_ranking",
    });

    assert.equal(artifactId, "imp-1");
    assert.equal(inserted.memory.type, "recurring_mistake");
    assert.equal(inserted.artifact.summary, "Ranking outcome: partial | Miss category: lexical_ranking");
    assert.deepEqual(inserted.artifact.evidence, {
      mode: "prompt",
      prompt: "How does the controlled backfill rollback work in lore?",
      caseType: "ranking_target",
      rankingOutcome: "partial",
      missCategory: "lexical_ranking",
      failedAssertions: [],
      expectedEvidence: {
        expectedCount: 1,
        includedCount: 0,
        rankedOnlyCount: 1,
      },
      estimatedTokens: 44,
    });
    assert.deepEqual(inserted.trajectory.context, {
      title: "Controlled backfill rollback details are retrievable",
      caseType: "ranking_target",
      mode: "prompt",
      rankingOutcome: "partial",
      missCategory: "lexical_ranking",
      failedAssertionCount: 0,
      expectedEvidenceCount: 1,
      includedEvidenceCount: 0,
      rankedOnlyEvidenceCount: 1,
      estimatedTokens: 44,
    });
  });

  test("persistReplayFailureArtifact preserves must-pass failure summaries and counts", async () => {
    const { persistReplayFailureArtifact } = await loadDiagnosticsHotspots();
    const inserted = {
      memory: null,
      artifact: null,
      trajectory: null,
    };
    const artifactId = persistReplayFailureArtifact({
      runtime: {
        repository: "diagnostics/current-repo",
        config: {
          rollout: {
            autoWriteImprovementGoals: true,
          },
        },
        db: {
          insertSemanticMemory(memory) {
            inserted.memory = memory;
            return "mem-2";
          },
          upsertImprovementArtifact(artifact) {
            inserted.artifact = artifact;
            return "imp-2";
          },
          insertTrajectoryArtifact(artifact) {
            inserted.trajectory = artifact;
          },
        },
      },
      definition: {
        id: "identity-greeting",
        title: "Identity greeting",
        mode: "prompt",
        prompt: "Hi Jules, can you help me today?",
        caseType: "must_pass",
      },
      evaluation: {
        assertions: [
          { label: "assistant identity included", passed: false, details: "No identity evidence found" },
          { label: "style omitted", passed: true },
        ],
      },
      explanation: {
        estimatedTokens: 12,
        trace: {
          output: {
            sectionTitles: [],
          },
        },
      },
      evidence: {
        expectedCount: 0,
        includedCount: 0,
        rankedOnlyCount: 0,
      },
      rankingOutcome: null,
      missCategory: null,
    });

    assert.equal(artifactId, "imp-2");
    assert.equal(inserted.memory.type, "recurring_mistake");
    assert.equal(
      inserted.artifact.summary,
      "assistant identity included (No identity evidence found)",
    );
    assert.deepEqual(inserted.artifact.evidence.failedAssertions, [
      { label: "assistant identity included", passed: false, details: "No identity evidence found" },
    ]);
    assert.equal(inserted.trajectory.summary, "Replay failure for identity-greeting: assistant identity included (No identity evidence found)");
    assert.equal(inserted.trajectory.context.failedAssertionCount, 1);
    assert.equal(inserted.trajectory.outcome, "must_pass_failed");
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
