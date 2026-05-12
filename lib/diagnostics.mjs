import { assembleMemoryCapsule, detectPromptContextNeed } from "./capsule-assembler.mjs";
import { recallMemory } from "./memory-operations.mjs";
import { buildProceduralProfile, detectRelevantInstructionFiles } from "./procedural-memory.mjs";

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

const LATENCY_SNAPSHOT_FIELDS = Object.freeze([
  ["p50Ms", 0],
  ["p95Ms", 0],
  ["averageMs", 0],
  ["maxMs", 0],
  ["latestMs", 0],
  ["readiness", "unknown"],
  ["samples", 0],
  ["minSamples", 0],
  ["targetMs", 0],
  ["targetStatus", "unknown"],
  ["recentAverageMs", 0],
  ["previousAverageMs", 0],
  ["trend", "unknown"],
  ["trendDeltaMs", 0],
]);

function normalizeLatencyPhase(snapshot) {
  return Object.fromEntries(
    LATENCY_SNAPSHOT_FIELDS.map(([key, fallback]) => [key, snapshot?.[key] ?? fallback]),
  );
}

function buildLatencySummary(metrics, phaseName, snapshot) {
  const suffix = phaseName[0].toUpperCase() + phaseName.slice(1);
  return {
    [`${phaseName}P95Ms`]: Math.round(metrics?.[`${phaseName}P95`] ?? 0),
    [`${phaseName}Samples`]: metrics?.sampleSize?.[phaseName] ?? 0,
    [`${phaseName}P95Readiness`]: snapshot.readiness,
    [`${phaseName}MinSamplesForP95`]: snapshot.minSamples,
  };
}

function latencySnapshot(metrics) {
  const sessionStart = normalizeLatencyPhase(metrics?.sessionStart);
  const userPromptSubmitted = normalizeLatencyPhase(metrics?.userPromptSubmitted);
  return {
    ...buildLatencySummary(metrics, "sessionStart", sessionStart),
    ...buildLatencySummary(metrics, "userPromptSubmitted", userPromptSubmitted),
    sessionStart,
    userPromptSubmitted,
  };
}

function getByPath(object, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, segment) => (current == null ? undefined : current[segment]), object);
}

