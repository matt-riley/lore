import { createRolloutBooleanReader } from "./rollout-flag-utils.mjs";

const readMemoryOperationsEnabled = createRolloutBooleanReader("memoryOperations", true);
const readWorkstreamOverlaysEnabled = createRolloutBooleanReader(
  "workstreamOverlays",
  true,
  readMemoryOperationsEnabled,
);
const readTemporalQueryNormalizationEnabled = createRolloutBooleanReader(
  "temporalQueryNormalization",
  true,
  readMemoryOperationsEnabled,
);
const readMemoryDomainsEnabled = createRolloutBooleanReader(
  "memoryDomains",
  true,
  readMemoryOperationsEnabled,
);
const readRefreshableObservationsEnabled = createRolloutBooleanReader(
  "refreshableObservations",
  true,
  readMemoryDomainsEnabled,
);
const readRetentionSanitizationEnabled = createRolloutBooleanReader(
  "retentionSanitization",
  true,
  readMemoryOperationsEnabled,
);
const readHybridRetrievalEnabled = createRolloutBooleanReader(
  "hybridRetrieval",
  true,
  readMemoryOperationsEnabled,
);
const readDirectivesEnabled = createRolloutBooleanReader(
  "directives",
  true,
  readMemoryOperationsEnabled,
);
const readTraceRecorderEnabled = createRolloutBooleanReader("traceRecorder", false);
const readOverlayAutoHydrationEnabled = createRolloutBooleanReader(
  "overlayAutoHydration",
  true,
  readWorkstreamOverlaysEnabled,
);

export {
  readDirectivesEnabled,
  readHybridRetrievalEnabled,
  readMemoryDomainsEnabled,
  readMemoryOperationsEnabled,
  readOverlayAutoHydrationEnabled,
  readRefreshableObservationsEnabled,
  readRetentionSanitizationEnabled,
  readTemporalQueryNormalizationEnabled,
  readTraceRecorderEnabled,
  readWorkstreamOverlaysEnabled,
};
