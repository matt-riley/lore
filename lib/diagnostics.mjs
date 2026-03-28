import { assembleMemoryCapsule, detectPromptContextNeed } from "./capsule-assembler.mjs";
import { recallMemory } from "./memory-operations.mjs";
import { buildProceduralProfile, detectRelevantInstructionFiles } from "./procedural-memory.mjs";

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function latencySnapshot(metrics) {
  const sessionStart = metrics?.sessionStart ?? {};
  const userPromptSubmitted = metrics?.userPromptSubmitted ?? {};
  return {
    sessionStartP95Ms: Math.round(metrics?.sessionStartP95 ?? 0),
    userPromptSubmittedP95Ms: Math.round(metrics?.userPromptSubmittedP95 ?? 0),
    sessionStartSamples: metrics?.sampleSize?.sessionStart ?? 0,
    userPromptSubmittedSamples: metrics?.sampleSize?.userPromptSubmitted ?? 0,
    sessionStartP95Readiness: sessionStart.readiness ?? "unknown",
    userPromptSubmittedP95Readiness: userPromptSubmitted.readiness ?? "unknown",
    sessionStartMinSamplesForP95: sessionStart.minSamples ?? 0,
    userPromptSubmittedMinSamplesForP95: userPromptSubmitted.minSamples ?? 0,
    sessionStart: {
      p50Ms: sessionStart.p50Ms ?? 0,
      p95Ms: sessionStart.p95Ms ?? 0,
      averageMs: sessionStart.averageMs ?? 0,
      maxMs: sessionStart.maxMs ?? 0,
      latestMs: sessionStart.latestMs ?? 0,
      readiness: sessionStart.readiness ?? "unknown",
      samples: sessionStart.samples ?? 0,
      minSamples: sessionStart.minSamples ?? 0,
      targetMs: sessionStart.targetMs ?? 0,
      targetStatus: sessionStart.targetStatus ?? "unknown",
      recentAverageMs: sessionStart.recentAverageMs ?? 0,
      previousAverageMs: sessionStart.previousAverageMs ?? 0,
      trend: sessionStart.trend ?? "unknown",
      trendDeltaMs: sessionStart.trendDeltaMs ?? 0,
    },
    userPromptSubmitted: {
      p50Ms: userPromptSubmitted.p50Ms ?? 0,
      p95Ms: userPromptSubmitted.p95Ms ?? 0,
      averageMs: userPromptSubmitted.averageMs ?? 0,
      maxMs: userPromptSubmitted.maxMs ?? 0,
      latestMs: userPromptSubmitted.latestMs ?? 0,
      readiness: userPromptSubmitted.readiness ?? "unknown",
      samples: userPromptSubmitted.samples ?? 0,
      minSamples: userPromptSubmitted.minSamples ?? 0,
      targetMs: userPromptSubmitted.targetMs ?? 0,
      targetStatus: userPromptSubmitted.targetStatus ?? "unknown",
      recentAverageMs: userPromptSubmitted.recentAverageMs ?? 0,
      previousAverageMs: userPromptSubmitted.previousAverageMs ?? 0,
      trend: userPromptSubmitted.trend ?? "unknown",
      trendDeltaMs: userPromptSubmitted.trendDeltaMs ?? 0,
    },
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

function renderLookup(name, lookup) {
  if (!lookup || typeof lookup !== "object") {
    return "";
  }
  const rows = ensureArray(lookup.rows);
  const rankedRows = ensureArray(lookup.rankedRows);
  const includedRows = ensureArray(lookup.includedRows);
  const filtered = ensureArray(lookup.filtered);
  const lines = [`### ${formatLookupLabel(name)}`];

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
  if (rows.length > 0) {
    lines.push(`- matched: ${rows.length}`);
  } else if (rankedRows.length > 0) {
    lines.push(`- ranked: ${rankedRows.length}`);
  }
  lines.push(`- included: ${includedRows.length}`);
  lines.push(`- dropped: ${filtered.length}`);
  if (lookup.reason) {
    lines.push(`- reason: ${lookup.reason}`);
  }
  const filteredSummary = aggregateFilteredReasons(filtered);
  if (filteredSummary) {
    lines.push(`- filtered: ${filteredSummary}`);
  }
  if (includedRows.length > 0) {
    lines.push("- sample:");
    for (const row of includedRows.slice(0, 3)) {
      lines.push(`  - ${summarizeTraceRow(row)}`);
    }
  }
  return lines.join("\n");
}

function renderLatencyMetric(label, metric) {
  return [
    `- ${label}: samples=${metric?.samples ?? 0} readiness=${metric?.readiness ?? "unknown"} target=${metric?.targetMs ?? 0}ms status=${metric?.targetStatus ?? "unknown"} p50=${metric?.p50Ms ?? 0} p95=${metric?.p95Ms ?? 0} avg=${metric?.averageMs ?? 0} max=${metric?.maxMs ?? 0} latest=${metric?.latestMs ?? 0} recentAvg=${metric?.recentAverageMs ?? 0} previousAvg=${metric?.previousAverageMs ?? 0} trend=${metric?.trend ?? "unknown"} delta=${metric?.trendDeltaMs ?? 0}`,
  ].join("\n");
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

  for (const [lookupName, lookup] of lookups) {
    ensureArray(lookup?.rankedRows).forEach((row, index) => {
      ranked.push({
        lookupName,
        position: index + 1,
        summary: summarizeTraceRow(row),
        text: buildTraceRowText(row),
        row,
      });
    });
    ensureArray(lookup?.includedRows).forEach((row, index) => {
      included.push({
        lookupName,
        position: index + 1,
        summary: summarizeTraceRow(row),
        text: buildTraceRowText(row),
        row,
      });
    });
  }

  return { ranked, included };
}

function countTraceRows(lookup) {
  const rows = ensureArray(lookup?.rows);
  const rankedRows = ensureArray(lookup?.rankedRows);
  const includedRows = ensureArray(lookup?.includedRows);
  return Math.max(rows.length, rankedRows.length, includedRows.length);
}

function buildDiagnosticInsights(cases) {
  const caseList = ensureArray(cases);
  const totalCases = caseList.length;
  const lookupMap = new Map();
  const sectionMap = new Map();
  const omissionMap = new Map();

  for (const item of caseList) {
    for (const title of ensureArray(item.sectionTitles)) {
      sectionMap.set(title, (sectionMap.get(title) ?? 0) + 1);
    }

    for (const omission of ensureArray(item.trace?.omissions)) {
      const key = `${omission.stage}:${omission.reason}`;
      omissionMap.set(key, (omissionMap.get(key) ?? 0) + 1);
    }

    for (const [name, lookup] of Object.entries(item.trace?.lookups ?? {})) {
      const entry = lookupMap.get(name) ?? {
        name,
        seenCases: 0,
        matchedCases: 0,
        includedCases: 0,
        filteredCases: 0,
        matchedRows: 0,
        includedRows: 0,
      };
      entry.seenCases += 1;
      const matchedRows = countTraceRows(lookup);
      const includedRows = ensureArray(lookup?.includedRows).length;
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
  }

  const lookupHitRates = [...lookupMap.values()]
    .map((entry) => ({
      ...entry,
      matchedRate: entry.seenCases > 0 ? entry.matchedCases / entry.seenCases : 0,
      includedRate: entry.seenCases > 0 ? entry.includedCases / entry.seenCases : 0,
    }))
    .sort((left, right) => {
      if (right.includedRate !== left.includedRate) {
        return right.includedRate - left.includedRate;
      }
      if (right.matchedRate !== left.matchedRate) {
        return right.matchedRate - left.matchedRate;
      }
      return left.name.localeCompare(right.name);
    });

  const sectionUsage = [...sectionMap.entries()]
    .map(([title, count]) => ({
      title,
      count,
      rate: totalCases > 0 ? count / totalCases : 0,
    }))
    .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title));

  const repeatedWins = lookupHitRates
    .filter((entry) => entry.includedCases >= 2)
    .map((entry) => ({
      label: entry.name,
      count: entry.includedCases,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));

  const repeatedMisses = [...omissionMap.entries()]
    .filter(([, count]) => count >= 2)
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));

  return {
    totalCases,
    lookupHitRates,
    sectionUsage,
    repeatedWins,
    repeatedMisses,
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

function classifyReplayMiss(definition, explanation, evidence) {
  if ((definition.caseType ?? "must_pass") !== "ranking_target") {
    return null;
  }
  if (evidence.missingCount === 0) {
    return null;
  }

  const sectionTitles = explanation.trace?.output?.sectionTitles ?? extractSectionTitles(explanation.text);
  const localEpisodes = explanation.trace?.lookups?.localEpisodes;
  const localMemories = explanation.trace?.lookups?.localMemories;
  const hasCrossRepoLeak = sectionTitles.includes("Cross-Repo Examples") || sectionTitles.includes("Cross-Repo Hints");
  const includedEpisodeRows = ensureArray(localEpisodes?.includedRows);
  const rankedEpisodeRows = ensureArray(localEpisodes?.rankedRows);
  const includedMemoryRows = ensureArray(localMemories?.includedRows);
  const rankedTexts = flattenTraceRows(explanation.trace).ranked.map((row) => row.text).join(" ");

  if (hasCrossRepoLeak && explanation.promptNeed?.wantsCrossRepoExamples !== true) {
    return "scope_classification";
  }
  if (includedEpisodeRows.length > 0 || rankedEpisodeRows.length > 0 || includedMemoryRows.length > 0) {
    if (/\b(files created|files modified|remaining work|immediate next steps|diagnostics\/validation|the user|the conversation)\b/i.test(rankedTexts)) {
      return "extraction_shape";
    }
    return "lexical_ranking";
  }
  return "lexical_ranking";
}

function evaluateCase(definition, explanation) {
  const assertions = [];
  const sectionTitles = explanation.trace?.output?.sectionTitles ?? extractSectionTitles(explanation.text);
  const text = String(explanation.text || "");
  const expect = definition.expect ?? {};

  const record = (label, passed, details) => {
    assertions.push({ label, passed, details });
  };

  for (const [field, expected] of Object.entries(expect.promptNeed ?? {})) {
    record(
      `promptNeed.${field} === ${expected}`,
      explanation.promptNeed?.[field] === expected,
      `actual=${explanation.promptNeed?.[field]}`,
    );
  }

  for (const path of ensureArray(expect.traceTruthyPaths)) {
    record(
      `trace ${path} is present`,
      Boolean(getByPath(explanation.trace, path)),
      `actual=${JSON.stringify(getByPath(explanation.trace, path))}`,
    );
  }

  for (const [path, minimum] of Object.entries(expect.traceMinCounts ?? {})) {
    const value = getByPath(explanation.trace, path);
    const count = Array.isArray(value) ? value.length : Number(value ?? 0);
    record(`${path} >= ${minimum}`, count >= minimum, `actual=${count}`);
  }

  for (const [path, expected] of Object.entries(expect.traceEquals ?? {})) {
    const value = getByPath(explanation.trace, path);
    record(
      `trace ${path} === ${JSON.stringify(expected)}`,
      value === expected,
      `actual=${JSON.stringify(value)}`,
    );
  }

  for (const title of ensureArray(expect.mustIncludeSections)) {
    record(
      `section includes "${title}"`,
      sectionTitles.includes(title),
      `actual=[${sectionTitles.join(", ")}]`,
    );
  }

  for (const title of ensureArray(expect.mustNotIncludeSections)) {
    record(
      `section excludes "${title}"`,
      !sectionTitles.includes(title),
      `actual=[${sectionTitles.join(", ")}]`,
    );
  }

  const includeOneOf = ensureArray(expect.mustIncludeOneOfSections);
  if (includeOneOf.length > 0) {
    record(
      `section includes one of ${includeOneOf.join(", ")}`,
      includeOneOf.some((title) => sectionTitles.includes(title)),
      `actual=[${sectionTitles.join(", ")}]`,
    );
  }

  const textMustIncludeAny = ensureArray(expect.textMustIncludeAny);
  if (textMustIncludeAny.length > 0) {
    record(
      `text includes one of ${textMustIncludeAny.join(", ")}`,
      textMustIncludeAny.some((snippet) => text.includes(snippet)),
      text,
    );
  }

  for (const snippet of ensureArray(expect.textMustIncludeAll)) {
    record(
      `text includes "${snippet}"`,
      text.includes(snippet),
      text,
    );
  }

  for (const snippet of ensureArray(expect.textMustNotInclude)) {
    record(
      `text excludes "${snippet}"`,
      !text.includes(snippet),
      text,
    );
  }

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
  const linkedMemoryId = createImprovementLinkedMemory({
    runtime,
    sourceKind: "replay",
    caseId: definition.id,
    title: definition.title,
    missCategory,
  });
  const summaryParts = [];
  if (definition.caseType === "must_pass") {
    summaryParts.push(summarizeFailedAssertions(evaluation.assertions));
  } else {
    summaryParts.push(`Ranking outcome: ${rankingOutcome ?? "missing"}`);
    if (missCategory) {
      summaryParts.push(`Miss category: ${missCategory}`);
    }
  }
  const id = runtime.db.upsertImprovementArtifact({
    sourceCaseId: definition.id,
    sourceKind: "replay",
    title: definition.title,
    summary: summaryParts.join(" | "),
    linkedMemoryId,
    evidence: {
      mode: definition.mode,
      prompt: definition.prompt,
      caseType: definition.caseType ?? "must_pass",
      rankingOutcome: rankingOutcome ?? null,
      missCategory: missCategory ?? null,
      failedAssertions: ensureArray(evaluation.assertions).filter((assertion) => assertion?.passed === false),
      expectedEvidence: evidence,
      estimatedTokens: explanation.estimatedTokens ?? 0,
    },
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
    context: {
      title: definition.title,
      caseType: definition.caseType ?? "must_pass",
      mode: definition.mode,
      rankingOutcome: rankingOutcome ?? null,
      missCategory: missCategory ?? null,
      failedAssertionCount: ensureArray(evaluation.assertions).filter((assertion) => assertion?.passed === false).length,
      expectedEvidenceCount: evidence?.expectedCount ?? 0,
      includedEvidenceCount: evidence?.includedCount ?? 0,
      rankedOnlyEvidenceCount: evidence?.rankedOnlyCount ?? 0,
      estimatedTokens: explanation.estimatedTokens ?? 0,
    },
    trace: explanation.trace ?? {},
  });
  return id;
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
      traceTruthyPaths: ["temporalDate"],
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
      traceTruthyPaths: ["temporalDate"],
      mustIncludeOneOfSections: ["Relevant Day Summary", "Relevant Prior Work"],
      mustNotIncludeSections: ["Response Style And Addressing", "Cross-Repo Examples", "Cross-Repo Hints"],
    },
  },
  {
    id: "repo-local-memory-scopes",
    caseType: "must_pass",
    title: "Repo-local continuity stays local",
    mode: "prompt",
    prompt: "Remember what we did here for coherence memory scopes.",
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
    prompt: "How does searchSemantic work in coherence?",
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
    prompt: "How does searchSemantic work in coherence?",
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
    prompt: "When we worked on coherence phase two in this repo, what did we change about prompt shaping?",
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
    prompt: "How did we make scope overrides auditable in coherence?",
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
    prompt: "How does the controlled backfill rollback work in coherence?",
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

export function renderExplanationReport(explanation) {
  const sectionTitles = explanation.trace?.output?.sectionTitles ?? extractSectionTitles(explanation.text);
  const sectionDetails = ensureArray(explanation.trace?.output?.sectionDetails);
  const routerDecision = explanation.trace?.routerDecision;
  const lines = [
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

  if (sectionDetails.length > 0) {
    lines.push("", "## Source Accounting", "");
    for (const detail of sectionDetails) {
      lines.push(
        `- ${detail.title}: source=${detail.source ?? "context"} tokens=${detail.usedTokens ?? 0}${detail.budget != null ? ` budget=${detail.budget}` : ""}${detail.entryCount != null ? ` entries=${detail.entryCount}` : ""}`,
      );
    }
  }

  if (explanation.trace?.eligibility) {
    lines.push(
      "",
      "## Scope Eligibility",
      "",
      ...Object.entries(explanation.trace.eligibility).map(
        ([key, values]) => `- ${formatLookupLabel(key)}: ${ensureArray(values).join(", ") || "none"}`,
      ),
    );
  }

  if (routerDecision) {
    lines.push(
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
    );
  }

  if (explanation.trace?.lookups) {
    lines.push("", "## Lookups", "");
    for (const [name, lookup] of Object.entries(explanation.trace.lookups)) {
      const rendered = renderLookup(name, lookup);
      if (rendered) {
        lines.push(rendered, "");
      }
    }
    if (lines.at(-1) === "") {
      lines.pop();
    }
  }

  const omissions = ensureArray(explanation.trace?.omissions);
  if (omissions.length > 0) {
    lines.push("", "## Omitted Or Suppressed", "");
    for (const omission of omissions) {
      lines.push(`- ${omission.stage}: ${omission.reason}`);
    }
  }

  lines.push("", "## Generated Context", "", explanation.text || "No additional context.");
  return lines.join("\n");
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
        const evidence = evaluateExpectedEvidence(definition, explanation);
        const missCategory = classifyReplayMiss(definition, explanation, evidence);
        const rankingOutcome = definition.caseType === "ranking_target"
          ? evidence.missingCount === 0 && evidence.expectedCount > 0
            ? "included"
            : evidence.includedCount > 0 || evidence.rankedOnlyCount > 0
              ? "partial"
              : "missing"
          : null;

        cases.push({
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
        });
        const replayFailed = definition.caseType === "must_pass"
          ? !evaluation.passed
          : rankingOutcome !== "included";
        if (replayFailed) {
          const artifactId = persistReplayFailureArtifact({
            runtime,
            definition,
            evaluation,
            explanation,
            evidence,
            rankingOutcome,
            missCategory,
          });
          improvementArtifacts.push({
            id: artifactId,
            sourceKind: "replay",
            sourceCaseId: definition.id,
            title: definition.title,
            missCategory,
          });
        }
      } finally {
        cleanupSeedDiagnosticsMemories(runtime, extraSeedIds);
      }
    }

    const mustPassCases = cases.filter((item) => item.caseType === "must_pass");
    const rankingTargetCases = cases.filter((item) => item.caseType === "ranking_target");

    return {
      generatedAt: new Date().toISOString(),
      repository: runtime.repository,
      latency: latencySnapshot(runtime.metrics),
      total: cases.length,
      mustPassTotal: mustPassCases.length,
      mustPassPassed: mustPassCases.filter((item) => item.passed).length,
      mustPassFailed: mustPassCases.filter((item) => !item.passed).length,
      rankingTargetTotal: rankingTargetCases.length,
      rankingTargetIncluded: rankingTargetCases.filter((item) => item.rankingOutcome === "included").length,
      rankingTargetPartial: rankingTargetCases.filter((item) => item.rankingOutcome === "partial").length,
      rankingTargetMissing: rankingTargetCases.filter((item) => item.rankingOutcome === "missing").length,
      improvementArtifacts,
      insights: buildDiagnosticInsights(cases),
      cases,
    };
  } finally {
    cleanupSeedDiagnosticsMemories(runtime, seededIds);
  }
}

