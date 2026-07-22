export function deriveMemoryStatusActivityPhases(stats) {
  const deferredActionableCount = (stats.deferredPendingCount ?? 0) + (stats.deferredFailedCount ?? 0);
  const deferredCurrentPhase = (stats.deferredRunningCount ?? 0) > 0
    ? "processing"
    : deferredActionableCount > 0
      ? "queued"
      : "idle";
  const backfillCurrentPhase = (stats.backfillRunningCount ?? 0) > 0 ? "processing" : "idle";
  return {
    deferredActionableCount,
    deferredCurrentPhase,
    backfillCurrentPhase,
  };
}

export function buildMemoryStatusLifecycleLines(stats, phases) {
  return [
    `backfillRunningCount: ${stats.backfillRunningCount}`,
    `backfillCompletedCount: ${stats.backfillCompletedCount}`,
    `backfillFailedCount: ${stats.backfillFailedCount}`,
    `backfillDryRunCount: ${stats.backfillDryRunCount}`,
    `backfillCurrentPhase: ${phases.backfillCurrentPhase}`,
    `deferredPendingCount: ${stats.deferredPendingCount}`,
    `deferredRunningCount: ${stats.deferredRunningCount}`,
    `deferredFailedCount: ${stats.deferredFailedCount}`,
    `deferredCompletedCount: ${stats.deferredCompletedCount}`,
    `deferredActionableCount: ${phases.deferredActionableCount}`,
    `deferredCurrentPhase: ${phases.deferredCurrentPhase}`,
  ];
}
