import { applyMemoryAdministration, normalizeAdministrationRequest, previewMemoryAdministration } from "../../memory/memory-administration.mjs";

export function buildMemoryRepairTool(getRuntime, context) {
  return context.toolDef("lore_repair", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) return JSON.stringify({ action: args.action ?? "preview", operation: "repair", error: runtime.lastError?.message ?? "not initialized" });
      const request = normalizeAdministrationRequest({ ...args, operation: "repair" });
      const report = request.action === "apply"
        ? applyMemoryAdministration(runtime.db, request, args.planFingerprint)
        : previewMemoryAdministration(runtime.db, request);
      return JSON.stringify(report);
    },
  });
}
