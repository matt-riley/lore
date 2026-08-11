import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { runDoctorObservation } from "../../lib/lore-doctor.mjs";

function createRuntime({
  maintenanceTaskStates = [],
  proposalRows = [],
  config = {},
} = {}) {
  return {
    config,
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
        return proposalRows;
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

  test("reads proposal documents from the configured Copilot root", async () => {
    const copilotRoot = await mkdtemp(path.join(os.tmpdir(), "lore-doctor-"));
    const proposalPath = "extensions/lore/docs/proposals/fixture.md";
    const absoluteProposalPath = path.join(copilotRoot, proposalPath);
    await mkdir(path.dirname(absoluteProposalPath), { recursive: true });
    await writeFile(absoluteProposalPath, "# Fixture proposal\n", "utf8");

    try {
      const report = runDoctorObservation({
        runtime: createRuntime({
          config: { paths: { copilotHome: copilotRoot } },
          proposalRows: [{
            id: "proposal-fixture",
            title: "Fixture proposal",
            proposal_path: proposalPath,
            review_state: "draft",
          }],
        }),
        dryRun: true,
      });

      assert.equal(report.infoCount, 1);
      assert.equal(report.incidents[0]?.context.unreadable, undefined);
      assert.ok(report.incidents[0]?.context.missingSections.length > 0);
    } finally {
      await rm(copilotRoot, { recursive: true, force: true });
    }
  });
});
