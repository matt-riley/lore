import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runDoctorObservation } from "../../lib/lore-doctor.mjs";

function createRuntime({
  maintenanceTaskStates = [],
} = {}) {
  return {
    db: {
      listMaintenanceTaskStates() {
        return maintenanceTaskStates;
      },
      listTrajectoryArtifacts() {
        return [];
      },
      getStats() {
        return {};
      },
      listImprovementArtifacts() {
        return [];
      },
      db: {
        prepare() {
          return {
            get() {
              return { count: 0 };
            },
          };
        },
      },
    },
    metrics: null,
  };
}

describe("runDoctorObservation", () => {
  test("classifies replay corpus ranking misses as replay-specific attention", () => {
    const report = runDoctorObservation({
      runtime: createRuntime({
        maintenanceTaskStates: [
          {
            task_name: "replayCorpus",
            last_status: "needs_attention",
            total_failures: 0,
            total_needs_attention: 2,
            total_runs: 4,
            last_completed_at: "2024-05-01T12:00:00.000Z",
            lastSummary: {
              mustPassFailed: 0,
              rankingTargetPartial: 1,
              rankingTargetMissing: 2,
              caseIds: ["replay-ranking-case"],
            },
          },
        ],
      }),
      dryRun: true,
    });

    assert.equal(report.incidentCount, 1);
    assert.equal(report.warningCount, 1);
    assert.equal(report.infoCount, 0);
    assert.equal(report.incidents[0]?.kind, "replay_corpus_attention");
    assert.equal(report.incidents[0]?.context.rankingTargetMissing, 2);
    assert.equal(report.incidents[0]?.context.rankingTargetPartial, 1);
  });
});
