import { estimateTokens } from "../utils/token-estimator.mjs";

function isRequiredTitle(title, requiredTitles) {
  return requiredTitles.some((pattern) => pattern instanceof RegExp
    ? pattern.test(String(title ?? ""))
    : String(pattern).toLowerCase() === String(title ?? "").toLowerCase());
}

function sectionUnits(section) {
  const match = section.text.match(/^(##[^\n]*)(?:\n+([\s\S]*))?$/u);
  const heading = match?.[1] ?? "";
  const body = (match ? match[2] ?? "" : section.text).trim();
  // Renderers use top-level list entries. Continuation lines, qualifications,
  // and nested lists stay attached to their assertion as an indivisible unit.
  const entries = body ? body.split(/\n(?=(?:- |\d+\. ))/u).map((entry) => entry.trim()).filter(Boolean) : [];
  return { ...section, heading, entries, selected: [] };
}

function renderSelection(section) {
  if (section.selected.length === 0) return "";
  const body = section.selected.map((index) => section.entries[index]).join("\n");
  return section.heading ? `${section.heading}\n\n${body}` : body;
}

/** Allocate complete entries, prioritizing substantive required context. */
export function enforceSectionBudget({ sections = [], totalBudget = Infinity, requiredTitles = [] } = {}) {
  const normalized = sections.map((section) => ({ ...section, text: String(section.text ?? "").trim() })).filter((section) => section.text);
  const limit = Number.isFinite(totalBudget) ? Math.max(0, Math.floor(totalBudget)) : Infinity;
  if (!Number.isFinite(limit)) {
    const text = normalized.map((section) => section.text).join("\n\n");
    return { sections: normalized, text, estimatedTokens: estimateTokens(text) };
  }
  const candidates = normalized.map(sectionUnits);
  const required = candidates.filter((section) => isRequiredTitle(section.title, requiredTitles));
  const optional = candidates.filter((section) => !isRequiredTitle(section.title, requiredTitles));
  const rendered = () => candidates.map(renderSelection).filter(Boolean).join("\n\n");
  const select = (section, index) => {
    section.selected.push(index);
    if (estimateTokens(rendered()) <= limit) return true;
    section.selected.pop();
    return false;
  };
  // Reserve a substantive entry for each required section before filling any
  // one section. An empty heading is not retained context.
  for (const section of required) {
    for (let index = 0; index < section.entries.length; index += 1) {
      if (select(section, index)) break;
    }
  }
  for (const section of [...required, ...optional]) {
    for (let index = 0; index < section.entries.length; index += 1) {
      if (!section.selected.includes(index)) select(section, index);
    }
    section.selected.sort((left, right) => left - right);
  }
  const selected = candidates.filter((section) => section.selected.length > 0).map((section) => {
    const { heading: _heading, entries, selected: indices, ...original } = section;
    const text = renderSelection(section);
    return { ...original, text, entryCount: indices.length, omittedEntryCount: entries.length - indices.length, usedTokens: estimateTokens(text) };
  });
  const text = selected.map((section) => section.text).join("\n\n");
  return { sections: selected, text, estimatedTokens: estimateTokens(text) };
}

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function filterTraceIncludedRows(trace, renderedText) {
  if (!trace || typeof trace !== "object") return trace;
  // A heading alone cannot prove that a memory was delivered. Preserve matched
  // rows for diagnostics, but included rows must have their evidence in output.
  const body = normalizedText(String(renderedText).replace(/^##[^\n]*$/gmu, ""));
  const present = (value) => Boolean(normalizedText(value)) && body.includes(normalizedText(value));
  const output = { ...trace, lookups: { ...trace.lookups }, omissions: [...(trace.omissions ?? [])] };
  for (const [name, lookup] of Object.entries(output.lookups)) {
    if (!lookup || typeof lookup !== "object" || !Array.isArray(lookup.includedRows)) continue;
    const includedRows = lookup.includedRows.filter((row) => [row?.content, row?.summary, row?.excerpt, row?.text, row?.mission, row?.objective].some(present))
      .map((row) => {
        const included = { ...row };
        for (const field of ["decisions", "learnings", "actions", "openItems"]) {
          if (Array.isArray(included[field])) included[field] = included[field].filter(present);
        }
        return included;
      });
    const includedIds = new Set(includedRows.map((row) => row.id ?? row.memoryId ?? row.sessionId));
    for (const row of lookup.includedRows) {
      const id = row.id ?? row.memoryId ?? row.sessionId;
      if (id && !includedIds.has(id) && !output.omissions.some((omission) => omission.stage === "output" && omission.lookup === name && omission.id === id)) {
        output.omissions.push({ stage: "output", lookup: name, id, reason: "not_rendered" });
      }
    }
    output.lookups[name] = { ...lookup, includedRows };
  }
  return output;
}

export function sectionsFromRenderedText(text, sectionTitles = [], sectionDetails = []) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  return normalized.split(/(?=^##\s+)/m).filter(Boolean).map((chunk, index) => {
    const title = chunk.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? sectionTitles[index] ?? `Section ${index + 1}`;
    const detail = sectionDetails.find((entry) => entry.title === title) ?? {};
    return { ...detail, title, text: chunk.trim(), source: detail.source ?? title };
  });
}
