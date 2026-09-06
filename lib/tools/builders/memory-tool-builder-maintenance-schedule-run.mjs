export function buildMaintenanceScheduleRunTool(getRuntime, context) {
  const {
    toolDef,
    ensureArray,
    formatMaintenanceReport,
    getMaintenanceStatus,
    rollbackMemoryHygiene,
    runMaintenanceSweep,
  } = context;
  return toolDef("maintenance_schedule_run", {
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "run", "rollback_hygiene"],
          description: "Show scheduler status, run a maintenance sweep, or roll back one automated hygiene marker",
        },
        dryRun: {
          type: "boolean",
          description: "When true, preview the sweep without mutating maintenance state",
        },
        force: {
          type: "boolean",
          description: "Ignore per-task cadence and force currently enabled tasks to be due",
        },
        includeRecentRuns: {
          type: "boolean",
          description: "When true, include recent maintenance runs in the report",
        },
        tasks: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "memoryHygiene",
              "deferredExtraction",
              "validationCorpus",
              "replayCorpus",
              "backlogReview",
              "traceCompaction",
              "indexUpkeep",
              "doctorSnapshot",
            ],
          },
          description: "Optional subset of maintenance tasks to evaluate or run",
        },
        marker: {
          type: "string",
          description: "Exact auto-hygiene marker required for rollback_hygiene",
        },
        actor: {
          type: "string",
          description: "Operator identity recorded in a hygiene rollback audit",
        },
        reason: {
          type: "string",
          description: "Human-readable reason recorded in a hygiene rollback audit",
        },
      },
    },
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