export function renderValidationReport(result, { verbose = false } = {}) {
  const insights = result.insights ?? buildDiagnosticInsights(result.cases);
  const lines = [
    `validationCases: ${result.total}`,
    `passed: ${result.passed}`,
    `failed: ${result.failed}`,
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
    "",
    "## Cases",
    "",
  ];

  const visibleCases = verbose
    ? result.cases
    : result.cases.filter((item) => !item.passed);

  if (visibleCases.length === 0) {
    lines.push("- All cases passed.");
    if (ensureArray(result.improvementArtifacts).length > 0) {
      lines.push("", "## Improvement Artifacts", "");
      for (const artifact of ensureArray(result.improvementArtifacts)) {
        lines.push(`- ${artifact.id} [${artifact.sourceKind}] ${artifact.sourceCaseId} — ${artifact.title}`);
      }
    }
    return lines.join("\n");
  }

  for (const item of visibleCases) {
    lines.push(`- ${item.passed ? "PASS" : "FAIL"} ${item.id} — ${item.title}`);
    lines.push(`  - mode: ${item.mode}`);
    lines.push(`  - sections: ${item.sectionTitles.join(", ") || "none"}`);
    const failedAssertions = item.assertions.filter((assertion) => !assertion.passed);
    const assertionsToShow = verbose ? item.assertions : failedAssertions;
    for (const assertion of assertionsToShow) {
      lines.push(`  - ${assertion.passed ? "ok" : "fail"}: ${assertion.label}`);
      if (!assertion.passed && assertion.details) {
        lines.push(`    ${assertion.details}`);
      }
    }
  }

  if (ensureArray(result.improvementArtifacts).length > 0) {
    lines.push("", "## Improvement Artifacts", "");
    for (const artifact of ensureArray(result.improvementArtifacts)) {
      lines.push(`- ${artifact.id} [${artifact.sourceKind}] ${artifact.sourceCaseId} — ${artifact.title}`);
    }
  }

  return lines.join("\n");
}

