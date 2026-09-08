export function buildMemoryExplainTool(getRuntime, context) {
  const {
    toolDef,
    ensureString,
    explainMemoryRetrieval,
    renderExplanationReport,
  } = context;
  return toolDef("lore_explain", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const prompt = ensureString(args.prompt, "prompt");
      const mode = args.mode === "session_start" ? "session_start" : "prompt";
      const explanation = await explainMemoryRetrieval({
        runtime,
        prompt,
        mode,
      });
      return renderExplanationReport(explanation);
    },
  });
}
