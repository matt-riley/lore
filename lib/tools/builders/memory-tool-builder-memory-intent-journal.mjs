export function buildMemoryIntentJournalTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    buildIntentJournalContext,
    recordIntentJournal,
    listIntentJournal,
  } = context;
  return toolDef("memory_intent_journal", {
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
