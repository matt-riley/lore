export function buildMemoryDoctorReportTool(getRuntime, context) {
  const {
    toolDef,
    ensureArray,
    formatDoctorReport,
    formatDoctorSafetyGateSection,
    readLoreDoctorEnabled,
    runDoctorObservation,
  } = context;
  return toolDef("lore_doctor", {
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
