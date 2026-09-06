export function buildMemoryDoctorReportTool(getRuntime, context) {
  const {
    toolDef,
    ensureArray,
    formatDoctorReport,
    formatDoctorSafetyGateSection,
    readLoreDoctorEnabled,
    runDoctorObservation,
  } = context;
  return toolDef("memory_doctor_report", {
    parameters: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description: "When true, classify incidents but do not record a trajectory artifact",
        },
        trajectoryLimit: {
          type: "number",
          description: "Maximum recent trajectory artifacts to scan (default 20, max 50)",
        },
        plannedActions: {
          type: "array",
          description: "Optional hypothetical future tool actions for observe-only safety classification",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              toolName: { type: "string" },
              operation: { type: "string" },
              target: { type: "string" },
              mutability: { type: "string", enum: ["read_only", "append_only", "metadata_update", "destructive_write"] },
              reversibility: { type: "string", enum: ["reversible", "operator_reversible", "difficult", "irreversible"] },
              scope: { type: "string", enum: ["isolated", "repository", "workspace", "multi_workspace", "external_system"] },
              notes: { type: "string" },
            },
          },
        },
      },
    },
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      if (!runtime.initialized || runtime.lastError) {
        return `lore unavailable: ${runtime.lastError?.message ?? "not initialized"}`;
      }
      if (!readLoreDoctorEnabled(runtime.config)) {
        return "memory_doctor_report: disabled — set rollout.loreDoctor: true in lore.json to enable";
      }
      const dryRun = args.dryRun === true;
      const trajectoryLimit = typeof args.trajectoryLimit === "number" ? args.trajectoryLimit : 20;
      const doctorResult = runDoctorObservation({
        runtime,
        repository: runtime.repository,
        dryRun,
        trajectoryLimit,
      });
      const doctorReport = formatDoctorReport(doctorResult);
      const safetyResult = observeSafetyGateActions({
        actions: ensureArray(args.plannedActions),
        repository: runtime.repository,
        actionSource: "doctor",
      });
      return `${doctorReport}${formatDoctorSafetyGateSection(safetyResult)}`;
    },
  });
}
