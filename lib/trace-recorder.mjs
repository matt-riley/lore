function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value;
}

function firstNonNullish(values, fallback = null) {
  for (const value of values) {
    if (value != null) {
      return value;
    }
  }
  return fallback;
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function truncateText(value, maxChars) {
  const text = String(firstNonNullish([value], "")).replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return "";
  }
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * ratio)),
  );
  return sorted[index];
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function emptyLatencySummary() {
  return {
    samples: 0,
    averageMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    maxMs: 0,
    latestMs: 0,
    recentAverageMs: 0,
    previousAverageMs: 0,
    trendDeltaMs: 0,
    trend: "no_samples",
  };
}

function determineLatencyTrend(trendDeltaMs) {
  if (Math.abs(trendDeltaMs) <= 5) {
    return "flat";
  }
  return trendDeltaMs > 0 ? "rising" : "falling";
}

function computeRecentWindowSize(samples) {
  const half = Math.floor(samples / 2);
  const capped = Math.min(10, half);
  return Math.max(1, capped);
}

function deriveLatencyTrend(recentAverageMs, previousValues) {
  if (previousValues.length === 0) {
    return {
      previousAverageMs: 0,
      trendDeltaMs: 0,
      trend: "insufficient_history",
    };
  }
  const previousAverageMs = Math.round(average(previousValues));
  const trendDeltaMs = recentAverageMs - previousAverageMs;
  return {
    previousAverageMs,
    trendDeltaMs,
    trend: determineLatencyTrend(trendDeltaMs),
  };
}

function buildLatencySummary(values) {
  const samples = values.length;
  if (samples === 0) {
    return emptyLatencySummary();
  }

  const recentWindowSize = computeRecentWindowSize(samples);
  const recentValues = values.slice(-recentWindowSize);
  const previousValues = values.slice(-(recentWindowSize * 2), -recentWindowSize);
  const recentAverageMs = Math.round(average(recentValues));
  const { previousAverageMs, trendDeltaMs, trend } = deriveLatencyTrend(recentAverageMs, previousValues);

  return {
    samples,
    averageMs: Math.round(average(values)),
    p50Ms: Math.round(percentile(values, 0.5)),
    p95Ms: Math.round(percentile(values, 0.95)),
    maxMs: Math.round(Math.max(...values)),
    latestMs: Math.round(values.at(-1) ?? 0),
    recentAverageMs,
    previousAverageMs,
    trendDeltaMs,
    trend,
  };
}

function normalizePromptNeed(promptNeed) {
  if (!promptNeed || typeof promptNeed !== "object") {
    return null;
  }
  return {
    requiresLookup: promptNeed.requiresLookup === true,
    wantsContinuity: promptNeed.wantsContinuity === true,
    wantsStyleContext: promptNeed.wantsStyleContext === true,
    wantsCrossRepoExamples: promptNeed.wantsCrossRepoExamples === true,
    wantsRepoLocalTaskContext: promptNeed.wantsRepoLocalTaskContext === true,
    allowCrossRepoFallback: promptNeed.allowCrossRepoFallback === true,
    identityOnly: promptNeed.identityOnly === true,
    directAddressed: promptNeed.directAddressed === true,
    hasTemporalSignal: promptNeed.hasTemporalSignal === true,
    seriousPrompt: promptNeed.seriousPrompt === true,
  };
}

function roundScore(value) {
  if (typeof value !== "number") {
    return null;
  }
  return Number(value.toFixed(2));
}

function summarizeRows(rows, limit, maxChars) {
  return ensureArray(rows)
    .slice(0, limit)
    .map((row) => summarizeTraceRow(row, maxChars))
    .filter(Boolean);
}

function summarizeFilteredRows(rows, limit, maxChars) {
  return ensureArray(rows)
    .slice(0, limit)
    .map((entry) => summarizeFilteredEntry(entry, maxChars))
    .filter(Boolean);
}

function stringifyArray(values) {
  return ensureArray(values).map((value) => String(value));
}

