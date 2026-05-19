import { readRolloutBoolean } from "./rollout-flag-utils.mjs";

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

export function readMemoryDomainsEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "memoryDomains", true);
}

export function readRefreshableObservationsEnabled(config) {
  return readMemoryDomainsEnabled(config)
    && readRolloutBoolean(config, "refreshableObservations", true);
}

export function readRetentionSanitizationEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "retentionSanitization", true);
}

export function readHybridRetrievalEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "hybridRetrieval", true);
}

export function readDirectivesEnabled(config) {
  return readMemoryOperationsEnabled(config)
    && readRolloutBoolean(config, "directives", true);
}

export function readTraceRecorderEnabled(config) {
  return readRolloutBoolean(config, "traceRecorder", false);
}

export function readOverlayAutoHydrationEnabled(config) {
  return readWorkstreamOverlaysEnabled(config)
    && readRolloutBoolean(config, "overlayAutoHydration", true);
}
