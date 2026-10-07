#!/usr/bin/env node
// Semantic-path latency benchmark: healthy local provider, a sleeping
// provider that must fall back inside the 100 ms inference allowance, and an
// offline endpoint. Four concurrent clients, unique first-seen queries.
//
//   LORED_BIN=daemon/target/debug/lored node daemon/tests/benchmark-semantic.mjs --report /tmp/g3-latency.json

import { execFileSync } from "node:child_process";
import http from "node:http";
import { statSync, writeFileSync } from "node:fs";

import { parseOk, recall, retain } from "../clients/js/status-client.mjs";
import {
  loadCorpus,
  localEmbeddingConfig,
  startDaemon,
  waitForCoverage,
  waitForLiveStatus,
} from "./harness.mjs";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const QUERIES = Number(option("--queries", "40"));
const CONCURRENCY = Number(option("--concurrency", "4"));
const BACKLOG = Number(option("--backlog", "300"));
const REPORT = option("--report", null);

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: +percentile(sorted, 0.5).toFixed(2),
    p95Ms: +percentile(sorted, 0.95).toFixed(2),
    p99Ms: +percentile(sorted, 0.99).toFixed(2),
    maxMs: +sorted.at(-1).toFixed(2),
  };
}

/** Fake provider returning a fixed 768-dim vector after an optional delay. */
function startFakeProvider({ delayMs = 0 } = {}) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const embedding = new Array(768).fill(0);
      embedding[0] = 1;
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ index: 0, embedding }] }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        endpoint: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function runScenario(name, embedding, { backlog = 0 } = {}) {
  const daemon = startDaemon({ embedding });
  try {
    const status = await waitForLiveStatus(daemon.socket);
    const storeId = status.storeId;
    const memories = Array.from({ length: 40 }, (_, index) => ({
      type: "decision",
      content: `Scenario ${name} memory ${index} covers socket transport variant ${index}.`,
      scope: "global",
    }));
    const ids = await loadCorpus(
      daemon.socket,
      { seed: 1, memories },
      { expectedStoreId: storeId },
    );
    try {
      await waitForCoverage(daemon.socket, { timeoutMs: 60_000 });
    } catch {
      // Offline/sleeping providers never complete coverage; fallback is the
      // behaviour under test.
    }

    const latencies = [];
    const fallbackCounts = {};
    const queries = Array.from(
      { length: QUERIES },
      (_, index) => `unique scenario ${name} probe ${index} socket transport variant ${index % 40}`,
    );
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, worker) =>
        (async () => {
          for (let index = worker; index < queries.length; index += CONCURRENCY) {
            const start = process.hrtime.bigint();
            const value = parseOk(
              await recall(
                daemon.socket,
                { query: queries[index], limit: 6 },
                { clientId: `bench-${name}-${worker}`, expectedStoreId: storeId },
              ),
            );
            latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
            const reason = value.result.diagnostics.fallbackReason;
            fallbackCounts[reason] = (fallbackCounts[reason] ?? 0) + 1;
          }
        })(),
      ),
    );

    // Backlog and write contention: retain while recalling.
    let retainSamples = [];
    let backlogRecall = [];
    if (backlog > 0) {
      const backlogMemories = Array.from({ length: backlog }, (_, index) => ({
        type: "decision",
        content: `Backlog memory ${index} covers write-ahead logging variant ${index}.`,
        scope: "global",
      }));
      const writes = loadCorpus(
        daemon.socket,
        { seed: 2, memories: backlogMemories },
        { expectedStoreId: storeId },
      );
      for (let index = 0; index < 20; index += 1) {
        const start = process.hrtime.bigint();
        await recall(
          daemon.socket,
          { query: `backlog recall probe ${index} write-ahead logging`, limit: 6 },
          { clientId: "bench-backlog", expectedStoreId: storeId },
        );
        backlogRecall.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      await writes;
      for (let index = 0; index < 50; index += 1) {
        const start = process.hrtime.bigint();
        await retain(
          daemon.socket,
          {
            idempotencyKey: `bench-retain-${name}-${index}`,
            type: "decision",
            content: `Retain latency sample ${index} for ${name}.`,
            scope: "global",
          },
          { expectedStoreId: storeId },
        );
        retainSamples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
    }

    const databaseBytes = statSync(daemon.databasePath).size;
    let walBytes = 0;
    try {
      walBytes = statSync(`${daemon.databasePath}-wal`).size;
    } catch {
      walBytes = 0;
    }
    const rssBytes =
      Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(daemon.child.pid)], {
          encoding: "utf8",
        }).trim(),
      ) * 1024;
    return {
      scenario: name,
      endpoint: embedding.endpoint.replace(/:\d+\//, ":**/"),
      recallMs: summarize(latencies),
      fallbackCounts,
      backlogRecallMs: backlogRecall.length ? summarize(backlogRecall) : null,
      retainMs: retainSamples.length ? summarize(retainSamples) : null,
      databaseBytes,
      walBytes,
      rssBytes,
      memoriesLoaded: ids.length,
    };
  } finally {
    await daemon.stop();
    daemon.cleanup();
  }
}

async function main() {
  const local = localEmbeddingConfig();
  const sleeping = await startFakeProvider({ delayMs: 400 });
  try {
    const scenarios = [];
    scenarios.push(await runScenario("healthy", { ...local, minSimilarity: 0.45 }, { backlog: BACKLOG }));
    scenarios.push(
      await runScenario(
        "sleeping",
        {
          endpoint: sleeping.endpoint,
          model: "sleeping-model",
          dimensions: 768,
          minSimilarity: 0.45,
          timeoutMs: 5_000,
        },
        { backlog: BACKLOG },
      ),
    );
    scenarios.push(
      await runScenario(
        "offline",
        {
          endpoint: "http://127.0.0.1:1/v1",
          model: "offline-model",
          dimensions: 768,
          minSimilarity: 0.45,
          timeoutMs: 1_000,
        },
        { backlog: BACKLOG },
      ),
    );
    const report = {
      generatedAt: new Date().toISOString(),
      platform: { os: process.platform, arch: process.arch, node: process.version },
      queriesPerScenario: QUERIES,
      concurrency: CONCURRENCY,
      backlogPerScenario: BACKLOG,
      scenarios,
    };
    console.log(JSON.stringify(report, null, 2));
    if (REPORT) {
      writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    await sleeping.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
