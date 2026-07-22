import { createRolloutBooleanReader } from "./rollout-flag-utils.mjs";

const readEvolutionLedgerEnabled = createRolloutBooleanReader("evolutionLedger", true);
const readProposalGenerationEnabled = createRolloutBooleanReader(
  "proposalGeneration",
  true,
  readEvolutionLedgerEnabled,
);
const readGeneratedArtifactIntegrityEnabled = createRolloutBooleanReader(
  "generatedArtifactIntegrity",
  true,
  readEvolutionLedgerEnabled,
);
const readLoreDoctorEnabled = createRolloutBooleanReader(
  "loreDoctor",
  true,
  readEvolutionLedgerEnabled,
);
const readReviewGateEnabled = createRolloutBooleanReader(
  "reviewGate",
  true,
  readEvolutionLedgerEnabled,
);
const readApprovalSubstrateEnabled = createRolloutBooleanReader(
  "approvalSubstrate",
  true,
  readEvolutionLedgerEnabled,
);

export {
  readApprovalSubstrateEnabled,
  readEvolutionLedgerEnabled,
  readGeneratedArtifactIntegrityEnabled,
  readLoreDoctorEnabled,
  readProposalGenerationEnabled,
  readReviewGateEnabled,
};
