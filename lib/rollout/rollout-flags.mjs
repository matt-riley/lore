import { normalizeBoolean } from "../core/config.mjs";

export function readRolloutBoolean(config, key, fallback) {
  return normalizeBoolean(config?.rollout?.[key], fallback);
}

export function createRolloutBooleanReader(key, fallback, parentReader = null) {
  return (config) => (parentReader?.(config) ?? true)
    && readRolloutBoolean(config, key, fallback);
}

export const readAmbientPersonaModeEnabled = createRolloutBooleanReader("ambientPersonaMode", false);
export const readAutoWriteImprovementGoalsEnabled = createRolloutBooleanReader("autoWriteImprovementGoals", false);
export const readAmbientWorkingProfileEnabled = createRolloutBooleanReader("ambientWorkingProfile", true);

export const readMemoryOperationsEnabled = createRolloutBooleanReader("memoryOperations", true);
export const readWorkstreamOverlaysEnabled = createRolloutBooleanReader(
  "workstreamOverlays",
  true,
  readMemoryOperationsEnabled,
);
export const readTemporalQueryNormalizationEnabled = createRolloutBooleanReader(
  "temporalQueryNormalization",
  true,
  readMemoryOperationsEnabled,
);
export const readMemoryDomainsEnabled = createRolloutBooleanReader(
  "memoryDomains",
  true,
  readMemoryOperationsEnabled,
);
export const readRefreshableObservationsEnabled = createRolloutBooleanReader(
  "refreshableObservations",
  true,
  readMemoryDomainsEnabled,
);
export const readRetentionSanitizationEnabled = createRolloutBooleanReader(
  "retentionSanitization",
  true,
  readMemoryOperationsEnabled,
);
export const readHybridRetrievalEnabled = createRolloutBooleanReader(
  "hybridRetrieval",
  true,
  readMemoryOperationsEnabled,
);
export const readDirectivesEnabled = createRolloutBooleanReader(
  "directives",
  true,
  readMemoryOperationsEnabled,
);
export const readTraceRecorderEnabled = createRolloutBooleanReader("traceRecorder", false);
export const readOverlayAutoHydrationEnabled = createRolloutBooleanReader(
  "overlayAutoHydration",
  true,
  readWorkstreamOverlaysEnabled,
);

export const readEvolutionLedgerEnabled = createRolloutBooleanReader("evolutionLedger", true);
export const readProposalGenerationEnabled = createRolloutBooleanReader(
  "proposalGeneration",
  true,
  readEvolutionLedgerEnabled,
);
export const readGeneratedArtifactIntegrityEnabled = createRolloutBooleanReader(
  "generatedArtifactIntegrity",
  true,
  readEvolutionLedgerEnabled,
);
export const readLoreDoctorEnabled = createRolloutBooleanReader(
  "loreDoctor",
  true,
  readEvolutionLedgerEnabled,
);
export const readReviewGateEnabled = createRolloutBooleanReader(
  "reviewGate",
  true,
  readEvolutionLedgerEnabled,
);
export const readApprovalSubstrateEnabled = createRolloutBooleanReader(
  "approvalSubstrate",
  true,
  readEvolutionLedgerEnabled,
);

export const readErrorTelemetryEnabled = createRolloutBooleanReader("errorTelemetry", false);
export const readPostToolUseEnabled = createRolloutBooleanReader("postToolUse", false);

export const readSubagentScopeTrackingEnabled = createRolloutBooleanReader("subagentScopeTracking", false);
export const readPreToolUseGuardrailEnabled = createRolloutBooleanReader("preToolUseGuardrail", false);
