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

export function buildMemoryStatusCaptureHealthLines(health = []) {
  const rows = Array.isArray(health) ? health : [];
  const pendingBytes = rows.reduce((sum, row) => sum + Math.max(0, Number(row?.health?.pendingBytes) || 0), 0);
  const failures = rows.filter((row) => row?.health?.failureCode).length;
  const lastSuccessAt = rows.map((row) => row?.health?.lastSuccessAt).filter(Boolean).sort().at(-1) ?? null;
  return [
    `captureCheckpointCount: ${rows.length}`,
    `capturePendingBytes: ${pendingBytes}`,
    `captureFailureCount: ${failures}`,
    `captureLastSuccessAt: ${lastSuccessAt ?? "none"}`,
  ];
}
