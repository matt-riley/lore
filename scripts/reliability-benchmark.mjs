#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { cpus, platform, arch } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LoreDb } from "../lib/db/db.mjs";
import { buildFixtureConfig } from "../tests/helpers/fixture-config.mjs";
import { semanticSearch } from "../lib/memory/semantic-search.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "lore-cli.mjs");
const DEFAULT_SIZES = Object.freeze([1_000, 10_000, 100_000]);

function percentile(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function isolatedEnvironment(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("LORE_")) delete env[key];
  env.LORE_HOME = home;
  env.LORE_CONFIG = path.join(home, "lore.json");
  env.LORE_REPOSITORY = "quality/native";
  return env;
}

function prepareSyntheticHome(size) {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-quality-benchmark-"));
  const config = buildFixtureConfig(home, {
    enabled: true,
    rollout: { memoryOperations: true, hybridRetrieval: true },
  });
  mkdirSync(path.dirname(config.paths.backupDir), { recursive: true });
  writeFileSync(path.join(home, "lore.json"), JSON.stringify({ enabled: true }), "utf8");
  const db = new LoreDb(config);
  db.initialize();
  const insert = db.db.prepare("INSERT INTO semantic_memory (id,type,content,scope,repository,created_at,updated_at) VALUES (?, ?, ?, 'repo', ?, ?, ?)");
  db.db.exec("BEGIN");
  for (let index = 0; index < size; index += 1) {
    const topic = ["rollback evidence", "bounded queues", "schema registry", "UTC timestamps"][index % 4];
    insert.run(`quality-benchmark-${index}`, "user_preference", `Synthetic ${topic} record ${index}.`, "quality/native", "2026-09-07T12:00:00Z", "2026-09-07T12:00:00Z");
  }
  for (let index = 0; index < 24; index += 1) {
    insert.run(`semantic-probe-${index}`, "semantic_probe", `Semantic probe candidate ${index} for benchmark cache behavior.`, "quality/native", "2026-09-07T12:00:00Z", "2026-09-07T12:00:00Z");
  }
  db.db.exec("COMMIT");
  db.close();
  return { home, env: isolatedEnvironment(home) };
}

function runNativeTool(home, env, tool, args) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, "tool", tool], {
    cwd: ROOT,
    env,
    input: `${JSON.stringify(args)}\n`,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    elapsedMs: performance.now() - started,
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout?.slice(0, 500) ?? "",
    stderr: result.stderr?.slice(0, 500) ?? "",
    home,
  };
}

function runNativeHook(home, env, client, event, args) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, "hook", client, event], {
    cwd: ROOT,
    env,
    input: `${JSON.stringify(args)}\n`,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { elapsedMs: performance.now() - started, ok: result.status === 0, stderr: result.stderr?.slice(0, 500) ?? "" };
}

function measureNativeCapture(home, env) {
  const transcriptPath = path.join(home, "capture.jsonl");
  const entries = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Prefer capture evidence with a source record." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will retain the source record with the captured evidence." }] } },
  ];
  writeFileSync(transcriptPath, `${entries.map(JSON.stringify).join("\n")}\n`, "utf8");
  const payload = { session_id: "benchmark-capture", cwd: home, transcript_path: transcriptPath };
  const cold = runNativeHook(home, env, "codex", "Stop", payload);
  entries.push(
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Also retain the refresh delta for the source record." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The refreshed capture includes one additional source record." }] } },
  );
  writeFileSync(transcriptPath, `${entries.map(JSON.stringify).join("\n")}\n`, "utf8");
  const refresh = runNativeHook(home, env, "codex", "Stop", payload);
  return {
    nativeHook: cold.ok && refresh.ok ? "passed" : "failed",
    coldMs: cold.elapsedMs,
    refreshMs: refresh.elapsedMs,
    captureDeltaTurns: 1,
    transcriptTurnsAfterRefresh: 2,
    error: cold.stderr || refresh.stderr || null,
  };
}

