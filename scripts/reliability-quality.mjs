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
  minIndependentSemanticScenarios: 120,
  maxFalseGlobalPromotions: 0,
  maxCriticalFailures: 0,
  maxNegativeFalsePositives: 0,
});

const CANDIDATE_TYPES = new Set([
  "commitment", "open_loop", "rejected_approach", "blocker", "user_preference",
  "assistant_identity", "user_identity", "assistant_goal", "recurring_mistake",
  "interaction_style", "decision", "fact", "constraint", "workstream_overlay",
]);

function words(value) {
  return new Set(String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/gu, " ").split(/\s+/u).filter(Boolean));
}

function normalizedAnchorTokens(anchors) {
  return [...words((anchors ?? []).join(" "))];
}

function overlap(haystack, anchors) {
  const actual = words(haystack);
  const expected = new Set(normalizedAnchorTokens(anchors));
  if (expected.size === 0) return 0;
  let found = 0;
  for (const word of expected) if (actual.has(word)) found += 1;
  return found / expected.size;
}

const NUMBER_WORDS = new Set("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million".split(" "));

function hasExactShortAnchors(haystack, anchors) {
  const text = String(haystack ?? "").toLowerCase();
  return normalizedAnchorTokens(anchors).filter((anchor) => anchor.length <= 2 || NUMBER_WORDS.has(anchor) || /^\d+(?:\.\d+)?$/u.test(anchor))
    .every((anchor) => new RegExp(`(?:^|[^a-z0-9])${anchor.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^a-z0-9])`, "u").test(text));
}

function evidenceText(memory) {
  return `${memory?.content ?? memory?.summary ?? ""} ${JSON.stringify(memory?.decisions ?? [])}`;
}

export function matchesProposition(memory, proposition) {
  if (!memory || !proposition) return false;
  if (proposition.type && memory.type !== proposition.type) return false;
  if (proposition.scope && memory.scope !== proposition.scope) return false;
  if (proposition.scope === "repo" && proposition.repository && memory.repository !== proposition.repository) return false;
  if (proposition.scope === "global" && memory.scope === "repo") return false;
  const evidence = evidenceText(memory);
  return hasExactShortAnchors(evidence, proposition.anchors ?? []) && overlap(evidence, proposition.anchors ?? []) >= 0.72;
}

function matchesForbidden(memory, forbidden) {
  const evidence = evidenceText(memory);
  return hasExactShortAnchors(evidence, forbidden?.anchors ?? [])
    && overlap(evidence, forbidden?.anchors ?? []) >= 0.72;
}

