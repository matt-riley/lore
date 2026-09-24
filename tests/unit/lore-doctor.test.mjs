import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { runDoctorObservation } from "../../lib/maintenance/lore-doctor.mjs";
import { applySetup, planSetup } from "../../lib/clients/setup.mjs";

function createRuntime({
  maintenanceTaskStates = [],
  proposalRows = [],
  config = {},
  ingestionCheckpointFailures = [],
  lastMaintenanceRun = null,
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
        prepare(sql) {
          if (sql.includes("FROM ingestion_checkpoint")) return { all: () => ingestionCheckpointFailures };
          if (sql.includes("FROM maintenance_run")) return { get: () => lastMaintenanceRun };
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

// A real Lore-owned client install under an isolated HOME, used by the
// install-health tests below so they exercise the exact manifest/hook-file
// shape setup.mjs produces rather than a hand-rolled fixture.
async function installFixture({ node = "/usr/bin/node", source } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-doctor-install-"));
  const env = { HOME: home };
  applySetup(planSetup(["codex"], { home, env, node, ...(source ? { source } : {}) }));
  return { home, env, loreHome: path.join(home, ".config", "lore") };
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

  test("reads proposal documents from Lore home proposals/", async () => {
    const loreHome = await mkdtemp(path.join(os.tmpdir(), "lore-doctor-"));
    const proposalPath = "proposals/fixture.md";
    const absoluteProposalPath = path.join(loreHome, proposalPath);
    await mkdir(path.dirname(absoluteProposalPath), { recursive: true });
    await writeFile(absoluteProposalPath, "# Fixture proposal\n", "utf8");

    try {
      const report = runDoctorObservation({
        runtime: createRuntime({
          config: { paths: { derivedStorePath: path.join(loreHome, "lore.db") } },
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
      await rm(loreHome, { recursive: true, force: true });
    }
  });

  test("without a resolved Lore home, install-health is skipped entirely (no real-host lookups)", async () => {
    const report = runDoctorObservation({
      runtime: createRuntime({ config: {} }),
      dryRun: true,
    });
    assert.equal(report.incidentCount, 0);
    assert.equal(report.signals.installHealth.manifestPath, null);
  });

  test("flags a hook pointing at a missing Node binary as a critical incident", async () => {
    const { home, env, loreHome } = await installFixture({ node: path.join(os.tmpdir(), "definitely-does-not-exist-node") });
    try {
      const report = runDoctorObservation({
        runtime: createRuntime({ config: { paths: { loreHome } } }),
        dryRun: true,
        env,
        home,
        cwd: home,
      });
      const incident = report.incidents.find((inc) => inc.kind === "install_node_missing");
      assert.ok(incident, "expected an install_node_missing incident");
      assert.equal(incident.severity, "critical");
      assert.equal(incident.context.client, "codex");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("flags a hook pointing at a missing lore-cli.mjs entry as a critical incident", async () => {
    const { home, env, loreHome } = await installFixture({ source: path.join(os.tmpdir(), "definitely-does-not-exist-source") });
    try {
      const report = runDoctorObservation({
        runtime: createRuntime({ config: { paths: { loreHome } } }),
        dryRun: true,
        env,
        home,
        cwd: home,
      });
      const incident = report.incidents.find((inc) => inc.kind === "install_entry_missing");
      assert.ok(incident, "expected an install_entry_missing incident");
      assert.equal(incident.severity, "critical");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not flag a hook that uses a stable mise alias", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lore-doctor-alias-"));
    try {
      const aliasNode = path.join(home, "mise", "installs", "node", "26", "bin", "node");
      mkdirSync(path.dirname(aliasNode), { recursive: true });
      writeFileSync(aliasNode, "#!/bin/sh\nexit 0\n");
      chmodSync(aliasNode, 0o755);
      const env = { HOME: home };
      applySetup(planSetup(["codex"], { home, env, node: aliasNode }));
      const loreHome = path.join(home, ".config", "lore");
      const report = runDoctorObservation({
        runtime: createRuntime({ config: { paths: { loreHome } } }),
        dryRun: true,
        env,
        home,
        cwd: home,
      });
      assert.equal(report.incidents.some((inc) => inc.kind === "install_node_version_pinned"), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("warns (info) when an installed hook pins a version-manager Node path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "lore-doctor-pinned-"));
    try {
      const miseNode = path.join(home, "mise", "installs", "node", "26.8.2", "bin", "node");
      mkdirSync(path.dirname(miseNode), { recursive: true });
      writeFileSync(miseNode, "#!/bin/sh\nexit 0\n");
      chmodSync(miseNode, 0o755);
      const env = { HOME: home };
      applySetup(planSetup(["codex"], { home, env, node: miseNode }));
      const loreHome = path.join(home, ".config", "lore");
      const report = runDoctorObservation({
        runtime: createRuntime({ config: { paths: { loreHome } } }),
        dryRun: true,
        env,
        home,
        cwd: home,
      });
      const incident = report.incidents.find((inc) => inc.kind === "install_node_version_pinned");
      assert.ok(incident, "expected an install_node_version_pinned incident");
      assert.equal(incident.severity, "info");
      assert.equal(incident.context.versionManager, "mise");
      // Every codex hook event shares one node path: report it once, not per event.
      assert.equal(report.incidents.filter((inc) => inc.kind === "install_node_version_pinned").length, 1);
      assert.equal(report.incidents.some((inc) => inc.kind === "install_node_missing"), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reports a malformed install manifest instead of throwing", async () => {
    const loreHome = await mkdtemp(path.join(os.tmpdir(), "lore-doctor-manifest-"));
    try {
      await writeFile(path.join(loreHome, "install-manifest.json"), "not json");
      const report = runDoctorObservation({
        runtime: createRuntime({ config: { paths: { loreHome } } }),
        dryRun: true,
        env: {},
        home: loreHome,
        cwd: loreHome,
      });
      const incident = report.incidents.find((inc) => inc.kind === "install_manifest_unreadable");
      assert.ok(incident, "expected an install_manifest_unreadable incident");
      assert.equal(incident.severity, "warning");
    } finally {
      await rm(loreHome, { recursive: true, force: true });
    }
  });

  test("detects a duplicate project-scope install alongside a global one", async () => {
    const { home, env, loreHome } = await installFixture();
    const project = await mkdtemp(path.join(os.tmpdir(), "lore-doctor-project-"));
    try {
      mkdirSync(path.join(project, ".codex"), { recursive: true });
      writeFileSync(path.join(project, ".codex", "hooks.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "'/usr/bin/node' '/some/lore-cli.mjs' hook codex SessionStart" }] }] },
      }));
      const report = runDoctorObservation({
        runtime: createRuntime({ config: { paths: { loreHome } } }),
        dryRun: true,
        env,
        home,
        cwd: project,
      });
      const incident = report.incidents.find((inc) => inc.kind === "install_duplicate_scope");
      assert.ok(incident, "expected an install_duplicate_scope incident");
      assert.equal(incident.severity, "warning");
      assert.equal(incident.context.client, "codex");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  test("surfaces ingestion checkpoint failures", () => {
    const report = runDoctorObservation({
      runtime: createRuntime({
        ingestionCheckpointFailures: [
          { client: "codex", session_id: "s1", repository: "owner/repo", failure_code: "source_missing", updated_at: "2024-05-01T00:00:00.000Z" },
        ],
      }),
      dryRun: true,
    });
    const incident = report.incidents.find((inc) => inc.kind === "ingestion_checkpoint_failures");
    assert.ok(incident, "expected an ingestion_checkpoint_failures incident");
    assert.equal(incident.severity, "warning");
    assert.equal(incident.context.failures.length, 1);
    assert.equal(report.signals.ingestionCheckpointFailures, 1);
  });

  test("flags a stale last maintenance run (info) but not a recent one", () => {
    const stale = runDoctorObservation({
      runtime: createRuntime({
        lastMaintenanceRun: { id: "run-1", trigger: "manual", status: "completed", completed_at: "2000-01-01T00:00:00.000Z", updated_at: "2000-01-01T00:00:00.000Z" },
      }),
      dryRun: true,
    });
    const staleIncident = stale.incidents.find((inc) => inc.kind === "maintenance_run_stale");
    assert.ok(staleIncident, "expected a maintenance_run_stale incident");
    assert.equal(staleIncident.severity, "info");
    assert.equal(stale.signals.lastMaintenanceRun.id, "run-1");

    const recent = runDoctorObservation({
      runtime: createRuntime({
        lastMaintenanceRun: { id: "run-2", trigger: "manual", status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      }),
      dryRun: true,
    });
    assert.equal(recent.incidents.some((inc) => inc.kind === "maintenance_run_stale"), false);
  });

  test("doctor never throws when a client's hook file is malformed", async () => {
    const { home, env, loreHome } = await installFixture();
    try {
      writeFileSync(path.join(home, ".codex", "hooks.json"), "{ not valid json");
      const report = runDoctorObservation({
        runtime: createRuntime({ config: { paths: { loreHome } } }),
        dryRun: true,
        env,
        home,
        cwd: home,
      });
      const incident = report.incidents.find((inc) => inc.kind === "install_hook_file_invalid");
      assert.ok(incident, "expected an install_hook_file_invalid incident");
      assert.equal(incident.severity, "warning");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
