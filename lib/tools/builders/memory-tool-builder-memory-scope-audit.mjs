export function buildMemoryScopeAuditTool(getRuntime, context) {
  const {
    toolDef,
    ensureLimit,
    formatAuditRows,
  } = context;
  return toolDef("memory_scope_audit", {
    parameters: {
      type: "object",
      properties: {
        targetType: {
          type: "string",
          enum: ["semantic", "episode"],
          description: "Optional audit filter by target type",
        },
        targetId: {
          type: "string",
          description: "Optional specific row id to inspect",
        },
        limit: {
          type: "number",
          description: "Maximum audit rows to show",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const rows = runtime.db.listScopeOverrideAudit({
        targetType: typeof args.targetType === "string" ? args.targetType : undefined,
        targetId: typeof args.targetId === "string" ? args.targetId : undefined,
        limit: ensureLimit(args.limit, 10, 50),
      });
      return [
        "## Scope Override Audit",
        "",
        formatAuditRows(rows),
      ].join("\n");
    },
  });
}
