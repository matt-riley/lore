// Shared harness for stage-2 JS proofs: daemon lifecycle, synthetic corpus
// generation, an isolated-destination guard and corpus loading.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseOk, requestStatus, retain } from "../clients/js/status-client.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loredBinary() {
  const binary = process.env.LORED_BIN;
  assert.ok(binary, "LORED_BIN must point at a built lored binary");
  return binary;
}

export function startDaemon({ enabled = true, limits = null, embedding = null, sources = null, dir: providedDir = null } = {}) {
  const dir = providedDir ?? mkdtempSync(path.join(tmpdir(), "lore-v2-"));
  const socket = path.join(dir, "lored.sock");
  const configPath = path.join(dir, "lore.json");
  const config = { configVersion: 2, enabled, dataDir: dir, socketPath: socket };
  if (limits) config.limits = limits;
  if (sources) config.sources = sources;
  if (embedding) {
    config.providers = {
      embeddings: {
        enabled: true,
        endpoint: embedding.endpoint,
        model: embedding.model,
        dimensions: embedding.dimensions,
        generation: embedding.generation ?? 1,
        timeoutMs: embedding.timeoutMs ?? 10_000,
        minSimilarity: embedding.minSimilarity ?? 0.35,
      },
    };
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const child = spawn(loredBinary(), ["--config", configPath], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  return {
    dir,
    socket,
    configPath,
    child,
    databasePath: path.join(dir, "lore-v2.db"),
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitForLiveStatus(socket, attempts = 1_000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const outcome = await requestStatus(socket);
      if (outcome.statusCode === 200) {
        return JSON.parse(outcome.body);
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("daemon did not become ready");
}

/** Refuse to load synthetic data anywhere but an explicitly isolated place. */
export function assertIsolatedDestination(socketPath, { allow = false } = {}) {
  for (const pattern of [/\.copilot/, /\.pi(\/|$)/, /lore\.db/, /\.config\/lore/]) {
    assert.ok(!pattern.test(socketPath), `refusing dangerous destination: ${socketPath}`);
  }
  const resolved = realpathSync(path.dirname(socketPath));
  const tempRoot = realpathSync(tmpdir());
  assert.ok(
    allow || resolved.startsWith(tempRoot),
    `synthetic loading is limited to temporary directories (got ${socketPath})`,
  );
}

export async function loadCorpus(
  socketPath,
  corpus,
  { clientId = "fixture-loader", expectedStoreId, onProgress } = {},
) {
  const ids = [];
  for (const [index, memory] of corpus.memories.entries()) {
    const params = {
      idempotencyKey: `synthetic-${corpus.seed ?? 0}-${index}`,
      type: memory.type ?? "note",
      content: memory.content,
      scope: memory.scope ?? "global",
    };
    if (memory.repository) params.repository = memory.repository;
    if (memory.tags) params.tags = memory.tags;
    const outcome = await retain(socketPath, params, {
      clientId,
      expectedStoreId,
      timeoutMs: 10_000,
    });
    ids.push(parseOk(outcome).result.memoryId);
    if (onProgress && (index + 1) % 500 === 0) onProgress(index + 1);
  }
  return ids;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function localEmbeddingConfig() {
  return {
    endpoint: process.env.LORE_TEST_EMBEDDING_ENDPOINT ?? "http://127.0.0.1:12434/v1",
    model: process.env.LORE_TEST_EMBEDDING_MODEL ?? "docker.io/ai/embeddinggemma:latest",
    dimensions: Number(process.env.LORE_TEST_EMBEDDING_DIMENSIONS ?? 768),
    minSimilarity: Number(process.env.LORE_TEST_MIN_SIMILARITY ?? 0.35),
  };
}

/** Wait until every eligible memory has a current vector. */
export async function waitForCoverage(socket, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const outcome = await requestStatus(socket);
    if (outcome.statusCode === 200) {
      last = JSON.parse(outcome.body);
      const embedding = last.result.embedding;
      if (
        embedding.coverageCurrent === embedding.coverageEligible &&
        embedding.pending === "0" &&
        embedding.state !== "invalid"
      ) {
        return last;
      }
      if (embedding.state === "invalid") {
        throw new Error(`provider became invalid: ${JSON.stringify(embedding)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`coverage did not complete: ${JSON.stringify(last?.result?.embedding)}`);
}

const TOPICS = [
  "authentication middleware",
  "database migrations",
  "socket transport",
  "retrieval ranking",
  "scope policy",
  "idempotency receipts",
  "write-ahead logging",
  "crash recovery",
  "deadline cancellation",
  "repository identity",
  "prompt budgeting",
  "context rendering",
  "memory tombstones",
  "expiry eligibility",
  "transferable consent",
  "candidate pools",
  "fts tokenization",
  "unicode content",
  "connection overload",
  "embedding intents",
  "checkpoint pressure",
  "backup snapshots",
  "schema migrations",
  "release evidence",
  "source checkpoints",
  "extraction grammar",
  "response bytes",
  "client fairness",
  "store locks",
  "endpoint ownership",
  "socket permissions",
  "unsafe integers",
  "body limits",
  "nested payloads",
  "host validation",
  "content types",
  "deadline clamps",
  "read your writes",
  "quota rejection",
  "rollback safety",
  "tombstone fingerprints",
  "manual authority",
  "deterministic ties",
  "candidate truncation",
  "version mismatch",
  "store mismatch",
  "configuration validation",
  "maintenance state",
  "domain overlays",
  "workstream scopes",
];

/** Deterministic synthetic corpus used by both benchmarks. */
export function generateSyntheticCorpus(count) {
  const memories = [];
  for (let index = 0; index < count; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    const variant = Math.floor(index / TOPICS.length);
    memories.push({
      type: "note",
      content: `Synthetic memory ${index} covers ${topic} variant ${variant} with bounded retrieval detail.`,
      scope: "global",
    });
  }
  const queries = [];
  for (let index = 0; index < 200; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    queries.push(`${topic} variant ${index % 200}`);
  }
  return { memories, queries };
}
