export function buildLoreRetainTool(getRuntime, context) {
  const {
    toolDef,
    normalizeRetainContext,
    formatLoreUnavailable,
    applyRetainDomainContext,
    buildWorkstreamRetainPayload,
    buildSemanticRetainPayload,
    formatRetainResult,
    retainMemory,
  } = context;
  return toolDef("lore_retain", {
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["semantic", "workstream"],
          description: "Whether to save a normal semantic memory or a workstream overlay",
        },
        type: { type: "string", description: "Semantic memory type when kind is semantic" },
        content: { type: "string", description: "Semantic memory content when kind is semantic" },
        repository: { type: "string", description: "Optional repository override" },
        scope: {
          type: "string",
          enum: ["global", "transferable", "repo"],
          description: "Optional explicit scope override",
        },
        confidence: { type: "number", description: "Optional confidence score" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional semantic memory tags",
        },
        domainKey: {
          type: "string",
          description: "Optional memory domain key for the retained semantic memory",
        },
        domainKind: {
          type: "string",
          enum: ["assistant", "user", "repo", "workstream", "person", "topic", "custom"],
          description: "Optional domain kind when creating/updating a domain alongside retain",
        },
        domainTitle: {
          type: "string",
          description: "Optional domain title when creating/updating a domain alongside retain",
        },
        domainMission: {
          type: "string",
          description: "Optional domain mission when creating/updating a domain alongside retain",
        },
        domainDirectives: {
          type: "array",
          items: { type: "string" },
          description: "Optional domain directives when creating/updating a domain alongside retain",
        },
        metadata: {
          type: "object",
          description: "Optional semantic memory metadata object",
        },
        workstreamId: { type: "string", description: "Stable identifier for the workstream overlay" },
        title: { type: "string", description: "Workstream title" },
        mission: { type: "string", description: "Workstream mission" },
        objective: { type: "string", description: "Current objective" },
        status: {
          type: "string",
          enum: ["active", "blocked", "paused", "done"],
          description: "Workstream status",
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Active workstream constraints",
        },
        blockers: {
          type: "array",
          items: { type: "string" },
          description: "Current blockers",
        },
        nextActions: {
          type: "array",
          items: { type: "string" },
          description: "Next actions",
        },
        decisions: {
          type: "array",
          items: { type: "string" },
          description: "Retained high-salience decisions",
        },
        retainPriorities: {
          type: "array",
          items: { type: "string" },
          description: "Extraction steering priorities",
        },
        reflectPriorities: {
          type: "array",
          items: { type: "string" },
          description: "Synthesis steering priorities",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = formatLoreUnavailable(runtime);
      if (unavailable) {
        return unavailable;
      }

      const retainContext = normalizeRetainContext(args, runtime);
      const domainOutcome = applyRetainDomainContext({
        runtime,
        args,
        repository: retainContext.repository,
        scope: retainContext.scope,
        domainKey: retainContext.domainKey,
      });
      if (domainOutcome) {
        return domainOutcome;
      }

      if (retainContext.kind === "workstream") {
        return formatRetainResult(retainMemory({
          db: runtime.db,
          kind: retainContext.kind,
          overlay: buildWorkstreamRetainPayload(args, {
            repository: retainContext.repository,
            scope: retainContext.scope,
            invocation,
          }),
        }), retainContext.kind);
      }

      return formatRetainResult(retainMemory({
        db: runtime.db,
        kind: retainContext.kind,
        memory: buildSemanticRetainPayload(args, {
          repository: retainContext.repository,
          scope: retainContext.scope,
          domainKey: retainContext.domainKey,
          invocation,
        }),
      }), retainContext.kind);
    },
  });
}
