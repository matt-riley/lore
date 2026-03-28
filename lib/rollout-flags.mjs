function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(lowered)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(lowered)) {
      return false;
    }
  }
  return fallback;
}

function readRolloutBoolean(config, key, fallback) {
  return normalizeBoolean(config?.rollout?.[key], fallback);
}

export function readMemoryOperationsEnabled(config) {
  return readRolloutBoolean(config, "memoryOperations", true);
}

export function readWorkstreamOverlaysEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "workstreamOverlays", true);
}

export function readTemporalQueryNormalizationEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "temporalQueryNormalization", true);
}

export function readRetentionSanitizationEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "retentionSanitization", true);
}

export function readTraceRecorderEnabled(config) {
  return readRolloutBoolean(config, "traceRecorder", false);
}

export function readEvolutionLedgerEnabled(config) {
  return readRolloutBoolean(config, "evolutionLedger", true);
}

export function readProposalGenerationEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "proposalGeneration", false);
}

export function readGeneratedArtifactIntegrityEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "generatedArtifactIntegrity", true);
}

export function readOverlayAutoHydrationEnabled(config) {
  return readWorkstreamOverlaysEnabled(config)
    && readRolloutBoolean(config, "overlayAutoHydration", true);
}

export function readCoherenceDoctorEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "coherenceDoctor", false);
}

export function readHybridRetrievalEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "hybridRetrieval", true);
}

export function readDirectivesEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "directives", true);
}

export function readReviewGateEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "reviewGate", false);
}
