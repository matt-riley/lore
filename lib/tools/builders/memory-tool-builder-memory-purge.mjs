import { applyMemoryAdministration, normalizeAdministrationRequest, previewMemoryAdministration } from "../../memory/memory-administration.mjs";

export function buildMemoryPurgeTool(getRuntime, context) {
  return context.toolDef("lore_purge", {
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
