function formatItemLine(item) {
  const scope = item.scope ?? "unknown";
  const repository = item.repository ? `/${item.repository}` : "";
  const detail = item.verdict === "reclassify"
    ? ` -> ${item.reclassifiedType}`
    : item.verdict === "demote"
      ? ` -> repo:${item.targetRepository ?? "unknown"}`
      : "";
  return `- [${item.verdict}${detail}] [${scope}${repository}/${item.memoryType}] ${item.reason}: `
    + `${String(item.content ?? "").slice(0, 140)}`;
}

export function buildLoreAuditExtractionsTool(getRuntime, context) {
  const {
    toolDef,
    runExtractionRevalidation,
    rollbackExtractionRevalidation,
  } = context;
  return toolDef("lore_audit_extractions", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }

      const action = typeof args.action === "string" ? args.action : "run";

      if (action === "rollback") {
        if (typeof args.marker !== "string" || !args.marker.trim()) {
          return "lore audit-extractions rollback requires --marker <extractor-revalidation:runId>";
        }
        const result = rollbackExtractionRevalidation({
          db: runtime.db,
          marker: args.marker,
          actor: args.actor,
          reason: args.reason,
        });
        return [
          `marker: ${result.marker}`,
          `restoredRejectedCount: ${result.restoredRejectedIds.length}`,
          `restoredRejectedIds: ${result.restoredRejectedIds.join(",") || "none"}`,
          `restoredOverrideCount: ${result.restoredOverrideIds.length}`,
          `restoredOverrideIds: ${result.restoredOverrideIds.join(",") || "none"}`,
          `artifactId: ${result.artifactId}`,
        ].join("\n");
      }

      const mode = args.apply === true ? "apply" : "shadow";
      const result = runExtractionRevalidation({
        db: runtime.db,
        repository: typeof args.repository === "string" && args.repository.trim() ? args.repository : runtime.repository,
        mode,
        maxItems: Number.isFinite(args.maxItems) ? args.maxItems : 50,
        includeGlobal: args.includeGlobal !== false,
        actor: typeof args.actor === "string" && args.actor.trim() ? args.actor : "extractor_revalidation",
        reason: typeof args.reason === "string" && args.reason.trim() ? args.reason : null,
      });

      return [
        "## Extraction Revalidation",
        "",
        `mode: ${result.mode}`,
        `marker: ${result.marker}`,
        `extractorVersion: ${result.extractorVersion}`,
        `inspected: ${result.inspectedCount}`,
        `keep: ${result.keepCount}`,
        `reject: ${result.rejectCount}`,
        `reclassify: ${result.reclassifyCount}`,
        `demote: ${result.demoteCount}`,
        `applied: ${result.appliedCount}`,
        "",
        ...result.items.filter((item) => item.verdict !== "keep").slice(0, 20).map(formatItemLine),
        result.mode === "shadow" && result.inspectedCount > result.keepCount
          ? ""
          : undefined,
        result.mode === "shadow" && result.inspectedCount > result.keepCount
          ? `Dry run: re-run with --apply to supersede/reclassify/demote under marker ${result.marker} (rollback with --action rollback --marker ${result.marker}).`
          : undefined,
      ].filter((line) => line !== undefined).join("\n");
    },
  });
}
