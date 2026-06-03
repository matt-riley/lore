import { ensureArray, formatRows } from "./memory-tools-helpers.mjs";

export function formatRetrievalTraceSampleRows(rows) {
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

export function formatTrajectoryArtifactRows(rows) {
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

export function formatDoctorReport(result) {
  if (!result.incidentCount) {
    return [
      `# Lore Doctor Report`,
      `generatedAt: ${result.generatedAt}`,
      `repository: ${result.repository ?? "global"}`,
      `incidents: 0 — no incidents classified`,
      `signals: maintenanceTasks=${result.signals.maintenanceTaskCount} trajectoryScanned=${result.signals.trajectoryRecentCount}`,
    ].join("\n");
  }
  const header = [
    `# Lore Doctor Report`,
    `generatedAt: ${result.generatedAt}`,
    `repository: ${result.repository ?? "global"}`,
    `incidents: ${result.incidentCount} (critical=${result.criticalCount} warning=${result.warningCount} info=${result.infoCount})`,
    `signals: maintenanceTasks=${result.signals.maintenanceTaskCount} trajectoryScanned=${result.signals.trajectoryRecentCount} improvementActive=${result.signals.improvementActiveCount}`,
    result.recordedArtifactId ? `recordedArtifact: ${result.recordedArtifactId}` : null,
    ``,
    `## Incidents`,
    ``,
  ].filter((line) => line != null).join("\n");
  const incidentLines = result.incidents.map((inc) => {
    const contextPairs = Object.entries(inc.context ?? {})
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
      .join(" ");
    return `- [${inc.severity}] ${inc.kind}: ${inc.summary}${contextPairs ? `\n  context: ${contextPairs}` : ""}`;
  });
  return [header, ...incidentLines].join("\n");
}

export function formatDoctorSafetyGateSection(result) {
  const lines = ["", "## Safety Gate (observe-only)", ""];
  if (!result || result.actionCount === 0) {
    lines.push("actions: 0");
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(`actions: ${result.actionCount}`);
  lines.push(`highestRisk: ${result.highestRisk}`);
  lines.push(
    `riskCounts: low=${result.riskCounts.low} moderate=${result.riskCounts.moderate} high=${result.riskCounts.high} critical=${result.riskCounts.critical}`,
  );
  lines.push("");
  for (const action of ensureArray(result.actions)) {
    const reasons = ensureArray(action.riskReasons).join(",");
    lines.push(
      [
        `- [${action.riskTier}] ${action.toolName}.${action.operation}`,
        `id=${action.id}`,
        action.target ? `target=${action.target}` : null,
        `mutability=${action.mutability}`,
        `reversibility=${action.reversibility}`,
        `scope=${action.scope}`,
        `riskScore=${action.riskScore}`,
        reasons ? `riskReasons=${reasons}` : null,
      ].filter(Boolean).join(" "),
    );
  }
  return lines.join("\n");
}

export function formatReviewGateReport(result) {
  const lines = [
    `# Review Gate — proposal_doc`,
    `generatedAt: ${result.generatedAt}`,
    `wordCount: ${result.wordCount}`,
    result.findingCount === 0
      ? `findings: 0 — all required sections present`
      : `findings: ${result.findingCount}`,
    result.recordedArtifactId ? `recordedArtifact: ${result.recordedArtifactId}` : null,
  ].filter((line) => line != null);
  if (result.findingCount > 0) {
    lines.push(``, `## Findings`, ``);
    for (const finding of result.findings) {
      lines.push(`- [${finding.severity}] ${finding.section}: ${finding.detail}`);
    }
  }
  return lines.join("\n");
}
