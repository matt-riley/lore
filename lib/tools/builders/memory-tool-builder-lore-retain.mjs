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
