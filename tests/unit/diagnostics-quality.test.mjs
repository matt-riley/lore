import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  QUALITY_CASES,
  renderQualityReport,
  runQualityBenchmark,
} from "../../scripts/diagnostics-quality.mjs";

describe("diagnostics quality corpus", () => {
  test("contains deterministic coverage across all required query lanes", () => {
    assert.ok(QUALITY_CASES.length >= 40);
    for (const category of ["explicit", "paraphrase", "irrelevant", "stale-conflicting", "temporal", "repo-isolation"]) {
      assert.ok(QUALITY_CASES.filter((item) => item.category === category).length >= 6, category);
    }
    assert.ok(QUALITY_CASES.every((item) => item.expectedEvidence?.length || item.forbiddenEvidence?.length));
  });

  test("runs against an isolated fixture database and reports evidence assertions", async () => {
    const result = await runQualityBenchmark({ sizes: [1], skipPerformance: true });
    assert.equal(result.totalCases, QUALITY_CASES.length);
    assert.ok(result.cases.every((item) => item.assertions.some((assertion) => assertion.kind === "evidence")));
    assert.equal(result.safety.forbiddenRepoEvidence, 0);
    assert.equal(result.safety.forgottenEvidence, 0);
    assert.equal(result.safety.supersededEvidence, 0);
    assert.equal(typeof result.positiveRecall, "number");
    assert.ok(result.positiveRecall >= 0 && result.positiveRecall <= 1);
    assert.match(renderQualityReport(result), /positiveRecall:/);
  });
});
