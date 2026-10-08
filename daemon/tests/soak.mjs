// Bounded soak harness: repeated retain/recall/forget across daemon restarts
// with latency and RSS sampling. Produces a JSON report; nonzero exit on any
// recall miss or protocol error.
//
// Usage: LORED_BIN=... node tests/soak.mjs [--seconds 60] [--out report.json]

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { startDaemon } from "./harness.mjs";
import { request } from "../clients/js/status-client.mjs";

function parseArgs(argv) {
  const options = { seconds: Number(process.env.SOAK_SECONDS ?? 60), out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--seconds") options.seconds = Number(argv[++index]);
    else if (argv[index] === "--out") options.out = argv[++index];
  }
  return options;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function latencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
  };
}

function rssKb(pid) {
  try {
    const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    const value = Number.parseInt(output.trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function call(socket, route, params, storeId) {
  const outcome = await request(socket, route, params, {
    clientId: "test.soak",
    expectedStoreId: storeId,
    timeoutMs: 10_000,
  });
  const body = JSON.parse(outcome.body);
  if (outcome.statusCode !== 200 || body.ok !== true) {
    throw new Error(`${route}: ${body?.error?.reason ?? outcome.statusCode}`);
  }
  return body.result;
}

async function waitForDaemon(socket) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const outcome = await request(socket, "/v2/status", {}, { clientId: "test.soak.wait", timeoutMs: 1_000 });
      const body = JSON.parse(outcome.body);
      if (outcome.statusCode === 200 && body.ok === true) return body.storeId;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("soak daemon never became ready");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(path.join(tmpdir(), "lore-soak-"));
  let daemon = startDaemon({ dir });
  let storeId = await waitForDaemon(daemon.socket);
  const started = Date.now();
  const deadline = started + options.seconds * 1000;

  const latencies = { retain: [], recall: [], forget: [], status: [] };
  const failures = [];
  let iterations = 0;
  let restarts = 0;
  let recallMisses = 0;
  const recallMissDetails = [];
  let peakRssKb = 0;
  let rssSamples = 0;
  let rssTotal = 0;
  let active = 0;
  let nextRestart = started + Math.max(5_000, Math.floor((options.seconds * 1000) / 3));

  const sampleRss = () => {
    const value = rssKb(daemon.child.pid);
    if (value !== null) {
      peakRssKb = Math.max(peakRssKb, value);
      rssTotal += value;
      rssSamples += 1;
    }
  };

  try {
    while (Date.now() < deadline) {
      iterations += 1;
      // The marker's discriminator must be a real FTS token: single-character
      // terms are below the retrieval prefix length and are dropped, which
      // makes every marker match every other one.
      const marker = `soak marker i${String(iterations).padStart(4, "0")}`;
      const key = `soak-${iterations}`;
      try {
        const retainStarted = performance.now();
        const retained = await call(daemon.socket, "/v2/retain", {
          idempotencyKey: key,
          type: "note",
          content: marker,
          scope: "global",
        }, storeId);
        latencies.retain.push(performance.now() - retainStarted);

        const recallStarted = performance.now();
        const recalled = await call(daemon.socket, "/v2/recall", {
          query: marker,
          limit: 5,
        }, storeId);
        latencies.recall.push(performance.now() - recallStarted);
        if (!String(recalled.context ?? "").includes(marker)) {
          recallMisses += 1;
          if (recallMissDetails.length < 5) {
            recallMissDetails.push({
              iteration: iterations,
              marker,
              represented: (recalled.representedIds ?? []).length,
              contextHead: String(recalled.context ?? "").slice(0, 200),
            });
          }
        }

        if (iterations % 3 === 0) {
          const forgetStarted = performance.now();
          await call(daemon.socket, "/v2/forget", {
            idempotencyKey: `${key}-forget`,
            memoryId: retained.memoryId,
            reason: "soak",
          }, storeId);
          latencies.forget.push(performance.now() - forgetStarted);
        }
        if (iterations % 10 === 0) {
          const statusStarted = performance.now();
          const status = await call(daemon.socket, "/v2/status", {}, storeId);
          latencies.status.push(performance.now() - statusStarted);
          active = Number(status.counts?.activeMemories ?? active);
        }
        sampleRss();
      } catch (error) {
        failures.push({ iteration: iterations, error: String(error.message ?? error) });
        if (failures.length > 200) break;
      }

      if (Date.now() >= nextRestart && Date.now() < deadline) {
        await daemon.stop();
        daemon = startDaemon({ dir });
        storeId = await waitForDaemon(daemon.socket);
        restarts += 1;
        sampleRss();
        nextRestart += Math.max(5_000, Math.floor((options.seconds * 1000) / 3));
      }
    }
  } finally {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }

  const report = {
    checkedAt: new Date().toISOString(),
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    iterations,
    restarts,
    operations: {
      retain: latencies.retain.length,
      recall: latencies.recall.length,
      forget: latencies.forget.length,
      status: latencies.status.length,
    },
    latencyMs: {
      retain: latencySummary(latencies.retain),
      recall: latencySummary(latencies.recall),
      forget: latencySummary(latencies.forget),
      status: latencySummary(latencies.status),
    },
    rssMb: {
      peak: Number((peakRssKb / 1024).toFixed(1)),
      average: rssSamples ? Number((rssTotal / rssSamples / 1024).toFixed(1)) : null,
      samples: rssSamples,
    },
    activeMemories: active,
    failures,
    recallMisses,
    recallMissDetails,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, text);
  process.stdout.write(text);
  if (failures.length > 0 || recallMisses > 0) process.exitCode = 1;
}

await main();
