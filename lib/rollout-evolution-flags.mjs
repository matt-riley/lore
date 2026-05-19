import { readRolloutBoolean } from "./rollout-flag-utils.mjs";

export function readEvolutionLedgerEnabled(config) {
  return readRolloutBoolean(config, "evolutionLedger", true);
}

export function readProposalGenerationEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "proposalGeneration", true);
}

export function readGeneratedArtifactIntegrityEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "generatedArtifactIntegrity", true);
}

export function readLoreDoctorEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "loreDoctor", true);
}

export function readReviewGateEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "reviewGate", true);
}

export function readApprovalSubstrateEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "approvalSubstrate", true);
}
