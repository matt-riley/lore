import assert from "node:assert/strict";
import { test } from "node:test";
import { QUALITY_CASES, evaluateQualityCase, runQualityBenchmark } from "../../scripts/diagnostics-quality.mjs";

test("quality evaluation requires emitted evidence, not ranked-only candidates", () => {
  const definition = QUALITY_CASES[0];
  const row = { id: "expected", content: definition.content, repository: "quality/current" };
  const explanation = { text: "", trace: { lookups: { local: { rankedRows: [row], includedRows: [] } } } };
  assert.equal(evaluateQualityCase(definition, explanation, { expectedId: row.id }).passed, false);
  explanation.text = definition.content;
  explanation.trace.lookups.local.includedRows = [row];
  assert.equal(evaluateQualityCase(definition, explanation, { expectedId: row.id }).passed, true);
  explanation.trace.lookups.local.includedRows.push({ id: "foreign", repository: "quality/other" });
  assert.equal(evaluateQualityCase(definition, explanation, { expectedId: row.id }).passed, false);
});

test("negative recall detects injection and forgotten IDs are forbidden", () => {
  const negative = QUALITY_CASES.find(item => item.category === "irrelevant");
  const explanation = { text: negative.content, trace: { lookups: { local: { includedRows: [{ id: "forgotten", repository: "quality/current" }] } } } };
  assert.equal(evaluateQualityCase(negative, explanation, { forbiddenIds: ["forgotten"] }).passed, false);
});

test("fixture-only corpus meets v1 safety and recall gates", async () => {
  assert.ok(QUALITY_CASES.length >= 40);
  for (const category of ["explicit", "paraphrase", "irrelevant", "stale-conflicting", "temporal", "repo-isolation"]) assert.equal(QUALITY_CASES.filter(item => item.category === category).length, 8);
  const result = await runQualityBenchmark();
  assert.equal(result.passed, true, JSON.stringify(result.cases.filter(item => !item.passed)));
  assert.ok(result.positiveRecall >= 0.95);
  assert.deepEqual(result.safetyFailures, []);
  assert.deepEqual(result.performance, []);
});