function summarizeTraceRow(row, maxChars) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const rawText = firstNonNullish(
    [row.content, row.summary, row.excerpt, row.reason],
    JSON.stringify(row),
  );
  const text = truncateText(rawText, maxChars);
  if (!text) {
    return null;
  }
  const score = roundScore(row.score);
  return {
    type: firstNonNullish([row.type, row.sourceType], "row"),
    repository: firstNonNullish([row.repository], null),
    dateKey: firstNonNullish([row.date_key, row.dateKey], null),
    score,
    text,
  };
}

function summarizeFilteredEntry(entry, maxChars) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const entryObject = asObject(entry);
  return {
    stage: firstNonNullish([entryObject.stage], "filtered"),
    reason: firstNonNullish([entryObject.reason], "filtered"),
    row: summarizeTraceRow(entryObject.row, maxChars),
  };
}

function compactLookup(lookup, options) {
  const lookupObject = asObject(lookup);
  const rows = ensureArray(lookupObject.rows);
  const rankedRows = ensureArray(lookupObject.rankedRows);
  const includedRows = ensureArray(lookupObject.includedRows);
  const filteredRows = ensureArray(lookupObject.filtered);
  const matchedRows = rows.length > 0 ? rows : rankedRows;

  return {
    enabled: lookupObject.enabled !== false,
    query: truncateText(firstNonNullish([lookupObject.query], ""), options.maxPromptChars),
    scopes: stringifyArray(lookupObject.scopes),
    eligibleScopes: stringifyArray(lookupObject.eligibleScopes),
    reason: firstNonNullish([lookupObject.reason], null),
    matchedCount: matchedRows.length,
    includedCount: includedRows.length,
    droppedCount: filteredRows.length,
    matchedRows: summarizeRows(matchedRows, options.maxRowsPerLookup, options.maxRowChars),
    includedRows: summarizeRows(includedRows, options.maxRowsPerLookup, options.maxRowChars),
    droppedRows: summarizeFilteredRows(filteredRows, options.maxFilteredRowsPerLookup, options.maxRowChars),
  };
}

function clampOptionalInteger(value, min = 0) {
  if (value == null) {
    return null;
  }
  return clampInteger(value, 0, { min });
}

function compactSectionDetail(detail) {
  const detailObject = asObject(detail);
  return {
    title: firstNonNullish([detailObject.title], "Section"),
    source: firstNonNullish([detailObject.source], "context"),
    usedTokens: clampInteger(detailObject.usedTokens, 0, { min: 0 }),
    budget: clampOptionalInteger(detailObject.budget, 0),
    entryCount: clampOptionalInteger(detailObject.entryCount, 0),
  };
}

function compactSectionDetails(sectionDetails = []) {
  return ensureArray(sectionDetails)
    .slice(0, 8)
    .map((detail) => compactSectionDetail(detail));
}

function compactOmission(omission) {
  const omissionObject = asObject(omission);
  return {
    stage: firstNonNullish([omissionObject.stage], "unknown"),
    reason: firstNonNullish([omissionObject.reason], "unspecified"),
  };
}

function compactOmissions(omissions = []) {
  return ensureArray(omissions)
    .slice(0, 12)
    .map((omission) => compactOmission(omission));
}

function resolveDecisionSource(primary, fallback) {
  if (primary && typeof primary === "object") {
    return primary;
  }
  return asObject(fallback);
}

function compactRouterDecision(routerDecision, fallback) {
  const source = resolveDecisionSource(routerDecision, fallback);
  return {
    route: firstNonNullish([source.route], "unknown"),
    reason: firstNonNullish([source.reason], null),
    includeOtherRepositories: source.includeOtherRepositories === true,
    usedWorkstreamOverlays: source.usedWorkstreamOverlays === true,
    usedLegacyPath: source.usedLegacyPath === true,
    additionalContext: source.additionalContext === true,
    sectionCount: clampInteger(source.sectionCount, 0, { min: 0 }),
  };
}

function buildFallbackTraceDecision(event, trace, promptNeed, contextText) {
  const eventObject = asObject(event);
  const traceObject = asObject(trace);
  const traceLookups = asObject(traceObject.lookups);
  const workstreamOverlays = asObject(traceLookups.workstreamOverlays);
  const traceOutput = asObject(traceObject.output);
  const route = eventObject.hook === "onSessionStart"
    ? "session_start_capsule"
    : firstNonNullish([traceObject.mode], "memory_recall");
  return {
    route,
    reason: null,
    includeOtherRepositories: asObject(promptNeed).allowCrossRepoFallback === true,
    usedWorkstreamOverlays: ensureArray(workstreamOverlays.includedRows).length > 0,
    usedLegacyPath: traceObject.mode === "legacy_prompt_context",
    additionalContext: contextText.length > 0,
    sectionCount: ensureArray(traceOutput.sectionTitles).length,
  };
}

