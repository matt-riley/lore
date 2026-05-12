export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

export function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function collectFilteredReasonSummaries(filtered) {
  const counts = new Map();
  for (const item of Array.isArray(filtered) ? filtered : []) {
    const key = String(item?.reason || "filtered");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => `${reason} x${count}`);
}
