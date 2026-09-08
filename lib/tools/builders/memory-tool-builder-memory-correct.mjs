import { applyMemoryAdministration, normalizeAdministrationRequest, previewMemoryAdministration } from "../../memory/memory-administration.mjs";

export function buildMemoryCorrectTool(getRuntime, context) {
  return context.toolDef("lore_correct", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) return JSON.stringify({ action: args.action ?? "preview", operation: "correct", error: runtime.lastError?.message ?? "not initialized" });
      const request = normalizeAdministrationRequest({ ...args, operation: "correct" });
      const report = request.action === "apply"
        ? applyMemoryAdministration(runtime.db, request, args.planFingerprint)
        : previewMemoryAdministration(runtime.db, request);
      return JSON.stringify(report);
    },
  });
}