function buildTraceEligibility(trace) {
  const eligibility = asObject(asObject(trace).eligibility);
  return {
    local: stringifyArray(eligibility.local).slice(0, 8),
    crossRepo: stringifyArray(eligibility.crossRepo).slice(0, 8),
  };
}

function buildTraceLookups(trace, options) {
  const lookups = asObject(asObject(trace).lookups);
  return Object.fromEntries(
    Object.entries(lookups).map(([name, lookup]) => [name, compactLookup(lookup, options)]),
  );
}

function buildTraceOutput(trace, contextText) {
  const output = asObject(asObject(trace).output);
  return {
    estimatedTokens: clampInteger(output.estimatedTokens, 0, { min: 0 }),
    sectionTitles: stringifyArray(output.sectionTitles).slice(0, 8),
    sectionDetails: compactSectionDetails(output.sectionDetails),
    injectedContextPreview: contextText,
    contextInjected: contextText.length > 0,
  };
}

function buildTraceRecordIdentity(event, trace, options, index) {
  const eventObject = asObject(event);
  const traceObject = asObject(trace);
  return {
    id: `trace-${index}`,
    recordedAt: new Date().toISOString(),
    hook: firstNonNullish([eventObject.hook], "unknown"),
    mode: firstNonNullish([traceObject.mode], null),
    repository: firstNonNullish([eventObject.repository, traceObject.repository], null),
    promptPreview: truncateText(firstNonNullish([eventObject.prompt], ""), options.maxPromptChars),
    latencyMs: clampInteger(eventObject.latencyMs, 0, { min: 0 }),
  };
}

function buildTraceRecordDetails(trace, options, promptNeed, contextText, fallbackDecision) {
  const traceObject = asObject(trace);
  return {
    promptNeed,
    eligibility: buildTraceEligibility(traceObject),
    routerDecision: compactRouterDecision(traceObject.routerDecision, fallbackDecision),
    lookups: buildTraceLookups(traceObject, options),
    omissions: compactOmissions(traceObject.omissions),
    output: buildTraceOutput(traceObject, contextText),
  };
}

function buildTraceRecord(event, options, index) {
  const eventObject = asObject(event);
  const trace = asObject(eventObject.trace);
  const promptNeed = normalizePromptNeed(firstNonNullish([eventObject.promptNeed, trace.promptNeed], null));
  const contextText = truncateText(firstNonNullish([eventObject.contextText], ""), options.maxContextChars);
  const fallbackDecision = buildFallbackTraceDecision(eventObject, trace, promptNeed, contextText);

  return {
    ...buildTraceRecordIdentity(eventObject, trace, options, index),
    ...buildTraceRecordDetails(trace, options, promptNeed, contextText, fallbackDecision),
  };
}

function getOrCreateLookupEntry(lookupMap, name) {
  const existing = lookupMap.get(name);
  if (existing) {
    return existing;
  }
  const entry = {
    name,
    seenCount: 0,
    matchedCount: 0,
    includedCount: 0,
    droppedCount: 0,
  };
  lookupMap.set(name, entry);
  return entry;
}

function positiveCounterIncrement(value) {
  if (Number(value) > 0) {
    return 1;
  }
  return 0;
}

function updateLookupEntry(entry, lookup) {
  const lookupObject = asObject(lookup);
  entry.seenCount += 1;
  entry.matchedCount += positiveCounterIncrement(lookupObject.matchedCount);
  entry.includedCount += positiveCounterIncrement(lookupObject.includedCount);
  entry.droppedCount += clampInteger(lookupObject.droppedCount, 0, { min: 0 });
}

