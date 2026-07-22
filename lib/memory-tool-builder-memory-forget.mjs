export function buildMemoryForgetTool(getRuntime, context) {
  const {
    toolDef,
    ensureString,
  } = context;
  return toolDef("memory_forget", {
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Semantic memory id" },
        supersededBy: { type: "string", description: "Optional replacement id or note" },
      },
      required: ["id"],
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const id = ensureString(args.id, "id");
      runtime.db.forgetMemory({
        id,
        supersededBy: typeof args.supersededBy === "string" ? args.supersededBy : undefined,
      });
      return `Marked memory ${id} as superseded.`;
    },
  });
}
