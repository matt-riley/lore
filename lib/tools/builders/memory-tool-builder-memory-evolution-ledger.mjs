export function buildMemoryEvolutionLedgerTool(getRuntime, context) {
  const {
    toolDef,
    ensureEvolutionLedgerAvailable,
    captureEvolutionSignal,
    generateEvolutionLedgerProposals,
    verifyEvolutionLedgerIntegrity,
    summarizeEvolutionLedger,
  } = context;
  return toolDef("memory_evolution_ledger", {
    handler: async (args, invocation) => {
      const runtime = await getRuntime(invocation.sessionId);
      const unavailable = ensureEvolutionLedgerAvailable(runtime);
      if (unavailable) {
        return unavailable;
      }
      const action = typeof args.action === "string" ? args.action : "summary";
      if (action === "capture_signal") {
        return captureEvolutionSignal(runtime, args);
      }
      if (action === "generate_proposals") {
        return generateEvolutionLedgerProposals(runtime, args);
      }
      if (action === "verify_integrity") {
        return verifyEvolutionLedgerIntegrity(runtime, args);
      }
      return summarizeEvolutionLedger(runtime, args);
    },
  });
}
