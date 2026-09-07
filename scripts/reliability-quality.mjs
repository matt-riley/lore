#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSessionMemories } from "../lib/sessions/rule-extractor.mjs";
import { applySessionExtraction } from "../lib/sessions/backfill.mjs";
import { recallMemory } from "../lib/memory/memory-operations.mjs";
import {
  RELIABILITY_CORPUS,
  RELIABILITY_CLIENTS,
  parseScenarioTranscript,
} from "../tests/fixtures/reliability-corpus.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../tests/helpers/fixture-db.mjs";

export const QUALITY_GATES = Object.freeze({
  extractionPrecision: 0.95,
  explicitPropositionRecall: 0.9,
  retentionRecall: 0.9,
  maxFalseGlobalPromotions: 0,
  maxCriticalFailures: 0,
  maxNegativeFalsePositives: 0,
});

const CANDIDATE_TYPES = new Set(["user_preference", "rejected_approach", "decision", "fact", "constraint"]);

function words(value) {
  return new Set(String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/gu, " ").split(/\s+/u).filter((word) => word.length > 2));
}

function overlap(haystack, anchors) {
  const actual = words(haystack);
  const expected = words(anchors.join(" "));
  if (expected.size === 0) return 0;
  let found = 0;
  for (const word of expected) if (actual.has(word)) found += 1;
  return found / expected.size;
}

function evidenceText(memory) {
  return `${memory?.content ?? memory?.summary ?? ""} ${JSON.stringify(memory?.decisions ?? [])} ${JSON.stringify(memory?.metadata ?? {})} ${JSON.stringify(memory ?? {})}`;
}

export function matchesProposition(memory, proposition) {
  if (!memory || !proposition) return false;
  if (proposition.type && memory.type !== proposition.type) return false;
  if (proposition.scope && memory.scope && memory.scope !== proposition.scope) return false;
  if (proposition.scope === "repo" && memory.repository && memory.repository !== proposition.repository && proposition.repository) return false;
  return overlap(evidenceText(memory), proposition.anchors ?? []) >= 0.72;
}

function matchesForbidden(memory, forbidden) {
  return overlap(evidenceText(memory), forbidden?.anchors ?? []) >= 0.72;
}

function includedRows(result) {
  return Object.values(result?.trace?.lookups ?? {}).flatMap((lookup) => Array.isArray(lookup?.includedRows) ? lookup.includedRows : []);
}

function candidateMemories(extraction) {
  const semantic = extraction.semanticMemories.filter((memory) => CANDIDATE_TYPES.has(memory.type));
  const decisions = (extraction.episodeDigest?.decisions ?? []).map((content) => ({
    type: "decision",
    scope: "repo",
    repository: extraction.episodeDigest.repository,
    content,
    provenance: "episode_digest",
  }));
  return [...semantic, ...decisions];
}

export function evaluateCandidateMemories({ scenario, extraction }) {
  const candidates = candidateMemories(extraction);
  const matched = scenario.expected.filter((proposition) => candidates.some((memory) => matchesProposition(memory, { ...proposition, repository: scenario.repository })));
  const falsePositives = candidates.filter((memory) => !scenario.expected.some((proposition) => matchesProposition(memory, { ...proposition, repository: scenario.repository })));
  const falseGlobals = candidates.filter((memory) => {
    if (scenario.expected.some((proposition) => proposition.scope === "global" && matchesProposition(memory, { ...proposition, repository: scenario.repository }))) return false;
    return memory.scope === "global" || memory.repository == null;
  });
  const negativeFalsePositives = scenario.expected.length > 0
    ? (scenario.forbidden ?? []).filter((forbidden) => candidates.some((memory) => matchesForbidden(memory, forbidden))).length
    : candidates.filter((memory) => (scenario.forbidden ?? []).some((forbidden) => matchesForbidden(memory, forbidden))).length;
  return {
    candidateCount: candidates.length,
    truePositiveCount: candidates.length - falsePositives.length,
    matchedExpected: matched.length,
    expectedCount: scenario.expected.length,
    falsePositiveCount: falsePositives.length,
    falseGlobalPromotions: falseGlobals.length,
    negativeFalsePositives,
    falsePositiveExamples: falsePositives.slice(0, 3).map((memory) => ({ type: memory.type, content: memory.content })),
  };
}

function findExpectedRecall(scenario, rows, text) {
  return scenario.expected.filter((proposition) => rows.some((row) => matchesProposition(row, { ...proposition, repository: scenario.repository }))
    || matchesProposition({ content: text, type: proposition.type, repository: scenario.repository }, proposition));
}

