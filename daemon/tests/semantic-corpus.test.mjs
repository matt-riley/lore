import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { splitFamilies } from "./semantic-corpus.mjs";

function corpusOf(count) {
  return {
    families: Array.from({ length: count }, (_, index) => ({
      id: `family-${String(index).padStart(3, "0")}`,
      queries: [`query for family ${index}`],
    })),
  };
}

const digest = (id) => createHash("sha256").update(id).digest("hex");

test("the calibration split is exactly the first 20% of family IDs sorted by SHA-256", () => {
  const corpus = corpusOf(120);
  const expected = corpus.families
    .map((family) => family.id)
    .sort((left, right) => (digest(left) < digest(right) ? -1 : 1))
    .slice(0, 24)
    .sort();
  const calibration = splitFamilies(corpus, "calibration").map((family) => family.id).sort();
  assert.deepEqual(calibration, expected);
  assert.equal(splitFamilies(corpus, "held-out").length, 96);
});

test("every family lands in exactly one split with its queries intact", () => {
  const corpus = corpusOf(120);
  const calibration = splitFamilies(corpus, "calibration");
  const heldOut = splitFamilies(corpus, "held-out");
  assert.equal(calibration.length + heldOut.length, 120);
  for (const family of [...calibration, ...heldOut]) {
    assert.deepEqual(family.queries, [`query for family ${Number(family.id.slice(7))}`]);
  }
});
