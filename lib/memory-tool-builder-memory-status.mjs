export function buildMemoryStatusTool(getRuntime, context) {
  const {
    toolDef,
    formatActivityStates,
    formatRetrievalTraceSampleRows,
    buildMemoryStatusIdentityLines,
    buildMemoryStatusRolloutLines,
    deriveMemoryStatusActivityPhases,
    buildMemoryStatusLifecycleLines,
    buildMemoryStatusImprovementLines,
    buildMemoryStatusTraceArtifactLines,
    buildMemoryStatusMetricLines,
    appendTraceRecorderStatusLines,
    appendRecentTraceSection,
    appendRecentTrajectorySection,
    appendMaintenanceSections,
    getMaintenanceStatus,
  } = context;
  return toolDef("memory_status", {
    parameters: {
      type: "object",
      properties: {
        includeRecentTraces: {
          type: "boolean",
          description: "When true, append recent bounded trace-recorder entries",
        },
        recentTraceLimit: {
          type: "number",
          description: "Maximum recent trace entries to render when includeRecentTraces is true",
        },
        includeRecentTrajectoryArtifacts: {
          type: "boolean",
          description: "When true, append recent sampled durable trajectory artifacts",
        },
        recentTrajectoryLimit: {
          type: "number",
          description: "Maximum recent trajectory artifacts to render when includeRecentTrajectoryArtifacts is true",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const stats = runtime.db.getStats();
      const activityPhases = deriveMemoryStatusActivityPhases(stats);
      const traceStats = runtime.traceRecorder?.getStats?.() ?? null;
      const activityStates = runtime.db.getActivityState({
        repository: runtime.repository,
        includeGlobal: true,
      });
      const recentDurableTraceSamples = runtime.db.listRetrievalTraceSamples({
        repository: runtime.repository,
        includeGlobal: true,
        limit: 5,
      });
      const maintenance = getMaintenanceStatus({
        runtime,
        repository: runtime.repository,
      });
      const lines = [
        ...buildMemoryStatusIdentityLines(runtime, stats),
        ...buildMemoryStatusRolloutLines(runtime, maintenance),
        ...buildMemoryStatusLifecycleLines(stats, activityPhases),
        ...buildMemoryStatusImprovementLines(stats),
        ...buildMemoryStatusTraceArtifactLines(runtime, stats),
        ...buildMemoryStatusMetricLines(runtime),
      ];

      appendTraceRecorderStatusLines(lines, traceStats);
      appendRecentTraceSection(lines, runtime, args);

      lines.push("", "## Last Success Activity", "", ...formatActivityStates(activityStates));
      lines.push("", "## Durable Retrieval Trace Samples", "", formatRetrievalTraceSampleRows(recentDurableTraceSamples));
      appendRecentTrajectorySection(lines, runtime, args);
      appendMaintenanceSections(lines, maintenance);

      return lines.join("\n");
    },
  });
}
