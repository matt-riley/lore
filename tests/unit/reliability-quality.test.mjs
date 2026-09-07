import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  QUALITY_GATES,
  evaluateCandidateMemories,
  evaluateForeignRows,
  matchesProposition,
  runQualityEvaluation,
} from "../../scripts/reliability-quality.mjs";
import {
  RELIABILITY_BLUEPRINTS,
  RELIABILITY_CLIENTS,
  RELIABILITY_CORPUS,
} from "../fixtures/reliability-corpus.mjs";
import {
  isolatedEnvironment,
  measureMockEmbeddingPaths,
  runReliabilityBenchmark,
} from "../../scripts/reliability-benchmark.mjs";

describe("independent reliability quality corpus", () => {
  test("freezes 24 distinct cases for every supported client", () => {
    assert.ok(RELIABILITY_BLUEPRINTS.length >= 24);
    assert.ok(RELIABILITY_CORPUS.length >= 120);
    assert.deepEqual(
      Object.fromEntries(RELIABILITY_CLIENTS.map((client) => [client, RELIABILITY_CORPUS.filter((scenario) => scenario.client === client).length])),
      { copilot: 28, pi: 28, codex: 28, claude: 28, antigravity: 28 },
    );
    assert.equal(new Set(RELIABILITY_CORPUS.map((scenario) => scenario.scenarioId)).size, 140);
    assert.ok(RELIABILITY_CORPUS.some((scenario) => scenario.transcript.turns.length > 12));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.family === "isolation"));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.family === "suppression"));
    for (const client of RELIABILITY_CLIENTS) {
      const scenario = RELIABILITY_CORPUS.find((item) => item.client === client && item.id === "repo-preference");
      assert.ok(scenario.transcript.turns.length > 0);
      assert.match(scenario.transcript.turns[0].user_message, new RegExp(scenario.user.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    }
    assert.equal(RELIABILITY_CORPUS.find((item) => item.client === "pi" && item.id === "repo-preference").transcript.files.length, 1);
    assert.ok(new Set(RELIABILITY_CORPUS.map((scenario) => `${scenario.transcript.turns[0]?.user_message}\n${scenario.transcript.turns[0]?.assistant_response}`)).size >= 120);
  });

  test("matches propositions by type, scope, and anchor evidence rather than a keyword", () => {
    const expected = { type: "user_preference", scope: "repo", repository: "acme/test", anchors: ["prefer", "bounded", "queues", "request", "identifier"] };
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Prefer bounded queues and keep the request identifier in logs." }, expected), true);
    assert.equal(matchesProposition({ type: "user_preference", scope: "global", repository: null, content: "I prefer queues." }, expected), false);
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Prefer colorful dashboards." }, expected), false);
    const timeout = { type: "user_preference", scope: "repo", repository: "acme/test", anchors: ["use", "45", "second", "timeout"] };
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Use a 45 second timeout." }, timeout), true);
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Use a 30 second timeout." }, timeout), false);
  });

  test("counts wrong evidence as a false positive even when it repeats a prompt keyword", () => {
    const scenario = { repository: "acme/test", expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "bounded", "queues", "request", "identifier"] }], forbidden: [] };
    const result = evaluateCandidateMemories({
      scenario,
      extraction: { semanticMemories: [
        { type: "user_preference", scope: "repo", repository: "acme/test", content: "I prefer dashboards." },
        { type: "user_preference", scope: "repo", repository: "acme/test", content: "Prefer bounded queues and keep the request identifier in logs." },
      ] },
    });
    assert.equal(result.matchedExpected, 1);
    assert.equal(result.falsePositiveCount, 1);
    assert.equal(result.falsePositiveExamples[0].content, "I prefer dashboards.");
  });

  test("does not treat metadata or quoted history as current proposition evidence", () => {
    const proposition = { type: "user_preference", scope: "repo", repository: "acme/test", anchors: ["prefer", "bounded", "queues", "identifier"] };
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "A policy was recorded.", metadata: { archivedQuote: "We prefer bounded queues and keep the identifier." } }, proposition), false);
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "A policy was recorded.", history: "We prefer bounded queues and keep the identifier." }, proposition), false);
  });

  test("detects a foreign global row even when its repository is null", () => {
    const foreignRows = evaluateForeignRows({
      rows: [{ id: "foreign", type: "user_preference", scope: "global", repository: null, content: "For beta prefer local wall-clock timestamps in display reports." }],
      foreignEvidence: [{ type: "user_preference", anchors: ["beta", "prefer", "local", "wall-clock", "timestamps", "display", "reports"] }],
    });
    assert.equal(foreignRows.length, 1);
  });

  test("contains distinct positive and negative intent expectations", () => {
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.expected.length > 0));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.expected.length === 0));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.id === "footer-link-do-not"));
  });

  test("keeps the frozen gates explicit", () => {
    assert.deepEqual(QUALITY_GATES, {
      extractionPrecision: 0.95,
      explicitPropositionRecall: 0.9,
      retentionRecall: 0.9,
      maxFalseGlobalPromotions: 0,
      maxCriticalFailures: 0,
      maxNegativeFalsePositives: 0,
    });
  });

  test("benchmark embedding paths expose production cold and warm cache work", async () => {
    const result = await measureMockEmbeddingPaths(100);
    assert.equal(result.mockedEndpoint, true);
    assert.match(result.productionPath, /semanticSearch/);
    assert.equal(result.diskCold, false);
    assert.deepEqual(result.cold.inputCounts, [1, 24]);
    assert.deepEqual(result.warm.inputCounts, [1]);
    assert.equal(result.warm.queryEmbeddings, 1);
    assert.equal(result.partialCoverage.complete, true);
    assert.equal(result.deadlineProbe.failedAsExpected, true);
    assert.equal(result.partialProbe.partial, true);
  });

  test("native benchmark runs through an isolated synthetic home", async () => {
    const env = isolatedEnvironment("/tmp/lore-quality-probe");
    assert.equal(env.LORE_ENABLED, undefined);
    assert.equal(env.LORE_REPOSITORY, "quality/native");
    const result = await runReliabilityBenchmark({ sizes: [1_000], warmups: 1, repeats: 2 });
    assert.equal(result.performance.length, 1);
    assert.equal(result.performance[0].nativeCli, "passed");
    assert.equal(result.performance[0].diskCold, false);
    assert.ok(Number.isFinite(result.performance[0].startupP95Ms));
    assert.ok(Number.isFinite(result.performance[0].promptP95Ms));
    assert.equal(result.performance[0].capture.nativeHook, "passed");
    assert.equal(result.performance[0].capture.persistedExpected, true);
    assert.ok(result.performance[0].capture.coldPersistedRows > 0);
    assert.equal(result.performance[0].capture.captureDeltaTurns, result.performance[0].capture.refreshPersistedTurns - result.performance[0].capture.coldPersistedTurns);
  });

  test("suppressed propositions do not reduce the positive retention denominator", async () => {
    const scenario = RELIABILITY_CORPUS.find((item) => item.client === "copilot" && item.id === "suppression");
    const result = await runQualityEvaluation({ scenarios: [scenario] });
    assert.equal(result.metrics.retentionRecall, 1);
    assert.equal(result.metrics.scenarioCount, 1);
    assert.ok(result.metrics.criticalFailures.includes("copilot:suppression"));
  });

  test("full production pipeline meets the frozen quality gates", async () => {
    const result = await runQualityEvaluation();
    assert.equal(result.passed, true, JSON.stringify(result.metrics, null, 2));
  });
});
