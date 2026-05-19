/**
 * Report-formatting helpers for capability inventory, routing, and evaluation output.
 */

function buildEvaluationHeader(result) {
  return [
    "## Capability Router Evaluation",
    "",
    `mode: ${result.mode}`,
    `generatedAt: ${result.generatedAt}`,
    `cases: ${result.total}`,
    `passed: ${result.passed}`,
    `failed: ${result.failed}`,
    `routeCoverage: ${result.routeCoverage.join(", ") || "none"}`,
    "",
    "## Success Bar",
    "",
    ...result.successBar.map((item) => `- ${item}`),
    "",
    "## Cases",
    "",
  ];
}

function formatCaseStatus(item) {
  return `- ${item.passed ? "PASS" : "FAIL"} ${item.id}`;
}

function formatCaseExpected(item) {
  return `  expected: ${item.expectedRouteKind} -> ${item.expectedTargetName} (${item.expectedExecutionMode})`;
}

function formatCaseActual(item) {
  return `  actual: ${item.recommendation.primaryRoute?.route ?? "unknown"} -> ${item.recommendation.primaryRoute?.targetName ?? "unknown"} (${item.recommendation.primaryRoute?.executionMode ?? "unknown"})`;
}

function formatCaseConfidence(item) {
  return `  confidence: ${item.recommendation.confidence?.label ?? "unknown"} (${item.recommendation.confidence?.value ?? 0})`;
}

function formatCasePrompt(item) {
  return `  prompt: ${item.prompt}`;
}

function formatFailedAssertions(item) {
  const failedAssertions = item.assertions.filter((assertion) => assertion.passed === false);
  if (failedAssertions.length === 0) {
    return [];
  }
  return [`  failedAssertions: ${failedAssertions.map((assertion) => `${assertion.label} [${assertion.details}]`).join(" | ")}`];
}

function formatCaseDetails(item) {
  return [
    formatCaseStatus(item),
    formatCaseExpected(item),
    formatCaseActual(item),
    formatCaseConfidence(item),
    formatCasePrompt(item),
    ...formatFailedAssertions(item),
  ];
}

function formatCapability(capability) {
  return [
    `- [${capability.capabilityType}] ${capability.name}`,
    `routeKind=${capability.routeKind}`,
    capability.manualOnly ? "manualOnly=true" : null,
    `executionMode=${capability.executionMode}`,
    capability.routeKindHints.length > 0 ? `routeHints=${capability.routeKindHints.join(",")}` : null,
    capability.triggerCapabilities.length > 0 ? `triggerCapabilities=${capability.triggerCapabilities.slice(0, 4).join(",")}` : null,
    capability.description ? `description=${capability.description}` : null,
    capability.sourcePath ? `source=${capability.sourcePath}` : null,
  ].filter(Boolean).join(" ");
}

function formatRoute(route) {
  return [
    `- ${route.id}`,
    `available=${route.available}`,
    `support=${route.supportLevel}`,
    `supportingCapabilities=${route.supportingCapabilityIds.length}`,
    route.gaps.length > 0 ? `gaps=${route.gaps.join(" | ")}` : null,
  ].filter(Boolean).join(" ");
}

function takeLimited(list, limit) {
  return list.slice(0, Math.max(1, limit));
}

function buildCapabilityRecommendationReasonLines(primaryRoute) {
  return primaryRoute.reasons?.length > 0
    ? primaryRoute.reasons.map((reason) => `- ${reason}`)
    : ["- No explicit rationale recorded."];
}

function buildRouteCandidateLines(candidate) {
  const lines = [
    `- ${candidate.route} score=${candidate.score} base=${candidate.baseScore ?? candidate.score} heuristic=${candidate.heuristicScore ?? 0} support=${candidate.supportLevel} available=${candidate.available}`,
    `  target: ${candidate.targetName ?? "none"} (${candidate.targetType ?? "none"}, ${candidate.executionMode ?? "none"})`,
    `  matchedTokens: ${candidate.matchedTokens.join(", ") || "none"}`,
    `  supportingMatches: ${candidate.supportingMatches.map((match) => match.name).join(", ") || "none"}`,
  ];
  if (candidate.reasons?.length > 0) {
    lines.push(`  reasons: ${candidate.reasons.join(" | ")}`);
  }
  if (candidate.gaps.length > 0) {
    lines.push(`  gaps: ${candidate.gaps.join(" | ")}`);
  }
  return lines;
}

function buildCapabilityMatchLines(match) {
  return [
    `- [${match.capabilityType}] ${match.name} score=${match.score} routeHints=${match.routeKindHints.join(",") || "none"}${match.nameMatched ? " nameMatched=true" : ""}`,
    `  routeKind: ${match.routeKind}`,
    `  executionMode: ${match.executionMode}`,
    `  matchedTokens: ${match.matchedTokens.join(", ") || "none"}`,
    `  triggerTerms: ${match.triggerTerms.join(", ") || "none"}`,
    `  triggerCapabilities: ${match.triggerCapabilities.join(", ") || "none"}`,
    `  source: ${match.sourcePath}`,
    `  description: ${match.description}`,
  ];
}

