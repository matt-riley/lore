import {
  readMemoryDomainsEnabled,
  readEvolutionLedgerEnabled,
  readRefreshableObservationsEnabled,
  readGeneratedArtifactIntegrityEnabled,
  readMemoryOperationsEnabled,
  readProposalGenerationEnabled,
  readRetentionSanitizationEnabled,
  readTraceRecorderEnabled,
  readTemporalQueryNormalizationEnabled,
  readWorkstreamOverlaysEnabled,
  readDirectivesEnabled,
} from "./rollout-flags.mjs";
import { formatWorkstreamOverlayStatus } from "./memory-tools-workstream-status.mjs";

export function buildMemoryStatusRolloutLines(runtime, maintenance) {
  return [
    `memoryOperationsEnabled: ${readMemoryOperationsEnabled(runtime.config)}`,
    `memoryDomainsEnabled: ${readMemoryDomainsEnabled(runtime.config)}`,
    `refreshableObservationsEnabled: ${readRefreshableObservationsEnabled(runtime.config)}`,
    `workstreamOverlaysEnabled: ${readWorkstreamOverlaysEnabled(runtime.config)}`,
    `directivesEnabled: ${readDirectivesEnabled(runtime.config)}`,
    `temporalQueryNormalizationEnabled: ${readTemporalQueryNormalizationEnabled(runtime.config)}`,
    `retentionSanitizationEnabled: ${readRetentionSanitizationEnabled(runtime.config)}`,
    `traceRecorderEnabled: ${readTraceRecorderEnabled(runtime.config)}`,
    `evolutionLedgerEnabled: ${readEvolutionLedgerEnabled(runtime.config)}`,
    `proposalGenerationEnabled: ${readProposalGenerationEnabled(runtime.config)}`,
    `generatedArtifactIntegrityEnabled: ${readGeneratedArtifactIntegrityEnabled(runtime.config)}`,
    `maintenanceEnabled: ${maintenance.enabled}`,
    `maintenanceAutoRunOnSessionStart: ${maintenance.autoRunOnSessionStart}`,
    `maintenanceMaxTasksPerRun: ${maintenance.maxTasksPerRun}`,
    `maintenanceDueTaskCount: ${maintenance.dueTasks.length}`,
    `maintenanceSelectedTaskCount: ${maintenance.selectedTasks.length}`,
    `maintenanceSkippedDueToCap: ${maintenance.skippedDueToCap}`,
    ...formatWorkstreamOverlayStatus(runtime),
  ];
}
