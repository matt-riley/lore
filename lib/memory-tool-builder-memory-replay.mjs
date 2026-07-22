export function buildMemoryReplayTool(getRuntime, context) {
  const {
    toolDef,
    renderReplayReport,
    runReplayCorpus,
  } = context;
  return toolDef("memory_replay", {
    parameters: {
      type: "object",
      properties: {
        caseIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of replay case IDs to run",
        },
        verbose: {
          type: "boolean",
          description: "When true, show all replay cases with evidence samples and lookup sources",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const caseIds = Array.isArray(args.caseIds)
        ? args.caseIds.filter((value) => typeof value === "string" && value.trim().length > 0)
        : [];
      const verbose = args.verbose === true;
      const result = await runReplayCorpus({
        runtime,
        caseIds,
      });
      return renderReplayReport(result, { verbose });
    },
  });
}