function buildLookupHitRates(records) {
  const lookupMap = new Map();
  for (const record of records) {
    const lookups = asObject(record).lookups;
    for (const [name, lookup] of Object.entries(asObject(lookups))) {
      const entry = getOrCreateLookupEntry(lookupMap, name);
      updateLookupEntry(entry, lookup);
    }
  }
  return [...lookupMap.values()]
    .map((entry) => ({
      ...entry,
      matchedRate: entry.seenCount > 0 ? entry.matchedCount / entry.seenCount : 0,
      includedRate: entry.seenCount > 0 ? entry.includedCount / entry.seenCount : 0,
    }))
    .sort((left, right) => right.includedRate - left.includedRate || right.matchedRate - left.matchedRate || left.name.localeCompare(right.name))
    .slice(0, 8);
}

function incrementLookupWins(lookupWins, name, lookup) {
  const includedCount = Number(asObject(lookup).includedCount);
  if (includedCount <= 0) {
    return;
  }
  const current = lookupWins.get(name);
  if (typeof current === "number") {
    lookupWins.set(name, current + 1);
    return;
  }
  lookupWins.set(name, 1);
}

function buildRepeatedWins(records) {
  const lookupWins = new Map();
  for (const record of records) {
    for (const [name, lookup] of Object.entries(asObject(asObject(record).lookups))) {
      incrementLookupWins(lookupWins, name, lookup);
    }
  }
  return [...lookupWins.entries()]
    .filter(([, count]) => count >= 2)
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 8);
}

function buildRepeatedMisses(records) {
  const omissionCounts = new Map();
  for (const record of records) {
    for (const omission of ensureArray(record.omissions)) {
      const label = `${omission.stage}:${omission.reason}`;
      omissionCounts.set(label, (omissionCounts.get(label) ?? 0) + 1);
    }
  }
  return [...omissionCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, 8);
}

function buildRouteCounts(records) {
  const counts = new Map();
  for (const record of records) {
    const route = firstNonNullish([asObject(asObject(record).routerDecision).route], "unknown");
    counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([route, count]) => ({ route, count }))
    .sort((left, right) => right.count - left.count || left.route.localeCompare(right.route));
}

function getOrCreateHookEntry(hookMap, hook) {
  const existing = hookMap.get(hook);
  if (existing) {
    return existing;
  }
  const entry = {
    hook,
    latencies: [],
    withContextCount: 0,
  };
  hookMap.set(hook, entry);
  return entry;
}

function buildHookSummaries(records) {
  const hookMap = new Map();
  for (const record of records) {
    const recordObject = asObject(record);
    const hook = firstNonNullish([recordObject.hook], "unknown");
    const entry = getOrCreateHookEntry(hookMap, hook);
    entry.latencies.push(clampInteger(recordObject.latencyMs, 0, { min: 0 }));
    if (asObject(recordObject.output).contextInjected === true) {
      entry.withContextCount += 1;
    }
  }

  return [...hookMap.values()]
    .map((entry) => ({
      hook: entry.hook,
      withContextCount: entry.withContextCount,
      withoutContextCount: entry.latencies.length - entry.withContextCount,
      ...buildLatencySummary(entry.latencies),
    }))
    .sort((left, right) => left.hook.localeCompare(right.hook));
}

function normalizeRecorderLimits(traceRecorderConfig) {
  const config = asObject(traceRecorderConfig);
  return {
    maxRecords: clampInteger(config.maxRecords, 40, { min: 1, max: 500 }),
    maxAgeMs: clampInteger(config.maxAgeMs, 30 * 60 * 1000, { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }),
    maxRowsPerLookup: clampInteger(config.maxRowsPerLookup, 3, { min: 1, max: 10 }),
    maxFilteredRowsPerLookup: clampInteger(config.maxFilteredRowsPerLookup, 3, { min: 1, max: 10 }),
    maxPromptChars: clampInteger(config.maxPromptChars, 160, { min: 32, max: 500 }),
    maxRowChars: clampInteger(config.maxRowChars, 160, { min: 32, max: 500 }),
    maxContextChars: clampInteger(config.maxContextChars, 600, { min: 64, max: 4000 }),
  };
}

function normalizeSampleRate(value, fallback = 0.25) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, numeric));
}

