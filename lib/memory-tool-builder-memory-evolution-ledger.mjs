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
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "capture_signal", "generate_proposals", "verify_integrity"],
          description: "Inspect the ledger, capture a manual signal, generate proposals, or verify generated proposal artifacts",
        },
        limit: {
          type: "number",
          description: "Maximum items to inspect or generate",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional backlog ids to target for proposal generation",
        },
        force: {
          type: "boolean",
          description: "When true, allow proposal generation to overwrite existing generated proposal artifacts",
        },
        dryRun: {
          type: "boolean",
          description: "When true, preview proposal or integrity work without writing files or DB updates",
        },
        repair: {
          type: "boolean",
          description: "When true, repair generated proposal artifacts that fail integrity verification",
        },
        sourceCaseId: {
          type: "string",
          description: "Optional explicit source case id for capture_signal",
        },
        signalType: {
          type: "string",
          enum: ["router", "maintenance", "trace"],
          description: "Signal family when capturing a manual ledger entry",
        },
        title: {
          type: "string",
          description: "Signal title for capture_signal",
        },
        summary: {
          type: "string",
          description: "Signal summary for capture_signal",
        },
        linkedMemoryId: {
          type: "string",
          description: "Optional related semantic memory id for capture_signal",
        },
        evidence: {
          type: "object",
          description: "Optional provenance/evidence object for capture_signal",
        },
        trace: {
          type: "object",
          description: "Optional trace metadata object for capture_signal",
        },
      },
    },
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
