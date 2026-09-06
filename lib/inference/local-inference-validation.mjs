export function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(minimum, Math.min(Math.trunc(numeric), maximum))
    : fallback;
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return -1;
  }
  const totals = left.reduce((result, value, index) => {
    result.dot += value * right[index];
    result.leftMagnitude += value * value;
    result.rightMagnitude += right[index] * right[index];
    return result;
  }, { dot: 0, leftMagnitude: 0, rightMagnitude: 0 });
  const magnitude = Math.sqrt(totals.leftMagnitude) * Math.sqrt(totals.rightMagnitude);
  return magnitude === 0 ? -1 : totals.dot / magnitude;
}

export function normalizeBoundedIndexes(value, itemCount, maximum = Number.POSITIVE_INFINITY) {
  const indexes = (Array.isArray(value) ? value : [])
    .map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < itemCount);
  return [...new Set(indexes)].slice(0, Math.max(1, Math.ceil(maximum)));
}
