#!/usr/bin/env node
// Stage-4 load proof: transcript capture runs while four clients Recall and
// Retain, a source keeps growing, and the foreground gates still pass.
//
//   LORED_BIN=daemon/target/debug/lored node daemon/tests/ingestion-load.mjs

import { appendFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseOk, recall, request, retain } from "../clients/js/status-client.mjs";
import { startDaemon, waitForLiveStatus } from "./harness.mjs";

const CLIENTS = 4;
const RETAINS_PER_CLIENT = 40;
const RECALLS_PER_CLIENT = 60;
const SOURCE_LINES = 1_200;

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function line(index) {
  return `${JSON.stringify({
    type: "message",
    timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Load proof turn ${index}: capture commits evidence atomically.`,
    },
  })}\n`;
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "lore-v2-load-"));
  const sourcesDir = path.join(dir, "sessions");
  mkdirSync(sourcesDir);
  const session = path.join(sourcesDir, "load.jsonl");
  writeFileSync(
    session,
    `${JSON.stringify({ type: "session", id: "load-proof-1", cwd: "/work" })}\n`,
  );
  for (let index = 0; index < SOURCE_LINES; index += 1) appendFileSync(session, line(index));
  // A second source grows continuously while clients work and capture runs.
  const churn = path.join(sourcesDir, "churn.jsonl");
  writeFileSync(
    churn,
    `${JSON.stringify({ type: "session", id: "load-churn-1", cwd: "/work" })}\n`,
  );
  for (let index = 0; index < 50; index += 1) appendFileSync(churn, line(index));

  const running = startDaemon({
    dir,
    sources: {
      roots: [{ rootId: "load-root", client: "pi", path: sourcesDir }],
      sweepSeconds: 5,
    },
  });
  const live = await waitForLiveStatus(running.socket);
  const options = { clientId: "load", expectedStoreId: live.storeId };

  const recallLatencies = [];
  const retainLatencies = [];
  const start = process.hrtime.bigint();
  let appended = 0;

  let churnWritten = 0;
  const churner = (async () => {
    for (let index = 50; index < 350; index += 1) {
      appendFileSync(churn, line(index));
      churnWritten += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();

  await Promise.all(
    Array.from({ length: CLIENTS }, (_, client) =>
      (async () => {
        for (let index = 0; index < RETAINS_PER_CLIENT; index += 1) {
          const retainStart = process.hrtime.bigint();
          await retain(
            running.socket,
            {
              idempotencyKey: `load-retain-${client}-${index}`,
              type: "note",
              content: `Load proof memory ${client}-${index} about capture visibility.`,
              scope: "global",
            },
            { ...options, clientId: `load-${client}` },
          );
          retainLatencies.push(Number(process.hrtime.bigint() - retainStart) / 1e6);
        }
        for (let index = 0; index < RECALLS_PER_CLIENT; index += 1) {
          const recallStart = process.hrtime.bigint();
          parseOk(
            await recall(
              running.socket,
              { query: `capture evidence atomically turn ${index}`, limit: 6 },
              { ...options, clientId: `load-${client}` },
            ),
          );
          recallLatencies.push(Number(process.hrtime.bigint() - recallStart) / 1e6);
        }
      })(),
    ),
  );
  await churner;

  // A missed notification must still be caught by the reconciliation sweep:
  // append after the load and send no hints at all.
  for (let index = SOURCE_LINES; index < SOURCE_LINES + 300; index += 1) {
    appendFileSync(session, line(index));
    appended += 1;
  }
  const finalSize = statSync(session).size;

  // Wait for the polling sweep to reach the final extent.
  let finalStatus = null;
  const churnSize = statSync(churn).size;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const body = parseOk(
      await request(
        running.socket,
        "/v2/sources/status",
        { limit: 10 },
        options,
      ),
    );
    const source = body.result.sources.find((row) => row.nativeSessionId === "load-proof-1");
    const churning = body.result.sources.find((row) => row.nativeSessionId === "load-churn-1");
    const bothCaughtUp =
      source?.state === "caught_up" &&
      source.offset >= finalSize &&
      churning?.state === "caught_up" &&
      churning.offset >= churnSize;
    if (bothCaughtUp) {
      finalStatus = {
        source,
        churn: churning,
        counts: body.result.counts,
        pendingExtraction: body.result.pendingExtraction,
        observedAt: body.result.observedAt,
      };
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const report = {
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, arch: process.arch, node: process.version },
    clients: CLIENTS,
    recalls: recallLatencies.length,
    retains: retainLatencies.length,
    recallMs: {
      p50: +percentile(recallLatencies, 0.5).toFixed(2),
      p95: +percentile(recallLatencies, 0.95).toFixed(2),
      p99: +percentile(recallLatencies, 0.99).toFixed(2),
    },
    retainMs: {
      p50: +percentile(retainLatencies, 0.5).toFixed(2),
      p95: +percentile(retainLatencies, 0.95).toFixed(2),
      p99: +percentile(retainLatencies, 0.99).toFixed(2),
    },
    captured: finalStatus,
    appendedDuringLoad: appended,
    churnLinesWritten: churnWritten,
    elapsedMs: +elapsedMs.toFixed(0),
  };
  console.log(JSON.stringify(report, null, 2));
  await running.stop();

  const failures = [];
  if (!finalStatus) failures.push("capture did not catch up during load");
  if (report.recallMs.p95 > 160) failures.push(`recall p95 ${report.recallMs.p95}ms exceeds 160ms`);
  if (report.retainMs.p95 > 500) failures.push(`retain p95 ${report.retainMs.p95}ms exceeds 500ms`);
  if (finalStatus && finalStatus.source.skippedRecords !== 0) failures.push("capture skipped records");
  if (finalStatus && finalStatus.source.normalizedRecords < SOURCE_LINES + appended) {
    failures.push(`only ${finalStatus.source.normalizedRecords} normalized records`);
  }
  if (finalStatus && finalStatus.churn.normalizedRecords < 50 + churnWritten) {
    failures.push(`churn source captured only ${finalStatus.churn.normalizedRecords} records`);
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
