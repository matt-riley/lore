import assert from "node:assert/strict";
import { test } from "node:test";

import { assembleMemoryCapsule } from "../../lib/context/capsule-assembler.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

for (const repository of ["owner/current", "owner/private", null, "   "]) {
  test(`proposal awareness stays within current repository ${JSON.stringify(repository)}`, { skip: !FTS5_AVAILABLE }, async () => {
    const { db, config, cleanup } = await withFixtureDb();
    try {
      const proposals = [
        { repository: "owner/current", title: "CURRENT PROPOSAL ONE" },
        { repository: "owner/current", title: "CURRENT PROPOSAL TWO" },
        ...Array.from({ length: 4 }, (_, index) => ({ repository: "owner/private", title: `PRIVATE PROPOSAL ${index}` })),
        { repository: null, title: "UNKNOWN PROVENANCE PROPOSAL" },
      ];
      const eligibleIds = new Set();
      for (const [index, proposal] of proposals.entries()) {
        const id = db.upsertImprovementArtifact({ sourceCaseId: `proposal-${index}`, sourceKind: "signal", title: proposal.title, summary: `Summary for ${proposal.title}`, repository: proposal.repository });
        if (repository && proposal.repository === repository) eligibleIds.add(id);
        db.setImprovementArtifactProposal({ id, proposalType: "skill", proposalPath: `proposals/${index}.md`, proposalHash: "fixture-hash" });
        db.db.prepare("UPDATE improvement_backlog SET updated_at = ? WHERE id = ?").run(`2099-01-0${index + 1}T00:00:00.000Z`, id);
      }
      const result = await assembleMemoryCapsule({
        prompt: "continue", repository, proceduralProfile: "", db, config,
        sessionStore: { searchIndex: () => [], findRelevantSessions: () => [], getRecentSessions: () => [] },
        includeTrace: true, includeProposalAwareness: true,
      });
      assert.doesNotMatch(result.text, /UNKNOWN PROVENANCE/);
      const lookup = result.trace.lookups.pendingProposalReview;
      if (repository === "owner/current") {
        assert.match(result.text, /CURRENT PROPOSAL ONE/);
        assert.match(result.text, /CURRENT PROPOSAL TWO/);
        assert.doesNotMatch(result.text, /PRIVATE PROPOSAL/);
        assert.equal(lookup.rows.length, 2);
      } else if (repository === "owner/private") {
        assert.match(result.text, /PRIVATE PROPOSAL/);
        assert.doesNotMatch(result.text, /CURRENT PROPOSAL/);
        assert.equal(lookup.rows.length, 3);
      } else {
        assert.doesNotMatch(result.text, /Pending Proposal Review/);
        assert.deepEqual(lookup.rows, []);
      }
      assert.equal(lookup.rows.every((row) => eligibleIds.has(row.id)), true);
    } finally {
      cleanup();
    }
  });
}

test("proposal awareness includes approved aliases before limiting rows", { skip: !FTS5_AVAILABLE }, async () => {
  const { db, config, cleanup } = await withFixtureDb();
  try {
    const canonical = "github.com/owner/current";
    db.setRepositoryMapping({ legacy: "owner/renamed", canonical });
    db.setRepositoryMapping({ legacy: "owner/unrelated", canonical: "github.com/owner/private" });
    const expectedIds = new Set();
    for (const [index, repository] of [canonical, "owner/renamed", "owner/unrelated", "owner/unmapped", null].entries()) {
      const id = db.upsertImprovementArtifact({ sourceCaseId: `alias-${index}`, sourceKind: "signal", title: `ALIAS PROPOSAL ${index}`, summary: `Summary ${index}`, repository });
      db.setImprovementArtifactProposal({ id, proposalType: "skill", proposalPath: `alias/${index}.md`, proposalHash: "fixture-hash" });
      db.db.prepare("UPDATE improvement_backlog SET updated_at = ? WHERE id = ?").run(`2099-01-0${index + 1}T00:00:00.000Z`, id);
      if (index < 2) expectedIds.add(id);
    }
    const result = await assembleMemoryCapsule({
      prompt: "continue", repository: canonical, proceduralProfile: "", db, config,
      sessionStore: { searchIndex: () => [], findRelevantSessions: () => [], getRecentSessions: () => [] },
      includeTrace: true, includeProposalAwareness: true,
    });
    assert.match(result.text, /ALIAS PROPOSAL 0/);
    assert.match(result.text, /ALIAS PROPOSAL 1/);
    assert.doesNotMatch(result.text, /ALIAS PROPOSAL [234]/);
    assert.deepEqual(new Set(result.trace.lookups.pendingProposalReview.rows.map((row) => row.id)), expectedIds);
    const exactRows = db.listImprovementArtifacts({ repository: canonical });
    assert.equal(exactRows.length, 1, "existing exact-repository callers remain unchanged");
    assert.equal(exactRows[0].repository, canonical);
  } finally {
    cleanup();
  }
});
