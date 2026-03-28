function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function truncateText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || maxChars <= 0) {
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

function buildLatencySummary(values) {
  const samples = values.length;
  if (samples === 0) {
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

  const recentWindowSize = Math.max(1, Math.min(10, Math.floor(samples / 2) || 1));
  const recentValues = values.slice(-recentWindowSize);
  const previousValues = values.slice(-(recentWindowSize * 2), -recentWindowSize);
  const recentAverageMs = Math.round(average(recentValues));
  const previousAverageMs = previousValues.length > 0
    ? Math.round(average(previousValues))
    : 0;
  const trendDeltaMs = previousValues.length > 0
    ? recentAverageMs - previousAverageMs
    : 0;
  const trend = previousValues.length === 0
    ? "insufficient_history"
    : Math.abs(trendDeltaMs) <= 5
      ? "flat"
      : trendDeltaMs > 0
        ? "rising"
        : "falling";

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

function summarizeTraceRow(row, maxChars) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const text = truncateText(
    row.content
      ?? row.summary
      ?? row.excerpt
      ?? row.reason
      ?? JSON.stringify(row),
    maxChars,
  );
  if (!text) {
    return null;
  }
  const score = typeof row.score === "number" ? Number(row.score.toFixed(2)) : null;
  return {
    type: row.type ?? row.sourceType ?? "row",
    repository: row.repository ?? null,
    dateKey: row.date_key ?? row.dateKey ?? null,
    score,
    text,
  };
}

function summarizeFilteredEntry(entry, maxChars) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return {
    stage: entry.stage ?? "filtered",
    reason: entry.reason ?? "filtered",
    row: summarizeTraceRow(entry.row, maxChars),
  };
}

function compactLookup(lookup, options) {
  const rows = ensureArray(lookup?.rows);
  const rankedRows = ensureArray(lookup?.rankedRows);
  const includedRows = ensureArray(lookup?.includedRows);
  const filteredRows = ensureArray(lookup?.filtered);
  const matchedRows = rows.length > 0 ? rows : rankedRows;

  return {
    enabled: lookup?.enabled !== false,
    query: truncateText(lookup?.query ?? "", options.maxPromptChars),
    scopes: ensureArray(lookup?.scopes).map((value) => String(value)),
    eligibleScopes: ensureArray(lookup?.eligibleScopes).map((value) => String(value)),
    reason: lookup?.reason ?? null,
    matchedCount: matchedRows.length,
    includedCount: includedRows.length,
    droppedCount: filteredRows.length,
    matchedRows: matchedRows
      .slice(0, options.maxRowsPerLookup)
      .map((row) => summarizeTraceRow(row, options.maxRowChars))
      .filter(Boolean),
    includedRows: includedRows
      .slice(0, options.maxRowsPerLookup)
      .map((row) => summarizeTraceRow(row, options.maxRowChars))
      .filter(Boolean),
    droppedRows: filteredRows
      .slice(0, options.maxFilteredRowsPerLookup)
      .map((entry) => summarizeFilteredEntry(entry, options.maxRowChars))
      .filter(Boolean),
  };
}

function compactSectionDetails(sectionDetails = []) {
  return ensureArray(sectionDetails)
    .slice(0, 8)
    .map((detail) => ({
      title: detail?.title ?? "Section",
      source: detail?.source ?? "context",
      usedTokens: clampInteger(detail?.usedTokens, 0, { min: 0 }),
      budget: detail?.budget == null ? null : clampInteger(detail.budget, 0, { min: 0 }),
      entryCount: detail?.entryCount == null ? null : clampInteger(detail.entryCount, 0, { min: 0 }),
    }));
}

function compactOmissions(omissions = []) {
  return ensureArray(omissions)
    .slice(0, 12)
    .map((omission) => ({
      stage: omission?.stage ?? "unknown",
      reason: omission?.reason ?? "unspecified",
    }));
}

function compactRouterDecision(routerDecision, fallback) {
  const source = routerDecision && typeof routerDecision === "object"
    ? routerDecision
    : fallback;
  return {
    route: source?.route ?? "unknown",
    reason: source?.reason ?? null,
    includeOtherRepositories: source?.includeOtherRepositories === true,
    usedWorkstreamOverlays: source?.usedWorkstreamOverlays === true,
    usedLegacyPath: source?.usedLegacyPath === true,
    additionalContext: source?.additionalContext === true,
    sectionCount: clampInteger(source?.sectionCount, 0, { min: 0 }),
  };
}

function buildTraceRecord(event, options, index) {
  const trace = event?.trace && typeof event.trace === "object" ? event.trace : {};
  const promptNeed = normalizePromptNeed(event?.promptNeed ?? trace.promptNeed);
  const contextText = truncateText(event?.contextText ?? "", options.maxContextChars);
  const fallbackDecision = {
    route: event?.hook === "onSessionStart"
      ? "session_start_capsule"
      : trace.mode ?? "memory_recall",
    reason: null,
    includeOtherRepositories: promptNeed?.allowCrossRepoFallback === true,
    usedWorkstreamOverlays: Boolean(trace?.lookups?.workstreamOverlays?.includedRows?.length),
    usedLegacyPath: trace?.mode === "legacy_prompt_context",
    additionalContext: contextText.length > 0,
    sectionCount: ensureArray(trace?.output?.sectionTitles).length,
  };

  return {
    id: `trace-${index}`,
    recordedAt: new Date().toISOString(),
    hook: event?.hook ?? "unknown",
    mode: trace?.mode ?? null,
    repository: event?.repository ?? trace?.repository ?? null,
    promptPreview: truncateText(event?.prompt ?? "", options.maxPromptChars),
    latencyMs: clampInteger(event?.latencyMs, 0, { min: 0 }),
    promptNeed,
    eligibility: {
      local: ensureArray(trace?.eligibility?.local).map((value) => String(value)).slice(0, 8),
      crossRepo: ensureArray(trace?.eligibility?.crossRepo).map((value) => String(value)).slice(0, 8),
    },
    routerDecision: compactRouterDecision(trace?.routerDecision, fallbackDecision),
    lookups: Object.fromEntries(
      Object.entries(trace?.lookups ?? {}).map(([name, lookup]) => [name, compactLookup(lookup, options)]),
    ),
    omissions: compactOmissions(trace?.omissions),
    output: {
      estimatedTokens: clampInteger(trace?.output?.estimatedTokens, 0, { min: 0 }),
      sectionTitles: ensureArray(trace?.output?.sectionTitles).map((value) => String(value)).slice(0, 8),
      sectionDetails: compactSectionDetails(trace?.output?.sectionDetails),
      injectedContextPreview: contextText,
      contextInjected: contextText.length > 0,
    },
  };
}

function buildLookupHitRates(records) {
  const lookupMap = new Map();
  for (const record of records) {
    for (const [name, lookup] of Object.entries(record.lookups ?? {})) {
      const entry = lookupMap.get(name) ?? {
        name,
        seenCount: 0,
        matchedCount: 0,
        includedCount: 0,
        droppedCount: 0,
      };
      entry.seenCount += 1;
      if ((lookup?.matchedCount ?? 0) > 0) {
        entry.matchedCount += 1;
      }
      if ((lookup?.includedCount ?? 0) > 0) {
        entry.includedCount += 1;
      }
      entry.droppedCount += clampInteger(lookup?.droppedCount, 0, { min: 0 });
      lookupMap.set(name, entry);
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

function buildRepeatedWins(records) {
  const lookupWins = new Map();
  for (const record of records) {
    for (const [name, lookup] of Object.entries(record.lookups ?? {})) {
      if ((lookup?.includedCount ?? 0) > 0) {
        lookupWins.set(name, (lookupWins.get(name) ?? 0) + 1);
      }
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
    const route = record?.routerDecision?.route ?? "unknown";
    counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([route, count]) => ({ route, count }))
    .sort((left, right) => right.count - left.count || left.route.localeCompare(right.route));
}

function buildHookSummaries(records) {
  const hookMap = new Map();
  for (const record of records) {
    const hook = record?.hook ?? "unknown";
    const entry = hookMap.get(hook) ?? {
      hook,
      latencies: [],
      withContextCount: 0,
    };
    entry.latencies.push(clampInteger(record?.latencyMs, 0, { min: 0 }));
    if (record?.output?.contextInjected === true) {
      entry.withContextCount += 1;
    }
    hookMap.set(hook, entry);
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

function normalizeRecorderOptions(config) {
  return Object.freeze({
    enabled: config?.rollout?.traceRecorder === true,
    maxRecords: clampInteger(config?.traceRecorder?.maxRecords, 40, { min: 1, max: 500 }),
    maxAgeMs: clampInteger(config?.traceRecorder?.maxAgeMs, 30 * 60 * 1000, { min: 60 * 1000, max: 24 * 60 * 60 * 1000 }),
    maxRowsPerLookup: clampInteger(config?.traceRecorder?.maxRowsPerLookup, 3, { min: 1, max: 10 }),
    maxFilteredRowsPerLookup: clampInteger(config?.traceRecorder?.maxFilteredRowsPerLookup, 3, { min: 1, max: 10 }),
    maxPromptChars: clampInteger(config?.traceRecorder?.maxPromptChars, 160, { min: 32, max: 500 }),
    maxRowChars: clampInteger(config?.traceRecorder?.maxRowChars, 160, { min: 32, max: 500 }),
    maxContextChars: clampInteger(config?.traceRecorder?.maxContextChars, 600, { min: 64, max: 4000 }),
    persistDurableSample: config?.traceRecorder?.persistDurableSample !== false,
    durableSampleRate: Math.min(1, Math.max(0, Number(config?.traceRecorder?.durableSampleRate ?? 0.25))),
    durableMaxRowsPerRepository: clampInteger(config?.traceRecorder?.durableMaxRowsPerRepository, 120, { min: 20, max: 5000 }),
    durableMaxRowsGlobal: clampInteger(config?.traceRecorder?.durableMaxRowsGlobal, 240, { min: 20, max: 10000 }),
    durableMaxAgeMs: clampInteger(config?.traceRecorder?.durableMaxAgeMs, 14 * 24 * 60 * 60 * 1000, { min: 60 * 60 * 1000, max: 365 * 24 * 60 * 60 * 1000 }),
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
    let expired = 0;
    while (state.records.length > 0) {
      const first = state.records[0];
      const recordedAt = Date.parse(first.recordedAt);
      if (!Number.isFinite(recordedAt) || recordedAt >= cutoff) {
        break;
      }
      state.records.shift();
      expired += 1;
    }
    state.totalExpired += expired;
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
