import { buildRecallEnvelope } from "./memory-operations.mjs";
import { buildQueryExpansionLine } from "./memory-tools-query-report.mjs";

function formatRecallSummary(trace) {
  return Object.entries(trace?.lookups ?? {})
    .map(([name, lookup]) => {
      const matched = Array.isArray(lookup?.rows)
        ? lookup.rows.length
        : Array.isArray(lookup?.rankedRows)
          ? lookup.rankedRows.length
          : 0;
      const included = Array.isArray(lookup?.includedRows) ? lookup.includedRows.length : 0;
      return `- ${name}: matched=${matched} included=${included}${lookup?.reason ? ` reason=${lookup.reason}` : ""}`;
    })
    .join("\n");
}

function formatRecallReport(result, { includeTrace = false } = {}) {
  const lines = [
    `repository: ${result.repository ?? "global-only"}`,
    `estimatedTokens: ${result.estimatedTokens ?? 0}`,
    `sections: ${(result.trace?.output?.sectionTitles ?? []).join(", ") || "none"}`,
    ...buildQueryExpansionLine(result.queryExpansion),
    "",
    "## Context",
    "",
    result.text || "No context.",
  ];
  if (includeTrace) {
    lines.push(
      "",
      "## Lookup Summary",
      "",
      formatRecallSummary(result.trace) || "- none",
    );
  }
  return lines.join("\n");
}

function formatRecallSupportingFactsLines(envelope) {
  return [
    "",
    "## Supporting Facts",
    "",
    ...(envelope.supportingFacts.length > 0
      ? envelope.supportingFacts.map((fact) => `- ${fact}`)
      : ["- none"]),
  ];
}

function formatRecallLookupLines(lookup, detailLevel) {
  const lines = [
    `- ${lookup.name}: matched=${lookup.matchedCount} included=${lookup.includedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
  ];
  const samples = lookup.includedRows.length > 0 ? lookup.includedRows : lookup.matchedRows;
  lines.push(...samples.slice(0, 2).map((sample) => `  - ${sample}`));
  if (detailLevel === "full" && lookup.rankedRows.length > 0) {
    lines.push("  - ranking:");
    lines.push(...lookup.rankedRows.slice(0, 2).map((sample) => `    - ${sample}`));
  }
  if (lookup.filteredReasons.length > 0) {
    lines.push(`  - filtered: ${lookup.filteredReasons.join(", ")}`);
  }
  return lines;
}

function formatRecallEvidenceLines(envelope, detailLevel) {
  if (envelope.lookups.length === 0) {
    return ["", "## Lookup Evidence", "", "- none"];
  }
  return [
    "",
    "## Lookup Evidence",
    "",
    ...envelope.lookups.flatMap((lookup) => formatRecallLookupLines(lookup, detailLevel)),
  ];
}

export function formatRecallEnvelope(result, { detailLevel = "context", includeTrace = false } = {}) {
  const lines = [formatRecallReport(result, { includeTrace })];
  if (detailLevel === "context") {
    return lines.join("\n");
  }

  const envelope = buildRecallEnvelope(result);
  lines.push(...formatRecallSupportingFactsLines(envelope));
  lines.push(...formatRecallEvidenceLines(envelope, detailLevel));

  return lines.join("\n");
}
