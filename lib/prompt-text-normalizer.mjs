export function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
