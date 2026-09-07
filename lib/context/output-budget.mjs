import { estimateTokens } from "../utils/token-estimator.mjs";

function isRequiredTitle(title, requiredTitles) {
  return (requiredTitles ?? []).some((pattern) => pattern instanceof RegExp
    ? pattern.test(String(title ?? ""))
    : String(pattern).toLowerCase() === String(title ?? "").toLowerCase());
}

/** Keep every required section visible, then fill remaining budget in order. */
export function enforceSectionBudget({ sections = [], totalBudget = Infinity, requiredTitles = [] } = {}) {
  const normalized = sections
    .map((section) => ({ ...section, text: String(section.text ?? "").trim() }))
    .filter((section) => section.text);
  if (!Number.isFinite(totalBudget)) {
    const text = normalized.map((section) => section.text).join("\n\n");
    return { sections: normalized, text, estimatedTokens: estimateTokens(text) };
  }
  if (totalBudget <= 0) {
    return { sections: [], text: "", estimatedTokens: 0 };
  }
  let remaining = Math.max(0, Math.floor(totalBudget));
  const selected = [];
  const ordered = [
    ...normalized.filter((section) => isRequiredTitle(section.title, requiredTitles)),
    ...normalized.filter((section) => !isRequiredTitle(section.title, requiredTitles)),
  ];
  for (const section of ordered) {
    const separator = selected.length > 0 ? "\n\n" : "";
    const used = estimateTokens(`${separator}${section.text}`);
    if (used <= remaining) {
      selected.push({ ...section, usedTokens: used });
      remaining -= used;
      continue;
    }
    // Preserve the persona section's heading as a complete unit when its
    // entries cannot fit. Never cut a sentence or assertion in half.
    if (isRequiredTitle(section.title, requiredTitles)) {
      const heading = section.text.split("\n").find((line) => /^##\s+/u.test(line)) ?? `## ${section.title}`;
      const headingUsed = estimateTokens(`${separator}${heading}`);
      if (headingUsed <= remaining) {
        selected.push({ ...section, text: heading, usedTokens: headingUsed, entryCount: 0 });
        remaining -= headingUsed;
      }
    }
  }
  const text = selected.map((section) => section.text).join("\n\n").trim();
  return { sections: selected, text, estimatedTokens: estimateTokens(text) };
}

export function filterTraceIncludedRows(trace, renderedText) {
  if (!trace || typeof trace !== "object") return trace;
  const output = { ...trace, lookups: { ...trace.lookups } };
  const renderedTitles = new Set([...String(renderedText).matchAll(/^##\s+(.+)$/gmu)].map((match) => match[1].trim().toLowerCase()));
  const details = Array.isArray(output.output?.sectionDetails) ? output.output.sectionDetails : [];
  const lookupAliases = {
    onboarding: ["lore onboarding"],
    directives: ["standing directives"],
    workstreamoverlays: ["active workstream"],
    localmemories: ["commitments", "relevant commitments, preferences, and identity"],
    semantic: ["semantic matches", "semantic_matches"],
  };
  for (const [name, lookup] of Object.entries(output.lookups)) {
    if (!lookup || typeof lookup !== "object" || !Array.isArray(lookup.includedRows)) continue;
    const aliases = lookupAliases[name.toLowerCase()] ?? [name.toLowerCase()];
    const relatedDetails = details.filter((detail) => aliases.some((alias) => String(detail.source ?? detail.title).toLowerCase().includes(alias)));
    const omitted = relatedDetails.length > 0 && relatedDetails.every((detail) => !renderedTitles.has(String(detail.title).toLowerCase()));
    const includedRows = omitted ? [] : lookup.includedRows;
    output.lookups[name] = { ...lookup, includedRows };
  }
  return output;
}

export function sectionsFromRenderedText(text, sectionTitles = [], sectionDetails = []) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  const chunks = normalized.split(/(?=^##\s+)/m).filter(Boolean);
  return chunks.map((chunk, index) => {
    const title = chunk.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? sectionTitles[index] ?? `Section ${index + 1}`;
    const detail = sectionDetails.find((entry) => entry.title === title) ?? {};
    return { ...detail, title, text: chunk.trim(), source: detail.source ?? title };
  });
}
