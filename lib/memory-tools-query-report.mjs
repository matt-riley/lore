export function buildQueryExpansionLine(queryExpansion) {
  if (queryExpansion?.requested !== true) {
    return [];
  }
  if (queryExpansion.fallbackUsed === true) {
    return ["queryExpansion: deterministic retrieval fallback"];
  }
  if (queryExpansion.used === true) {
    return [
      `queryExpansion: used added=${queryExpansion.addedTerms.join(", ")}`,
    ];
  }
  if (queryExpansion.error) {
    return [`queryExpansion: deterministic fallback (${queryExpansion.error})`];
  }
  return ["queryExpansion: unchanged"];
}