// Historical session summaries may accurately quote the question or rejected
// proposal. They are not current directives. Unexpected/new sections remain
// checked so an unlabeled assertion cannot evade the rendered guidance gate.
export function currentGuidanceText(text) {
  const historical = new Set(["Relevant Prior Work", "Long-Range Related Hints", "Cross-Repo Examples", "Cross-Repo Hints"]);
  let include = true;
  return String(text ?? "").split("\n").filter((line) => {
    const heading = line.match(/^##\s+(.+)$/u);
    if (heading) include = !historical.has(heading[1].trim());
    return include;
  }).join("\n");
}

function includedRows(result) {
  return Object.values(result?.trace?.lookups ?? {}).flatMap((lookup) => Array.isArray(lookup?.includedRows) ? lookup.includedRows : []);
}

function candidateMemories(extraction) {
  const retired = new Set(extraction.retiredEvidenceKeys ?? []);
  const semantic = extraction.semanticMemories.filter((memory) => CANDIDATE_TYPES.has(memory.type) && !retired.has(memory.evidence?.key));
  const decisions = (extraction.episodeDigest?.decisions ?? []).map((content) => ({
    type: "decision",
    scope: "repo",
    repository: extraction.episodeDigest.repository,
    content,
    provenance: "episode_digest",
  }));
  const merged = [...semantic, ...decisions];
  const byDecisionChoice = new Map();
  const result = [];
  for (const memory of merged) {
    if (memory.type !== "decision") {
      result.push(memory);
      continue;
    }
    const choice = String(memory.metadata?.decisionChoice
      || memory.content?.replace(/^(?:Assistant reported|User stated):\s*/i, "").replace(/^Decision:\s*/i, "").split(/\s+because\s+/i)[0]
      || "").trim().toLowerCase();
    if (!choice) {
      result.push(memory);
      continue;
    }
    const priorIndex = byDecisionChoice.get(choice);
    if (priorIndex === undefined) {
      byDecisionChoice.set(choice, result.length);
      result.push(memory);
    } else if (String(memory.content || "").length > String(result[priorIndex].content || "").length) {
      result[priorIndex] = memory;
    }
  }
  return result;
}

export function normalizeRecallEvidence(rows) {
  return rows.flatMap((row) => {
    if (row?.type) return [row];
    const decisions = Array.isArray(row?.decisions) ? row.decisions : [];
    return decisions.map((content) => ({ ...row, type: "decision", content, evidenceKind: "episode_decision" }));
  });
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

export function evaluatePersistedRows({ scenario, rows }) {
  const activeRows = rows.filter((row) => !row.superseded_by);
  const falseGlobals = activeRows.filter((row) => {
    if (scenario.expected.some((proposition) => proposition.scope === "global" && matchesProposition(row, { ...proposition, repository: scenario.repository }))) return false;
    return row.scope === "global" || row.repository == null;
  });
  return {
    activeRows,
    falseGlobalPromotions: falseGlobals.length,
    falseGlobalExamples: falseGlobals.slice(0, 3).map((row) => ({ id: row.id, type: row.type, scope: row.scope, repository: row.repository, content: row.content })),
  };
}

export function evaluateForeignRows({ rows, foreignEvidence }) {
  return rows.filter((row) => normalizeRecallEvidence([row]).some((evidence) => foreignEvidence.some((proposition) => matchesProposition(evidence, proposition))));
}

export function evaluateNegativeQueryEvidence({ rows, scenarioRows }) {
  const evidenceIds = new Set(scenarioRows.flatMap((row) => [row?.id, row?.memoryId, row?.evidenceId]).filter(Boolean));
  const sessionIds = new Set(scenarioRows.flatMap((row) => [row?.source_session_id, row?.session_id, row?.sessionId, row?.sourceSessionId]).filter(Boolean));
  return rows.filter((row) => [row?.id, row?.memoryId, row?.evidenceId].some((id) => id && evidenceIds.has(id))
    || [row?.source_session_id, row?.session_id, row?.sessionId, row?.sourceSessionId].some((id) => id && sessionIds.has(id)));
}

function findExpectedRecall(scenario, rows) {
  const evidence = normalizeRecallEvidence(rows);
  return scenario.expected.filter((proposition) => evidence.some((row) => matchesProposition(row, { ...proposition, repository: scenario.repository })));
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
    foreignEvidence: [],
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
    let foreignEvidence = [];
    if (foreign) {
      const foreignWorkspace = { workspace: { repository: foreign.repository, branch: "quality" } };
      const foreignExtraction = extractSessionMemories({ sessionId: foreign.sessionId, repository: foreign.repository, sessionArtifacts: foreign.transcript, workspace: foreignWorkspace, config: fixture.db.config });
      applySessionExtraction({ db: fixture.db, sessionId: foreign.sessionId, repository: foreign.repository, sessionArtifacts: foreign.transcript, workspace: foreignWorkspace, extraction: foreignExtraction });
      foreignEvidence = candidateMemories(foreignExtraction).map((memory) => ({ type: memory.type, anchors: [...words(memory.content)], scope: undefined, repository: undefined }));
    }

    let retainedRows = fixture.db.db.prepare("SELECT id, type, content, scope, repository, source_session_id, metadata_json, superseded_by FROM semantic_memory WHERE source_session_id = ? AND superseded_by IS NULL").all(scenario.sessionId);
    const persistedMetrics = evaluatePersistedRows({ scenario, rows: retainedRows });
    extractionMetrics.falseGlobalPromotions = persistedMetrics.falseGlobalPromotions;
    extractionMetrics.falseGlobalExamples = persistedMetrics.falseGlobalExamples;
    if (scenario.suppress) {
      const suppressionTargets = retainedRows.filter((candidate) => scenario.expected.some((proposition) => matchesProposition(candidate, { ...proposition, scope: undefined, repository: undefined })));
      if (suppressionTargets.length === 0) {
        return {
          id: scenario.scenarioId,
          client: scenario.client,
          family: scenario.family,
          extraction: extractionMetrics,
          expectedRecall: 0,
          recallExpectedCount: 0,
          forbiddenRecall: 0,
          isolationFailure: false,
          suppressionFailure: true,
          suppressionSetupFailure: true,
          candidateRows: retainedRows.length,
          activeRowsAfterReplay: retainedRows.length,
          parsedTurns: scenario.transcript.turns.length,
        };
      }
      for (const row of suppressionTargets) {
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
      retainedRows = fixture.db.db.prepare(`
        SELECT sm.id, sm.type, sm.content, sm.scope, sm.repository, sm.source_session_id, sm.metadata_json, sm.superseded_by
        FROM semantic_memory sm
        WHERE sm.source_session_id = ? AND sm.superseded_by IS NULL
          AND (NOT EXISTS (SELECT 1 FROM memory_evidence me WHERE me.memory_id = sm.id)
            OR EXISTS (
              SELECT 1 FROM memory_evidence me
              JOIN session_evidence se ON se.evidence_key = me.evidence_key
              WHERE me.memory_id = sm.id AND me.retired_at IS NULL AND se.retired_at IS NULL
            ))
      `).all(scenario.sessionId);
    }

    const recall = await recallMemory({ db: fixture.db, prompt: scenario.query, repository: scenario.repository, limit: 12 });
    const rows = includedRows(recall);
    const recalledExpected = findExpectedRecall(scenario, rows);
    const forbiddenSemanticRows = (scenario.forbidden ?? []).filter((forbidden) => normalizeRecallEvidence(rows).some((row) => matchesForbidden(row, forbidden)));
    const forbiddenRenderedOutput = (scenario.forbidden ?? []).filter((forbidden) => matchesForbidden({ content: currentGuidanceText(recall.text) }, forbidden));
    const foreignRows = evaluateForeignRows({ rows, foreignEvidence });
    const isolationFailure = scenario.critical?.includes("isolation") && foreignRows.length > 0;
    const suppressionFailure = scenario.critical?.includes("suppression") && (recalledExpected.length > 0 || retainedRows.some((row) => scenario.expected.some((proposition) => matchesProposition(row, { ...proposition, scope: undefined, repository: undefined }))));
    let negativeQueryResult = null;
    if (scenario.negativeQuery) {
      const negativeRecall = await recallMemory({ db: fixture.db, prompt: scenario.negativeQuery, repository: scenario.repository, limit: 12 });
      const negativeRows = includedRows(negativeRecall);
      const scenarioRows = fixture.db.db.prepare("SELECT id, source_session_id, type, content, scope, repository FROM semantic_memory WHERE source_session_id = ? UNION ALL SELECT id, session_id AS source_session_id, 'episode' AS type, summary AS content, scope, repository FROM episode_digest WHERE session_id = ?").all(scenario.sessionId, scenario.sessionId);
      if (foreign) {
        const foreignRows = fixture.db.db.prepare("SELECT id, source_session_id, type, content, scope, repository FROM semantic_memory WHERE source_session_id = ? UNION ALL SELECT id, session_id AS source_session_id, 'episode' AS type, summary AS content, scope, repository FROM episode_digest WHERE session_id = ?").all(foreign.sessionId, foreign.sessionId);
        scenarioRows.push(...foreignRows);
      }
      const negativeSemanticRows = evaluateNegativeQueryEvidence({ rows: negativeRows, scenarioRows });
      const scenarioEvidence = candidateMemories(extraction).map((memory) => ({ type: memory.type, anchors: [...words(memory.content)], scope: undefined, repository: undefined })).concat(foreignEvidence);
      const negativeRenderedOutput = scenarioEvidence.filter((proposition) => matchesProposition({ type: proposition.type, content: negativeRecall.text }, proposition));
      negativeQueryResult = { prompt: scenario.negativeQuery, semanticRows: negativeSemanticRows.length, semanticRowIds: negativeSemanticRows.map((row) => row.id), renderedOutput: negativeRenderedOutput.length };
    }
    return {
      id: scenario.scenarioId,
      client: scenario.client,
      family: scenario.family,
      extraction: extractionMetrics,
      expectedRecall: recalledExpected.length,
      recallExpectedCount: scenario.suppress ? 0 : scenario.expected.length,
      forbiddenSemanticRows: forbiddenSemanticRows.length,
      forbiddenRenderedOutput: forbiddenRenderedOutput.length,
      forbiddenRecall: forbiddenSemanticRows.length + forbiddenRenderedOutput.length,
      negativeQuery: negativeQueryResult,
      negativeQueryFailure: Boolean(negativeQueryResult && (negativeQueryResult.semanticRows > 0 || negativeQueryResult.renderedOutput > 0)),
      foreignRows: foreignRows.map((row) => ({ id: row.id, type: row.type, scope: row.scope, repository: row.repository, content: row.content })),
      isolationFailure: Boolean(isolationFailure),
      suppressionFailure: Boolean(suppressionFailure),
      suppressionSetupFailure: false,
      candidateRows: retainedRows.length,
      activeRowsAfterReplay: retainedRows.length,
      persistedScope: persistedMetrics,
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
    independentSemanticScenarioCount: new Set(scenarios.filter((scenario) => scenario.id.startsWith("independent-")).map((scenario) => scenario.id)).size,
    clients: Object.fromEntries(RELIABILITY_CLIENTS.map((client) => [client, cases.filter((item) => item.client === client).length])),
    extractionPrecision: candidateCount ? truePositiveCount / candidateCount : 1,
    explicitPropositionRecall: expectedCount ? matchedExpected / expectedCount : 1,
    retentionRecall: recallExpectedCount ? recalledExpected / recallExpectedCount : 1,
    falseGlobalPromotions: cases.reduce((sum, item) => sum + item.extraction.falseGlobalPromotions, 0),
    negativeFalsePositives: cases.reduce((sum, item) => sum + item.extraction.negativeFalsePositives, 0),
    negativeQueryFailures: cases.filter((item) => item.negativeQueryFailure).map((item) => item.id),
    criticalFailures: cases.filter((item) => item.isolationFailure || item.suppressionFailure).map((item) => item.id),
    forbiddenSemanticRowFailures: cases.filter((item) => item.forbiddenSemanticRows > 0).map((item) => item.id),
    forbiddenRenderedOutputFailures: cases.filter((item) => item.forbiddenRenderedOutput > 0).map((item) => item.id),
    extractionMatchedExpected: matchedExpected,
    recallMatchedExpected: recalledExpected,
  };
  const passed = metrics.extractionPrecision >= QUALITY_GATES.extractionPrecision
    && metrics.explicitPropositionRecall >= QUALITY_GATES.explicitPropositionRecall
    && metrics.retentionRecall >= QUALITY_GATES.retentionRecall
    && metrics.independentSemanticScenarioCount >= QUALITY_GATES.minIndependentSemanticScenarios
    && metrics.falseGlobalPromotions <= QUALITY_GATES.maxFalseGlobalPromotions
    && metrics.negativeFalsePositives <= QUALITY_GATES.maxNegativeFalsePositives
    && metrics.negativeQueryFailures.length === 0
    && metrics.criticalFailures.length <= QUALITY_GATES.maxCriticalFailures
    && metrics.forbiddenSemanticRowFailures.length === 0
    && metrics.forbiddenRenderedOutputFailures.length === 0;
  return { passed, gates: QUALITY_GATES, metrics, cases };
}

export function renderQualityReport(result) {
  const { metrics } = result;
  return [
    `passed: ${result.passed}`,
    `scenarios: ${metrics.scenarioCount}`,
    `independent semantic scenarios: ${metrics.independentSemanticScenarioCount}`,
    `clients: ${Object.entries(metrics.clients).map(([client, count]) => `${client}=${count}`).join(", ")}`,
    `extraction precision: ${(metrics.extractionPrecision * 100).toFixed(2)}%`,
    `explicit proposition recall: ${(metrics.explicitPropositionRecall * 100).toFixed(2)}%`,
    `retention recall: ${(metrics.retentionRecall * 100).toFixed(2)}%`,
    `false global promotions: ${metrics.falseGlobalPromotions}`,
    `negative false positives: ${metrics.negativeFalsePositives}`,
    `critical failures: ${metrics.criticalFailures.length}${metrics.criticalFailures.length ? ` (${metrics.criticalFailures.join(", ")})` : ""}`,
    `negative query failures: ${metrics.negativeQueryFailures.length}`,
    `forbidden semantic row failures: ${metrics.forbiddenSemanticRowFailures.length}`,
    `forbidden rendered output failures: ${metrics.forbiddenRenderedOutputFailures.length}`,
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
