export function buildMemoryValidateTool(getRuntime, context) {
  const {
    toolDef,
    renderValidationReport,
    runValidationSet,
  } = context;
  return toolDef("lore_validate", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const caseIds = Array.isArray(args.caseIds)
        ? args.caseIds.filter((value) => typeof value === "string" && value.trim().length > 0)
        : [];
      const verbose = args.verbose === true;
      const result = await runValidationSet({
        runtime,
        caseIds,
      });
      return renderValidationReport(result, { verbose });
    },
  });
}