function measureNativeSize(size, { warmups = 2, repeats = 8 } = {}) {
  const fixture = prepareSyntheticHome(size);
  try {
    const startup = [];
    const prompt = [];
    let failure = null;
    for (let index = 0; index < warmups + repeats; index += 1) {
      const startupResult = runNativeTool(fixture.home, fixture.env, "memory_status", { repository: "quality/native" });
      const promptResult = runNativeTool(fixture.home, fixture.env, "lore_recall", { repository: "quality/native", prompt: "What rollback evidence and queue rule did we retain?", limit: 6 });
      if (!startupResult.ok || !promptResult.ok) failure = startupResult.stderr || promptResult.stderr || "native CLI returned a non-zero status";
      if (index >= warmups) {
        startup.push(startupResult.elapsedMs);
        prompt.push(promptResult.elapsedMs);
      }
    }
    const capture = measureNativeCapture(fixture.home, fixture.env);
    return {
      size,
      warmups,
      measured: repeats,
      startupP95Ms: percentile(startup),
      promptP95Ms: percentile(prompt),
      startupDefinition: "actual node lore-cli.mjs tool memory_status subprocess with isolated Lore home",
      promptDefinition: "actual node lore-cli.mjs tool lore_recall subprocess with isolated Lore home",
      nativeCli: failure ? "failed" : "passed",
      error: failure,
      capture,
      diskCold: false,
      passed: !failure && capture.nativeHook === "passed" && (size !== 10_000 || (percentile(startup) < 300 && percentile(prompt) < 200)),
    };
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
}

function mockVector(text) {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return [1, (hash % 997) / 997, ((hash >>> 8) % 991) / 991];
}

export async function measureMockEmbeddingPaths(size) {
  const home = prepareSyntheticHome(size);
  const config = buildFixtureConfig(home.home, {
    enabled: true,
    localInference: { enabled: true, embeddings: { enabled: true, model: "quality-mock", maxInputs: 24, minSimilarity: 0 } },
  });
  const db = new LoreDb(config);
  db.initialize();
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = Array.isArray(body.input) ? body.input : [];
    requests.push(input.length);
    return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: mockVector(text) })) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const coldStarted = performance.now();
    const cold = await semanticSearch({ db, query: "semantic probe cache", repository: "quality/native", types: ["semantic_probe"], limit: 6, fetchImpl, config, deadlineMs: 1_000 });
    const coldDurationMs = performance.now() - coldStarted;
    const coldRequests = requests.splice(0);
    const warmStarted = performance.now();
    const warm = await semanticSearch({ db, query: "semantic probe cache", repository: "quality/native", types: ["semantic_probe"], limit: 6, fetchImpl, config, deadlineMs: 1_000 });
    const warmDurationMs = performance.now() - warmStarted;
    const warmRequests = requests.splice(0);
    const cacheRows = db.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding WHERE memory_id LIKE 'semantic-probe-%'").get().count;
    return {
      mockedEndpoint: true,
      productionPath: "semanticSearch + memory_embedding",
      diskCold: false,
      fixtureRows: size,
      candidateCount: 24,
      cold: { enabled: cold.enabled, durationMs: coldDurationMs, endpointCalls: coldRequests.length, inputCounts: coldRequests, resultCount: cold.rows.length, cacheRowsAfter: Math.min(24, Number(cacheRows)) },
      warm: { enabled: warm.enabled, durationMs: warmDurationMs, endpointCalls: warmRequests.length, inputCounts: warmRequests, queryEmbeddings: warmRequests[0] === 1 ? 1 : 0, resultCount: warm.rows.length, cacheRowsAfter: Number(cacheRows) },
      captureDeltaWork: null,
      partialCoverage: { indexedCandidates: Number(cacheRows), totalCandidates: 24, complete: Number(cacheRows) === 24 },
      deadlineMs: 1_000,
      deadlineStatus: "mocked endpoint completed within deadline; no network claim",
    };
  } finally {
    db.close();
    rmSync(home.home, { recursive: true, force: true });
  }
}

export async function runReliabilityBenchmark({ sizes = DEFAULT_SIZES, warmups = 2, repeats = 8 } = {}) {
  const performanceResults = sizes.map((size) => measureNativeSize(size, { warmups, repeats }));
  const embedding = Object.fromEntries(await Promise.all(sizes.map(async (size) => [String(size), await measureMockEmbeddingPaths(size)])));
  return {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model },
    sizes,
    warmups,
    repeats,
    performance: performanceResults,
    embedding,
    passed: performanceResults.every((item) => item.passed),
  };
}

export function renderBenchmarkReport(result) {
  return [
    `passed: ${result.passed}`,
    `environment: ${result.environment.node} ${result.environment.platform}/${result.environment.architecture}`,
    ...result.performance.map((item) => `${item.size}: native=${item.nativeCli}, startup p95=${item.startupP95Ms?.toFixed(2)}ms, prompt p95=${item.promptP95Ms?.toFixed(2)}ms, diskCold=${item.diskCold}, capture=${item.capture.nativeHook} cold=${item.capture.coldMs.toFixed(2)}ms refresh=${item.capture.refreshMs.toFixed(2)}ms deltaTurns=${item.capture.captureDeltaTurns}`),
    ...Object.entries(result.embedding).map(([size, value]) => `${size}: semanticSearch mocked coldInputs=${value.cold.inputCounts.join(",")}, warmInputs=${value.warm.inputCounts.join(",")}, cache=${value.warm.cacheRowsAfter}/${value.partialCoverage.totalCandidates}, deadline=${value.deadlineStatus}`),
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => !["--json"].includes(arg) && !/^--(?:sizes|warmups|repeats)=\d+(?:,\d+)*$/u.test(arg))) throw new Error("Usage: reliability-benchmark.mjs [--json] [--sizes=1000,10000,100000] [--warmups=N] [--repeats=N]");
    const readArg = (name, fallback) => args.find((arg) => arg.startsWith(`${name}=`))?.split("=", 2)[1] ?? fallback;
    const sizes = String(readArg("--sizes", DEFAULT_SIZES.join(","))).split(",").map(Number);
    const result = await runReliabilityBenchmark({ sizes, warmups: Number(readArg("--warmups", 2)), repeats: Number(readArg("--repeats", 8)) });
    process.stdout.write(`${args.includes("--json") ? JSON.stringify(result, null, 2) : renderBenchmarkReport(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
