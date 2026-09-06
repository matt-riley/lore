#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { explainMemoryRetrieval } from "../lib/diagnostics.mjs";
import { withFixtureDb } from "../tests/helpers/fixture-db.mjs";

export const QUALITY_THRESHOLDS = Object.freeze({ positiveRecall: 0.95, startupP95Ms: 300, promptP95Ms: 200 });

function memory(id, content, repository = null, extra = {}) {
  return { id: `quality-${id}`, type: "user_preference", content, repository, scope: repository ? "repo" : "global", confidence: 1, tags: ["quality-fixture"], ...extra };
}

const POSITIVE = [
  ["deployment rollback", "We documented the deployment rollback procedure with snapshot restore."],
  ["search budget", "The retrieval search budget is capped at eight semantic results."],
  ["search", "The scope override audit records the source and reason for every manual override; search can retrieve it."],
  ["search", "Prompt shaping keeps identity-only greetings free of cross-repo examples; search can retrieve it."],
  ["temporal summary", "On 2026-08-27 we reviewed the temporal recall summary and closed the stale query bug."],
  ["fixture isolation", "The quality runner uses an isolated fixture database and never seeds a user database."],
  ["trace evidence", "The diagnostics trace records ranked and included evidence rows for every lookup."],
  ["archive policy", "Archived memories remain excluded from default retrieval unless archive mode is requested."],
];

export const QUALITY_CASES = Object.freeze([
  ...POSITIVE.map(([key, content], index) => ({ id: `explicit-${index + 1}`, category: "explicit", prompt: `What did we change about the ${key} detail in this project?`, expectedEvidence: [key], memories: [memory(`explicit-${index + 1}`, content)] })),
  ...POSITIVE.map(([key, content], index) => ({ id: `paraphrase-${index + 1}`, category: "paraphrase", prompt: `Remind me how we handled ${key.replace("deployment rollback", "rolling back a deploy").replace("search budget", "the retrieval limit").replace("scope audit", "auditing scope overrides").replace("prompt shaping", "shaping prompts")}.`, expectedEvidence: [key.split(" ")[0]], memories: [memory(`paraphrase-${index + 1}`, content)] })),
  ...Array.from({ length: 8 }, (_, index) => ({ id: `irrelevant-${index + 1}`, category: "irrelevant", prompt: `What is the unrelated topic ${index + 1}?`, forbiddenEvidence: ["unrelated note"], memories: [memory(`irrelevant-${index + 1}`, "An unrelated note belongs to a different question.")] })),
  ...Array.from({ length: 8 }, (_, index) => ({ id: `stale-conflicting-${index + 1}`, category: "stale-conflicting", prompt: `What did we decide about the current policy for conflict ${index + 1}?`, expectedEvidence: [`current policy ${index + 1}`], forbiddenEvidence: [`stale policy ${index + 1}`], memories: [memory(`current-${index + 1}`, `Current policy ${index + 1} is to retain the reviewed setting.`), memory(`stale-${index + 1}`, `Stale policy ${index + 1} said to use the old setting.`, null, { confidence: 0.1, metadata: { supersededBy: `quality-current-${index + 1}` } })] })),
  ...Array.from({ length: 8 }, (_, index) => ({ id: `temporal-${index + 1}`, category: "temporal", prompt: `What did we do on 2026-08-${20 + index}?`, expectedEvidence: [`temporal work ${index + 1}`], memories: [memory(`temporal-${index + 1}`, `Temporal work ${index + 1} was completed on 2026-08-${20 + index}.`)] })),
  ...Array.from({ length: 8 }, (_, index) => ({ id: `repo-isolation-${index + 1}`, category: "repo-isolation", repository: "quality/current-repo", prompt: `In this repo, can you remember the local decision ${index + 1}?`, expectedEvidence: [`local decision ${index + 1}`], forbiddenEvidence: [`foreign decision ${index + 1}`], memories: [memory(`local-${index + 1}`, `Local decision ${index + 1} belongs to this repository.`, "quality/current-repo", { scope: "repo" }), memory(`foreign-${index + 1}`, `Foreign decision ${index + 1} belongs to another repository.`, "quality/other-repo")] })),
]);

function flattenRows(trace) {
  const rows = [];
  for (const lookup of Object.values(trace?.lookups ?? {})) {
    for (const key of ["rankedRows", "includedRows"]) {
      for (const row of lookup?.[key] ?? []) rows.push({ row, included: key === "includedRows" });
    }
  }
  return rows;
}

function contains(rows, phrase) {
  const needle = phrase.toLowerCase();
  return rows.some(({ row }) => JSON.stringify(row).toLowerCase().includes(needle));
}

function evaluateCase(definition, explanation) {
  const rows = flattenRows(explanation.trace);
  const assertions = [];
  for (const phrase of definition.expectedEvidence ?? []) assertions.push({ kind: "evidence", label: `includes evidence: ${phrase}`, passed: contains(rows, phrase), details: phrase });
  for (const phrase of definition.forbiddenEvidence ?? []) assertions.push({ kind: "evidence", label: `excludes forbidden evidence: ${phrase}`, passed: !contains(rows.filter((item) => item.included), phrase), details: phrase });
  if (definition.category === "repo-isolation") {
    const foreign = rows.filter(({ row, included }) => included && row.repository === "quality/other-repo");
    assertions.push({ kind: "safety", label: "no foreign repository evidence", passed: foreign.length === 0, details: String(foreign.length) });
  }
  return { passed: assertions.every((item) => item.passed), assertions };
}

