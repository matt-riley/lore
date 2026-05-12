export function collectFilteredReasonSummaries(filtered) {
  const counts = new Map();
  for (const item of Array.isArray(filtered) ? filtered : []) {
    const key = String(item?.reason || "filtered");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => `${reason} x${count}`);
}
