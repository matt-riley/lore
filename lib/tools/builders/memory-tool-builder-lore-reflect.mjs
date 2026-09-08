export function buildLoreReflectTool(getRuntime, context) {
  const {
    toolDef,
    formatLoreUnavailable,
    normalizeReflectionRequest,
    maybePersistReflectionObservation,
    formatReflectionReport,
    reflectMemory,
    enhanceReflectionWithLocalInference,
    reflectionEvidenceCandidateLimit,
    recallHasQueryEvidence,
    resolveRetrievalPrompt,
  } = context;
  return toolDef("lore_reflect", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = formatLoreUnavailable(runtime);
      if (unavailable) {
        return unavailable;
      }

      const request = normalizeReflectionRequest(args, runtime);
      const queryExpansion = await resolveRetrievalPrompt(runtime, request.prompt);
      const recentSessionCandidateLimit = reflectionEvidenceCandidateLimit(
        runtime.config?.localInference,
        request.useLocalInference,
      );
      let reflection = await reflectMemory({
        db: runtime.db,
        prompt: request.prompt,
        retrievalPrompt: queryExpansion.query,
        repository: runtime.repository,
        includeOtherRepositories: request.includeOtherRepositories,
        limit: request.limit,
        sessionStore: runtime.sessionStore,
        focus: request.focus,
        lookbackHours: request.lookbackHours,
        recentSessionCandidateLimit,
      });
      if (queryExpansion.used && !recallHasQueryEvidence(reflection.recall)) {
        reflection = await reflectMemory({
          db: runtime.db,
          prompt: request.prompt,
          retrievalPrompt: queryExpansion.deterministicQuery,
          repository: runtime.repository,
          includeOtherRepositories: request.includeOtherRepositories,
          limit: request.limit,
          sessionStore: runtime.sessionStore,
          focus: request.focus,
          lookbackHours: request.lookbackHours,
          recentSessionCandidateLimit,
        });
        queryExpansion.fallbackUsed = true;
      }
      reflection.queryExpansion = queryExpansion;
      if (request.useLocalInference) {
        if (runtime.config?.localInference?.enabled !== true) {
          reflection = {
            ...reflection,
            localInference: {
              requested: true,
              used: false,
              embeddingsUsed: false,
              embeddingError: null,
              error: "provider disabled",
            },
          };
        } else {
          try {
            reflection = await enhanceReflectionWithLocalInference({
              config: runtime.config.localInference,
              reflection,
              fetchImpl: runtime.localInferenceFetch,
            });
          } catch (error) {
            reflection = {
              ...reflection,
              localInference: {
                requested: true,
                used: false,
                embeddingsUsed: false,
                embeddingError: null,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }

        }
      }
      const observationLine = maybePersistReflectionObservation({
        runtime,
        reflection,
        request,
        args,
      });
      if (observationLine === "refreshable observations rollout is disabled" || observationLine === "memory domains rollout is disabled") {
        return observationLine;
      }
      return [
        observationLine,
        formatReflectionReport(reflection, { detailLevel: request.detailLevel }),
      ].filter(Boolean).join("\n\n");
    },
  });
}
