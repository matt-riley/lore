export function buildMemoryBackfillTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    normalizeBackfillRequest,
    runControlledBackfillAction,
    runLegacyBackfill,
  } = context;
  return toolDef("memory_backfill", {
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["legacy", "controlled"],
          description: "Legacy one-shot mode or controlled resumable mode",
        },
        action: {
          type: "string",
          enum: ["preview", "start", "resume", "status", "restore"],
          description: "Controlled-mode action",
        },
        limit: { type: "number", description: "Maximum recent sessions to inspect" },
        batchSize: { type: "number", description: "Maximum items to process per controlled batch" },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, backfill across repositories rather than current repo only",
        },
        refreshExisting: {
          type: "boolean",
          description: "When true, reprocess existing digests so improved extraction logic can refresh older summaries",
        },
        runId: {
          type: "string",
          description: "Controlled backfill run id for resume, status, or restore",
        },
        retryFailed: {
          type: "boolean",
          description: "When true, resume retries failed items as well as pending ones",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = formatLoreUnavailable(runtime);
      if (unavailable) {
        return unavailable;
      }

      const request = normalizeBackfillRequest(args, runtime);
      if (request.mode === "controlled") {
        return runControlledBackfillAction({ runtime, request, args });
      }

      return runLegacyBackfill({ runtime, request });
    },
  });
}
