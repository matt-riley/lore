export function buildMemoryExplainTool(getRuntime, context) {
  const {
    toolDef,
    ensureString,
    explainMemoryRetrieval,
    renderExplanationReport,
  } = context;
  return toolDef("memory_explain", {
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt to explain" },
        mode: {
          type: "string",
          description: "Explain prompt-time retrieval or the session-start capsule",
          enum: ["prompt", "session_start"],
        },
      },
      required: ["prompt"],
    },
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
