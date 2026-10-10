#!/usr/bin/env node
// Calibrate minSimilarity on the frozen calibration split only.
//
//   node daemon/tests/calibrate-threshold.mjs --report docs/v2/evidence/g3-calibration.json
//
// Selection rule (validation.md): among thresholds where the v2 semantic
// stream is at least as good as the equivalent v1 semantic stream on
// recall@6, MRR@6 and irrelevant-context rate — and the deleted canary never
// returns — take the highest recall@6; ties go to the stricter threshold.
// The chosen value is frozen before any held-out run.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const REPORT = option("--report", null);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const THRESHOLDS = (option("--thresholds", "0.4,0.45,0.5,0.55,0.6,0.65,0.7"))
  .split(",")
  .map(Number);

function run(mode, threshold) {
  const output = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "daemon/tests/semantic-quality.mjs"),
      "--mode",
      mode,
      "--split",
      "calibration",
      "--threshold",
      String(threshold),
    ],
    { encoding: "utf8", env: process.env },
  );
  return JSON.parse(output);
}

const rows = [];
for (const threshold of THRESHOLDS) {
  const v2 = run("v2", threshold);
  const v1 = run("v1-semantic", threshold);
  const passes =
    v2.canaryHits === 0 &&
    v2.recallAt6 >= v1.recallAt6 &&
    v2.mrrAt6 >= v1.mrrAt6 &&
    v2.irrelevantRate <= v1.irrelevantRate;
  rows.push({
    threshold,
    passes,
    v2: {
      recallAt6: v2.recallAt6,
      mrrAt6: v2.mrrAt6,
      irrelevantRate: v2.irrelevantRate,
      canaryHits: v2.canaryHits,
    },
    v1: {
      recallAt6: v1.recallAt6,
      mrrAt6: v1.mrrAt6,
      irrelevantRate: v1.irrelevantRate,
    },
  });
  console.error(
    `t=${threshold} v2 r=${v2.recallAt6.toFixed(3)} m=${v2.mrrAt6.toFixed(3)} i=${v2.irrelevantRate.toFixed(3)} | v1 r=${v1.recallAt6.toFixed(3)} m=${v1.mrrAt6.toFixed(3)} i=${v1.irrelevantRate.toFixed(3)} => ${passes ? "PASS" : "fail"}`,
  );
}

const eligible = rows.filter((row) => row.passes);
eligible.sort(
  (left, right) =>
    right.v2.recallAt6 - left.v2.recallAt6 || right.threshold - left.threshold,
);
const chosen = eligible.length > 0 ? eligible[0].threshold : null;
const summary = {
  split: "calibration",
  rule: "v2 semantic >= v1 semantic on recall@6, MRR@6 and irrelevant rate; canary never returns; ties to the stricter threshold",
  thresholds: rows,
  chosen,
};
console.log(JSON.stringify(summary, null, 2));
if (REPORT) {
  writeFileSync(path.resolve(REPO_ROOT, REPORT), `${JSON.stringify(summary, null, 2)}\n`);
}