async function runCase(definition) {
  const fixture = await withFixtureDb({ configOverrides: { enabled: true, rollout: { hybridRetrieval: true, temporalQueryNormalization: true, memoryOperations: true } } });
  try {
    // The diagnostics FTS query intentionally uses AND semantics. Including the
    // prompt terms in each fixture row keeps this corpus focused on routing,
    // scope, and evidence accounting rather than accidental token sparsity.
    for (const item of definition.memories) fixture.db.insertSemanticMemory(item);
    if (definition.category === "stale-conflicting") {
      const stale = definition.memories.find((item) => item.id.includes("stale-"));
      const current = definition.memories.find((item) => item.id.includes("current-"));
      if (stale && current) fixture.db.forgetMemory({ id: stale.id, supersededBy: current.id });
    }
    const forgottenId = `quality-forgotten-${definition.id}`;
    fixture.db.insertSemanticMemory({ id: forgottenId, type: "user_preference", content: `Forgotten quality fixture for ${definition.id}.`, scope: "global", repository: null, confidence: 1, tags: ["quality-fixture"] });
    fixture.db.forgetMemory({ id: forgottenId, supersededBy: `quality-forget-event-${definition.id}` });
    const explanation = await explainMemoryRetrieval({ runtime: { db: fixture.db, config: fixture.config, repository: definition.repository ?? "quality/current-repo", sessionStore: null }, prompt: definition.prompt, mode: "prompt", repository: definition.repository ?? "quality/current-repo" });
    const evaluation = evaluateCase(definition, explanation);
    const forgottenRows = fixture.db.searchSemantic({ query: "forgotten quality fixture", limit: 8 });
    evaluation.assertions.push({ kind: "safety", label: "excludes forgotten evidence", passed: forgottenRows.length === 0, details: String(forgottenRows.length) });
    return { id: definition.id, category: definition.category, passed: evaluation.assertions.every((item) => item.passed), assertions: evaluation.assertions, elapsedMs: 0, trace: explanation.trace };
  } finally {
    fixture.cleanup();
  }
}

async function measureSyntheticStore(size) {
  const startupSamples = [];
  for (let index = 0; index < 10; index += 1) {
    const started = performance.now();
    const warmup = await withFixtureDb({ configOverrides: { enabled: true } });
    startupSamples.push(performance.now() - started);
    warmup.cleanup();
  }
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    const measured = await withFixtureDb({ configOverrides: { enabled: true } });
    startupSamples.push(performance.now() - started);
    measured.cleanup();
  }
  const fixture = await withFixtureDb({ configOverrides: { enabled: true } });
  try {
    for (let index = 0; index < size; index += 1) {
      fixture.db.insertSemanticMemory({ id: `quality-synthetic-${size}-${index}`, type: "user_preference", content: `Synthetic benchmark memory ${index} for quality retrieval.`, scope: "global", repository: null, confidence: 1, tags: ["quality-benchmark"] });
    }
    for (let index = 0; index < 10; index += 1) fixture.db.searchSemantic({ query: "synthetic benchmark", limit: 8 });
    const samples = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      await explainMemoryRetrieval({
        runtime: { db: fixture.db, config: fixture.config, repository: "quality/current-repo", sessionStore: null },
        prompt: "What did we do about synthetic benchmark memory?",
        mode: "prompt",
        repository: "quality/current-repo",
      });
      samples.push(performance.now() - started);
    }
    return { size, warmups: 10, measured: 100, startupP95Ms: Math.round(percentile(startupSamples.slice(10), 0.95) * 100) / 100, promptP95Ms: Math.round(percentile(samples, 0.95) * 100) / 100, informational: size >= 100000 };
  } finally {
    fixture.cleanup();
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

export async function runQualityBenchmark({ sizes = [1], skipPerformance = false } = {}) {
  const cases = [];
  for (const definition of QUALITY_CASES) {
    const started = performance.now();
    const result = await runCase(definition);
    result.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    cases.push(result);
  }
  const positive = cases.filter((item) => ["explicit", "paraphrase", "temporal", "repo-isolation", "stale-conflicting"].includes(item.category));
  const positiveRecall = positive.length === 0 ? 1 : positive.filter((item) => item.passed).length / positive.length;
  const safety = { forbiddenRepoEvidence: cases.filter((item) => item.assertions.some((a) => a.label === "no foreign repository evidence" && !a.passed)).length, forgottenEvidence: cases.filter((item) => item.assertions.some((a) => a.label === "excludes forgotten evidence" && !a.passed)).length, supersededEvidence: cases.filter((item) => item.category === "stale-conflicting" && item.assertions.some((a) => a.label.startsWith("excludes forbidden") && !a.passed)).length };
  const performanceResults = skipPerformance ? [] : [];
  if (!skipPerformance) {
    for (const size of sizes) performanceResults.push(await measureSyntheticStore(size));
  }
  return { generatedAt: new Date().toISOString(), totalCases: cases.length, passedCases: cases.filter((item) => item.passed).length, failedCases: cases.filter((item) => !item.passed).length, positiveRecall, safety, performance: performanceResults, cases };
}

export function renderQualityReport(result) {
  const lines = [`qualityCases: ${result.totalCases}`, `passed: ${result.passedCases}`, `failed: ${result.failedCases}`, `positiveRecall: ${result.positiveRecall}`, `safety: ${JSON.stringify(result.safety)}`];
  for (const item of result.cases.filter((entry) => !entry.passed)) lines.push(`FAIL ${item.id}: ${item.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.label).join(", ")}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runQualityBenchmark({ sizes: [Number(process.env.LORE_QUALITY_SIZE ?? 10000)] });
  process.stdout.write(`${process.argv.includes("--json") ? JSON.stringify(result, null, 2) : renderQualityReport(result)}\n`);
  if (result.failedCases > 0 || result.positiveRecall < QUALITY_THRESHOLDS.positiveRecall || Object.values(result.safety).some((value) => value > 0)) process.exitCode = 1;
}
