export function buildLoreRecallTool(getRuntime, context) {
  const {
    toolDef,
    ensureString,
    ensureLimit,
    formatRecallEnvelope,
    recallMemory,
    recallHasQueryEvidence,
    resolveRetrievalPrompt,
  } = context;
  return toolDef("lore_recall", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const prompt = ensureString(args.prompt, "prompt");
      const queryExpansion = await resolveRetrievalPrompt(runtime, prompt);
      let result = await recallMemory({
        db: runtime.db,
        prompt,
        retrievalPrompt: queryExpansion.query,
        repository: runtime.repository,
        includeOtherRepositories: args.includeOtherRepositories === true,
        limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
        sessionStore: runtime.sessionStore,
        fetchImpl: runtime.localInferenceFetch ?? globalThis.fetch,
      });
      if (queryExpansion.used && !recallHasQueryEvidence(result)) {
        result = await recallMemory({
          db: runtime.db,
          prompt,
          retrievalPrompt: queryExpansion.deterministicQuery,
          repository: runtime.repository,
          includeOtherRepositories: args.includeOtherRepositories === true,
          limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
          sessionStore: runtime.sessionStore,
          fetchImpl: runtime.localInferenceFetch ?? globalThis.fetch,
        });
        queryExpansion.fallbackUsed = true;
      }
      result.queryExpansion = queryExpansion;

      return formatRecallEnvelope(result, {
        detailLevel: args.detailLevel === "full" || args.detailLevel === "evidence"
          ? args.detailLevel
          : "context",
        includeTrace: args.includeTrace === true,
      });
    },
  });
}