function createForeignScenario(scenario) {
  if (!scenario.foreign) return null;
  return {
    ...scenario,
    id: `${scenario.id}-foreign`,
    scenarioId: `${scenario.client}:${scenario.id}-foreign`,
    sessionId: `${scenario.client}:${scenario.id}-foreign`,
    repository: scenario.foreign.repository,
    user: scenario.foreign.user,
    assistant: scenario.foreign.assistant,
    correction: null,
    expected: [],
    forbidden: [],
    foreign: null,
    suppress: false,
    transcript: parseScenarioTranscript({
      ...scenario,
      ...scenario.foreign,
      id: `${scenario.id}-foreign`,
      turnsBefore: 0,
    }, scenario.client),
  };
}

async function runScenario(scenario) {
  const fixture = await withFixtureDb({
    configOverrides: {
      enabled: true,
      rollout: { memoryOperations: true, directives: true, retentionSanitization: false, hybridRetrieval: true },
    },
  });
  try {
    const workspace = { workspace: { repository: scenario.repository, branch: "quality" } };
    const extraction = extractSessionMemories({
      sessionId: scenario.sessionId,
      repository: scenario.repository,
      sessionArtifacts: scenario.transcript,
      workspace,
      config: fixture.db.config,
    });
    const extractionMetrics = evaluateCandidateMemories({ scenario, extraction });
    applySessionExtraction({
      db: fixture.db,
      sessionId: scenario.sessionId,
      repository: scenario.repository,
      sessionArtifacts: scenario.transcript,
      workspace,
      extraction,
    });

    const foreign = createForeignScenario(scenario);
    if (foreign) {
      const foreignWorkspace = { workspace: { repository: foreign.repository, branch: "quality" } };
      const foreignExtraction = extractSessionMemories({ sessionId: foreign.sessionId, repository: foreign.repository, sessionArtifacts: foreign.transcript, workspace: foreignWorkspace, config: fixture.db.config });
      applySessionExtraction({ db: fixture.db, sessionId: foreign.sessionId, repository: foreign.repository, sessionArtifacts: foreign.transcript, workspace: foreignWorkspace, extraction: foreignExtraction });
    }

    let retainedRows = fixture.db.db.prepare("SELECT id, type, content, scope, repository, superseded_by FROM semantic_memory WHERE source_session_id = ?").all(scenario.sessionId);
    if (scenario.suppress) {
      for (const row of retainedRows.filter((candidate) => scenario.expected.some((proposition) => matchesProposition(candidate, { ...proposition, repository: scenario.repository })))) {
        fixture.db.forgetMemory({ id: row.id, supersededBy: `quality:${scenario.scenarioId}` });
      }
      // Replay the same transcript after forgetting. Durable suppression must
      // survive refresh and prevent automatic recapture of the proposition.
      applySessionExtraction({
        db: fixture.db,
        sessionId: scenario.sessionId,
        repository: scenario.repository,
        sessionArtifacts: scenario.transcript,
        workspace,
        extraction,
      });
      retainedRows = fixture.db.db.prepare("SELECT id, type, content, scope, repository, superseded_by FROM semantic_memory WHERE source_session_id = ?").all(scenario.sessionId);
    }

    const recall = recallMemory({ db: fixture.db, prompt: scenario.query, repository: scenario.repository, limit: 12 });
    const rows = includedRows(recall);
    const recalledExpected = findExpectedRecall(scenario, rows, recall.text ?? "");
    const forbiddenRecall = (scenario.forbidden ?? []).filter((forbidden) => rows.some((row) => matchesForbidden(row, forbidden)) || matchesForbidden({ content: recall.text }, forbidden));
    const isolationFailure = scenario.critical?.includes("isolation") && rows.some((row) => row.repository && row.repository !== scenario.repository);
    const suppressionFailure = scenario.critical?.includes("suppression") && recalledExpected.length > 0;
    return {
      id: scenario.scenarioId,
      client: scenario.client,
      family: scenario.family,
      extraction: extractionMetrics,
      expectedRecall: recalledExpected.length,
      recallExpectedCount: scenario.expected.length,
      forbiddenRecall: forbiddenRecall.length,
      isolationFailure: Boolean(isolationFailure),
      suppressionFailure: Boolean(suppressionFailure),
      candidateRows: retainedRows.length,
      parsedTurns: scenario.transcript.turns.length,
    };
  } finally {
    fixture.cleanup();
  }
}

