import { applyMemoryAdministration, normalizeAdministrationRequest, previewMemoryAdministration } from "../../memory/memory-administration.mjs";

export function buildMemoryPurgeTool(getRuntime, context) {
  return context.toolDef("memory_purge", {
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["preview", "apply"] },
        memoryIds: { type: "array", items: { type: "string" } },
        repository: { type: "string" },
        scope: { type: "string", enum: ["global"] },
        includeDependentAggregates: { type: "boolean" },
        selectedCandidateIds: { type: "array", items: { type: "string" }, maxItems: 200, uniqueItems: true },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        planFingerprint: { type: "string" },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) return JSON.stringify({ action: args.action ?? "preview", operation: "purge", error: runtime.lastError?.message ?? "not initialized" });
      const request = normalizeAdministrationRequest({ ...args, operation: "purge" });
      const report = request.action === "apply"
        ? applyMemoryAdministration(runtime.db, request, args.planFingerprint)
        : previewMemoryAdministration(runtime.db, request);
      return JSON.stringify(report);
    },
  });
}
