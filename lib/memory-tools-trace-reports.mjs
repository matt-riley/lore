import { ensureArray } from "./memory-tools-array-utils.mjs";
import { formatRows } from "./memory-tools-render-utils.mjs";

function formatRetrievalTraceSampleRows(rows) {
  return formatRows(rows, (row) => [
    `- [${row.id}] hook=${row.hook}`,
    row.repository ? `repository=${row.repository}` : "repository=global",
    row.route ? `route=${row.route}` : null,
    row.routeReason ? `reason=${row.routeReason}` : null,
    `contextInjected=${row.contextInjected === true}`,
    row.latencyMs != null ? `latency=${row.latencyMs}ms` : null,
    `sections=${ensureArray(row.sectionTitles).join(",") || "none"}`,
    `recordedAt=${row.recordedAt}`,
    row.promptPreview ? `prompt=${row.promptPreview}` : null,
  ].filter(Boolean).join(" "));
}

function formatTrajectoryArtifactRows(rows) {
  return formatRows(rows, (row) => {
    const contextKeys = Object.keys(row.context ?? {});
    return [
      `- [${row.id}] kind=${row.kind}`,
      row.source_kind ? `source=${row.source_kind}:${row.source_case_id ?? "n/a"}` : null,
      `severity=${row.severity}`,
      `outcome=${row.outcome}`,
      row.latency_ms != null ? `latency=${row.latency_ms}ms` : null,
      row.target_ms != null ? `target=${row.target_ms}ms` : null,
      row.improvement_artifact_id ? `improvementArtifact=${row.improvement_artifact_id}` : null,
      row.event_key ? `event=${row.event_key}` : null,
      contextKeys.length > 0 ? `contextKeys=${contextKeys.join(",")}` : null,
      `summary=${row.summary}`,
      `created=${row.created_at}`,
    ].filter(Boolean).join(" ");
  });
}

export {
  formatRetrievalTraceSampleRows,
  formatTrajectoryArtifactRows,
};
