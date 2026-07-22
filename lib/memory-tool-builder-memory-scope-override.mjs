export function buildMemoryScopeOverrideTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    buildScopeOverrideRequest,
    previewScopeOverride,
    applyScopeOverride,
    formatScopePreview,
  } = context;
  return toolDef("memory_scope_override", {
    parameters: {
      type: "object",
      properties: {
        targetType: {
          type: "string",
          enum: ["semantic", "episode"],
          description: "Which memory table to modify",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "One or more target row ids from memory_search output",
        },
        action: {
          type: "string",
          enum: ["set", "clear"],
          description: "Set a manual scope override or clear it back to auto classification",
        },
        scope: {
          type: "string",
          enum: ["global", "transferable", "repo"],
          description: "Required when action is set",
        },
        repository: {
          type: "string",
          description: "Optional repository fallback when assigning a non-global scope to a global row",
        },
        dryRun: {
          type: "boolean",
          description: "When true, preview the scope change without writing",
        },
        actor: {
          type: "string",
          description: "Optional actor label for audit history",
        },
        reason: {
          type: "string",
          description: "Reason for the override or clear action",
        },
        source: {
          type: "string",
          description: "Optional audit source label",
        },
      },
      required: ["targetType", "ids"],
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = formatLoreUnavailable(runtime);
      if (unavailable) {
        return unavailable;
      }

      const request = buildScopeOverrideRequest(args, runtime, invocation);
      const preview = previewScopeOverride(runtime, request);
      if (request.dryRun) {
        return formatScopePreview(preview);
      }
      return applyScopeOverride(runtime, request);
    },
  });
}
