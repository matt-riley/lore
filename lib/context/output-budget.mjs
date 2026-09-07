import { estimateTokens } from "../utils/token-estimator.mjs";

function truncateToBudget(text, budget) {
  const normalized = String(text ?? "").trim();
  if (!normalized || !Number.isFinite(budget) || budget <= 0) return "";
  if (estimateTokens(normalized) <= budget) return normalized;
  const cap = Math.max(1, Math.floor(budget * 4));
  let candidate = normalized.slice(0, cap).trimEnd();
  while (candidate && estimateTokens(`${candidate}…`) > budget) {
    candidate = candidate.slice(0, -Math.max(1, Math.ceil(candidate.length / 20))).trimEnd();
  }
  return candidate ? `${candidate}…` : "";
}

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
  const requiredCount = normalized.filter((section) => isRequiredTitle(section.title, requiredTitles)).length;
  let requiredLeft = requiredCount;
  const selected = [];
  for (const section of normalized) {
    const required = isRequiredTitle(section.title, requiredTitles);
    if (!required && remaining < 8) continue;
    if (required) {
      requiredLeft -= 1;
    }
    const reserve = required ? requiredLeft : 0;
    const available = Math.max(0, remaining - reserve);
    const text = truncateToBudget(section.text, available);
    if (!text) continue;
    const used = estimateTokens(text);
    selected.push({ ...section, text, usedTokens: used });
    remaining = Math.max(0, remaining - used);
  }
  const text = selected.map((section) => section.text).join("\n\n").trim();
  return { sections: selected, text, estimatedTokens: estimateTokens(text) };
}

export function filterTraceIncludedRows(trace, renderedText) {
  if (!trace || typeof trace !== "object") return trace;
  const output = { ...trace, lookups: { ...trace.lookups } };
  for (const [name, lookup] of Object.entries(output.lookups)) {
    if (!lookup || typeof lookup !== "object" || !Array.isArray(lookup.includedRows)) continue;
    const includedRows = lookup.includedRows.filter((row) => {
      const values = [row?.content, row?.summary, row?.excerpt, row?.text, row?.title, row?.mission, row?.objective]
        .filter((value) => value && String(value).trim());
      return values.length === 0 || values.some((value) => String(renderedText).toLowerCase().includes(String(value).toLowerCase()));
    });
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
