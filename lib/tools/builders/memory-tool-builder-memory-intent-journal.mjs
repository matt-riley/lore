export function buildMemoryIntentJournalTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    buildIntentJournalContext,
    recordIntentJournal,
    listIntentJournal,
  } = context;
  return toolDef("memory_intent_journal", {
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "record"],
          description: "List recent entries or record a new entry",
        },
        kind: {
          type: "string",
          enum: ["journal", "routing", "rollout", "reviewer", "fallback", "serendipity"],
          description: "Intent kind for record/list filtering",
        },
        summary: {
          type: "string",
          description: "Short decision/discovery summary for record",
        },
        rationale: {
          type: "string",
          description: "Optional rationale for the decision or discovery",
        },
        turnHint: {
          type: "string",
          description: "Optional free-form turn marker such as 'after-memory_replay'",
        },
        sessionId: {
          type: "string",
          description: "Optional session id override for record/list",
        },
        context: {
          type: "object",
          description: "Optional structured metadata for record",
        },
        repository: {
          type: "string",
          description: "Optional repository override for record/list",
        },
        limit: {
          type: "number",
          description: "Maximum rows to return for list",
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = formatLoreUnavailable(runtime);
      if (unavailable) {
        return unavailable;
      }
      const context = buildIntentJournalContext(args, runtime, invocation);
      return context.action === "record"
        ? recordIntentJournal(runtime, args, context)
        : listIntentJournal(runtime, args, context);
    },
  });
}
