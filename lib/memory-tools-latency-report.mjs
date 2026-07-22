export function formatLatencyMetric(prefix, metric) {
  const normalized = normalizeLatencyMetric(metric);
  return [
    formatLatencyMetricLine(prefix, "P50Ms", normalized.p50Ms),
    formatLatencyMetricLine(prefix, "P95Ms", normalized.p95Ms),
    formatLatencyMetricLine(prefix, "AverageMs", normalized.averageMs),
    formatLatencyMetricLine(prefix, "MaxMs", normalized.maxMs),
    formatLatencyMetricLine(prefix, "LatestMs", normalized.latestMs),
    formatLatencyMetricLine(prefix, "Samples", normalized.samples),
    formatLatencyMetricLine(prefix, "P95Readiness", normalized.readiness),
    formatLatencyMetricLine(prefix, "MinSamplesForP95", normalized.minSamples),
    formatLatencyMetricLine(prefix, "TargetMs", normalized.targetMs),
    formatLatencyMetricLine(prefix, "TargetStatus", normalized.targetStatus),
    formatLatencyMetricLine(prefix, "RecentAverageMs", normalized.recentAverageMs),
    formatLatencyMetricLine(prefix, "PreviousAverageMs", normalized.previousAverageMs),
    formatLatencyMetricLine(prefix, "Trend", normalized.trend),
    formatLatencyMetricLine(prefix, "TrendDeltaMs", normalized.trendDeltaMs),
  ];
}

function formatLatencyMetricLine(prefix, suffix, value) {
  return `${prefix}${suffix}: ${value}`;
}

function normalizeLatencyMetric(metric) {
  const {
    p50Ms = 0,
    p95Ms = 0,
    averageMs = 0,
    maxMs = 0,
    latestMs = 0,
    samples = 0,
    readiness = "unknown",
    minSamples = 0,
    targetMs = 0,
    targetStatus = "unknown",
    recentAverageMs = 0,
    previousAverageMs = 0,
    trend = "unknown",
    trendDeltaMs = 0,
  } = metric ?? {};
  return {
    p50Ms,
    p95Ms,
    averageMs,
    maxMs,
    latestMs,
    samples,
    readiness,
    minSamples,
    targetMs,
    targetStatus,
    recentAverageMs,
    previousAverageMs,
    trend,
    trendDeltaMs,
  };
}
