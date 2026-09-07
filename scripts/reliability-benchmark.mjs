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
  const insert = db.db.prepare("INSERT INTO semantic_memory (id,type,content,scope,repository,created_at,updated_at) VALUES (?, 'user_preference', ?, 'repo', ?, ?, ?)");
  db.db.exec("BEGIN");
  for (let index = 0; index < size; index += 1) {
    const topic = ["rollback evidence", "bounded queues", "schema registry", "UTC timestamps"][index % 4];
    insert.run(`quality-benchmark-${index}`, `Synthetic ${topic} record ${index}.`, "quality/native", "2026-09-07T12:00:00Z", "2026-09-07T12:00:00Z");
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
      diskCold: false,
      passed: !failure && (size !== 10_000 || (percentile(startup) < 300 && percentile(prompt) < 200)),
    };
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
}

function hashEmbedding(text) {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return [hash >>> 0, (hash * 31) >>> 0, (hash * 131) >>> 0];
}

function measureEmbeddingPath(records, cache) {
  let calls = 0;
  let cacheHits = 0;
  const started = performance.now();
  for (const record of records) {
    if (cache.has(record.key)) {
      cacheHits += 1;
      continue;
    }
    calls += 1;
    cache.set(record.key, hashEmbedding(record.content));
  }
  return { durationMs: performance.now() - started, calls, cacheHits, covered: records.length };
}

export function measureMockEmbeddingPaths(size) {
  const records = Array.from({ length: Math.min(size, 2_000) }, (_, index) => ({ key: `embedding-${index}`, content: `Synthetic embedding record ${index} for quality/native.` }));
  const cold = measureEmbeddingPath(records, new Map());
  const warmCache = new Map();
  measureEmbeddingPath(records, warmCache);
  const warm = measureEmbeddingPath(records, warmCache);
  return {
    mocked: true,
    diskCold: false,
    inputRecords: records.length,
    cold,
    warm,
    captureDeltaWork: cold.calls - warm.calls,
    deadlineMs: null,
    deadlineStatus: "reported separately; no network/model deadline asserted for mocked paths",
  };
}

export async function runReliabilityBenchmark({ sizes = DEFAULT_SIZES, warmups = 2, repeats = 8 } = {}) {
  const performanceResults = sizes.map((size) => measureNativeSize(size, { warmups, repeats }));
  const embedding = Object.fromEntries(sizes.map((size) => [String(size), measureMockEmbeddingPaths(size)]));
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
    ...result.performance.map((item) => `${item.size}: native=${item.nativeCli}, startup p95=${item.startupP95Ms?.toFixed(2)}ms, prompt p95=${item.promptP95Ms?.toFixed(2)}ms, diskCold=${item.diskCold}`),
    ...Object.entries(result.embedding).map(([size, value]) => `${size}: embedding mocked coldCalls=${value.cold.calls}, warmCalls=${value.warm.calls}, captureDeltaWork=${value.captureDeltaWork}, deadline=${value.deadlineStatus}`),
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