export function renderReplayReport(result, { verbose = false } = {}) {
  const insights = result.insights ?? buildDiagnosticInsights(result.cases);
  const lines = [
    `replayCases: ${result.total}`,
    `mustPassTotal: ${result.mustPassTotal}`,
    `mustPassPassed: ${result.mustPassPassed}`,
    `mustPassFailed: ${result.mustPassFailed}`,
    `rankingTargetTotal: ${result.rankingTargetTotal}`,
    `rankingTargetIncluded: ${result.rankingTargetIncluded}`,
    `rankingTargetPartial: ${result.rankingTargetPartial}`,
    `rankingTargetMissing: ${result.rankingTargetMissing}`,
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
    "",
    "## Cases",
    "",
  ];

  const visibleCases = verbose
    ? result.cases
    : result.cases.filter((item) => item.caseType === "ranking_target" || !item.passed);

  if (visibleCases.length === 0) {
    lines.push("- All must-pass cases passed and no ranking targets are defined.");
    if (ensureArray(result.improvementArtifacts).length > 0) {
      lines.push("", "## Improvement Artifacts", "");
      for (const artifact of ensureArray(result.improvementArtifacts)) {
        lines.push(
          `- ${artifact.id} [${artifact.sourceKind}] ${artifact.sourceCaseId} — ${artifact.title}`
          + (artifact.missCategory ? ` (missCategory=${artifact.missCategory})` : ""),
        );
      }
    }
    return lines.join("\n");
  }

  for (const item of visibleCases) {
    const prefix = item.caseType === "must_pass"
      ? item.passed ? "PASS" : "FAIL"
      : `TARGET ${String(item.rankingOutcome || "missing").toUpperCase()}`;
    lines.push(`- ${prefix} ${item.id} — ${item.title}`);
    lines.push(`  - type: ${item.caseType}`);
    lines.push(`  - mode: ${item.mode}`);
    lines.push(`  - sections: ${item.sectionTitles.join(", ") || "none"}`);
    if (item.caseType === "must_pass") {
      const failedAssertions = item.assertions.filter((assertion) => !assertion.passed);
      const assertionsToShow = verbose ? item.assertions : failedAssertions;
      for (const assertion of assertionsToShow) {
        lines.push(`  - ${assertion.passed ? "ok" : "fail"}: ${assertion.label}`);
        if (!assertion.passed && assertion.details) {
          lines.push(`    ${assertion.details}`);
        }
      }
    }
    if (item.caseType === "ranking_target" && item.missCategory) {
      lines.push(`  - missCategory: ${item.missCategory}`);
    }
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
  }

  if (ensureArray(result.improvementArtifacts).length > 0) {
    lines.push("", "## Improvement Artifacts", "");
    for (const artifact of ensureArray(result.improvementArtifacts)) {
      lines.push(
        `- ${artifact.id} [${artifact.sourceKind}] ${artifact.sourceCaseId} — ${artifact.title}`
        + (artifact.missCategory ? ` (missCategory=${artifact.missCategory})` : ""),
      );
    }
  }

  return lines.join("\n");
}
