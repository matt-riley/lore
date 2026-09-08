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
