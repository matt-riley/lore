import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import {
  generateProposalArtifacts,
  verifyProposalArtifacts,
} from "../../lib/proposal-generator.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function buildRuntime(db, config) {
  return {
    db,
    config,
  };
}

function proposalDocsRoot(config) {
  return path.join(config.paths.copilotHome, "extensions", "lore", "docs", "proposals");
}

function toRepoRelative(config, absolutePath) {
  return path.relative(config.paths.copilotHome, absolutePath).replaceAll(path.sep, "/");
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(targetPath) {
  if (!(await pathExists(targetPath))) {
    return null;
  }
  return readFile(targetPath, "utf8");
}

async function restoreFile(targetPath, originalContent) {
  if (originalContent == null) {
    await rm(targetPath, { force: true });
    return;
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, originalContent, "utf8");
}

describe("proposal generator integrity checks", () => {
  test("verifyProposalArtifacts reports missing files without adding content drift", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          evolutionLedger: true,
          generatedArtifactIntegrity: true,
        },
      },
    });
    const proposalsRoot = proposalDocsRoot(config);
    const indexPath = path.join(proposalsRoot, "PROPOSAL_INDEX.md");
    const fixturePath = path.join(proposalsRoot, "test-fixtures", "missing-proposal.md");
    const fixtureRelativePath = toRepoRelative(config, fixturePath);
    const originalIndex = await readIfExists(indexPath);
    try {
      await rm(fixturePath, { force: true });
      await rm(indexPath, { force: true });

      const artifactId = db.upsertImprovementArtifact({
        sourceCaseId: "proposal-missing-file",
        sourceKind: "signal",
        title: "Proposal integrity missing file",
        summary: "Pin the missing-file verification behavior.",
      });
      db.setImprovementArtifactProposal({
        id: artifactId,
        proposalType: "skill",
        proposalPath: fixtureRelativePath,
        proposalHash: "stale-hash",
      });

      const result = await verifyProposalArtifacts({
        runtime: buildRuntime(db, config),
        dryRun: true,
      });

      const issueTypes = result.issues.map((issue) => issue.type);
      assert.ok(issueTypes.includes("missing_file"));
      assert.ok(issueTypes.includes("missing_index"));
      assert.equal(issueTypes.includes("content_drift"), false);
      assert.equal(result.issues.filter((issue) => issue.type === "missing_file").length, 1);
      assert.equal(result.repairedCount, 0);
    } finally {
      await restoreFile(indexPath, originalIndex);
      await rm(fixturePath, { force: true });
      await rm(path.dirname(fixturePath), { recursive: true, force: true });
      cleanup();
    }
  });

  test("verifyProposalArtifacts flags drift when the stored proposal hash is stale", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          evolutionLedger: true,
          proposalGeneration: true,
          generatedArtifactIntegrity: true,
        },
      },
    });
    const indexPath = path.join(proposalDocsRoot(config), "PROPOSAL_INDEX.md");
    const originalIndex = await readIfExists(indexPath);
    let generatedPath = null;
    try {
      const runtime = buildRuntime(db, config);
      const artifactId = db.upsertImprovementArtifact({
        sourceCaseId: "proposal-stale-hash",
        sourceKind: "signal",
        title: "Proposal integrity stale hash",
        summary: "Pin the DB-hash drift branch.",
      });

      const generated = await generateProposalArtifacts({
        runtime,
        ids: [artifactId],
        limit: 1,
      });
      assert.equal(generated.generatedCount, 1);

      const artifact = db.getImprovementArtifact(artifactId);
      generatedPath = path.join(config.paths.copilotHome, artifact.proposal_path);
      db.db.prepare(`
        UPDATE improvement_backlog
        SET proposal_hash = ?
        WHERE id = ?
      `).run("stale-hash", artifactId);

      const result = await verifyProposalArtifacts({
        runtime,
        limit: 1,
        dryRun: true,
      });

      assert.deepStrictEqual(result.issues.map((issue) => issue.type), ["content_drift"]);
      assert.equal(result.repairedCount, 0);
      assert.equal(await pathExists(generatedPath), true);
    } finally {
      await restoreFile(indexPath, originalIndex);
      if (generatedPath) {
        await rm(generatedPath, { force: true });
        await rm(path.dirname(generatedPath), { recursive: true, force: true });
      }
      cleanup();
    }
  });

  test("verifyProposalArtifacts does not repair missing files during dry-run mode", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          evolutionLedger: true,
          generatedArtifactIntegrity: true,
        },
      },
    });
    const proposalsRoot = proposalDocsRoot(config);
    const indexPath = path.join(proposalsRoot, "PROPOSAL_INDEX.md");
    const fixturePath = path.join(proposalsRoot, "test-fixtures", "dry-run-proposal.md");
    const fixtureRelativePath = toRepoRelative(config, fixturePath);
    const originalIndex = await readIfExists(indexPath);
    try {
      await rm(fixturePath, { force: true });
      await rm(indexPath, { force: true });

      const artifactId = db.upsertImprovementArtifact({
        sourceCaseId: "proposal-dry-run",
        sourceKind: "signal",
        title: "Proposal integrity dry run",
        summary: "Pin repair gating during dry-run.",
      });
      db.setImprovementArtifactProposal({
        id: artifactId,
        proposalType: "skill",
        proposalPath: fixtureRelativePath,
        proposalHash: "stale-hash",
      });

      const result = await verifyProposalArtifacts({
        runtime: buildRuntime(db, config),
        repair: true,
        dryRun: true,
      });

      assert.equal(result.issueCount, 2);
      assert.equal(result.repairedCount, 0);
      assert.deepStrictEqual(result.repaired, []);
      assert.equal(await pathExists(fixturePath), false);
      assert.equal(await pathExists(indexPath), false);
    } finally {
      await restoreFile(indexPath, originalIndex);
      await rm(fixturePath, { force: true });
      await rm(path.dirname(fixturePath), { recursive: true, force: true });
      cleanup();
    }
  });
});
