export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

export function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
