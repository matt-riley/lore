export function buildMemoryBackfillTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    normalizeBackfillRequest,
    runControlledBackfillAction,
    runLegacyBackfill,
  } = context;
  return toolDef("lore_backfill", {
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
