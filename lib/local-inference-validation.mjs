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
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return -1;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function normalizeBoundedIndexes(value, itemCount, maximum = Number.POSITIVE_INFINITY) {
  const indexes = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const index = Number(item);
    if (
      !Number.isInteger(index)
      || index < 0
      || index >= itemCount
      || seen.has(index)
    ) {
      continue;
    }
    seen.add(index);
    indexes.push(index);
    if (indexes.length >= maximum) {
      break;
    }
  }
  return indexes;
}
