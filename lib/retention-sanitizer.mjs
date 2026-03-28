const INJECTED_XML_BLOCK_PATTERNS = [
  /<hindsight_memories\b[^>]*>[\s\S]*?<\/hindsight_memories>/gi,
  /<relevant_memories\b[^>]*>[\s\S]*?<\/relevant_memories>/gi,
  /<coherence_context\b[^>]*>[\s\S]*?<\/coherence_context>/gi,
];

const INJECTED_SECTION_HEADINGS = [
  /^## Relevant Day Summary$/m,
  /^## Relevant Prior Work$/m,
  /^## Relevant Commitments, Preferences, And Identity$/m,
  /^## Cross-Repo Examples$/m,
  /^## Cross-Repo Hints$/m,
  /^## Transferable Cross-Repo Preferences$/m,
  /^## Active Workstream$/m,
];

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function stripInjectedContext(value) {
  let text = String(value || "");
  for (const pattern of INJECTED_XML_BLOCK_PATTERNS) {
    text = text.replace(pattern, "\n");
  }

  const cutPoints = INJECTED_SECTION_HEADINGS
    .map((pattern) => text.search(pattern))
    .filter((index) => index >= 0);
  if (cutPoints.length > 0) {
    text = text.slice(0, Math.min(...cutPoints));
  }

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function sanitizeRetainedText(value) {
  return normalizeText(stripInjectedContext(value));
}

export function sanitizeRetainedList(values, limit = 12) {
  const source = Array.isArray(values) ? values : [values];
  const cleaned = [];
  const seen = new Set();
  for (const value of source) {
    const text = sanitizeRetainedText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    cleaned.push(text);
    if (cleaned.length >= limit) {
      break;
    }
  }
  return cleaned;
}

export function sanitizeRetainedMetadata(value) {
  if (Array.isArray(value)) {
    return sanitizeRetainedList(value, 24);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, sanitizeRetainedMetadata(entry)])
        .filter(([, entry]) => {
          if (Array.isArray(entry)) {
            return entry.length > 0;
          }
          if (typeof entry === "string") {
            return entry.length > 0;
          }
          return entry !== null && entry !== undefined;
        }),
    );
  }
  if (typeof value === "string") {
    return sanitizeRetainedText(value);
  }
  return value;
}
