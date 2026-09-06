import { ensureArray } from "./memory-tools-array-utils.mjs";
import { formatTrajectoryArtifactRows } from "./memory-tools-observability-reports.mjs";
import { ensureLimit } from "./memory-tools-validation-utils.mjs";

function formatTraceRecorderRoutes(routes) {
  return ensureArray(routes).length > 0
    ? ensureArray(routes).map((entry) => `${entry.route} x${entry.count}`).join(", ")
    : "none";
}

function formatTraceRecorderLookups(lookups) {
  return ensureArray(lookups).length > 0
    ? ensureArray(lookups)
      .slice(0, 5)
      .map((entry) => `${entry.name} included=${entry.includedCount}/${entry.seenCount} matched=${entry.matchedCount}/${entry.seenCount} dropped=${entry.droppedCount}`)
      .join(" | ")
    : "none";
}

function formatTraceRecorderPatterns(patterns) {
  return ensureArray(patterns).length > 0
    ? ensureArray(patterns).slice(0, 5).map((entry) => `${entry.label} x${entry.count}`).join(", ")
    : "none";
}

function formatTraceRecorderHooks(hooks) {
  return ensureArray(hooks).map((entry) => [
    `traceHook:${entry.hook}`,
    `samples=${entry.samples}`,
    `withContext=${entry.withContextCount}`,
    `withoutContext=${entry.withoutContextCount}`,
    `p50=${entry.p50Ms}`,
    `p95=${entry.p95Ms}`,
    `avg=${entry.averageMs}`,
    `max=${entry.maxMs}`,
    `trend=${entry.trend}`,
    `delta=${entry.trendDeltaMs}`,
  ].join(" "));
}

function formatTraceLookupSamples(rows) {
  return ensureArray(rows)
    .map((row) => {
      const label = row?.type ? `[${row.type}] ` : "";
      const repository = row?.repository ? ` (${row.repository})` : "";
      return `${label}${row?.text ?? ""}${repository}`;
    })
    .filter(Boolean);
}

function formatTracePromptNeedLines(promptNeed) {
  if (!promptNeed) {
    return [];
  }
  return [
    `- promptNeed.requiresLookup: ${promptNeed.requiresLookup === true}`,
    `- promptNeed.wantsContinuity: ${promptNeed.wantsContinuity === true}`,
    `- promptNeed.allowCrossRepoFallback: ${promptNeed.allowCrossRepoFallback === true}`,
    `- promptNeed.identityOnly: ${promptNeed.identityOnly === true}`,
  ];
}

function formatRecentTraceLookupLines(lookups) {
  const lookupEntries = Object.entries(lookups ?? {});
  if (lookupEntries.length === 0) {
    return ["  - none"];
  }
  return lookupEntries.flatMap(([name, lookup]) => {
    const lines = [
      `  - ${name}: matched=${lookup.matchedCount} included=${lookup.includedCount} dropped=${lookup.droppedCount}${lookup.reason ? ` reason=${lookup.reason}` : ""}`,
    ];
    for (const sample of formatTraceLookupSamples(lookup.includedRows).slice(0, 2)) {
      lines.push(`    - included: ${sample}`);
    }
    for (const sample of formatTraceLookupSamples(lookup.matchedRows).slice(0, 1)) {
      lines.push(`    - matched: ${sample}`);
    }
    for (const dropped of ensureArray(lookup.droppedRows).slice(0, 1)) {
      const rowText = dropped?.row?.text ? ` — ${dropped.row.text}` : "";
      lines.push(`    - dropped: ${dropped.stage}:${dropped.reason}${rowText}`);
    }
    return lines;
  });
}

function buildRecentTraceHeaderLines(record) {
  return [
    `### ${record.id}`,
    `- hook: ${record.hook}`,
    `- recordedAt: ${record.recordedAt}`,
    `- repository: ${record.repository ?? "global-only"}`,
    `- prompt: ${record.promptPreview || "none"}`,
    `- latencyMs: ${record.latencyMs}`,
  ];
}

