export function buildMemoryReviewGateTool(getRuntime, context) {
  const {
    toolDef,
    formatReviewGateReport,
    readReviewGateEnabled,
    runReviewGate,
  } = context;
  return toolDef("memory_review_gate", {
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: {
          type: "string",
          description: "Proposal-doc text to review",
        },
        dryRun: {
          type: "boolean",
          description: "When true, run checks but skip recording a trajectory artifact",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }
      if (!readReviewGateEnabled(runtime.config)) {
        return "memory_review_gate: disabled — set rollout.reviewGate: true in lore.json to enable";
      }
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) {
        return "memory_review_gate: text must be a non-empty string";
      }
      const result = runReviewGate({
        runtime,
        text,
        repository: runtime.repository,
        dryRun: args.dryRun === true,
      });
      return formatReviewGateReport(result);
    },
  });
}
