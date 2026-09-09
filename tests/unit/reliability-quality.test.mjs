import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  QUALITY_GATES,
  MANDATORY_RECALL_SCENARIO_IDS,
  renderQualityReport,
  currentGuidanceText,
  evaluateCandidateMemories,
  evaluateForeignRows,
  evaluateNegativeQueryEvidence,
  matchesProposition,
  normalizeRecallEvidence,
  runQualityEvaluation,
} from "../../scripts/reliability-quality.mjs";
import {
  RELIABILITY_BLUEPRINTS,
  RELIABILITY_CLIENTS,
  RELIABILITY_CORPUS,
  STANDING_DIRECTIVE_CORPUS,
} from "../fixtures/reliability-corpus.mjs";
import { directiveSentences, standingDirectiveType } from "../../lib/sessions/extraction-grammar.mjs";
import {
  isolatedEnvironment,
  checkpointDeltaWork,
  measureMockEmbeddingPaths,
  runReliabilityBenchmark,
} from "../../scripts/reliability-benchmark.mjs";

describe("independent reliability quality corpus", () => {
  test("freezes independent semantic cases for every supported client", () => {
    assert.ok(RELIABILITY_BLUEPRINTS.length >= 120);
    assert.ok(RELIABILITY_CORPUS.length >= 600);
    assert.deepEqual(
      Object.fromEntries(RELIABILITY_CLIENTS.map((client) => [client, RELIABILITY_CORPUS.filter((scenario) => scenario.client === client).length])),
      { copilot: 160, pi: 160, codex: 160, claude: 160, antigravity: 160 },
    );
    assert.equal(new Set(RELIABILITY_CORPUS.map((scenario) => scenario.scenarioId)).size, 800);
    assert.ok(RELIABILITY_CORPUS.some((scenario) => scenario.transcript.turns.length > 12));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.family === "isolation"));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.family === "suppression"));
    for (const client of RELIABILITY_CLIENTS) {
      const scenario = RELIABILITY_CORPUS.find((item) => item.client === client && item.id === "repo-preference");
      assert.ok(scenario.transcript.turns.length > 0);
      assert.match(scenario.transcript.turns[0].user_message, new RegExp(scenario.user.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    }
    assert.equal(RELIABILITY_CORPUS.find((item) => item.client === "pi" && item.id === "repo-preference").transcript.files.length, 1);
    assert.ok(new Set(RELIABILITY_BLUEPRINTS.map((scenario) => `${scenario.user}\n${scenario.assistant}`)).size >= 120);
    assert.equal(RELIABILITY_BLUEPRINTS.filter((scenario) => scenario.id.startsWith("independent-")).length, 128);
  });

  test("matches propositions by type, scope, and anchor evidence rather than a keyword", () => {
    const expected = { type: "user_preference", scope: "repo", repository: "acme/test", anchors: ["prefer", "bounded", "queues", "request", "identifier"] };
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Prefer bounded queues and keep the request identifier in logs." }, expected), true);
    assert.equal(matchesProposition({ type: "user_preference", scope: "global", repository: null, content: "I prefer queues." }, expected), false);
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Prefer colorful dashboards." }, expected), false);
    assert.equal(matchesProposition({ type: "user_preference", content: "Prefer bounded queues and keep the request identifier in logs." }, expected), false);
    const timeout = { type: "user_preference", scope: "repo", repository: "acme/test", anchors: ["use", "45", "second", "timeout"] };
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Use a 45 second timeout." }, timeout), true);
    assert.equal(matchesProposition({ type: "user_preference", scope: "repo", repository: "acme/test", content: "Use a 30 second timeout." }, timeout), false);
  });

  test("forbidden timeout matching distinguishes the old number from its correction", () => {
    const scenario = RELIABILITY_CORPUS.find((row) => row.client === "copilot" && row.id === "correction");
    const evaluate = (seconds) => evaluateCandidateMemories({
      scenario,
      extraction: { semanticMemories: [{ type: "user_preference", scope: "repo", repository: scenario.repository, content: `Use a ${seconds} second timeout for the worker.` }] },
    });
    assert.equal(evaluate(45).negativeFalsePositives, 0);
    assert.equal(evaluate(30).negativeFalsePositives, 1);
    const written = RELIABILITY_CORPUS.find((row) => row.client === "copilot" && row.id === "independent-negative-corrected-old");
    assert.equal(written.transcript.turns.length, 2);
    assert.match(written.transcript.turns[1].user_message, /twenty seconds/);
    assert.equal(evaluateCandidateMemories({
      scenario: written,
      extraction: { semanticMemories: [{ type: "user_preference", scope: "repo", repository: written.repository, content: "Use twenty seconds for the endpoint timeout because the upstream SLA changed." }] },
    }).negativeFalsePositives, 0);
  });

  test("retired extraction evidence and labeled historical questions are not current guidance", () => {
    const scenario = { repository: "acme/test", expected: [], forbidden: [] };
    const result = evaluateCandidateMemories({ scenario, extraction: {
      semanticMemories: [{ type: "decision", content: "Decision: old queue.", evidence: { key: "old" } }],
      retiredEvidenceKeys: ["old"],
    } });
    assert.equal(result.candidateCount, 0);
    const text = "## Relevant Prior Work\n\n- Should we always cache?\n\n## Relevant Knowledge\n\n- Always cache.\n\n## New Unexpected Section\n\n- Never validate.";
    assert.doesNotMatch(currentGuidanceText(text), /Should we/);
    assert.match(currentGuidanceText(text), /Always cache/);
    assert.match(currentGuidanceText(text), /Never validate/);
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

  test("normalizes episodic decisions for positive recall and foreign isolation", () => {
    const proposition = { type: "decision", scope: "repo", repository: "acme/test", anchors: ["chose", "PostgreSQL", "concurrent", "writers"] };
    const episode = { id: "episode-1", sessionId: "local-session", scope: "repo", repository: "acme/test", decisions: ["We chose PostgreSQL for concurrent writers."] };
    const foreignEpisode = { id: "episode-2", sessionId: "foreign-session", scope: "global", repository: null, decisions: ["We chose PostgreSQL for concurrent writers."] };
    const normalized = normalizeRecallEvidence([episode]);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].type, "decision");
    assert.equal(matchesProposition(normalized[0], proposition), true);
    assert.equal(evaluateForeignRows({ rows: [foreignEpisode], foreignEvidence: [{ type: "decision", anchors: ["chose", "PostgreSQL", "concurrent", "writers"] }] }).length, 1);
  });

  test("rejects every negative-query row sharing scenario evidence identity", () => {
    const scenarioRows = [{ id: "semantic-1", source_session_id: "session-1" }, { id: "episode-1", source_session_id: "session-1" }];
    const returned = [
      { id: "semantic-1", source_session_id: "other", content: "unrelated text" },
      { id: "other-id", source_session_id: "session-1", content: "unrelated text" },
      { id: "other-id-2", source_session_id: "other", content: "unrelated text" },
    ];
    assert.deepEqual(evaluateNegativeQueryEvidence({ rows: returned, scenarioRows }).map((row) => row.id), ["semantic-1", "other-id"]);
  });

  test("contains distinct positive and negative intent expectations", () => {
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.expected.length > 0));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.expected.length === 0));
    assert.ok(RELIABILITY_BLUEPRINTS.some((scenario) => scenario.id === "footer-link-do-not"));
  });

  test("covers standing directive extraction types in the reliability corpus", () => {
    assert.equal(STANDING_DIRECTIVE_CORPUS.length, 4);
    for (const item of STANDING_DIRECTIVE_CORPUS) {
      const [sentence] = directiveSentences(item.grammarText);
      assert.equal(standingDirectiveType(sentence), item.grammarType, item.id);
    }
  });

  test("counts unknown active extraction types as precision failures", () => {
    const scenario = { repository: "acme/test", expected: [], forbidden: [] };
    const result = evaluateCandidateMemories({
      scenario,
      extraction: { semanticMemories: [{ type: "future_memory_type", scope: "repo", repository: scenario.repository, content: "Unexpected proposal" }] },
    });
    assert.equal(result.candidateCount, 1);
    assert.equal(result.falsePositiveCount, 1);
  });

  test("counts an unexpected forbidden directive as an extraction failure", () => {
    const scenario = {
      repository: "acme/test", expected: [],
      forbidden: [{ type: "directive", anchors: ["always", "publish", "secrets"] }],
    };
    const result = evaluateCandidateMemories({
      scenario,
      extraction: { semanticMemories: [{
        type: "directive", scope: "repo", repository: scenario.repository,
        content: "Always publish secrets",
      }] },
    });
    assert.equal(result.candidateCount, 1);
    assert.equal(result.falsePositiveCount, 1);
    assert.equal(result.negativeFalsePositives, 1);
  });

  test("keeps the frozen gates explicit", () => {
    assert.deepEqual(QUALITY_GATES, {
      extractionPrecision: 0.95,
      explicitPropositionRecall: 0.9,
      retentionRecall: 0.9,
      minIndependentSemanticScenarios: 120,
      maxFalseGlobalPromotions: 0,
      maxCriticalFailures: 0,
      maxNegativeFalsePositives: 0,
    });
    assert.deepEqual([...MANDATORY_RECALL_SCENARIO_IDS], ["global-style", "global-reversals"]);
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
    assert.equal(result.cold.cacheRowsAfter, 24);
    assert.equal(result.passed, true);
    assert.equal(result.corpusTraversal.eligibleCandidates, 100);
    assert.equal(result.corpusTraversal.enabled, true);
    assert.deepEqual(result.corpusTraversal.inputCounts, [1], "full-corpus warm scoring embeds only the query");
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
    assert.equal(result.performance[0].capture.checkpointSupport, true);
    assert.ok(result.performance[0].capture.captureDeltaWork > 0);
    assert.ok(result.performance[0].capture.coldPersistedRows > 0);
    assert.equal(result.performance[0].capture.captureDeltaTurns, result.performance[0].capture.refreshPersistedTurns - result.performance[0].capture.coldPersistedTurns);
  });

  test("uses checkpoint offsets as resumable capture work when supported", () => {
    assert.equal(checkpointDeltaWork({ offset: 100 }, { offset: 160 }), 60);
    assert.equal(checkpointDeltaWork({ revision: 3 }, { revision: 4 }), 1);
    assert.equal(checkpointDeltaWork(null, { offset: 10 }), null);
  });

  test("suppressed propositions do not reduce the positive retention denominator", async () => {
    const scenario = RELIABILITY_CORPUS.find((item) => item.client === "copilot" && item.id === "suppression");
    const result = await runQualityEvaluation({ scenarios: [scenario] });
    assert.equal(result.metrics.retentionRecall, 1);
    assert.equal(result.metrics.scenarioCount, 1);
    assert.deepEqual(result.metrics.criticalFailures, []);
  });

  test("production pipeline executes representative scenarios without regressions", async () => {
    const scenarios = RELIABILITY_CLIENTS.map((client) =>
      RELIABILITY_CORPUS.find((item) => item.client === client && item.id === "repo-preference")
    );
    const result = await runQualityEvaluation({ scenarios });
    assert.equal(result.metrics.extractionPrecision, 1);
    assert.equal(result.metrics.explicitPropositionRecall, 1);
    assert.equal(result.metrics.retentionRecall, 1);
    assert.deepEqual(result.metrics.criticalFailures, []);
  });

  test("reports recall misses by underlying scenario instead of truncating them", async () => {
    const scenarios = RELIABILITY_CLIENTS.map((client) =>
      RELIABILITY_CORPUS.find((scenario) => scenario.client === client && scenario.id === "independent-worker-shutdown")
    );
    const result = await runQualityEvaluation({ scenarios });
    assert.deepEqual(result.metrics.recallMissesByScenario["independent-worker-shutdown"].clients, RELIABILITY_CLIENTS);
    assert.equal(result.metrics.recallMissesByScenario["independent-worker-shutdown"].missingPropositions.length, 1);
    assert.deepEqual(result.metrics.mandatoryRecallFailures, []);
  });

  test("renders recall-only failures and fails mandatory recall", () => {
    const result = {
      passed: false,
      metrics: {
        scenarioCount: 1,
        independentSemanticScenarioCount: 0,
        clients: { copilot: 1 },
        extractionPrecision: 1,
        explicitPropositionRecall: 1,
        retentionRecall: 1,
        mandatoryRecallFailures: ["copilot:mandatory"],
        recallMissesByScenario: { mandatory: { clients: ["copilot"], missingPropositions: ["directive/repo: missing rule"] } },
        falseGlobalPromotions: 0,
        negativeFalsePositives: 0,
        criticalFailures: [],
        negativeQueryFailures: [],
        forbiddenSemanticRowFailures: [],
        forbiddenRenderedOutputFailures: [],
      },
      cases: [],
    };
    const report = renderQualityReport(result);
    assert.match(report, /mandatory recall failures: 1/);
    assert.match(report, /RECALL MISS mandatory: clients=copilot/);
  });

  test("mandatory recall gate fails an existing miss without changing other metrics", async () => {
    const scenarios = RELIABILITY_CORPUS.filter((item) => item.client === "copilot");
    const baseline = await runQualityEvaluation({ scenarios });
    assert.equal(baseline.passed, true);
    const workerIndex = scenarios.findIndex((item) => item.id === "independent-worker-shutdown");
    const mandatory = scenarios.map((item, index) => index === workerIndex ? { ...item, mandatoryRecall: true } : item);
    const gated = await runQualityEvaluation({ scenarios: mandatory });
    assert.equal(gated.passed, false);
    assert.deepEqual(gated.metrics.mandatoryRecallFailures, ["copilot:independent-worker-shutdown"]);
    assert.equal(gated.metrics.retentionRecall, baseline.metrics.retentionRecall);
    assert.equal(gated.metrics.extractionPrecision, baseline.metrics.extractionPrecision);
    assert.deepEqual(gated.metrics.recallMissesByScenario, baseline.metrics.recallMissesByScenario);
  });

  test("runs standing directive cases through the real multi-client corpus", async () => {
    const representative = RELIABILITY_CORPUS.find((item) => item.client === "copilot" && item.id === STANDING_DIRECTIVE_CORPUS[0].id);
    const evaluated = await runQualityEvaluation({ scenarios: [representative] });
    assert.equal(evaluated.cases[0].expectedRecall, 1);
    assert.equal(evaluated.cases[0].directiveTraceRows, 1);
    for (const directive of STANDING_DIRECTIVE_CORPUS) {
      for (const client of RELIABILITY_CLIENTS) {
        const scenario = RELIABILITY_CORPUS.find((item) => item.client === client && item.id === directive.id);
        assert.ok(scenario, `${client}:${directive.id}`);
        assert.equal(scenario.mandatoryRecall, true);
        assert.equal(scenario.expected[0].type, directive.expected[0].type);
      }
    }
  });

  test("full production pipeline meets the frozen quality gates", {
    skip: process.env.LORE_RELIABILITY_FULL !== "1",
  }, async () => {
    const result = await runQualityEvaluation();
    assert.equal(result.passed, true, JSON.stringify(result.metrics, null, 2));
  });
});
