export function buildMemorySearchTool(getRuntime, context) {
  const {
    toolDef,
    formatRows,
    ensureString,
    ensureLimit,
  } = context;
  return toolDef("memory_search", {
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        type: { type: "string", description: "Optional semantic memory type filter" },
        limit: { type: "number", description: "Optional result limit" },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, search beyond the current repository scope",
        },
      },
      required: ["query"],
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const query = ensureString(args.query, "query");
      const limit = ensureLimit(args.limit, 6, 50);
      const includeOtherRepositories = args.includeOtherRepositories === true;
      const types = typeof args.type === "string" && args.type.trim().length > 0
        ? [args.type.trim()]
        : [];

      const semantic = runtime.db.searchSemantic({
        query,
        repository: runtime.repository,
        includeOtherRepositories,
        types,
        limit,
        includeTypedFallback: true,
      });
      const episodes = runtime.db.searchEpisodes({
        query,
        repository: runtime.repository,
        includeOtherRepositories,
        limit: Math.max(1, Math.floor(limit / 2)),
      });

      return [
        "## Semantic Memory",
        "",
        formatRows(
          semantic,
          (row) => [
            `- [${row.id} ${row.type}/${row.scope}/${row.scope_source}]`,
            row.content,
            `(${row.repository ?? "global"})`,
            row.canonical_key ? `canonical=${row.canonical_key}` : null,
            `reinforcement=${row.reinforcement_count ?? 1}`,
            row.last_seen_at ? `lastSeen=${row.last_seen_at}` : null,
          ].filter(Boolean).join(" "),
        ),
        "",
        "## Episodic Memory",
        "",
        formatRows(
          episodes,
          (row) => `- [${row.id} ${row.scope}/${row.scope_source}] ${row.summary} (${row.repository ?? "global"}, ${row.date_key})`,
        ),
      ].join("\n");
    },
  });
}
