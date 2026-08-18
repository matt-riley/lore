import { semanticSearch, semanticSearchEnabled } from "./semantic-search.mjs";

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
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt or question to recall context for" },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, allow transferable cross-repository fallback where applicable",
        },
        limit: { type: "number", description: "Optional result budget" },
        includeTrace: {
          type: "boolean",
          description: "When true, include a compact lookup summary",
        },
        detailLevel: {
          type: "string",
          enum: ["context", "evidence", "full"],
          description: "How much supporting retrieval evidence to render",
        },
      },
      required: ["prompt"],
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const prompt = ensureString(args.prompt, "prompt");
      const queryExpansion = await resolveRetrievalPrompt(runtime, prompt);
      let result = recallMemory({
        db: runtime.db,
        prompt,
        retrievalPrompt: queryExpansion.query,
        repository: runtime.repository,
        includeOtherRepositories: args.includeOtherRepositories === true,
        limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
        sessionStore: runtime.sessionStore,
      });
      if (queryExpansion.used && !recallHasQueryEvidence(result)) {
        result = recallMemory({
          db: runtime.db,
          prompt,
          retrievalPrompt: queryExpansion.deterministicQuery,
          repository: runtime.repository,
          includeOtherRepositories: args.includeOtherRepositories === true,
          limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
          sessionStore: runtime.sessionStore,
        });
        queryExpansion.fallbackUsed = true;
      }
      result.queryExpansion = queryExpansion;

      // Semantic (vector) matches are appended when embeddings are configured
      // and the local endpoint is reachable. Fails open to lexical-only.
      if (semanticSearchEnabled(runtime.config)) {
        const semantic = await semanticSearch({
          db: runtime.db,
          query: prompt,
          repository: runtime.repository,
          limit: ensureLimit(args.limit, runtime.config.limits.promptContextLimit, 50),
        });
        if (semantic.enabled && semantic.rows.length > 0) {
          result.semanticMatches = semantic.rows;
        }
      }

      return formatRecallEnvelope(result, {
        detailLevel: args.detailLevel === "full" || args.detailLevel === "evidence"
          ? args.detailLevel
          : "context",
        includeTrace: args.includeTrace === true,
      });
    },
  });
}
