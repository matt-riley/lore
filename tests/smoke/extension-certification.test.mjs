import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import { applySessionExtraction } from "../../lib/backfill.mjs";
import { recallMemory, retainMemory } from "../../lib/memory-operations.mjs";
import { FTS5_AVAILABLE, freshDb, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function artifacts(marker, repository) {
  return {
    session: { repository, branch: "main", summary: "certification session", updated_at: "2026-09-06T12:00:00.000Z" },
    checkpoints: [],
    files: [],
    refs: [],
    turns: [{
      turn_index: 1,
      user_message: `I prefer preserving the ${marker} decision for the next session.`,
      assistant_response: "The decision was recorded.",
    }],
  };
}

test("Core capture survives session end and a fresh-session recall", { skip: SKIP_NO_FTS5 }, async () => {
  const { db, config, cleanup } = await withFixtureDb({ configOverrides: { enabled: true } });
  const marker = `copilot-capture-${randomUUID().slice(0, 8)}`;
  try {
    applySessionExtraction({
      db,
      sessionId: "copilot:certification-session",
      repository: "copilot-certification",
      sessionArtifacts: artifacts(marker, "copilot-certification"),
      workspace: { workspace: { repository: "copilot-certification", branch: "main" } },
    });
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM episode_digest WHERE session_id = ?").get("copilot:certification-session").n, 1);
    db.close();

    const reopened = freshDb(config);
    try {
      const recall = recallMemory({
        db: reopened,
        prompt: `What did we decide about ${marker}?`,
        retrievalPrompt: marker,
        repository: "copilot-certification",
        sessionStore: null,
      });
      assert.match(recall.text, new RegExp(marker));
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("Core retrieval keeps repo and global memories isolated", { skip: SKIP_NO_FTS5 }, async () => {
  const { db, cleanup } = await withFixtureDb({ configOverrides: { enabled: true } });
  const globalMarker = `global-${randomUUID().slice(0, 8)}`;
  const otherMarker = `other-repo-${randomUUID().slice(0, 8)}`;
  try {
    retainMemory({ db, memory: { type: "user_preference", content: globalMarker, scope: "global", repository: null, sourceSessionId: "copilot:global", tags: ["user_preference"], metadata: { source: "certification" } } });
    retainMemory({ db, memory: { type: "user_preference", content: otherMarker, scope: "repo", repository: "other-copilot-repository", sourceSessionId: "copilot:other", tags: ["user_preference"], metadata: { source: "certification" } } });
    const local = db.searchSemantic({ query: otherMarker, repository: "copilot-repository", includeOtherRepositories: false, includeTypedFallback: true, limit: 10 });
    const global = db.searchSemantic({ query: globalMarker, repository: "copilot-repository", includeOtherRepositories: true, includeTypedFallback: true, limit: 10 });
    const crossRepo = db.searchSemantic({ query: otherMarker, repository: "copilot-repository", includeOtherRepositories: true, includeTypedFallback: true, limit: 10 });
    assert.equal(local.some((row) => row.content.includes(otherMarker)), false);
    assert.equal(global.some((row) => row.content.includes(globalMarker)), true);
    assert.equal(crossRepo.some((row) => row.content.includes(otherMarker)), true);
  } finally {
    cleanup();
  }
});