export async function runQualityEvaluation({ scenarios = RELIABILITY_CORPUS } = {}) {
  if (!FTS5_AVAILABLE) throw new Error("Reliability quality evaluation requires SQLite FTS5");
  const cases = [];
  for (const scenario of scenarios) cases.push(await runScenario(scenario));
  const candidateCount = cases.reduce((sum, item) => sum + item.extraction.candidateCount, 0);
  const truePositiveCount = cases.reduce((sum, item) => sum + item.extraction.truePositiveCount, 0);
  const expectedCount = cases.reduce((sum, item) => sum + item.extraction.expectedCount, 0);
  const matchedExpected = cases.reduce((sum, item) => sum + item.extraction.matchedExpected, 0);
  const recalledExpected = cases.reduce((sum, item) => sum + item.expectedRecall, 0);
  const recallExpectedCount = cases.reduce((sum, item) => sum + item.recallExpectedCount, 0);
  const metrics = {
    scenarioCount: cases.length,
    clients: Object.fromEntries(RELIABILITY_CLIENTS.map((client) => [client, cases.filter((item) => item.client === client).length])),
    extractionPrecision: candidateCount ? truePositiveCount / candidateCount : 1,
    explicitPropositionRecall: expectedCount ? matchedExpected / expectedCount : 1,
    retentionRecall: recallExpectedCount ? recalledExpected / recallExpectedCount : 1,
    falseGlobalPromotions: cases.reduce((sum, item) => sum + item.extraction.falseGlobalPromotions, 0),
    negativeFalsePositives: cases.reduce((sum, item) => sum + item.extraction.negativeFalsePositives, 0),
    criticalFailures: cases.filter((item) => item.isolationFailure || item.suppressionFailure).map((item) => item.id),
    forbiddenRecallFailures: cases.filter((item) => item.forbiddenRecall > 0).map((item) => item.id),
    extractionMatchedExpected: matchedExpected,
    recallMatchedExpected: recalledExpected,
  };
  const passed = metrics.extractionPrecision >= QUALITY_GATES.extractionPrecision
    && metrics.explicitPropositionRecall >= QUALITY_GATES.explicitPropositionRecall
    && metrics.retentionRecall >= QUALITY_GATES.retentionRecall
    && metrics.falseGlobalPromotions <= QUALITY_GATES.maxFalseGlobalPromotions
    && metrics.negativeFalsePositives <= QUALITY_GATES.maxNegativeFalsePositives
    && metrics.criticalFailures.length <= QUALITY_GATES.maxCriticalFailures
    && metrics.forbiddenRecallFailures.length === 0;
  return { passed, gates: QUALITY_GATES, metrics, cases };
}

export function renderQualityReport(result) {
  const { metrics } = result;
  return [
    `passed: ${result.passed}`,
    `scenarios: ${metrics.scenarioCount}`,
    `clients: ${Object.entries(metrics.clients).map(([client, count]) => `${client}=${count}`).join(", ")}`,
    `extraction precision: ${(metrics.extractionPrecision * 100).toFixed(2)}%`,
    `explicit proposition recall: ${(metrics.explicitPropositionRecall * 100).toFixed(2)}%`,
    `retention recall: ${(metrics.retentionRecall * 100).toFixed(2)}%`,
    `false global promotions: ${metrics.falseGlobalPromotions}`,
    `negative false positives: ${metrics.negativeFalsePositives}`,
    `critical failures: ${metrics.criticalFailures.length}${metrics.criticalFailures.length ? ` (${metrics.criticalFailures.join(", ")})` : ""}`,
    `forbidden recall failures: ${metrics.forbiddenRecallFailures.length}`,
    ...result.cases.filter((item) => item.extraction.falsePositiveCount || item.extraction.matchedExpected < item.extraction.expectedCount || item.forbiddenRecall || item.isolationFailure || item.suppressionFailure).slice(0, 80).map((item) => `FAIL ${item.id}: candidates=${item.extraction.candidateCount}, matched=${item.extraction.matchedExpected}/${item.extraction.expectedCount}, recall=${item.expectedRecall}/${item.recallExpectedCount}, falseGlobals=${item.extraction.falseGlobalPromotions}`),
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !["--json", "--limit"].includes(arg) && !/^--limit=\d+$/u.test(arg))) throw new Error("Usage: reliability-quality.mjs [--json] [--limit=N]");
    const limitArg = args.find((arg) => arg.startsWith("--limit="));
    const limit = limitArg ? Number(limitArg.split("=", 2)[1]) : null;
    const result = await runQualityEvaluation({ scenarios: limit ? RELIABILITY_CORPUS.slice(0, limit) : RELIABILITY_CORPUS });
    process.stdout.write(`${args.includes("--json") ? JSON.stringify(result, null, 2) : renderQualityReport(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
