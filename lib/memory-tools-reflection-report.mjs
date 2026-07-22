import { buildQueryExpansionLine } from "./memory-tools-query-report.mjs";

function humanizeFocus(value) {
  return String(value || "summary")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function humanizeLookupLabel(value) {
  return String(value || "lookup")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

export function formatReflectionReport(result, { detailLevel = "summary" } = {}) {
  const lines = [
    ...buildReflectionHeaderLines(result),
    ...buildReflectionInsightLines(result),
    ...buildReflectionAnalysisLines(result.analysis),
  ];

  if (detailLevel === "summary") {
    return lines.join("\n");
  }

  lines.push(...buildReflectionEvidenceLines(result));
  if (detailLevel !== "full") {
    return lines.join("\n");
  }

  lines.push(...buildReflectionLookupCoverageLines(result));
  return lines.join("\n");
}

function buildReflectionHeaderLines(result) {
  return [
    `repository: ${result.repository ?? "global-only"}`,
    `focus: ${humanizeFocus(result.focus)}`,
    `estimatedTokens: ${result.recall?.estimatedTokens ?? 0}`,
    `sections: ${(result.envelope?.sections ?? []).join(", ") || "none"}`,
    ...buildReflectionLookbackLine(result),
    ...buildQueryExpansionLine(result.queryExpansion),
    ...buildReflectionInferenceLine(result.localInference),
    ...buildReflectionAnalysisDiagnostic(result),
    ...buildReflectionQualityDiagnostic(result.localInference),
    "",
    "## Reflection",
    "",
    result.summary,
    "",
    "## Key Insights",
    "",
  ];
}


function buildReflectionLookbackLine(result) {
  if (!result.lookbackHours) {
    return [];
  }
  const cappedSuffix = result.recentSessionCountCapped ? "+ (capped)" : "";
  return [`lookbackHours: ${result.lookbackHours} (sessions found: ${result.recentSessionCount ?? 0}${cappedSuffix})`];
}

function buildReflectionInferenceLine(localInference) {
  if (localInference?.requested !== true) {
    return [];
  }
  if (localInference.used === true) {
    return [
      `localInference: used (embeddings: ${describeReflectionEmbeddings(localInference)})`,
      ...buildReflectionGroundingLine(localInference),
    ];
  }
  return [`localInference: deterministic fallback (${localInference.error ?? "unavailable"})`];
}

function buildReflectionGroundingLine(localInference) {
  if (!Number.isFinite(localInference.evidenceCandidateCount)) {
    return [];
  }
  const summaryStatus = localInference.groundingUsed === true
    ? localInference.summaryGrounded === true
      ? "grounded"
      : "deterministic"
    : "unchecked";
  return [
    [
      `localInferenceGrounding: candidates=${localInference.evidenceCandidateCount}`,
      `selected=${localInference.evidenceSelectedCount ?? 0}`,
      `grounded=${localInference.groundedInsightCount ?? 0}`,
      `discarded=${localInference.discardedInsightCount ?? 0}`,
      `summary=${summaryStatus}`,
    ].join(" "),
  ];
}

function describeReflectionEmbeddings(localInference) {
  if (localInference.embeddingsUsed === true) {
    return "used";
  }
  return localInference.embeddingError ? "fallback" : "disabled";
}

function buildReflectionAnalysisDiagnostic(result) {
  const analysis = result.analysis;
  if (!analysis || result.localInference?.used !== true) {
    return [];
  }
  return [
    [
      `localInferenceAnalysis: consolidations=${analysis.consolidations?.length ?? 0}`,
      `contradictions=${analysis.contradictions?.length ?? 0}`,
      `trends=${analysis.trends?.length ?? 0}`,
      `grounded=${result.localInference.groundedAnalysisCount ?? 0}`,
      `discarded=${result.localInference.discardedAnalysisCount ?? 0}`,
    ].join(" "),
  ];
}

function buildReflectionQualityDiagnostic(localInference) {
  if (localInference?.qualityEvaluationUsed !== true) {
    return [];
  }
  return [
    [
      "localInferenceQuality: used",
      `accepted=${localInference.qualityAcceptedCount ?? 0}`,
      `rejected=${localInference.qualityRejectedCount ?? 0}`,
    ].join(" "),
  ];
}

function buildReflectionInsightLines(result) {
  if (!Array.isArray(result.insights) || result.insights.length === 0) {
    return ["- none"];
  }
  return result.insights.map((insight) => `- ${insight.text}${insight.source ? ` (${insight.source})` : ""}`);
}

function buildReflectionAnalysisSection(title, items, renderSuffix = () => "") {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return [
    "",
    `## ${title}`,
    "",
    ...items.map((item) => `- ${item.text}${renderSuffix(item)}`),
  ];
}

function buildReflectionAnalysisLines(analysis) {
  if (!analysis) {
    return [];
  }
  return [
    ...buildReflectionAnalysisSection(
      "Memory Consolidation Proposals",
      analysis.consolidations,
      (item) => ` (evidence: ${item.evidenceIndexes.join(", ")})`,
    ),
    ...buildReflectionAnalysisSection(
      "Contradictions And Possible Supersessions",
      analysis.contradictions,
      (item) => ` (evidence: ${item.evidenceIndexes.join(", ")})`,
    ),
    ...buildReflectionAnalysisSection(
      "Recurring Trends",
      analysis.trends,
      (item) => ` (occurrences: ${item.occurrences}; evidence: ${item.evidenceIndexes.join(", ")})`,
    ),
  ];
}

function buildReflectionEvidenceLines(result) {
  return [
    "",
    "## Supporting Evidence",
    "",
    ...formatReflectionFactLines(result.envelope?.supportingFacts),
    "",
    "## Source Accounting",
    "",
    ...formatReflectionSourceAccountingLines(result.envelope?.sourceAccounting),
  ];
}

function formatReflectionFactLines(facts) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return ["- none"];
  }
  return facts.map((fact) => `- ${fact}`);
}

function formatReflectionSourceAccountingLines(sourceAccounting) {
  if (!Array.isArray(sourceAccounting) || sourceAccounting.length === 0) {
    return ["- none"];
  }
  return sourceAccounting.map((section) => (
    `- ${section.title}: source=${section.source ?? "unknown"} entries=${section.entryCount ?? 0} tokens=${section.usedTokens ?? 0}${section.budget ? `/${section.budget}` : ""}`
  ));
}

function buildReflectionLookupCoverageLines(result) {
  const lookups = Array.isArray(result.envelope?.lookups) ? result.envelope.lookups : [];
  return [
    "",
    "## Lookup Coverage",
    "",
    ...(lookups.length === 0 ? ["- none"] : lookups.flatMap((lookup) => formatReflectionLookupLines(lookup))),
  ];
}

function formatReflectionLookupLines(lookup) {
  return [
    `- ${humanizeLookupLabel(lookup.name)}: matched=${lookup.matchedCount} included=${lookup.includedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
    ...formatReflectionLookupSamples(lookup),
    ...(lookup.filteredReasons.length > 0 ? [`  - filtered: ${lookup.filteredReasons.join(", ")}`] : []),
  ];
}

function formatReflectionLookupSamples(lookup) {
  const includedEntries = lookup.includedEntries.slice(0, 2).map((sample) => `  - ${sample.text}`);
  if (includedEntries.length > 0) {
    return includedEntries;
  }
  return lookup.matchedEntries.slice(0, 1).map((sample) => `  - ${sample.text}`);
}
