#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { explainMemoryRetrieval } from "../lib/diagnostics.mjs";
import { withFixtureDb } from "../tests/helpers/fixture-db.mjs";

export const QUALITY_THRESHOLDS = Object.freeze({ positiveRecall: 0.95, startupP95Ms: 300, promptP95Ms: 200 });
const REPO = "quality/current";
const TOPICS = [
  ["Redis retries", "Redis retries use exponential backoff.", "What are our retries for Redis?"],
  ["deployment rollback", "Deployment rollback restores the previous immutable image.", "Remind me about deployment rollback."],
  ["invoice currency", "Invoice currency is GBP for domestic customers.", "What did we decide about invoice currency?"],
  ["cache eviction", "Cache eviction uses least recently used entries.", "Tell me about our cache eviction."],
  ["database backups", "Database backups run nightly and are encrypted.", "How are our database backups handled?"],
  ["upload timeout", "Upload timeout is thirty seconds.", "What upload timeout did we decide to use?"],
  ["branch naming", "Branch naming uses the issue identifier as a prefix.", "Can you remind me about branch naming?"],
  ["release checklist", "Release checklist requires a tested recovery rehearsal.", "What is our release checklist again?"],
];
const NEGATIVES = ["What is the capital of Finland?", "Explain photosynthesis.", "How many moons does Mars have?", "Translate hello into French.", "What causes a solar eclipse?", "How do penguins stay warm?", "Calculate seven times eight.", "Write a poem about the ocean."];
const DATE_PROMPTS = ["What did we do on 2026-08-20?", "What happened on August 21, 2026?", "Recall our work on 2026-08-22.", "What did we do on 2026-08-23?", "What happened on August 24, 2026?", "Recall our work on 2026-08-25.", "What did we do on 2026-08-26?", "What happened on August 27, 2026?"];
export const QUALITY_CASES = Object.freeze(TOPICS.flatMap(([topic, content, paraphrase], index) => [
  { id: `explicit-${index}`, category: "explicit", prompt: topic, topic, content },
  { id: `paraphrase-${index}`, category: "paraphrase", prompt: paraphrase, topic, content },
  { id: `irrelevant-${index}`, category: "irrelevant", prompt: NEGATIVES[index], topic, content },
  { id: `stale-${index}`, category: "stale-conflicting", prompt: topic, topic, content },
  { id: `temporal-${index}`, category: "temporal", prompt: DATE_PROMPTS[index], topic, content, date: `2026-08-${20 + index}` },
  { id: `scope-${index}`, category: "repo-isolation", prompt: topic, topic, content },
]));

function includedRows(explanation) {
  return Object.values(explanation.trace?.lookups ?? {}).flatMap(lookup => lookup?.includedRows ?? []);
}

// Exported so tests can prove ranked-only evidence and unrelated output fail.
export function evaluateQualityCase(definition, explanation, { expectedId, forbiddenIds = [], forbiddenContent = [] } = {}) {
  const rows = includedRows(explanation);
  const text = explanation.text ?? "";
  const assertions = [];
  if (definition.category !== "irrelevant") {
    assertions.push({ kind: "evidence", label: "expected evidence emitted", passed: text.includes(definition.content) && rows.some(row => row.id === expectedId || (definition.category === "temporal" && JSON.stringify(row).includes(definition.content))) });
  } else {
    assertions.push({ kind: "evidence", label: "no repository memory injected", passed: !rows.some(row => row.repository === REPO) && !text.includes(definition.content) });
  }
  assertions.push({ kind: "safety", label: "forbidden evidence excluded", passed: !rows.some(row => forbiddenIds.includes(row.id)) && !forbiddenContent.some(content => text.includes(content)) });
  assertions.push({ kind: "safety", label: "foreign repository excluded", passed: !rows.some(row => row.repository && row.repository !== REPO) });
  return { passed: assertions.every(item => item.passed), assertions };
}

async function runCase(definition) {
  const fixture = await withFixtureDb({ configOverrides: { enabled: true, now: new Date("2026-09-06T12:00:00Z"), rollout: { memoryOperations: true, temporalQueryNormalization: true } } });
  try {
    const save = (content, repository = REPO) => fixture.db.insertSemanticMemory({ type: "user_preference", content, repository, scope: "repo", confidence: 1, sourceSessionId: "quality-synthetic" });
    let expectedId;
    const forbiddenContent = [`${definition.topic} must follow the obsolete crimson setting.`, `${definition.topic} uses the foreign violet setting.`];
    const staleId = save(forbiddenContent[0]);
    const foreignId = save(forbiddenContent[1], "quality/other");
    if (definition.category === "temporal") {
      expectedId = `episode-${definition.id}`;
      fixture.db.upsertEpisodeDigest({ id: expectedId, sessionId: expectedId, repository: REPO, summary: definition.content, actions: [], decisions: [], learnings: [], filesChanged: [], refs: [], significance: 7, themes: [], openItems: [], dateKey: definition.date, createdAt: `${definition.date}T12:00:00Z` });
      fixture.db.refreshDaySummary({ date: definition.date, repository: REPO });
    } else expectedId = save(definition.content);
    fixture.db.forgetMemory({ id: staleId, supersededBy: definition.category === "stale-conflicting" ? expectedId : "manual-forget" });
    const explanation = await explainMemoryRetrieval({ runtime: { db: fixture.db, config: fixture.config, repository: REPO, sessionStore: null }, prompt: definition.prompt, mode: "prompt", repository: REPO });
    const result = evaluateQualityCase(definition, explanation, { expectedId, forbiddenIds: [staleId, foreignId], forbiddenContent });
    return { id: definition.id, category: definition.category, ...result, text: explanation.text, trace: explanation.trace };
  } finally { fixture.cleanup(); }
}

