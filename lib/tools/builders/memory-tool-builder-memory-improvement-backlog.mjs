export function buildMemoryImprovementBacklogTool(getRuntime, context) {
  const {
    toolDef,
    withAvailableRuntime,
    formatImprovementArtifactRows,
    normalizeImprovementStatus,
    ensureString,
    ensureLimit,
  } = context;
  return toolDef("memory_improvement_backlog", {
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "resolve", "supersede"],
          description: "List artifacts or update artifact lifecycle state",
        },
        id: { type: "string", description: "Artifact id for resolve or supersede" },
        supersededBy: { type: "string", description: "Required for supersede action" },
        sourceKind: {
          type: "string",
          enum: ["session", "validation", "replay", "signal"],
          description: "Optional source kind filter for list",
        },
        sourceCaseId: { type: "string", description: "Optional source case id filter for list" },
        status: {
          type: "string",
          enum: ["active", "resolved", "superseded"],
          description: "Optional status filter for list",
        },
        limit: {
          type: "number",
          description: "Maximum items to return",
        },
      },
    },
    handler: withAvailableRuntime(getRuntime, async ({ args, runtime }) => {
      const action = typeof args.action === "string" ? args.action : "list";
      if (action === "resolve") {
        const id = ensureString(args.id, "id");
        runtime.db.updateImprovementArtifactStatus({
          id,
          status: "resolved",
        });
        return `Resolved improvement artifact ${id}.`;
      }
      if (action === "supersede") {
        const id = ensureString(args.id, "id");
        const supersededBy = ensureString(args.supersededBy, "supersededBy");
        runtime.db.updateImprovementArtifactStatus({
          id,
          status: "superseded",
          supersededBy,
        });
        return `Superseded improvement artifact ${id} with ${supersededBy}.`;
      }
      const rows = runtime.db.listImprovementArtifacts({
        sourceKind: typeof args.sourceKind === "string" ? args.sourceKind : undefined,
        sourceCaseId: typeof args.sourceCaseId === "string" ? args.sourceCaseId : undefined,
        status: typeof args.status === "string" ? normalizeImprovementStatus(args.status) : undefined,
        limit: ensureLimit(args.limit, 10, 20),
      });
      return [
        "## Improvement Backlog",
        "",
        formatImprovementArtifactRows(rows),
      ].join("\n");
    }),
  });
}