function normalizeDurableRecorderOptions(traceRecorderConfig) {
  const config = asObject(traceRecorderConfig);
  return {
    persistDurableSample: config.persistDurableSample !== false,
    durableSampleRate: normalizeSampleRate(config.durableSampleRate),
    durableMaxRowsPerRepository: clampInteger(config.durableMaxRowsPerRepository, 120, { min: 20, max: 5000 }),
    durableMaxRowsGlobal: clampInteger(config.durableMaxRowsGlobal, 240, { min: 20, max: 10000 }),
    durableMaxAgeMs: clampInteger(config.durableMaxAgeMs, 14 * 24 * 60 * 60 * 1000, { min: 60 * 60 * 1000, max: 365 * 24 * 60 * 60 * 1000 }),
  };
}

function normalizeRecorderOptions(config) {
  const traceRecorderConfig = config?.traceRecorder ?? null;
  return Object.freeze({
    enabled: config?.rollout?.traceRecorder === true,
    ...normalizeRecorderLimits(traceRecorderConfig),
    ...normalizeDurableRecorderOptions(traceRecorderConfig),
  });
}

function shouldPersistDurableSample(options) {
  if (!options.persistDurableSample) {
    return false;
  }
  if (options.durableSampleRate >= 1) {
    return true;
  }
  if (options.durableSampleRate <= 0) {
    return false;
  }
  return Math.random() <= options.durableSampleRate;
}

function isTraceRecordExpired(record, cutoff) {
  const recordedAt = Date.parse(asObject(record).recordedAt);
  return Number.isFinite(recordedAt) && recordedAt < cutoff;
}

function removeExpiredRecords(records, cutoff) {
  let expired = 0;
  while (records.length > 0 && isTraceRecordExpired(records[0], cutoff)) {
    records.shift();
    expired += 1;
  }
  return expired;
}

export function createTraceRecorder(config) {
  const options = normalizeRecorderOptions(config);
  const state = {
    records: [],
    totalRecorded: 0,
    totalEvicted: 0,
    totalExpired: 0,
  };

  const pruneExpired = () => {
    if (state.records.length === 0) {
      return;
    }
    const cutoff = Date.now() - options.maxAgeMs;
    state.totalExpired += removeExpiredRecords(state.records, cutoff);
  };

  return {
    isEnabled() {
      return options.enabled;
    },
    record(event) {
      if (!options.enabled) {
        return null;
      }
      pruneExpired();
      const nextIndex = state.totalRecorded + 1;
      const record = buildTraceRecord(event, options, nextIndex);
      state.totalRecorded += 1;
      state.records.push(record);
      if (state.records.length > options.maxRecords) {
        const evicted = state.records.length - options.maxRecords;
        state.records.splice(0, evicted);
        state.totalEvicted += evicted;
      }
      const durableSelected = shouldPersistDurableSample(options);
      return {
        id: record.id,
        record,
        durableSelected,
      };
    },
    getRecent(limit = 5) {
      pruneExpired();
      const boundedLimit = clampInteger(limit, 5, { min: 1, max: 20 });
      return state.records.slice(-boundedLimit).reverse();
    },
    compact() {
      const storedBefore = state.records.length;
      const expiredBefore = state.totalExpired;
      pruneExpired();
      return {
        storedBefore,
        storedAfter: state.records.length,
        expiredRemoved: state.totalExpired - expiredBefore,
        totalRecorded: state.totalRecorded,
      };
    },
    getStats() {
      pruneExpired();
      const records = [...state.records];
      return {
        enabled: options.enabled,
        storedRecords: records.length,
        totalRecorded: state.totalRecorded,
        totalEvicted: state.totalEvicted,
        totalExpired: state.totalExpired,
        maxRecords: options.maxRecords,
        maxAgeMs: options.maxAgeMs,
        maxRowsPerLookup: options.maxRowsPerLookup,
        maxFilteredRowsPerLookup: options.maxFilteredRowsPerLookup,
        lastRecordedAt: records.at(-1)?.recordedAt ?? null,
        routes: buildRouteCounts(records),
        hooks: buildHookSummaries(records),
        lookupHitRates: buildLookupHitRates(records),
        repeatedWins: buildRepeatedWins(records),
        repeatedMisses: buildRepeatedMisses(records),
      };
    },
  };
}
