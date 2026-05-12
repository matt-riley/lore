import { readRolloutBoolean } from "./rollout-flag-utils.mjs";

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

export function readLoreDoctorEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "loreDoctor", false);
}

export function readReviewGateEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "reviewGate", false);
}

export function readApprovalSubstrateEnabled(config) {
  return readEvolutionLedgerEnabled(config)
    && readRolloutBoolean(config, "approvalSubstrate", false);
}
