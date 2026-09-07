import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  QUALITY_GATES,
  evaluateCandidateMemories,
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
      { copilot: 27, pi: 27, codex: 27, claude: 27, antigravity: 27 },
    );
    assert.equal(new Set(RELIABILITY_CORPUS.map((scenario) => scenario.scenarioId)).size, 135);
    assert.ok(RELIABILITY_CORPUS.some((scenario) => scenario.transcript.turns.length > 12));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.family === "isolation"));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.family === "suppression"));
    for (const client of RELIABILITY_CLIENTS) {
      const scenario = RELIABILITY_CORPUS.find((item) => item.client === client && item.id === "repo-preference");
      assert.ok(scenario.transcript.turns.length > 0);
      assert.equal(scenario.transcript.turns[0].user_message, scenario.user);
    }
    assert.equal(RELIABILITY_CORPUS.find((item) => item.client === "pi" && item.id === "repo-preference").transcript.files.length, 1);
  });

  test("matches propositions by type, scope, and anchor evidence rather than a keyword", () => {
    const expected = { type: "user_preference", scope: "repo", repository: "acme/test", anchors: ["prefer", "bounded", "queues", "request", "identifier"] };
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Prefer bounded queues and keep the request identifier in logs." }, expected), true);
    assert.equal(matchesProposition({ type: "user_preference", scope: "global", repository: null, content: "I prefer queues." }, expected), false);
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Prefer colorful dashboards." }, expected), false);
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

  test("benchmark embedding paths expose cold, warm, and capture delta work", () => {
    const result = measureMockEmbeddingPaths(100);
    assert.equal(result.mocked, true);
    assert.equal(result.diskCold, false);
    assert.equal(result.cold.calls, 100);
    assert.equal(result.warm.calls, 0);
    assert.equal(result.captureDeltaWork, 100);
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
  });

  test("full production pipeline meets the frozen quality gates", async () => {
    const result = await runQualityEvaluation();
    assert.equal(result.passed, true, JSON.stringify(result.metrics, null, 2));
  });
});
