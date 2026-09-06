export function buildMemoryCapabilityInventoryTool(_getRuntime, context) {
  const {
    toolDef,
    ensureLimit,
    normalizeCapabilityInventoryAction,
    renderCapabilityInventoryAction,
  } = context;
  return toolDef("memory_capability_inventory", {
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "recommend", "route", "evaluate", "json"],
          description: "Show the local inventory, run the recommendation-only router core, evaluate the router corpus, or return raw JSON",
        },
        prompt: {
          type: "string",
          description: "Prompt to score through the local-first router core when action is recommend or route",
        },
        caseIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional router evaluation case IDs to run when action is evaluate",
        },
        detailLevel: {
          type: "string",
          enum: ["summary", "full"],
          description: "How much inventory detail to render for summary mode",
        },
        limit: {
          type: "number",
          description: "Maximum route candidates or capabilities to show",
        },
      },
    },
    handler: async (args) => {
      const action = normalizeCapabilityInventoryAction(args.action);
      const limit = ensureLimit(args.limit, 5, 20);
      return renderCapabilityInventoryAction(args, limit, action);
    },
  });
}
