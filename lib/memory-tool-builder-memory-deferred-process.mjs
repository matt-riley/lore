export function buildMemoryDeferredProcessTool(getRuntime, context) {
  const {
    toolDef,
    withAvailableRuntime,
    ensureLimit,
    processDeferredExtractions,
  } = context;
  return toolDef("memory_deferred_process", {
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum queued jobs to process" },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, process queued jobs across repositories",
        },
      },
    },
    handler: withAvailableRuntime(getRuntime, async ({ args, runtime }) => {
      const limit = ensureLimit(args.limit, runtime.config.deferredExtraction?.maxJobsPerRun ?? 2, 20);
      const includeOtherRepositories = args.includeOtherRepositories === true;
      const result = await processDeferredExtractions({
        db: runtime.db,
        sessionStore: runtime.sessionStore,
        repository: includeOtherRepositories ? null : runtime.repository,
        limit,
        retryDelayMinutes: runtime.config.deferredExtraction?.retryDelayMinutes ?? 15,
        fetchImpl: runtime.localInferenceFetch,
      });
      return [
        `Processed ${result.processed} deferred job(s), failed ${result.failed}, inspected ${result.inspected}.`,
        `Local inference used ${result.inferenceUsed}, fell back ${result.inferenceFailed}.`,
      ].join("\n");
    }),
  });
}
