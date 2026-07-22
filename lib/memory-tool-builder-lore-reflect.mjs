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
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or reflection prompt to analyze" },
        focus: {
          type: "string",
          enum: ["summary", "patterns", "blockers", "decisions", "next_actions"],
          description: "Optional reflection focus override",
        },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, allow transferable cross-repository fallback where applicable",
        },
        limit: { type: "number", description: "Optional result budget" },
        lookbackHours: {
          type: "number",
          description: "Optional explicit time window (in hours) to directly pull real session activity from across repositories, bypassing free-text date detection. E.g. 24 for \"last day\".",
        },
        detailLevel: {
          type: "string",
          enum: ["summary", "evidence", "full"],
          description: "How much supporting reflection evidence to render",
        },
        persistObservation: {
          type: "boolean",
          description: "When true, save the reflection result as a refreshable observation",
        },
        observationKey: {
          type: "string",
          description: "Optional stable key for the saved observation",
        },
        domainKey: {
          type: "string",
          description: "Optional memory domain key for a saved observation",
        },
        freshnessHours: {
          type: "number",
          description: "Optional freshness window for a saved observation",
        },
        useLocalInference: {
          type: "boolean",
          description: "Override the configured default for synthesis with the local inference provider",
        },
      },
      required: ["prompt"],
    },
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
      let reflection = reflectMemory({
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
        reflection = reflectMemory({
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
