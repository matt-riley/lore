import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  generateProposalArtifacts,
  verifyProposalArtifacts,
} from "../../lib/proposal-generator.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const COPILOT_ROOT = path.resolve(TEST_DIR, "../../../..");
const PROPOSALS_ROOT = path.join(COPILOT_ROOT, "extensions", "lore", "docs", "proposals");
const INDEX_PATH = path.join(PROPOSALS_ROOT, "PROPOSAL_INDEX.md");

function buildRuntime(db, config) {
  return {
    db,
    config,
  };
}

function toRepoRelative(absolutePath) {
  return path.relative(COPILOT_ROOT, absolutePath).replaceAll(path.sep, "/");
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
    const fixturePath = path.join(PROPOSALS_ROOT, "test-fixtures", "missing-proposal.md");
    const fixtureRelativePath = toRepoRelative(fixturePath);
    const originalIndex = await readIfExists(INDEX_PATH);
    try {
      await rm(fixturePath, { force: true });
      await rm(INDEX_PATH, { force: true });

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
      await restoreFile(INDEX_PATH, originalIndex);
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
    const originalIndex = await readIfExists(INDEX_PATH);
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
      generatedPath = path.join(COPILOT_ROOT, artifact.proposal_path);
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
      await restoreFile(INDEX_PATH, originalIndex);
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
    const fixturePath = path.join(PROPOSALS_ROOT, "test-fixtures", "dry-run-proposal.md");
    const fixtureRelativePath = toRepoRelative(fixturePath);
    const originalIndex = await readIfExists(INDEX_PATH);
    try {
      await rm(fixturePath, { force: true });
      await rm(INDEX_PATH, { force: true });

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
      assert.equal(await pathExists(INDEX_PATH), false);
    } finally {
      await restoreFile(INDEX_PATH, originalIndex);
      await rm(fixturePath, { force: true });
      await rm(path.dirname(fixturePath), { recursive: true, force: true });
      cleanup();
    }
  });
});