function extractSectionTitles(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.match(/^##\s+(.+)$/))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

function summarizeTraceRow(row) {
  if (!row || typeof row !== "object") {
    return "";
  }
  const repositoryLabel = row.repository ? ` (${row.repository})` : "";
  if (typeof row.content === "string" && row.content.length > 0) {
    return `[${row.type ?? row.sourceType ?? "row"}] ${row.content}${repositoryLabel}`;
  }
  if (typeof row.summary === "string" && row.summary.length > 0) {
    return `${row.summary}${repositoryLabel}`;
  }
  if (typeof row.excerpt === "string" && row.excerpt.length > 0) {
    return `${row.excerpt}${repositoryLabel}`;
  }
  return JSON.stringify(row);
}

function formatLookupLabel(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function aggregateFilteredReasons(filtered) {
  const counts = new Map();
  for (const item of ensureArray(filtered)) {
    const key = String(item.reason || "filtered");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => `${reason} x${count}`)
    .join(", ");
}

function normalizeLookupCounts(lookup) {
  return {
    rows: ensureArray(lookup?.rows),
    rankedRows: ensureArray(lookup?.rankedRows),
    includedRows: ensureArray(lookup?.includedRows),
    filtered: ensureArray(lookup?.filtered),
  };
}

function buildLookupMetadataLines(lookup) {
  const lines = [];
  if ("enabled" in lookup) {
    lines.push(`- enabled: ${lookup.enabled === true}`);
  }
  if (typeof lookup.query === "string" && lookup.query.length > 0) {
    lines.push(`- query: ${lookup.query}`);
  }
  if (Array.isArray(lookup.scopes) && lookup.scopes.length > 0) {
    lines.push(`- scopes: ${lookup.scopes.join(", ")}`);
  }
  if (Array.isArray(lookup.eligibleScopes) && lookup.eligibleScopes.length > 0) {
    lines.push(`- eligibleScopes: ${lookup.eligibleScopes.join(", ")}`);
  }
  return lines;
}

function buildLookupCountLines(lookup, { rows, rankedRows, includedRows, filtered }) {
  const lines = rows.length > 0
    ? [`- matched: ${rows.length}`]
    : rankedRows.length > 0
      ? [`- ranked: ${rankedRows.length}`]
      : [];
  lines.push(`- included: ${includedRows.length}`, `- dropped: ${filtered.length}`);
  if (lookup.reason) {
    lines.push(`- reason: ${lookup.reason}`);
  }
  const filteredSummary = aggregateFilteredReasons(filtered);
  if (filteredSummary) {
    lines.push(`- filtered: ${filteredSummary}`);
  }
  return lines;
}

function buildLookupSampleLines(includedRows) {
  if (includedRows.length === 0) {
    return [];
  }
  return [
    "- sample:",
    ...includedRows.slice(0, 3).map((row) => `  - ${summarizeTraceRow(row)}`),
  ];
}

function renderLookup(name, lookup) {
  if (!lookup || typeof lookup !== "object") {
    return "";
  }
  const counts = normalizeLookupCounts(lookup);
  return [
    `### ${formatLookupLabel(name)}`,
    ...buildLookupMetadataLines(lookup),
    ...buildLookupCountLines(lookup, counts),
    ...buildLookupSampleLines(counts.includedRows),
  ].join("\n");
}

function renderLatencyMetric(label, metric) {
  return `- ${label}: ${formatLatencySummary(normalizeLatencyMetric(metric))}`;
}

function formatLatencySummary(metric) {
  return [
    `samples=${metric.samples}`,
    `readiness=${metric.readiness}`,
    `target=${metric.targetMs}ms`,
    `status=${metric.targetStatus}`,
    `p50=${metric.p50Ms}`,
    `p95=${metric.p95Ms}`,
    `avg=${metric.averageMs}`,
    `max=${metric.maxMs}`,
    `latest=${metric.latestMs}`,
    `recentAvg=${metric.recentAverageMs}`,
    `previousAvg=${metric.previousAverageMs}`,
    `trend=${metric.trend}`,
    `delta=${metric.trendDeltaMs}`,
  ].join(" ");
}

function normalizeLatencyMetric(metric) {
  const {
    samples = 0,
    readiness = "unknown",
    targetMs = 0,
    targetStatus = "unknown",
    p50Ms = 0,
    p95Ms = 0,
    averageMs = 0,
    maxMs = 0,
    latestMs = 0,
    recentAverageMs = 0,
    previousAverageMs = 0,
    trend = "unknown",
    trendDeltaMs = 0,
  } = metric ?? {};
  return {
    samples,
    readiness,
    targetMs,
    targetStatus,
    p50Ms,
    p95Ms,
    averageMs,
    maxMs,
    latestMs,
    recentAverageMs,
    previousAverageMs,
    trend,
    trendDeltaMs,
  };
}

function normalizeComparisonText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTraceRowText(row) {
  if (!row || typeof row !== "object") {
    return "";
  }
  return normalizeComparisonText([
    row.type,
    row.sourceType,
    row.content,
    row.summary,
    row.excerpt,
    ...ensureArray(row.decisions),
    ...ensureArray(row.actions),
    ...ensureArray(row.openItems),
    ...ensureArray(row.themes),
    row.repository,
    row.date_key,
    row.dateKey,
  ].filter(Boolean).join(" "));
}

function flattenTraceRows(trace) {
  const ranked = [];
  const included = [];
  const lookups = trace?.lookups && typeof trace.lookups === "object"
    ? Object.entries(trace.lookups)
    : [];

  function pushRowItems(target, rows, lookupName) {
    ensureArray(rows).forEach((row, index) => {
      target.push({
        lookupName,
        position: index + 1,
        summary: summarizeTraceRow(row),
        text: buildTraceRowText(row),
        row,
      });
    });
  }

  for (const [lookupName, lookup] of lookups) {
    pushRowItems(ranked, lookup?.rankedRows, lookupName);
    pushRowItems(included, lookup?.includedRows, lookupName);
  }

  return { ranked, included };
}

function countTraceRows(lookup) {
  const rows = ensureArray(lookup?.rows);
  const rankedRows = ensureArray(lookup?.rankedRows);
  const includedRows = ensureArray(lookup?.includedRows);
  return Math.max(rows.length, rankedRows.length, includedRows.length);
}

function incrementCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function lookupInsightEntry(name) {
  return {
    name,
    seenCases: 0,
    matchedCases: 0,
    includedCases: 0,
    filteredCases: 0,
    matchedRows: 0,
    includedRows: 0,
  };
}

function collectLookupInsight(lookupMap, name, lookup) {
  const entry = lookupMap.get(name) ?? lookupInsightEntry(name);
  const matchedRows = countTraceRows(lookup);
  const includedRows = ensureArray(lookup?.includedRows).length;
  entry.seenCases += 1;
  if (matchedRows > 0) {
    entry.matchedCases += 1;
    entry.matchedRows += matchedRows;
  }
  if (includedRows > 0) {
    entry.includedCases += 1;
    entry.includedRows += includedRows;
  }
  if (ensureArray(lookup?.filtered).length > 0) {
    entry.filteredCases += 1;
  }
  lookupMap.set(name, entry);
}

function collectDiagnosticMaps(caseList) {
  const lookupMap = new Map();
  const sectionMap = new Map();
  const omissionMap = new Map();
  for (const item of caseList) {
    ensureArray(item.sectionTitles).forEach((title) => incrementCount(sectionMap, title));
    ensureArray(item.trace?.omissions).forEach((omission) => incrementCount(omissionMap, `${omission.stage}:${omission.reason}`));
    Object.entries(item.trace?.lookups ?? {}).forEach(([name, lookup]) => collectLookupInsight(lookupMap, name, lookup));
  }
  return { lookupMap, sectionMap, omissionMap };
}

function sortLookupHitRates(left, right) {
  if (right.includedRate !== left.includedRate) {
    return right.includedRate - left.includedRate;
  }
  if (right.matchedRate !== left.matchedRate) {
    return right.matchedRate - left.matchedRate;
  }
  return left.name.localeCompare(right.name);
}

function buildLookupHitRates(lookupMap) {
  return [...lookupMap.values()]
    .map((entry) => ({
      ...entry,
      matchedRate: entry.seenCases > 0 ? entry.matchedCases / entry.seenCases : 0,
      includedRate: entry.seenCases > 0 ? entry.includedCases / entry.seenCases : 0,
    }))
    .sort(sortLookupHitRates);
}

function buildSectionUsage(sectionMap, totalCases) {
  return [...sectionMap.entries()]
    .map(([title, count]) => ({
      title,
      count,
      rate: totalCases > 0 ? count / totalCases : 0,
    }))
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title));
}

function buildRepeatedWins(lookupHitRates) {
  return lookupHitRates
    .filter((entry) => entry.includedCases >= 2)
    .map((entry) => ({ label: entry.name, count: entry.includedCases }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function buildRepeatedMisses(omissionMap) {
  return [...omissionMap.entries()]
    .filter(([, count]) => count >= 2)
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function buildDiagnosticInsights(cases) {
  const caseList = ensureArray(cases);
  const totalCases = caseList.length;
  const { lookupMap, sectionMap, omissionMap } = collectDiagnosticMaps(caseList);
  const lookupHitRates = buildLookupHitRates(lookupMap);

  return {
    totalCases,
    lookupHitRates,
    sectionUsage: buildSectionUsage(sectionMap, totalCases),
    repeatedWins: buildRepeatedWins(lookupHitRates),
    repeatedMisses: buildRepeatedMisses(omissionMap),
  };
}

function matchesEvidenceItem(traceRow, definition) {
  const includesAny = ensureArray(definition.includesAny).map((value) => normalizeComparisonText(value));
  const types = ensureArray(definition.types).map((value) => String(value).trim()).filter(Boolean);
  const rowType = String(traceRow?.row?.type ?? traceRow?.row?.sourceType ?? "").trim();
  const textMatches = includesAny.length === 0 || includesAny.some((snippet) => traceRow.text.includes(snippet));
  const typeMatches = types.length === 0 || types.includes(rowType);
  return textMatches && typeMatches;
}

function evaluateExpectedEvidence(definition, explanation) {
  const expectedItems = ensureArray(definition.expectedEvidence).map((item) => (
    typeof item === "string"
      ? { label: item, includesAny: [item] }
      : item
  ));
  const traceRows = flattenTraceRows(explanation.trace);

  const items = expectedItems.map((item) => {
    const rankedMatches = traceRows.ranked.filter((traceRow) => matchesEvidenceItem(traceRow, item));
    const includedMatches = traceRows.included.filter((traceRow) => matchesEvidenceItem(traceRow, item));
    const bestRankedPosition = rankedMatches.length > 0
      ? Math.min(...rankedMatches.map((match) => match.position))
      : null;
    const bestIncludedPosition = includedMatches.length > 0
      ? Math.min(...includedMatches.map((match) => match.position))
      : null;
    const outcome = bestIncludedPosition != null
      ? "included"
      : bestRankedPosition != null
        ? "ranked_only"
        : "missing";
    return {
      label: item.label ?? item.includesAny?.[0] ?? item.types?.[0] ?? "expected-evidence",
      includesAny: ensureArray(item.includesAny),
      types: ensureArray(item.types),
      outcome,
      bestRankedPosition,
      bestIncludedPosition,
      rankedMatchCount: rankedMatches.length,
      includedMatchCount: includedMatches.length,
      sample: includedMatches[0]?.summary ?? rankedMatches[0]?.summary ?? null,
      matchedLookups: [...new Set([...includedMatches, ...rankedMatches].map((match) => match.lookupName))],
    };
  });

  return {
    expectedCount: items.length,
    includedCount: items.filter((item) => item.outcome === "included").length,
    rankedOnlyCount: items.filter((item) => item.outcome === "ranked_only").length,
    missingCount: items.filter((item) => item.outcome === "missing").length,
    items,
  };
}

function isRankingTargetReplayMiss(definition, evidence) {
  return (definition.caseType ?? "must_pass") === "ranking_target" && evidence.missingCount > 0;
}

function hasUnexpectedCrossRepoLeak(sectionTitles, explanation) {
  const hasCrossRepoLeak = sectionTitles.includes("Cross-Repo Examples") || sectionTitles.includes("Cross-Repo Hints");
  return hasCrossRepoLeak && explanation.promptNeed?.wantsCrossRepoExamples !== true;
}

function hasLocalReplayCandidates(localEpisodes, localMemories) {
  return [
    ensureArray(localEpisodes?.includedRows).length,
    ensureArray(localEpisodes?.rankedRows).length,
    ensureArray(localMemories?.includedRows).length,
  ].some((count) => count > 0);
}

function rankedReplayTexts(explanation) {
  return flattenTraceRows(explanation.trace).ranked.map((row) => row.text).join(" ");
}

function classifyReplayMiss(definition, explanation, evidence) {
  if (!isRankingTargetReplayMiss(definition, evidence)) {
    return null;
  }

  const sectionTitles = explanation.trace?.output?.sectionTitles ?? extractSectionTitles(explanation.text);
  const localEpisodes = explanation.trace?.lookups?.localEpisodes;
  const localMemories = explanation.trace?.lookups?.localMemories;
  if (hasUnexpectedCrossRepoLeak(sectionTitles, explanation)) {
    return "scope_classification";
  }
  if (!hasLocalReplayCandidates(localEpisodes, localMemories)) {
    return "lexical_ranking";
  }
  return /\b(files created|files modified|remaining work|immediate next steps|diagnostics\/validation|the user|the conversation)\b/i.test(rankedReplayTexts(explanation))
    ? "extraction_shape"
    : "lexical_ranking";
}

function addEqualityAssertions(assertions, values = {}, labelBuilder, valueReader) {
  for (const [key, expected] of Object.entries(values)) {
    const actual = valueReader(key);
    assertions.push({
      label: labelBuilder(key, expected),
      passed: actual === expected,
      details: `actual=${JSON.stringify(actual)}`,
    });
  }
}

function addTruthyPathAssertions(assertions, paths, trace) {
  for (const path of ensureArray(paths)) {
    const actual = getByPath(trace, path);
    assertions.push({
      label: `trace ${path} is present`,
      passed: Boolean(actual),
      details: `actual=${JSON.stringify(actual)}`,
    });
  }
}

function addTraceMinimumAssertions(assertions, minimums = {}, trace) {
  for (const [path, minimum] of Object.entries(minimums)) {
    const value = getByPath(trace, path);
    const count = Array.isArray(value) ? value.length : Number(value ?? 0);
    assertions.push({
      label: `${path} >= ${minimum}`,
      passed: count >= minimum,
      details: `actual=${count}`,
    });
  }
}

function addSectionAssertions(assertions, sectionTitles, expect) {
  for (const title of ensureArray(expect.mustIncludeSections)) {
    assertions.push({
      label: `section includes "${title}"`,
      passed: sectionTitles.includes(title),
      details: `actual=[${sectionTitles.join(", ")}]`,
    });
  }

  for (const title of ensureArray(expect.mustNotIncludeSections)) {
    assertions.push({
      label: `section excludes "${title}"`,
      passed: !sectionTitles.includes(title),
      details: `actual=[${sectionTitles.join(", ")}]`,
    });
  }

  const includeOneOf = ensureArray(expect.mustIncludeOneOfSections);
  if (includeOneOf.length > 0) {
    assertions.push({
      label: `section includes one of ${includeOneOf.join(", ")}`,
      passed: includeOneOf.some((title) => sectionTitles.includes(title)),
      details: `actual=[${sectionTitles.join(", ")}]`,
    });
  }
}

function addTextAssertions(assertions, text, expect) {
  const textMustIncludeAny = ensureArray(expect.textMustIncludeAny);
  if (textMustIncludeAny.length > 0) {
    assertions.push({
      label: `text includes one of ${textMustIncludeAny.join(", ")}`,
      passed: textMustIncludeAny.some((snippet) => text.includes(snippet)),
      details: text,
    });
  }

  for (const snippet of ensureArray(expect.textMustIncludeAll)) {
    assertions.push({
      label: `text includes "${snippet}"`,
      passed: text.includes(snippet),
      details: text,
    });
  }

  for (const snippet of ensureArray(expect.textMustNotInclude)) {
    assertions.push({
      label: `text excludes "${snippet}"`,
      passed: !text.includes(snippet),
      details: text,
    });
  }
}

function evaluateCase(definition, explanation) {
  const assertions = [];
  const sectionTitles = explanation.trace?.output?.sectionTitles ?? extractSectionTitles(explanation.text);
  const text = String(explanation.text || "");
  const expect = definition.expect ?? {};
  addEqualityAssertions(
    assertions,
    expect.promptNeed,
    (field, expected) => `promptNeed.${field} === ${expected}`,
    (field) => explanation.promptNeed?.[field],
  );
  addTruthyPathAssertions(assertions, expect.traceTruthyPaths, explanation.trace);
  addTraceMinimumAssertions(assertions, expect.traceMinCounts, explanation.trace);
  addEqualityAssertions(
    assertions,
    expect.traceEquals,
    (path, expected) => `trace ${path} === ${JSON.stringify(expected)}`,
    (path) => getByPath(explanation.trace, path),
  );
  addSectionAssertions(assertions, sectionTitles, expect);
  addTextAssertions(assertions, text, expect);

  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    sectionTitles,
  };
}

function summarizeFailedAssertions(assertions = []) {
  const failed = ensureArray(assertions).filter((assertion) => assertion?.passed === false);
  if (failed.length === 0) {
    return "Case failed without assertion details.";
  }
  return failed
    .slice(0, 3)
    .map((assertion) => assertion.details
      ? `${assertion.label} (${assertion.details})`
      : assertion.label)
    .join(" | ");
}

function createImprovementLinkedMemory({
  runtime,
  sourceKind,
  caseId,
  title,
  missCategory,
}) {
  if (runtime.config?.rollout?.autoWriteImprovementGoals !== true) {
    return null;
  }
  const now = new Date().toISOString();
  if (sourceKind === "validation") {
    return runtime.db.insertSemanticMemory({
      type: "assistant_goal",
      content: `Improvement goal: fix diagnostics validation case "${caseId}" (${title}).`,
      scope: "global",
      confidence: 0.95,
      tags: ["diagnostics-improvement", "assistant-goal", "validation"],
      metadata: {
        source: "diagnostics_improvement",
        sourceKind,
        sourceCaseId: caseId,
        capturedAt: now,
      },
    });
  }
  return runtime.db.insertSemanticMemory({
    type: "recurring_mistake",
    content: `Recurring mistake to avoid: replay case "${caseId}" missed expected evidence${missCategory ? ` (${missCategory})` : ""}.`,
    scope: "global",
    confidence: 0.95,
    tags: ["diagnostics-improvement", "recurring-mistake", "replay"],
    metadata: {
      source: "diagnostics_improvement",
      sourceKind,
      sourceCaseId: caseId,
      missCategory: missCategory ?? null,
      capturedAt: now,
    },
  });
}

function persistValidationFailureArtifact({ runtime, definition, evaluation, explanation }) {
  const linkedMemoryId = createImprovementLinkedMemory({
    runtime,
    sourceKind: "validation",
    caseId: definition.id,
    title: definition.title,
  });
  const summary = summarizeFailedAssertions(evaluation.assertions);
  const id = runtime.db.upsertImprovementArtifact({
    sourceCaseId: definition.id,
    sourceKind: "validation",
    title: definition.title,
    summary,
    linkedMemoryId,
    evidence: {
      mode: definition.mode,
      prompt: definition.prompt,
      failedAssertions: ensureArray(evaluation.assertions).filter((assertion) => assertion?.passed === false),
      sectionTitles: evaluation.sectionTitles,
      estimatedTokens: explanation.estimatedTokens ?? 0,
    },
    trace: explanation.trace ?? {},
  });
  runtime.db.insertTrajectoryArtifact({
    kind: "validation_miss",
    repository: runtime.repository,
    sourceCaseId: definition.id,
    sourceKind: "validation",
    improvementArtifactId: id,
    eventKey: `validation:${definition.id}:${id}`,
    summary: `Validation miss for ${definition.id}: ${summary}`,
    severity: "warning",
    outcome: "failed",
    context: {
      title: definition.title,
      mode: definition.mode,
      promptNeed: explanation.promptNeed ?? null,
      failedAssertionCount: ensureArray(evaluation.assertions).filter((assertion) => assertion?.passed === false).length,
      sectionTitles: evaluation.sectionTitles,
      estimatedTokens: explanation.estimatedTokens ?? 0,
    },
    trace: explanation.trace ?? {},
  });
  return id;
}

function persistReplayFailureArtifact({
  runtime,
  definition,
  evaluation,
  explanation,
  evidence,
  rankingOutcome,
  missCategory,
}) {
  const failedAssertions = ensureArray(evaluation.assertions).filter((assertion) => assertion?.passed === false);
  const linkedMemoryId = createImprovementLinkedMemory({
    runtime,
    sourceKind: "replay",
    caseId: definition.id,
    title: definition.title,
    missCategory,
  });
  const summaryParts = buildReplayFailureSummaryParts({
    definition,
    evaluation,
    rankingOutcome,
    missCategory,
  });
  const id = runtime.db.upsertImprovementArtifact({
    sourceCaseId: definition.id,
    sourceKind: "replay",
    title: definition.title,
    summary: summaryParts.join(" | "),
    linkedMemoryId,
    evidence: buildReplayFailureEvidence({
      definition,
      explanation,
      evidence,
      rankingOutcome,
      missCategory,
      failedAssertions,
    }),
    trace: explanation.trace ?? {},
  });
  runtime.db.insertTrajectoryArtifact({
    kind: "replay_failure",
    repository: runtime.repository,
    sourceCaseId: definition.id,
    sourceKind: "replay",
    improvementArtifactId: id,
    eventKey: `replay:${definition.id}:${id}`,
    summary: `Replay failure for ${definition.id}: ${summaryParts.join(" | ")}`,
    severity: "warning",
    outcome: definition.caseType === "must_pass" ? "must_pass_failed" : "ranking_miss",
    context: buildReplayFailureContext({
      definition,
      explanation,
      evidence,
      rankingOutcome,
      missCategory,
      failedAssertions,
    }),
    trace: explanation.trace ?? {},
  });
  return id;
}

function buildReplayFailureSummaryParts({
  definition,
  evaluation,
  rankingOutcome,
  missCategory,
}) {
  if (definition.caseType === "must_pass") {
    return [summarizeFailedAssertions(evaluation.assertions)];
  }
  return [
    `Ranking outcome: ${rankingOutcome ?? "missing"}`,
    ...(missCategory ? [`Miss category: ${missCategory}`] : []),
  ];
}

function buildReplayFailureEvidence({
  definition,
  explanation,
  evidence,
  rankingOutcome,
  missCategory,
  failedAssertions,
}) {
  return {
    mode: definition.mode,
    prompt: definition.prompt,
    caseType: definition.caseType ?? "must_pass",
    rankingOutcome: rankingOutcome ?? null,
    missCategory: missCategory ?? null,
    failedAssertions,
    expectedEvidence: evidence,
    estimatedTokens: explanation.estimatedTokens ?? 0,
  };
}

function buildReplayFailureContext({
  definition,
  explanation,
  evidence,
  rankingOutcome,
  missCategory,
  failedAssertions,
}) {
  return {
    title: definition.title,
    caseType: definition.caseType ?? "must_pass",
    mode: definition.mode,
    rankingOutcome: rankingOutcome ?? null,
    missCategory: missCategory ?? null,
    failedAssertionCount: failedAssertions.length,
    expectedEvidenceCount: evidence?.expectedCount ?? 0,
    includedEvidenceCount: evidence?.includedCount ?? 0,
    rankedOnlyEvidenceCount: evidence?.rankedOnlyCount ?? 0,
    estimatedTokens: explanation.estimatedTokens ?? 0,
  };
}

const DIAGNOSTIC_SEED_NAME = "Taylor";
const DIAGNOSTIC_ASSISTANT_NAME = "Jules";
const DIAGNOSTIC_STYLE_PREFERENCE = "Prefer a conversational, teammate-like tone and use the user's preferred name where appropriate.";
const DIAGNOSTIC_ASSISTANT_IDENTITY_MEMORY = Object.freeze({
  type: "assistant_identity",
  content: `The assistant's name is ${DIAGNOSTIC_ASSISTANT_NAME}.`,
  scope: "global",
  confidence: 1,
  tags: ["diagnostics-seed", "assistant-identity", DIAGNOSTIC_ASSISTANT_NAME.toLowerCase()],
  metadata: {
    source: "diagnostics_seed",
    assistantName: DIAGNOSTIC_ASSISTANT_NAME,
  },
});
const DIAGNOSTIC_INTERACTION_STYLE_MEMORY = Object.freeze({
  type: "interaction_style",
  content: "Interaction style preference: be like a warm, chaotic-good teammate with quick wit, playful irreverence, and good-times energy; use humor freely when it helps and use the user's preferred name naturally.",
  scope: "global",
  confidence: 1,
  tags: ["diagnostics-seed", "interaction-style"],
  metadata: {
    source: "diagnostics_seed",
    profile: {
      voice: "colleague",
      warmth: "warm",
      humor: "light",
      humorFrequency: "frequent",
      collaborative: true,
      useNameNaturally: true,
    },
  },
});

const DIAGNOSTIC_ASSISTANT_GOAL_MEMORY = Object.freeze({
  type: "assistant_goal",
  content: "Current assistant goal: Ship the smallest coherent scoped change first.",
  scope: "global",
  confidence: 1,
  tags: ["diagnostics-seed", "assistant-goal"],
  metadata: {
    source: "diagnostics_seed",
    goal: "Ship the smallest coherent scoped change first.",
  },
});

const DIAGNOSTIC_RECURRING_MISTAKE_MEMORY = Object.freeze({
  type: "recurring_mistake",
  content: "Recurring mistake to avoid: continuing investigation after user asks to implement now.",
  scope: "global",
  confidence: 1,
  tags: ["diagnostics-seed", "recurring-mistake"],
  metadata: {
    source: "diagnostics_seed",
    mistake: "continuing investigation after user asks to implement now",
  },
});

const DIAGNOSTIC_CROSS_REPO_CI_MEMORY = Object.freeze({
  type: "user_preference",
  content: "Use an example from another repo for a CI migration like before; prefer the reusable-workflow pattern from the diagnostics CI playbook.",
  scope: "transferable",
  repository: "diagnostics/ci-playbook",
  confidence: 1,
  tags: ["diagnostics-seed", "cross-repo", "ci", "migration"],
  metadata: {
    source: "diagnostics_seed",
  },
});

function seedDiagnosticsMemories(runtime) {
  return [
    runtime.db.insertSemanticMemory(DIAGNOSTIC_ASSISTANT_IDENTITY_MEMORY),
    runtime.db.insertSemanticMemory({
      type: "user_identity",
      content: `The user's preferred name is ${DIAGNOSTIC_SEED_NAME}.`,
      scope: "global",
      confidence: 1,
      tags: ["diagnostics-seed", "user-identity", "preferred-name"],
      metadata: {
        source: "diagnostics_seed",
        preferredName: DIAGNOSTIC_SEED_NAME,
      },
    }),
    runtime.db.insertSemanticMemory({
      type: "user_preference",
      content: DIAGNOSTIC_STYLE_PREFERENCE,
      scope: "global",
      confidence: 1,
      tags: ["diagnostics-seed", "user-preference", "style"],
      metadata: {
        source: "diagnostics_seed",
      },
    }),
    runtime.db.insertSemanticMemory(DIAGNOSTIC_ASSISTANT_GOAL_MEMORY),
    runtime.db.insertSemanticMemory(DIAGNOSTIC_RECURRING_MISTAKE_MEMORY),
  ];
}

function seedExtraDiagnosticsMemories(runtime, extraMemories = []) {
  return extraMemories.map((memory) => runtime.db.insertSemanticMemory(memory));
}

function cleanupSeedDiagnosticsMemories(runtime, ids) {
  const supersededBy = `diagnostics-seed:${new Date().toISOString()}`;
  for (const id of [...new Set(ids)]) {
    runtime.db.forgetMemory({ id, supersededBy });
  }
}

export const VALIDATION_CASES = Object.freeze([
  {
    id: "identity-greeting",
    caseType: "must_pass",
    title: "Greeting keeps identity and avoids cross-repo noise",
    mode: "prompt",
    prompt: "Hi Jules, how are you?",
    expect: {
      promptNeed: {
        requiresLookup: true,
        directAddressed: true,
        wantsContinuity: false,
        wantsCrossRepoExamples: false,
        identityOnly: true,
      },
      mustIncludeSections: ["Relevant Commitments, Preferences, And Identity"],
      mustNotIncludeSections: ["Relevant Prior Work", "Cross-Repo Examples", "Cross-Repo Hints", "Transferable Cross-Repo Preferences", "Response Style And Addressing"],
      textMustIncludeAny: ["Jules", "assistant_identity/global"],
      traceMinCounts: {
        "lookups.identityMemories.includedRows": 1,
      },
    },
  },
  {
    id: "identity-greeting-with-user-name",
    caseType: "must_pass",
    title: "Greeting can surface user-name addressing guidance",
    mode: "prompt",
    prompt: "Hi Jules, how are you?",
    expect: {
      promptNeed: {
        requiresLookup: true,
        directAddressed: true,
        wantsContinuity: false,
        wantsStyleContext: false,
        identityOnly: true,
      },
      mustIncludeSections: ["Relevant Commitments, Preferences, And Identity"],
      mustNotIncludeSections: ["Relevant Prior Work", "Cross-Repo Examples", "Cross-Repo Hints", "Transferable Cross-Repo Preferences", "Response Style And Addressing"],
      traceMinCounts: {
        "lookups.identityMemories.includedRows": 1,
      },
    },
  },
  {
    id: "temporal-last-thursday",
    caseType: "must_pass",
    title: "Temporal prompts surface prior work",
    mode: "prompt",
    prompt: "What did we do last Thursday?",
    extraSeedMemories: [DIAGNOSTIC_INTERACTION_STYLE_MEMORY],
    expect: {
      promptNeed: {
        requiresLookup: true,
        allowCrossRepoFallback: true,
      },
      traceTruthyPaths: ["temporalDate", "temporal.source", "temporal.confidence"],
      mustIncludeOneOfSections: ["Relevant Day Summary", "Relevant Prior Work"],
      mustNotIncludeSections: ["Response Style And Addressing", "Cross-Repo Examples", "Cross-Repo Hints"],
    },
  },
  {
    id: "temporal-last-thursday-this-repo",
    caseType: "must_pass",
    title: "Explicit repo-scoped temporal prompts stay local",
    mode: "prompt",
    prompt: "In this repo can you remember what we did last Thursday?",
    extraSeedMemories: [DIAGNOSTIC_INTERACTION_STYLE_MEMORY],
    expect: {
      promptNeed: {
        requiresLookup: true,
        allowCrossRepoFallback: false,
      },
      traceTruthyPaths: ["temporalDate", "temporal.source", "temporal.confidence"],
      mustIncludeOneOfSections: ["Relevant Day Summary", "Relevant Prior Work"],
      mustNotIncludeSections: ["Response Style And Addressing", "Cross-Repo Examples", "Cross-Repo Hints"],
    },
  },
  {
    id: "repo-local-memory-scopes",
    caseType: "must_pass",
    title: "Repo-local continuity stays local",
    mode: "prompt",
    prompt: "Remember what we did here for lore memory scopes.",
    expect: {
      promptNeed: {
        requiresLookup: true,
        wantsContinuity: true,
      },
      mustIncludeOneOfSections: ["Relevant Prior Work", "Relevant Commitments, Preferences, And Identity"],
      mustNotIncludeSections: ["Cross-Repo Examples", "Cross-Repo Hints"],
    },
  },
  {
    id: "style-colleague-humor-request",
    caseType: "must_pass",
    title: "Explicit style requests still surface prompt-local guidance",
    mode: "prompt",
    prompt: "Talk to me more like a colleague and feel free to use a little humor.",
    extraSeedMemories: [DIAGNOSTIC_INTERACTION_STYLE_MEMORY],
    expect: {
      promptNeed: {
        requiresLookup: true,
        wantsStyleContext: true,
        explicitStyleRequest: true,
      },
      mustIncludeSections: ["Response Style And Addressing"],
      textMustIncludeAny: ["Prompt-local overrides", "Follow the prompt-local style request for this prompt."],
    },
  },
  {
    id: "style-and-name-request",
    caseType: "must_pass",
    title: "Explicit style and naming requests render dedicated guidance",
    mode: "prompt",
    prompt: `Please be more conversational and call me ${DIAGNOSTIC_SEED_NAME} where appropriate.`,
    expect: {
      promptNeed: {
        requiresLookup: true,
        wantsContinuity: false,
        wantsStyleContext: true,
        wantsRepoLocalTaskContext: false,
      },
      mustIncludeSections: ["Response Style And Addressing"],
      mustNotIncludeSections: ["Relevant Prior Work", "Cross-Repo Examples", "Cross-Repo Hints", "Transferable Cross-Repo Preferences"],
      textMustIncludeAll: [
        `Address the user as "${DIAGNOSTIC_SEED_NAME}" for this prompt.`,
      ],
      textMustNotInclude: ["Matt naturally"],
      traceEquals: {
        "lookups.styleAddressing.includeAmbient": false,
      },
      traceTruthyPaths: ["lookups.styleAddressing.promptLocal.userNameOverride"],
    },
  },
  {
    id: "technical-prompt-ambient-style",
    caseType: "must_pass",
    title: "Ordinary technical prompts inherit ambient interaction style when enabled",
    mode: "prompt",
    prompt: "How does searchSemantic work in lore?",
    extraSeedMemories: [DIAGNOSTIC_INTERACTION_STYLE_MEMORY],
    expect: {
      promptNeed: {
        requiresLookup: false,
      },
      mustIncludeSections: ["Response Style And Addressing"],
      textMustIncludeAny: ["Quick wit", "chaotic-good energy", "Light humor is fine"],
    },
  },
  {
    id: "technical-prompt-no-style-profile",
    caseType: "must_pass",
    title: "Ordinary technical prompts stay style-free without an interaction-style profile",
    mode: "prompt",
    prompt: "How does searchSemantic work in lore?",
    expect: {
      promptNeed: {
        requiresLookup: false,
      },
      mustNotIncludeSections: ["Response Style And Addressing"],
      textMustNotInclude: [DIAGNOSTIC_SEED_NAME],
    },
  },
  {
    id: "serious-prompt-suppresses-ambient-style",
    caseType: "must_pass",
    title: "Serious prompts suppress ambient style and humor",
    mode: "prompt",
    prompt: "This is a serious production issue; help me debug it.",
    extraSeedMemories: [DIAGNOSTIC_INTERACTION_STYLE_MEMORY],
    expect: {
      promptNeed: {
        seriousPrompt: true,
      },
      mustNotIncludeSections: ["Response Style And Addressing"],
    },
  },
  {
    id: "cross-repo-ci-example",
    caseType: "must_pass",
    title: "Cross-repo example prompts surface labeled prior art",
    mode: "prompt",
    repository: "diagnostics/current-repo",
    prompt: "Can you use an example from another repo for a CI migration like before?",
    extraSeedMemories: [DIAGNOSTIC_CROSS_REPO_CI_MEMORY],
    expect: {
      promptNeed: {
        requiresLookup: true,
        wantsCrossRepoExamples: true,
      },
      mustIncludeOneOfSections: ["Cross-Repo Examples", "Cross-Repo Hints", "Transferable Cross-Repo Preferences"],
    },
  },
  {
    id: "session-start-identity",
    caseType: "must_pass",
    title: "Session start capsule keeps identity available",
    mode: "session_start",
    prompt: "Hi Jules, can you help me today?",
    expect: {
      promptNeed: {
        identityOnly: true,
        wantsCrossRepoExamples: false,
      },
      mustIncludeSections: ["Commitments, Preferences, And Identity"],
      mustNotIncludeSections: ["Relevant Knowledge", "Recent Related Work", "Relevant History Hints", "Long-Range Related Hints", "Cross-Repo Examples", "Cross-Repo Hints"],
      textMustIncludeAny: ["Jules", "assistant_identity"],
    },
  },
  {
    id: "session-start-style-addressing",
    caseType: "must_pass",
    title: "Session start capsule keeps style guidance disabled by default",
    mode: "session_start",
    prompt: "Hi Jules, can you help me today?",
    expect: {
      promptNeed: {
        identityOnly: true,
        wantsCrossRepoExamples: false,
      },
      mustIncludeSections: ["Commitments, Preferences, And Identity"],
      mustNotIncludeSections: ["Relevant Knowledge", "Recent Related Work", "Relevant History Hints", "Long-Range Related Hints", "Cross-Repo Examples", "Cross-Repo Hints", "Response Style And Addressing"],
      textMustNotInclude: [DIAGNOSTIC_SEED_NAME],
    },
  },
  {
    id: "session-start-ambient-style",
    caseType: "must_pass",
    title: "Session start capsule can include ambient interaction style when enabled",
    mode: "session_start",
    prompt: "How should we refactor this retrieval path?",
    extraSeedMemories: [DIAGNOSTIC_INTERACTION_STYLE_MEMORY],
    expect: {
      promptNeed: {
        requiresLookup: false,
      },
      mustIncludeSections: ["Response Style And Addressing"],
    },
  },
]);

export const REPLAY_CASES = Object.freeze([
  ...VALIDATION_CASES,
  {
    id: "ranking-phase2-prompt-shaping",
    caseType: "ranking_target",
    title: "Prompt-shaping history surfaces the phase-two changes",
    mode: "prompt",
    prompt: "When we worked on lore phase two in this repo, what did we change about prompt shaping?",
    expect: {
      mustIncludeSections: ["Relevant Prior Work"],
      mustNotIncludeSections: ["Cross-Repo Examples", "Cross-Repo Hints"],
    },
    expectedEvidence: [
      {
        label: "prompt-shaping detail",
        includesAny: ["prompt shaping", "identity-only", "cross-repo fallback"],
      },
    ],
  },
  {
    id: "ranking-scope-override-audit",
    caseType: "ranking_target",
    title: "Scope-override audit work is discoverable",
    mode: "prompt",
    prompt: "How did we make scope overrides auditable in lore?",
    expect: {
      mustIncludeOneOfSections: ["Relevant Prior Work", "Relevant Commitments, Preferences, And Identity"],
      mustNotIncludeSections: ["Cross-Repo Examples", "Cross-Repo Hints"],
    },
    expectedEvidence: [
      {
        label: "scope override audit detail",
        includesAny: ["scope override audit", "scope_override_audit", "manual overrides", "scope_source"],
      },
    ],
  },
  {
    id: "ranking-controlled-backfill-rollback",
    caseType: "ranking_target",
    title: "Controlled backfill rollback details are retrievable",
    mode: "prompt",
    prompt: "How does the controlled backfill rollback work in lore?",
    expect: {
      mustIncludeOneOfSections: ["Relevant Prior Work", "Relevant Commitments, Preferences, And Identity"],
      mustNotIncludeSections: ["Cross-Repo Examples", "Cross-Repo Hints"],
    },
    expectedEvidence: [
      {
        label: "rollback detail",
        includesAny: ["snapshot", "restore", "vacuum into", "controlled backfill"],
      },
    ],
  },
]);

export async function explainMemoryRetrieval({
  runtime,
  prompt,
  mode = "prompt",
  repository = runtime.repository ?? null,
}) {
  if (mode === "session_start") {
    const relevantInstructionFiles = detectRelevantInstructionFiles(prompt);
    const proceduralProfile = await buildProceduralProfile({
      prompt,
      relevantInstructionFiles,
      config: runtime.config,
    });
    const result = await assembleMemoryCapsule({
      prompt,
      repository,
      proceduralProfile,
      db: runtime.db,
      sessionStore: runtime.sessionStore,
      config: runtime.config,
      includeTrace: true,
    });
    return {
      mode,
      prompt,
      repository,
      promptNeed: detectPromptContextNeed(prompt),
      text: result.text,
      trace: result.trace,
      estimatedTokens: result.estimatedTokens,
    };
  }

    const promptNeed = detectPromptContextNeed(prompt);
    const includeOtherRepositories = promptNeed.allowCrossRepoFallback === true;
    const result = recallMemory({
      db: runtime.db,
      prompt,
      repository,
      includeOtherRepositories,
      limit: runtime.config.limits.promptContextLimit,
      sessionStore: runtime.sessionStore,
      promptNeed,
    });
  return {
    mode,
    prompt,
    repository,
    promptNeed,
    text: result.text,
    trace: result.trace,
    estimatedTokens: result.trace?.output?.estimatedTokens ?? 0,
  };
}

function buildExplanationOverviewLines(explanation, sectionTitles) {
  return [
    `mode: ${explanation.mode}`,
    `repository: ${explanation.repository ?? "global-only"}`,
    `prompt: ${explanation.prompt}`,
    `requiresLookup: ${explanation.promptNeed?.requiresLookup === true}`,
    `wantsContinuity: ${explanation.promptNeed?.wantsContinuity === true}`,
    `wantsStyleContext: ${explanation.promptNeed?.wantsStyleContext === true}`,
    `wantsCrossRepoExamples: ${explanation.promptNeed?.wantsCrossRepoExamples === true}`,
    `wantsRepoLocalTaskContext: ${explanation.promptNeed?.wantsRepoLocalTaskContext === true}`,
    `identityOnly: ${explanation.promptNeed?.identityOnly === true}`,
    `directAddressed: ${explanation.promptNeed?.directAddressed === true}`,
    `estimatedTokens: ${explanation.estimatedTokens ?? 0}`,
    "",
    "## Output Sections",
    "",
    sectionTitles.length > 0
      ? sectionTitles.map((title) => `- ${title}`).join("\n")
      : "- none",
  ];
}

function buildExplanationSourceAccountingLines(sectionDetails) {
  if (sectionDetails.length === 0) {
    return [];
  }
  return [
    "",
    "## Source Accounting",
    "",
    ...sectionDetails.map((detail) =>
      `- ${detail.title}: source=${detail.source ?? "context"} tokens=${detail.usedTokens ?? 0}${detail.budget != null ? ` budget=${detail.budget}` : ""}${detail.entryCount != null ? ` entries=${detail.entryCount}` : ""}`,
    ),
  ];
}

function buildExplanationEligibilityLines(eligibility) {
  if (!eligibility) {
    return [];
  }
  return [
    "",
    "## Scope Eligibility",
    "",
    ...Object.entries(eligibility).map(
      ([key, values]) => `- ${formatLookupLabel(key)}: ${ensureArray(values).join(", ") || "none"}`,
    ),
  ];
}

function buildExplanationDecisionLines(routerDecision) {
  if (!routerDecision) {
    return [];
  }
  return [
    "",
    "## Decision Trace",
    "",
    `- route: ${routerDecision.route ?? "unknown"}`,
    `- reason: ${routerDecision.reason ?? "none"}`,
    `- includeOtherRepositories: ${routerDecision.includeOtherRepositories === true}`,
    `- usedWorkstreamOverlays: ${routerDecision.usedWorkstreamOverlays === true}`,
    `- usedLegacyPath: ${routerDecision.usedLegacyPath === true}`,
    `- additionalContext: ${routerDecision.additionalContext === true}`,
    `- sectionCount: ${routerDecision.sectionCount ?? 0}`,
  ];
}

function buildExplanationLookupLines(lookups) {
  if (!lookups) {
    return [];
  }
  const renderedLookups = Object.entries(lookups)
    .map(([name, lookup]) => renderLookup(name, lookup))
    .filter(Boolean);
  if (renderedLookups.length === 0) {
    return [];
  }
  return ["", "## Lookups", "", ...renderedLookups];
}

function buildExplanationOmissionLines(omissions) {
  if (omissions.length === 0) {
    return [];
  }
  return [
    "",
    "## Omitted Or Suppressed",
    "",
    ...omissions.map((omission) => `- ${omission.stage}: ${omission.reason}`),
  ];
}

export function renderExplanationReport(explanation) {
  const sectionTitles = explanation.trace?.output?.sectionTitles ?? extractSectionTitles(explanation.text);
  const sectionDetails = ensureArray(explanation.trace?.output?.sectionDetails);
  const routerDecision = explanation.trace?.routerDecision;
  const omissions = ensureArray(explanation.trace?.omissions);
  return [
    ...buildExplanationOverviewLines(explanation, sectionTitles),
    ...buildExplanationSourceAccountingLines(sectionDetails),
    ...buildExplanationEligibilityLines(explanation.trace?.eligibility),
    ...buildExplanationDecisionLines(routerDecision),
    ...buildExplanationLookupLines(explanation.trace?.lookups),
    ...buildExplanationOmissionLines(omissions),
    "",
    "## Generated Context",
    "",
    explanation.text || "No additional context.",
  ].join("\n");
}

export async function runValidationSet({ runtime, caseIds = [] }) {
  const selected = caseIds.length > 0
    ? VALIDATION_CASES.filter((testCase) => caseIds.includes(testCase.id))
    : VALIDATION_CASES;

  const seededIds = seedDiagnosticsMemories(runtime);
  try {
    const cases = [];
    const improvementArtifacts = [];
    for (const definition of selected) {
      const extraSeedIds = seedExtraDiagnosticsMemories(runtime, definition.extraSeedMemories ?? []);
      try {
        const explanation = await explainMemoryRetrieval({
          runtime,
          prompt: definition.prompt,
          mode: definition.mode,
          repository: definition.repository ?? runtime.repository ?? null,
        });
        const evaluation = evaluateCase(definition, explanation);
        cases.push({
          id: definition.id,
          title: definition.title,
          mode: definition.mode,
          prompt: definition.prompt,
          passed: evaluation.passed,
          sectionTitles: evaluation.sectionTitles,
          assertions: evaluation.assertions,
          estimatedTokens: explanation.estimatedTokens ?? 0,
          trace: explanation.trace,
          text: explanation.text,
          promptNeed: explanation.promptNeed,
        });
        if (!evaluation.passed) {
          const artifactId = persistValidationFailureArtifact({
            runtime,
            definition,
            evaluation,
            explanation,
          });
          improvementArtifacts.push({
            id: artifactId,
            sourceKind: "validation",
            sourceCaseId: definition.id,
            title: definition.title,
          });
        }
      } finally {
        cleanupSeedDiagnosticsMemories(runtime, extraSeedIds);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      repository: runtime.repository,
      latency: latencySnapshot(runtime.metrics),
      total: cases.length,
      passed: cases.filter((item) => item.passed).length,
      failed: cases.filter((item) => !item.passed).length,
      improvementArtifacts,
      insights: buildDiagnosticInsights(cases),
      cases,
    };
  } finally {
    cleanupSeedDiagnosticsMemories(runtime, seededIds);
  }
}

export async function runReplayCorpus({ runtime, caseIds = [] }) {
  const selected = caseIds.length > 0
    ? REPLAY_CASES.filter((testCase) => caseIds.includes(testCase.id))
    : REPLAY_CASES;
  const seededIds = seedDiagnosticsMemories(runtime);
  try {
    const replay = await collectReplayCases(runtime, selected);
    return buildReplayCorpusResult(runtime, replay);
  } finally {
    cleanupSeedDiagnosticsMemories(runtime, seededIds);
  }
}

function deriveReplayRankingOutcome(definition, evidence) {
  if (definition.caseType !== "ranking_target") {
    return null;
  }
  if (evidence.missingCount === 0 && evidence.expectedCount > 0) {
    return "included";
  }
  return evidence.includedCount > 0 || evidence.rankedOnlyCount > 0 ? "partial" : "missing";
}

function buildReplayCaseResult(definition, evaluation, explanation, evidence, rankingOutcome, missCategory) {
  return {
    id: definition.id,
    caseType: definition.caseType ?? "must_pass",
    title: definition.title,
    mode: definition.mode,
    prompt: definition.prompt,
    passed: evaluation.passed,
    rankingOutcome,
    missCategory,
    sectionTitles: evaluation.sectionTitles,
    assertions: evaluation.assertions,
    evidence,
    estimatedTokens: explanation.estimatedTokens ?? 0,
    trace: explanation.trace,
    text: explanation.text,
    promptNeed: explanation.promptNeed,
  };
}

function replayCaseFailed(definition, evaluation, rankingOutcome) {
  return definition.caseType === "must_pass" ? !evaluation.passed : rankingOutcome !== "included";
}

function buildReplayImprovementArtifact(definition, artifactId, missCategory) {
  return {
    id: artifactId,
    sourceKind: "replay",
    sourceCaseId: definition.id,
    title: definition.title,
    missCategory,
  };
}

async function runReplayDefinition(runtime, definition) {
  const extraSeedIds = seedExtraDiagnosticsMemories(runtime, definition.extraSeedMemories ?? []);
  try {
    const explanation = await explainMemoryRetrieval({
      runtime,
      prompt: definition.prompt,
      mode: definition.mode,
      repository: definition.repository ?? runtime.repository ?? null,
    });
    const evaluation = evaluateCase(definition, explanation);
    const evidence = evaluateExpectedEvidence(definition, explanation);
    const missCategory = classifyReplayMiss(definition, explanation, evidence);
    const rankingOutcome = deriveReplayRankingOutcome(definition, evidence);
    const caseResult = buildReplayCaseResult(
      definition,
      evaluation,
      explanation,
      evidence,
      rankingOutcome,
      missCategory,
    );
    if (!replayCaseFailed(definition, evaluation, rankingOutcome)) {
      return { caseResult, improvementArtifact: null };
    }
    const artifactId = persistReplayFailureArtifact({
      runtime,
      definition,
      evaluation,
      explanation,
      evidence,
      rankingOutcome,
      missCategory,
    });
    return {
      caseResult,
      improvementArtifact: buildReplayImprovementArtifact(definition, artifactId, missCategory),
    };
  } finally {
    cleanupSeedDiagnosticsMemories(runtime, extraSeedIds);
  }
}

async function collectReplayCases(runtime, definitions) {
  const cases = [];
  const improvementArtifacts = [];
  for (const definition of definitions) {
    const replayResult = await runReplayDefinition(runtime, definition);
    cases.push(replayResult.caseResult);
    if (replayResult.improvementArtifact) {
      improvementArtifacts.push(replayResult.improvementArtifact);
    }
  }
  return { cases, improvementArtifacts };
}

function summarizeReplayCaseTotals(cases) {
  const mustPassCases = cases.filter((item) => item.caseType === "must_pass");
  const rankingTargetCases = cases.filter((item) => item.caseType === "ranking_target");
  return {
    total: cases.length,
    mustPassTotal: mustPassCases.length,
    mustPassPassed: mustPassCases.filter((item) => item.passed).length,
    mustPassFailed: mustPassCases.filter((item) => !item.passed).length,
    rankingTargetTotal: rankingTargetCases.length,
    rankingTargetIncluded: rankingTargetCases.filter((item) => item.rankingOutcome === "included").length,
    rankingTargetPartial: rankingTargetCases.filter((item) => item.rankingOutcome === "partial").length,
    rankingTargetMissing: rankingTargetCases.filter((item) => item.rankingOutcome === "missing").length,
  };
}

function buildReplayCorpusResult(runtime, replay) {
  return {
    generatedAt: new Date().toISOString(),
    repository: runtime.repository,
    latency: latencySnapshot(runtime.metrics),
    ...summarizeReplayCaseTotals(replay.cases),
    improvementArtifacts: replay.improvementArtifacts,
    insights: buildDiagnosticInsights(replay.cases),
    cases: replay.cases,
  };
}

export function renderValidationReport(result, { verbose = false } = {}) {
  const insights = result.insights ?? buildDiagnosticInsights(result.cases);
  const lines = [
    ...buildValidationHeaderLines(result),
    ...buildValidationInsightLines(result, insights),
    "",
    "## Cases",
    "",
  ];
  const visibleCases = selectVisibleValidationCases(result.cases, verbose);

  if (visibleCases.length === 0) {
    lines.push("- All cases passed.", ...buildValidationArtifactLines(result.improvementArtifacts));
    return lines.join("\n");
  }

  lines.push(
    ...visibleCases.flatMap((item) => buildValidationCaseLines(item, { verbose })),
    ...buildValidationArtifactLines(result.improvementArtifacts),
  );
  return lines.join("\n");
}

function buildSharedLatencyHeaderLines(result) {
  return [
    `improvementArtifacts: ${ensureArray(result.improvementArtifacts).length}`,
    `repository: ${result.repository ?? "global-only"}`,
    `sessionStartP95Ms: ${result.latency.sessionStartP95Ms}`,
    `userPromptSubmittedP95Ms: ${result.latency.userPromptSubmittedP95Ms}`,
    `sessionStartSamples: ${result.latency.sessionStartSamples}`,
    `userPromptSubmittedSamples: ${result.latency.userPromptSubmittedSamples}`,
    `sessionStartP95Readiness: ${result.latency.sessionStartP95Readiness ?? "unknown"}`,
    `userPromptSubmittedP95Readiness: ${result.latency.userPromptSubmittedP95Readiness ?? "unknown"}`,
    `sessionStartMinSamplesForP95: ${result.latency.sessionStartMinSamplesForP95 ?? 0}`,
    `userPromptSubmittedMinSamplesForP95: ${result.latency.userPromptSubmittedMinSamplesForP95 ?? 0}`,
  ];
}

function buildValidationHeaderLines(result) {
  return [
    `validationCases: ${result.total}`,
    `passed: ${result.passed}`,
    `failed: ${result.failed}`,
    ...buildSharedLatencyHeaderLines(result),
  ];
}

function buildSharedInsightLines(result, insights) {
  return [
    "",
    "## Latency Observability",
    "",
    renderLatencyMetric("sessionStart", result.latency.sessionStart),
    renderLatencyMetric("userPromptSubmitted", result.latency.userPromptSubmitted),
    "",
    "## Lookup Hit Rates",
    "",
    insights.lookupHitRates.length > 0
      ? insights.lookupHitRates
        .slice(0, 8)
        .map((entry) => `- ${entry.name}: included=${entry.includedCases}/${entry.seenCases} matched=${entry.matchedCases}/${entry.seenCases} filtered=${entry.filteredCases}`)
        .join("\n")
      : "- none",
    "",
    "## Source Sections",
    "",
    insights.sectionUsage.length > 0
      ? insights.sectionUsage
        .slice(0, 8)
        .map((entry) => `- ${entry.title}: ${entry.count}/${insights.totalCases} cases`)
        .join("\n")
      : "- none",
    "",
    "## Repeated Wins",
    "",
    insights.repeatedWins.length > 0
      ? insights.repeatedWins.map((entry) => `- ${entry.label}: ${entry.count} cases`).join("\n")
      : "- none",
    "",
    "## Repeated Misses",
    "",
    insights.repeatedMisses.length > 0
      ? insights.repeatedMisses.map((entry) => `- ${entry.label}: ${entry.count} cases`).join("\n")
      : "- none",
  ];
}

function buildValidationInsightLines(result, insights) {
  return buildSharedInsightLines(result, insights);
}

function selectVisibleValidationCases(cases, verbose) {
  return verbose ? cases : cases.filter((item) => !item.passed);
}

function buildAssertionLines(assertions, { verbose }) {
  const failedAssertions = ensureArray(assertions).filter((a) => !a.passed);
  const assertionsToShow = verbose ? ensureArray(assertions) : failedAssertions;
  const lines = [];
  for (const assertion of assertionsToShow) {
    lines.push(`  - ${assertion.passed ? "ok" : "fail"}: ${assertion.label}`);
    if (!assertion.passed && assertion.details) {
      lines.push(`    ${assertion.details}`);
    }
  }
  return lines;
}

function buildImprovementArtifactSection(artifacts, formatArtifact) {
  const rows = ensureArray(artifacts);
  if (rows.length === 0) {
    return [];
  }
  return [
    "",
    "## Improvement Artifacts",
    "",
    ...rows.map(formatArtifact),
  ];
}

function buildValidationCaseLines(item, { verbose }) {
  return [
    `- ${item.passed ? "PASS" : "FAIL"} ${item.id} — ${item.title}`,
    `  - mode: ${item.mode}`,
    `  - sections: ${item.sectionTitles.join(", ") || "none"}`,
    ...buildAssertionLines(item.assertions, { verbose }),
  ];
}

function buildValidationArtifactLines(artifacts) {
  return buildImprovementArtifactSection(
    artifacts,
    (artifact) => `- ${artifact.id} [${artifact.sourceKind}] ${artifact.sourceCaseId} — ${artifact.title}`,
  );
}

function buildReplayHeaderLines(result) {
  return [
    `replayCases: ${result.total}`,
    `mustPassTotal: ${result.mustPassTotal}`,
    `mustPassPassed: ${result.mustPassPassed}`,
    `mustPassFailed: ${result.mustPassFailed}`,
    `rankingTargetTotal: ${result.rankingTargetTotal}`,
    `rankingTargetIncluded: ${result.rankingTargetIncluded}`,
    `rankingTargetPartial: ${result.rankingTargetPartial}`,
    `rankingTargetMissing: ${result.rankingTargetMissing}`,
    ...buildSharedLatencyHeaderLines(result),
  ];
}

function buildReplayInsightLines(result, insights) {
  return buildSharedInsightLines(result, insights);
}

function formatReplayCaseLines(item, { verbose = false } = {}) {
  return [
    ...buildReplayCaseHeaderLines(item),
    ...buildReplayAssertionLines(item, { verbose }),
    ...buildReplayMissCategoryLines(item),
    ...buildReplayEvidenceLines(item, { verbose }),
  ];
}

function buildReplayCaseHeaderLines(item) {
  const prefix = item.caseType === "must_pass"
    ? item.passed ? "PASS" : "FAIL"
    : `TARGET ${String(item.rankingOutcome || "missing").toUpperCase()}`;
  return [
    `- ${prefix} ${item.id} — ${item.title}`,
    `  - type: ${item.caseType}`,
    `  - mode: ${item.mode}`,
    `  - sections: ${item.sectionTitles.join(", ") || "none"}`,
  ];
}

function buildReplayAssertionLines(item, { verbose }) {
  if (item.caseType !== "must_pass") {
    return [];
  }
  return buildAssertionLines(item.assertions, { verbose });
}

function buildReplayMissCategoryLines(item) {
  return item.caseType === "ranking_target" && item.missCategory
    ? [`  - missCategory: ${item.missCategory}`]
    : [];
}

function buildReplayEvidenceLines(item, { verbose }) {
  const lines = [];
  for (const evidence of ensureArray(item.evidence?.items)) {
    lines.push(
      `  - evidence ${evidence.label}: ${evidence.outcome}`
      + ` ranked=${evidence.bestRankedPosition ?? "none"}`
      + ` included=${evidence.bestIncludedPosition ?? "none"}`,
    );
    if (verbose && evidence.sample) {
      lines.push(`    sample: ${evidence.sample}`);
    }
    if (verbose && evidence.matchedLookups.length > 0) {
      lines.push(`    lookups: ${evidence.matchedLookups.join(", ")}`);
    }
  }
  return lines;
}

function buildReplayImprovementArtifactLines(artifacts) {
  return buildImprovementArtifactSection(
    artifacts,
    (artifact) =>
      `- ${artifact.id} [${artifact.sourceKind}] ${artifact.sourceCaseId} — ${artifact.title}`
      + (artifact.missCategory ? ` (missCategory=${artifact.missCategory})` : ""),
  );
}

export function renderReplayReport(result, { verbose = false } = {}) {
  const insights = result.insights ?? buildDiagnosticInsights(result.cases);
  const visibleCases = verbose
    ? result.cases
    : result.cases.filter((item) => item.caseType === "ranking_target" || !item.passed);

  if (visibleCases.length === 0) {
    return [
      ...buildReplayHeaderLines(result),
      ...buildReplayInsightLines(result, insights),
      "",
      "## Cases",
      "",
      "- All must-pass cases passed and no ranking targets are defined.",
      ...buildReplayImprovementArtifactLines(result.improvementArtifacts),
    ].join("\n");
  }

  return [
    ...buildReplayHeaderLines(result),
    ...buildReplayInsightLines(result, insights),
    "",
    "## Cases",
    "",
    ...visibleCases.flatMap((item) => formatReplayCaseLines(item, { verbose })),
    ...buildReplayImprovementArtifactLines(result.improvementArtifacts),
  ].join("\n");
}
