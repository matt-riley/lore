import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addNegative,
  addPositive,
  chooseThreshold,
  newAccumulator,
  passesCalibrationGates,
  summarize,
} from "./semantic-metrics.mjs";

test("negative prompts are reported separately, not in the irrelevant-context rate", () => {
  const accumulator = newAccumulator();
  addPositive(accumulator, [{ id: "gold" }, { id: "other" }], "gold", "canary");
  addNegative(accumulator, [{ id: "stray-1" }, { id: "stray-2" }, { id: "stray-3" }]);
  const summary = summarize(accumulator);
  assert.equal(summary.irrelevantRate, 0.5);
  assert.equal(summary.negativeQueries, 1);
  assert.equal(summary.negativeReturned, 3);
});

test("recall and MRR come from positive queries only", () => {
  const accumulator = newAccumulator();
  addPositive(accumulator, [{ id: "gold" }], "gold", "canary");
  addPositive(accumulator, [{ id: "x" }, { id: "gold" }], "gold", "canary");
  const summary = summarize(accumulator);
  assert.equal(summary.recallAt6, 1);
  assert.equal(summary.mrrAt6, 0.75);
});

test("a canary return fails the calibration gates", () => {
  const v1 = { recallAt6: 0.5, mrrAt6: 0.5, irrelevantRate: 0.2, canaryHits: 0 };
  const v2 = { recallAt6: 0.9, mrrAt6: 0.9, irrelevantRate: 0.1, canaryHits: 1 };
  assert.equal(passesCalibrationGates(v1, v2), false);
  assert.equal(passesCalibrationGates(v1, { ...v2, canaryHits: 0 }), true);
});

test("no passing threshold chooses nothing, so calibration cannot report a pass", () => {
  const rows = [
    { threshold: 0.4, passes: false, v2: { recallAt6: 0.9 } },
    { threshold: 0.5, passes: false, v2: { recallAt6: 0.8 } },
  ];
  assert.equal(chooseThreshold(rows), null);
});

test("the highest recall wins, and a tie goes to the stricter threshold", () => {
  const rows = [
    { threshold: 0.4, passes: true, v2: { recallAt6: 0.8 } },
    { threshold: 0.5, passes: true, v2: { recallAt6: 0.9 } },
    { threshold: 0.6, passes: true, v2: { recallAt6: 0.9 } },
  ];
  assert.equal(chooseThreshold(rows), 0.6);
});
