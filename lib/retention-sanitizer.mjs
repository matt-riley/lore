const INJECTED_XML_BLOCK_PATTERN = /<(hindsight_memories|relevant_memories|lore_context)\b[^>]*>[\s\S]*?<\/\1>/gi;
const INJECTED_SECTION_HEADING = /^## (?:Relevant Day Summary|Relevant Prior Work|Relevant Commitments, Preferences, And Identity|Cross-Repo Examples|Cross-Repo Hints|Transferable Cross-Repo Preferences|Active Workstream)$/m;

import { normalizeText } from "./content-normalizer.mjs";

export function stripInjectedContext(value) {
  let text = String(value || "").replace(INJECTED_XML_BLOCK_PATTERN, "\n");
  const cutPoint = text.search(INJECTED_SECTION_HEADING);
  if (cutPoint >= 0) {
    text = text.slice(0, cutPoint);
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
