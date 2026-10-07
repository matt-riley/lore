#!/usr/bin/env node
// Stage-2 lexical benchmark: release daemon, synthetic corpus, four
// concurrent clients. Writes a JSON report to stdout (and --report PATH).
//
//   LORED_BIN=daemon/target/release/lored node daemon/tests/benchmark-lexical.mjs

import { execFileSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";

import { parseOk, recall, request } from "../clients/js/status-client.mjs";
import {
  generateSyntheticCorpus,
  loadCorpus,
  startDaemon,
  waitForLiveStatus,
} from "./harness.mjs";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}
const COUNT = option("--count", 10_000);
const QUERY_COUNT = option("--queries", 200);
const CONCURRENCY = option("--concurrency", 4);
const RETAIN_SAMPLES = option("--retains", 100);

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: +sorted[0].toFixed(3),
    p50Ms: +percentile(sorted, 0.5).toFixed(3),
    p95Ms: +percentile(sorted, 0.95).toFixed(3),
    p99Ms: +percentile(sorted, 0.99).toFixed(3),
    maxMs: +sorted.at(-1).toFixed(3),
  };
}

function rssBytes(pid) {
  const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
  return Number(output) * 1024;
}

async function main() {
  const corpus = generateSyntheticCorpus(COUNT);
  const queries = corpus.queries.slice(0, QUERY_COUNT);
  const daemon = startDaemon();
  try {
    const status = await waitForLiveStatus(daemon.socket);

    const loadStart = process.hrtime.bigint();
    await loadCorpus(daemon.socket, corpus, {
      expectedStoreId: status.storeId,
      onProgress: (done) => process.stderr.write(`loaded ${done}/${COUNT}\r`),
    });
    const loadSeconds = Number(process.hrtime.bigint() - loadStart) / 1e9;
    process.stderr.write(`\nloaded ${COUNT} memories in ${loadSeconds.toFixed(1)}s\n`);

    const retainSamples = [];
    for (let index = 0; index < RETAIN_SAMPLES; index += 1) {
      const start = process.hrtime.bigint();
      parseOk(
        await request(
          daemon.socket,
          "/v2/retain",
          {
            idempotencyKey: `bench-retain-${index}`,
            type: "note",
            content: `benchmark retain sample ${index}`,
            scope: "global",
          },
          { clientId: "bench-retain", expectedStoreId: status.storeId },
        ),
      );
      retainSamples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }

    for (let index = 0; index < 20; index += 1) {
      await recall(
        daemon.socket,
        { query: queries[index % queries.length] },
        { clientId: `bench-warmup-${index % CONCURRENCY}`, expectedStoreId: status.storeId },
      );
    }

    const latencies = [];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, worker) =>
        (async () => {
          const clientId = `bench-client-${worker}`;
          for (let index = worker; index < queries.length; index += CONCURRENCY) {
            const start = process.hrtime.bigint();
            const outcome = await recall(
              daemon.socket,
              { query: queries[index] },
              { clientId, expectedStoreId: status.storeId },
            );
            if (outcome.statusCode !== 200) {
              throw new Error(`recall failed: ${outcome.body}`);
            }
            latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
          }
        })(),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const databaseBytes = statSync(daemon.databasePath).size;
    let walBytes = 0;
    try {
      walBytes = statSync(`${daemon.databasePath}-wal`).size;
    } catch {
      walBytes = 0;
    }

    const report = {
      stage: "g2",
      generatedAt: new Date().toISOString(),
      platform: { os: process.platform, arch: process.arch, node: process.version },
      corpus: { memories: COUNT, queries: queries.length, concurrency: CONCURRENCY },
      loadSeconds: +loadSeconds.toFixed(2),
      recallMs: summarize(latencies),
      retainMs: summarize(retainSamples),
      databaseBytes,
      walBytes,
      rssBytes: rssBytes(daemon.child.pid),
    };
    console.log(JSON.stringify(report, null, 2));
    const reportIndex = args.indexOf("--report");
    if (reportIndex >= 0 && args[reportIndex + 1]) {
      writeFileSync(args[reportIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    await daemon.stop();
    daemon.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