function percentile(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function measureSyntheticStore(size) {
  const fixture = await withFixtureDb({ configOverrides: { enabled: true } });
  try {
    // Fixture-only bulk insert includes the production FTS triggers. No user paths.
    const statement = fixture.db.db.prepare("INSERT INTO semantic_memory (id,type,content,scope,repository,created_at,updated_at) VALUES (?, 'user_preference', ?, 'repo', ?, ?, ?)");
    fixture.db.db.exec("BEGIN");
    for (let index = 0; index < size; index++) statement.run(`benchmark-${index}`, `${TOPICS[index % TOPICS.length][1]} Synthetic record ${index}.`, REPO, "2026-09-01T12:00:00Z", "2026-09-01T12:00:00Z");
    fixture.db.db.exec("COMMIT");
    const startup = [], prompt = [];
    for (let index = 0; index < 110; index++) {
      fixture.db.close();
      let started = performance.now();
      fixture.db.initialize();
      await explainMemoryRetrieval({ runtime: { db: fixture.db, config: fixture.config, repository: REPO, sessionStore: null }, prompt: "Redis retries", mode: "session_start", repository: REPO });
      if (index >= 10) startup.push(performance.now() - started);
      started = performance.now();
      await explainMemoryRetrieval({ runtime: { db: fixture.db, config: fixture.config, repository: REPO, sessionStore: null }, prompt: TOPICS[index % TOPICS.length][2], mode: "prompt", repository: REPO });
      if (index >= 10) prompt.push(performance.now() - started);
    }
    const startupP95Ms = percentile(startup), promptP95Ms = percentile(prompt);
    return { size, warmups: 10, measured: 100, startupP95Ms, promptP95Ms, startupDefinition: "reopen seeded DB and build session-start capsule; OS disk cache not flushed", informational: size !== 10000, passed: size !== 10000 || (startupP95Ms < 300 && promptP95Ms < 200) };
  } finally { fixture.cleanup(); }
}

export async function runQualityBenchmark({ sizes = [1000, 10000, 100000], skipPerformance = true, benchmarkOnly = false } = {}) {
  const cases = [];
  if (!benchmarkOnly) for (const definition of QUALITY_CASES) cases.push(await runCase(definition));
  const positive = cases.filter(item => item.category !== "irrelevant");
  const positiveRecall = positive.length ? positive.filter(item => item.assertions.find(a => a.label === "expected evidence emitted")?.passed).length / positive.length : null;
  const safetyFailures = cases.filter(item => item.assertions.some(a => (a.kind === "safety" || a.label === "no repository memory injected") && !a.passed));
  const timings = [];
  if (!skipPerformance) for (const size of sizes) timings.push(await measureSyntheticStore(size));
  return { generatedAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model }, totalCases: cases.length, passedCases: cases.filter(item => item.passed).length, failedCases: cases.filter(item => !item.passed).length, positiveRecall, safetyFailures: safetyFailures.map(item => item.id), performance: timings, cases, passed: (positiveRecall === null || positiveRecall >= 0.95) && safetyFailures.length === 0 && timings.every(item => item.passed) };
}

export function renderQualityReport(result) {
  return [`qualityCases: ${result.totalCases}`, `passed: ${result.passedCases}`, `failed: ${result.failedCases}`, `positiveRecall: ${result.positiveRecall ?? "not measured"}`, `safetyFailures: ${result.safetyFailures.length}`, ...result.cases.filter(item => !item.passed).map(item => `FAIL ${item.id}: ${item.assertions.filter(a => !a.passed).map(a => a.label).join(", ")}`), ...result.performance.map(item => `${item.size} memories: startup p95=${item.startupP95Ms.toFixed(2)}ms prompt p95=${item.promptP95Ms.toFixed(2)}ms ${item.informational ? "informational" : item.passed ? "PASS" : "FAIL"}`)].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !["--json", "--benchmark"].includes(arg))) throw new Error("Usage: diagnostics-quality.mjs [--json] [--benchmark]");
    const benchmarkOnly = args.includes("--benchmark");
    const result = await runQualityBenchmark({ skipPerformance: !benchmarkOnly, benchmarkOnly });
    console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : renderQualityReport(result));
    if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