function buildCapabilityRecommendationReportHeaderLines(recommendation) {
  return [
    "## Capability Routing Recommendation",
    "",
    `mode: ${recommendation.mode}`,
    `prompt: ${recommendation.prompt}`,
    `primaryRoute: ${recommendation.primaryRoute.route}`,
    `primaryLabel: ${recommendation.primaryRoute.label}`,
    `primaryTarget: ${recommendation.primaryRoute.targetName ?? "none"}`,
    `primaryTargetType: ${recommendation.primaryRoute.targetType ?? "none"}`,
    `primaryExecutionMode: ${recommendation.primaryRoute.executionMode ?? "none"}`,
    `primaryScore: ${recommendation.primaryRoute.score}`,
    `confidence: ${recommendation.confidence?.label ?? "unknown"}${recommendation.confidence?.value != null ? ` (${recommendation.confidence.value})` : ""}`,
    `supportLevel: ${recommendation.primaryRoute.supportLevel}`,
    `matchedPromptTokens: ${recommendation.promptTokens.join(", ") || "none"}`,
    `requiresLookup: ${recommendation.promptNeed?.requiresLookup === true}`,
    `hasTemporalSignal: ${recommendation.promptNeed?.hasTemporalSignal === true}`,
    `wantsContinuity: ${recommendation.promptNeed?.wantsContinuity === true}`,
    `greeting: ${recommendation.promptProfile?.greeting === true}`,
    "",
    "## Why This Route",
    "",
    ...buildCapabilityRecommendationReasonLines(recommendation.primaryRoute),
    "",
  ];
}

function buildCapabilityRecommendationReportSections(recommendation, { limit = 5 } = {}) {
  const lines = [
    "",
    "## Ranked Route Candidates",
    "",
  ];

  for (const candidate of takeLimited(recommendation.routeCandidates, limit)) {
    lines.push(...buildRouteCandidateLines(candidate));
  }

  lines.push("", "## Matched Local Capabilities", "");
  const capabilityMatches = takeLimited(recommendation.capabilityMatches, limit);
  if (capabilityMatches.length === 0) {
    lines.push("- none");
  } else {
    for (const match of capabilityMatches) {
      lines.push(...buildCapabilityMatchLines(match));
    }
  }

  lines.push(
    "",
    "## Recommendation Notes",
    "",
    "- This router core is recommendation-only; it does not invoke skills, agents, or background work automatically.",
    "- The inventory is local-first and scans repo-authored skills, agents, and extension/lore tool surfaces.",
    "- Retrieval targets are selected explicitly among lore_recall, lore_reflect, memory_search, and memory_explain.",
  );
  return lines;
}

/**
 * Render a capability router evaluation result as markdown.
 *
 * @param {object} result
 * @returns {string}
 */
export function renderCapabilityEvaluationReport(result) {
  const lines = [
    ...buildEvaluationHeader(result),
    ...result.cases.flatMap((item) => formatCaseDetails(item)),
  ];

  return lines.join("\n");
}

/**
 * Render a capability inventory snapshot as markdown.
 *
 * @param {object} inventory
 * @param {{ detailLevel?: string, limit?: number }} [options]
 * @returns {string}
 */
export function renderCapabilityInventoryReport(inventory, { detailLevel = "summary", limit = 6 } = {}) {
  const lines = [
    "## Capability Inventory",
    "",
    `mode: ${inventory.mode}`,
    `generatedAt: ${inventory.generatedAt}`,
    `rootPath: ${inventory.rootPath}`,
    `skills: ${inventory.counts.skills}`,
    `agents: ${inventory.counts.agents}`,
    `extensions: ${inventory.counts.extensions}`,
    `tools: ${inventory.counts.tools}`,
    `capabilities: ${inventory.counts.capabilities}`,
    `manifestEntries: ${inventory.counts.manifestEntries}`,
    "",
    "## Route Families",
    "",
    ...inventory.routes.map(formatRoute),
  ];

  if (detailLevel === "full") {
    lines.push(
      "",
      "## Skills",
      "",
      ...(inventory.skills.length > 0 ? inventory.skills.map(formatCapability) : ["- none"]),
      "",
      "## Agents",
      "",
      ...(inventory.agents.length > 0 ? inventory.agents.map(formatCapability) : ["- none"]),
      "",
      "## Tools",
      "",
      ...(inventory.tools.length > 0 ? inventory.tools.map(formatCapability) : ["- none"]),
      "",
      "## Manifest Entries",
      "",
      ...(inventory.manifest.length > 0
        ? inventory.manifest.map((entry) =>
          `- ${entry.id} routeKind=${entry.routeKind} target=${entry.targetName} executionMode=${entry.executionMode} source=${entry.sourcePath} triggerTerms=${entry.triggerTerms.slice(0, 6).join(",") || "none"}`,
        )
        : ["- none"]),
      "",
      "## Extensions",
      "",
      ...(inventory.extensions.length > 0
        ? inventory.extensions.map((extension) =>
          `- ${extension.name} hooks=${extension.hookNames.join(",") || "none"} tools=${extension.toolNames.join(",") || "none"} source=${extension.sourcePath}`,
        )
        : ["- none"]),
      "",
      "## Router Corpus Scaffold",
      "",
      `- status=${inventory.routerCorpus.status} explanationMode=${inventory.routerCorpus.explanationMode}`,
      ...inventory.routerCorpus.routeFamilies.map((family) =>
        `- ${family.id} expectedRouteKind=${family.expectedRouteKind} description=${family.description}`,
      ),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "## Representative Capabilities",
    "",
    ...(takeLimited(inventory.capabilities, limit).map(formatCapability)),
  );
  return lines.join("\n");
}

/**
 * Render a routing recommendation as markdown.
 *
 * @param {object} recommendation
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function renderCapabilityRecommendationReport(recommendation, { limit = 5 } = {}) {
  return [
    ...buildCapabilityRecommendationReportHeaderLines(recommendation),
    ...buildCapabilityRecommendationReportSections(recommendation, { limit }),
  ].join("\n");
}