function formatRecentTraceList(values) {
  return ensureArray(values).join(", ") || "none";
}

function formatRecentTraceValue(value, fallback = "none") {
  return value ?? fallback;
}

function buildRecentTraceRoutingLines(record) {
  return [
    `- route: ${formatRecentTraceValue(record.routerDecision?.route, "unknown")}`,
    `- routeReason: ${formatRecentTraceValue(record.routerDecision?.reason)}`,
    `- contextInjected: ${record.output?.contextInjected === true}`,
    `- sectionTitles: ${formatRecentTraceList(record.output?.sectionTitles)}`,
    `- eligibility.local: ${formatRecentTraceList(record.eligibility?.local)}`,
    `- eligibility.crossRepo: ${formatRecentTraceList(record.eligibility?.crossRepo)}`,
  ];
}

function formatRecentTraceOptionalLines(record) {
  return [
    record.output?.injectedContextPreview
      ? `- injectedContextPreview: ${record.output.injectedContextPreview}`
      : null,
    ensureArray(record.omissions).length > 0
      ? `- omissions: ${ensureArray(record.omissions).map((item) => `${item.stage}:${item.reason}`).join(", ")}`
      : null,
  ].filter(Boolean);
}

function formatRecentTraceRecord(record) {
  return [
    ...buildRecentTraceHeaderLines(record),
    ...buildRecentTraceRoutingLines(record),
    ...formatTracePromptNeedLines(record.promptNeed),
    "- lookups:",
    ...formatRecentTraceLookupLines(record.lookups),
    ...formatRecentTraceOptionalLines(record),
  ];
}

function formatRecentTraceRecords(records) {
  if (ensureArray(records).length === 0) {
    return ["- none"];
  }

  const lines = [];
  for (const record of ensureArray(records)) {
    lines.push(...formatRecentTraceRecord(record));
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export function appendTraceRecorderStatusLines(lines, traceStats) {
  if (!traceStats) {
    return;
  }
  lines.push(
    `traceRecorderStoredRecords: ${traceStats.storedRecords}`,
    `traceRecorderTotalRecorded: ${traceStats.totalRecorded}`,
    `traceRecorderEvictedCount: ${traceStats.totalEvicted}`,
    `traceRecorderExpiredCount: ${traceStats.totalExpired}`,
    `traceRecorderMaxRecords: ${traceStats.maxRecords}`,
    `traceRecorderMaxAgeMs: ${traceStats.maxAgeMs}`,
    `traceRecorderLastRecordedAt: ${traceStats.lastRecordedAt ?? "none"}`,
    `traceRecorderRoutes: ${formatTraceRecorderRoutes(traceStats.routes)}`,
    `traceRecorderLookupLeaders: ${formatTraceRecorderLookups(traceStats.lookupHitRates)}`,
    `traceRecorderRepeatedWins: ${formatTraceRecorderPatterns(traceStats.repeatedWins)}`,
    `traceRecorderRepeatedMisses: ${formatTraceRecorderPatterns(traceStats.repeatedMisses)}`,
    ...formatTraceRecorderHooks(traceStats.hooks),
  );
}

export function appendRecentTraceSection(lines, runtime, args) {
  if (args.includeRecentTraces !== true) {
    return;
  }
  const recentTraceLimit = ensureLimit(args.recentTraceLimit, 3, 50);
  const recentRecords = runtime.traceRecorder?.getRecent?.(recentTraceLimit) ?? [];
  lines.push("", "## Recent Trace Records", "", ...formatRecentTraceRecords(recentRecords));
}

export function appendRecentTrajectorySection(lines, runtime, args) {
  if (args.includeRecentTrajectoryArtifacts !== true) {
    return;
  }
  const recentTrajectoryLimit = ensureLimit(args.recentTrajectoryLimit, 5, 50);
  const trajectoryRows = runtime.db.listTrajectoryArtifacts({
    repository: runtime.repository ?? undefined,
    limit: recentTrajectoryLimit,
  });
  lines.push("", "## Recent Trajectory Artifacts", "", formatTrajectoryArtifactRows(trajectoryRows));
}
