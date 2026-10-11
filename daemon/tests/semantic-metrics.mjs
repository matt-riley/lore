// Retrieval metrics and the calibration rule for the semantic validation. Kept
// free of I/O so the rules can be tested without a daemon or a corpus.

/** Running totals for one mode and split. */
export function newAccumulator() {
  return {
    positive: 0,
    hits: 0,
    reciprocal: 0,
    returned: 0,
    nonGold: 0,
    canaryHits: 0,
    negativeQueries: 0,
    negativeReturned: 0,
    fallbackCounts: {},
  };
}

/** A query with a gold memory: its rows count toward recall, MRR and the irrelevant rate. */
export function addPositive(accumulator, records, goldId, canaryId) {
  accumulator.positive += 1;
  accumulator.returned += records.length;
  const ids = records.map((record) => record.id);
  const rank = ids.indexOf(goldId);
  if (rank >= 0) {
    accumulator.hits += 1;
    accumulator.reciprocal += 1 / (rank + 1);
  }
  accumulator.nonGold += ids.filter((id) => id !== goldId).length;
  if (ids.includes(canaryId)) {
    accumulator.canaryHits += 1;
  }
}

/**
 * A negative prompt has no gold memory. validation.md reports it separately: its
 * rows are counted here but kept out of the irrelevant-context rate.
 */
export function addNegative(accumulator, records) {
  accumulator.negativeQueries += 1;
  accumulator.negativeReturned += records.length;
}

export function summarize(accumulator) {
  return {
    positiveQueries: accumulator.positive,
    recallAt6: accumulator.positive === 0 ? 0 : accumulator.hits / accumulator.positive,
    mrrAt6: accumulator.positive === 0 ? 0 : accumulator.reciprocal / accumulator.positive,
    irrelevantRate:
      accumulator.returned === 0 ? 0 : accumulator.nonGold / accumulator.returned,
    canaryHits: accumulator.canaryHits,
    negativeQueries: accumulator.negativeQueries,
    negativeReturned: accumulator.negativeReturned,
    fallbackCounts: accumulator.fallbackCounts,
  };
}

/**
 * A threshold passes when the v2 semantic stream is at least as good as the v1
 * semantic stream on recall@6, MRR@6 and irrelevant-context rate, and the deleted
 * canary never returns.
 */
export function passesCalibrationGates(v1, v2) {
  return (
    v2.canaryHits === 0 &&
    v2.recallAt6 >= v1.recallAt6 &&
    v2.mrrAt6 >= v1.mrrAt6 &&
    v2.irrelevantRate <= v1.irrelevantRate
  );
}

/** The passing threshold with the highest v2 recall@6; ties go to the stricter one. Null when none passes. */
export function chooseThreshold(rows) {
  const eligible = rows.filter((row) => row.passes);
  eligible.sort(
    (left, right) =>
      right.v2.recallAt6 - left.v2.recallAt6 || right.threshold - left.threshold,
  );
  return eligible.length > 0 ? eligible[0].threshold : null;
}
