import { formatLatencyMetric } from "./memory-tools-latency-report.mjs";

export function buildMemoryStatusMetricLines(runtime) {
  return [
    ...formatLatencyMetric("sessionStart", runtime.metrics.sessionStart),
    ...formatLatencyMetric("userPromptSubmitted", runtime.metrics.userPromptSubmitted),
  ];
}
