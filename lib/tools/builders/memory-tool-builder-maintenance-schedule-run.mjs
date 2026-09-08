export function buildMaintenanceScheduleRunTool(getRuntime, context) {
  const {
    toolDef,
    ensureArray,
    formatMaintenanceReport,
    getMaintenanceStatus,
    rollbackMemoryHygiene,
    runMaintenanceSweep,
  } = context;
  return toolDef("lore_maintenance", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const action = typeof args.action === "string" ? args.action : "status";
      if (action === "rollback_hygiene") {
        const result = rollbackMemoryHygiene({
          db: runtime.db,
          marker: args.marker,
          actor: args.actor,
          reason: args.reason,
        });
        return [
          `marker: ${result.marker}`,
          `restoredCount: ${result.restoredMemoryIds.length}`,
          `restoredMemoryIds: ${result.restoredMemoryIds.join(",") || "none"}`,
          `artifactId: ${result.artifactId}`,
        ].join("\n");
      }
      if (action === "status") {
        const maintenance = getMaintenanceStatus({
          runtime,
          repository: runtime.repository,
        });
        return formatMaintenanceReport({
          status: "status",
          dryRun: true,
          trigger: "status",
          repository: runtime.repository,
          taskCount: maintenance.selectedTasks.length,
          completedCount: 0,
          needsAttentionCount: 0,
          failedCount: 0,
          skippedCount: maintenance.skippedDueToCap,
          tasks: maintenance.selectedTasks.map((task) => ({
            taskName: task.taskName,
            label: task.label,
            status: "planned",
            durationMs: 0,
            summary: task.preview ? { caseIds: task.preview.caseIds } : null,
          })),
          plan: maintenance,
        }, {
          includeRecentRuns: args.includeRecentRuns === true,
        });
      }

      const result = await runMaintenanceSweep({
        runtime,
        repository: runtime.repository,
        trigger: "manual",
        requestedTasks: ensureArray(args.tasks),
        force: args.force === true,
        dryRun: args.dryRun === true,
      });
      return formatMaintenanceReport(result, {
        includeRecentRuns: args.includeRecentRuns === true,
      });
    },
  });
}
