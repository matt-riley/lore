export function buildMemorySaveTool(getRuntime, context) {
  const {
    toolDef,
    withAvailableRuntime,
    ensureString,
    retainMemory,
  } = context;
  return toolDef("memory_save", {
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Memory content to persist" },
        type: { type: "string", description: "Semantic memory type" },
        repository: { type: "string", description: "Optional explicit repository scope" },
        scope: { type: "string", description: "Optional memory scope: global, transferable, or repo" },
        confidence: { type: "number", description: "Optional confidence score from 0 to 1" },
      },
      required: ["content", "type"],
    },
    handler: withAvailableRuntime(getRuntime, async ({ args, invocation, runtime }) => {
      const content = ensureString(args.content, "content");
      const type = ensureString(args.type, "type");
      const confidence = typeof args.confidence === "number" ? args.confidence : 0.9;
      const retained = retainMemory({
        db: runtime.db,
        kind: "semantic",
        memory: {
          type,
          content,
          confidence,
          repository: typeof args.repository === "string" && args.repository.trim()
            ? args.repository.trim()
            : null,
          scope: typeof args.scope === "string" ? args.scope.trim() : undefined,
          sourceSessionId: invocation.sessionId,
          tags: [type, "manual"],
          metadata: { source: "memory_save" },
        },
      });

      return retained.id
        ? `Saved semantic memory ${retained.id}`
        : "Skipped semantic memory save: empty after sanitization.";
    }),
  });
}
