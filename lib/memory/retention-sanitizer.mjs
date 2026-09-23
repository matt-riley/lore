const INJECTED_XML_BLOCK_PATTERN = /<(hindsight_memories|relevant_memories|lore_context|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|INSTRUCTIONS|environment_context|user_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi;
const INJECTED_SECTION_HEADING = /^## (?:Lore Onboarding|Standing Directives|Response Style And Addressing|Relevant Day Summary|Relevant Prior Work|Relevant Commitments, Preferences, And Identity|Cross-Repo Examples|Cross-Repo Hints|Transferable Cross-Repo Preferences|Active Workstream)$/m;
const AGENTS_MD_INSTRUCTIONS_HEADING = /^# AGENTS\.md instructions for .+$/m;

import { normalizeText } from "../utils/text-normalizer.mjs";

export function stripInjectedContext(value) {
  let text = String(value || "").replace(INJECTED_XML_BLOCK_PATTERN, "\n");

  // Remove # AGENTS.md instructions heading line if present
  const agentsCutPoint = text.search(AGENTS_MD_INSTRUCTIONS_HEADING);
  if (agentsCutPoint >= 0) {
    // Remove the heading line and keep the rest (which may have INSTRUCTIONS blocks that get stripped above)
    const nextNewline = text.indexOf("\n", agentsCutPoint);
    if (nextNewline >= 0) {
      text = text.slice(0, agentsCutPoint) + text.slice(nextNewline);
    } else {
      text = text.slice(0, agentsCutPoint);
    }
  }

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
