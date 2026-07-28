import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  consumeLatestMemoryHygieneSummary,
  evaluateMemoryHygieneCandidate,
  formatLatestMemoryHygieneSummary,
  rollbackMemoryHygiene,
  runMemoryHygiene,
} from "../../lib/memory-hygiene.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function buildMemory(overrides = {}) {
  return {
    id: "memory-1",
    type: "open_loop",
    content: "Promote commit bdfb41e into main.",
    scope: "repo",
    repository: "matt-riley/lore",
    updated_at: "2026-07-27T10:00:00.000Z",
    ...overrides,
  };
}

function buildEpisode(overrides = {}) {
  return {
    sessionId: "session-2",
    repository: "matt-riley/lore",
    updatedAt: "2026-07-28T10:00:00.000Z",
    summary: "",
    actions: [],
    decisions: [],
    openItems: [],
    ...overrides,
  };
}

describe("evaluateMemoryHygieneCandidate", () => {
  test("resolves a repo-scoped commit promotion when the commit is now an ancestor", async () => {
    const result = await evaluateMemoryHygieneCandidate({
      memory: buildMemory(),
      episodes: [],
      repository: "matt-riley/lore",
      isCommitAncestor: async (commit) => commit === "bdfb41e",
    });

    assert.equal(result.disposition, "resolved");
    assert.equal(result.evidenceKind, "git_ancestry");
    assert.equal(result.evidenceValue, "bdfb41e");
  });

  test("does not resolve a global item from repo-local Git ancestry alone", async () => {
    const result = await evaluateMemoryHygieneCandidate({
      memory: buildMemory({
        scope: "global",
        repository: null,
      }),
      episodes: [],
      repository: "matt-riley/lore",
      isCommitAncestor: async () => true,
    });

    assert.equal(result.disposition, "ambiguous");
    assert.equal(result.reason, "global_requires_explicit_completion");
  });

  test("resolves a global item only from an exact target and explicit later completion", async () => {
    const target = "Refresh the daily profile after CI migration work";
    const result = await evaluateMemoryHygieneCandidate({
      memory: buildMemory({
        type: "assistant_goal",
        content: `Current assistant goal: ${target}`,
        scope: "global",
        repository: null,
      }),
      episodes: [
        buildEpisode({
          repository: "another/repository",
          decisions: [`Completed: ${target}.`],
        }),
      ],
      repository: "matt-riley/lore",
      isCommitAncestor: async () => false,
    });

    assert.equal(result.disposition, "resolved");
    assert.equal(result.evidenceKind, "episode_completion");
  });

  test("keeps an item active when a later episode still lists the same target as open", async () => {
    const result = await evaluateMemoryHygieneCandidate({
      memory: buildMemory(),
      episodes: [
        buildEpisode({
          decisions: ["Merged commit bdfb41e into main."],
          openItems: ["Promote commit bdfb41e into main."],
        }),
      ],
      repository: "matt-riley/lore",
      isCommitAncestor: async () => true,
    });

    assert.equal(result.disposition, "negative_evidence");
    assert.equal(result.reason, "later_episode_still_open");
  });

  test("does not use another repository's completion evidence for a repo-scoped item", async () => {
    const result = await evaluateMemoryHygieneCandidate({
      memory: buildMemory(),
      episodes: [
        buildEpisode({
          repository: "other/repository",
          decisions: ["Merged commit bdfb41e into main."],
        }),
      ],
      repository: "matt-riley/lore",
      isCommitAncestor: async () => false,
    });

    assert.equal(result.disposition, "ambiguous");
    assert.equal(result.reason, "commit_not_ancestor");
  });
});

describe("runMemoryHygiene", () => {
  test("shadow mode records a candidate without superseding the memory", async () => {
    const artifacts = [];
    const forgotten = [];
    const db = {
      listActiveStabilisationMemories: () => [buildMemory()],
      listMemoryHygieneEpisodes: () => [],
      insertTrajectoryArtifact: (artifact) => {
        artifacts.push(artifact);
        return "artifact-shadow";
      },
      forgetMemory: (input) => forgotten.push(input),
    };

    const result = await runMemoryHygiene({
      db,
      repository: "matt-riley/lore",
      mode: "shadow",
      isCommitAncestor: async () => true,
    });

    assert.equal(result.resolvedCount, 0);
    assert.equal(result.candidateCount, 1);
    assert.deepStrictEqual(forgotten, []);
    assert.equal(artifacts[0].outcome, "candidate");
  });

  test("apply mode supersedes eligible memory with an automated marker and audit artifact", async () => {
    const artifacts = [];
    const forgotten = [];
    const db = {
      listActiveStabilisationMemories: () => [buildMemory()],
      listMemoryHygieneEpisodes: () => [],
      insertTrajectoryArtifact: (artifact) => {
        artifacts.push(artifact);
        return "artifact-apply";
      },
      forgetMemory: (input) => forgotten.push(input),
    };

    const result = await runMemoryHygiene({
      db,
      repository: "matt-riley/lore",
      mode: "apply",
      runId: "run-123",
      isCommitAncestor: async () => true,
    });

    assert.equal(result.resolvedCount, 1);
    assert.deepStrictEqual(forgotten, [{
      id: "memory-1",
      supersededBy: "auto-hygiene:run-123",
    }]);
    assert.equal(artifacts[0].outcome, "resolved");
    assert.equal(artifacts[0].context.marker, "auto-hygiene:run-123");
  });
});

describe("rollbackMemoryHygiene", () => {
  test("restores only the requested automated marker and records rollback audit", () => {
    const artifacts = [];
    const restored = [];
    const db = {
      restoreMemoriesBySupersessionMarker: (marker) => {
        restored.push(marker);
        return ["memory-1", "memory-2"];
      },
      insertTrajectoryArtifact: (artifact) => {
        artifacts.push(artifact);
        return "artifact-rollback";
      },
    };

    const result = rollbackMemoryHygiene({
      db,
      marker: "auto-hygiene:run-123",
      actor: "operator",
      reason: "false positive",
    });

    assert.deepStrictEqual(restored, ["auto-hygiene:run-123"]);
    assert.deepStrictEqual(result.restoredMemoryIds, ["memory-1", "memory-2"]);
    assert.equal(artifacts[0].kind, "memory_hygiene_rollback");
    assert.equal(artifacts[0].context.marker, "auto-hygiene:run-123");
  });
});

describe("formatLatestMemoryHygieneSummary", () => {
  test("renders a bounded non-blocking summary from the latest completed run", () => {
    const db = {
      listTrajectoryArtifacts: () => [{
        created_at: "2026-07-28T10:00:00.000Z",
        context: {
          mode: "shadow",
          candidateCount: 1,
          resolvedCount: 0,
          ambiguousCount: 1,
          negativeEvidenceCount: 1,
          unresolvedItems: [
            {
              memoryType: "open_loop",
              scope: "repo",
              content: "Decide whether to publish the release.",
              disposition: "ambiguous",
            },
            {
              memoryType: "assistant_goal",
              scope: "global",
              content: "Current assistant goal: finish the migration.",
              disposition: "negative_evidence",
            },
          ],
        },
      }],
    };

    const summary = formatLatestMemoryHygieneSummary({
      db,
      repository: "fixture-repo",
    });

    assert.match(summary, /## Automated Memory Hygiene/);
    assert.match(summary, /mode=shadow candidates=1 resolved=0 ambiguous=1 negativeEvidence=1/);
    assert.match(summary, /Decide whether to publish the release/);
    assert.match(summary, /Non-blocking/);
  });

  test("consumes each summary artifact only once for a session", () => {
    const db = {
      listTrajectoryArtifacts: () => [{
        id: "hygiene-summary-1",
        context: {
          mode: "shadow",
          candidateCount: 1,
          resolvedCount: 0,
          ambiguousCount: 0,
          negativeEvidenceCount: 0,
          reviewItems: [{
            memoryType: "open_loop",
            scope: "repo",
            content: "Promote commit abc1234 into main.",
            disposition: "candidate",
          }],
        },
      }],
    };

    const first = consumeLatestMemoryHygieneSummary({
      db,
      repository: "fixture-repo",
      lastSurfacedArtifactId: null,
    });
    const second = consumeLatestMemoryHygieneSummary({
      db,
      repository: "fixture-repo",
      lastSurfacedArtifactId: first.artifactId,
    });

    assert.equal(first.artifactId, "hygiene-summary-1");
    assert.match(first.text, /Promote commit abc1234/);
    assert.equal(second, null);
  });
});

describe("LoreDb memory hygiene persistence", () => {
  test("lists active memories, applies markers, and restores only the requested marker", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const firstId = db.insertSemanticMemory({
        id: "hygiene-db-1",
        type: "open_loop",
        content: "Promote commit abc1234 into main.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 0.9,
        tags: ["open-loop"],
      });
      const secondId = db.insertSemanticMemory({
        id: "hygiene-db-2",
        type: "assistant_goal",
        content: "Current assistant goal: finish release validation",
        repository: null,
        scope: "global",
        confidence: 0.9,
        tags: ["assistant-goal"],
      });

      const active = db.listActiveStabilisationMemories({
        repository: "fixture-repo",
        includeGlobal: true,
        limit: 10,
      });
      assert.deepStrictEqual(active.map((row) => row.id).sort(), [firstId, secondId].sort());

      db.forgetMemory({
        id: firstId,
        supersededBy: "auto-hygiene:run-db",
      });
      db.forgetMemory({
        id: secondId,
        supersededBy: "manual:other",
      });

      assert.deepStrictEqual(
        db.restoreMemoriesBySupersessionMarker("auto-hygiene:run-db"),
        [firstId],
      );
      const rows = db.db.prepare(`
        SELECT id, superseded_by
        FROM semantic_memory
        WHERE id IN (?, ?)
        ORDER BY id
      `).all(firstId, secondId).map((row) => ({ ...row }));
      assert.deepStrictEqual(rows, [
        { id: firstId, superseded_by: null },
        { id: secondId, superseded_by: "manual:other" },
      ]);
    } finally {
      cleanup();
    }
  });

  test("returns bounded episode evidence with parsed arrays", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.upsertEpisodeDigest({
        id: "episode-hygiene-1",
        sessionId: "session-hygiene-1",
        scope: "repo",
        repository: "fixture-repo",
        summary: "Completed release validation.",
        actions: ["Merged commit abc1234."],
        decisions: ["Release validation is complete."],
        openItems: ["Publish release notes."],
        significance: 0.8,
        dateKey: "2026-07-28",
      });

      const episodes = db.listMemoryHygieneEpisodes({
        repository: "fixture-repo",
        includeOtherRepositories: false,
        limit: 5,
      });

      assert.equal(episodes.length, 1);
      assert.deepStrictEqual(episodes[0].actions, ["Merged commit abc1234."]);
      assert.deepStrictEqual(episodes[0].decisions, ["Release validation is complete."]);
      assert.deepStrictEqual(episodes[0].openItems, ["Publish release notes."]);
    } finally {
      cleanup();
    }
  });

  test("prioritizes current-repository evidence before bounded cross-repository evidence", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.upsertEpisodeDigest({
        id: "episode-own",
        sessionId: "session-own",
        scope: "repo",
        repository: "fixture-repo",
        summary: "Completed the fixture release.",
        actions: [],
        decisions: [],
        openItems: [],
        significance: 0.8,
        dateKey: "2026-07-20",
        updatedAt: "2026-07-20T10:00:00.000Z",
      });
      for (let index = 0; index < 5; index += 1) {
        db.upsertEpisodeDigest({
          id: `episode-other-${index}`,
          sessionId: `session-other-${index}`,
          scope: "repo",
          repository: `other/repository-${index}`,
          summary: `Other repository activity ${index}.`,
          actions: [],
          decisions: [],
          openItems: [],
          significance: 0.8,
          dateKey: "2026-07-28",
        });
      }

      const episodes = db.listMemoryHygieneEpisodes({
        repository: "fixture-repo",
        includeOtherRepositories: true,
        limit: 2,
      });

      assert.equal(episodes.length, 2);
      assert.equal(episodes.some((episode) => episode.sessionId === "session-own"), true);
      assert.equal(episodes.some((episode) => episode.repository?.startsWith("other/")), true);
    } finally {
      cleanup();
    }
  });

  test("global episodes cannot crowd current-repository evidence out of the bounded window", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.upsertEpisodeDigest({
        id: "episode-own-global-pressure",
        sessionId: "session-own-global-pressure",
        scope: "repo",
        repository: "fixture-repo",
        summary: "Completed the fixture rollout.",
        actions: [],
        decisions: [],
        openItems: [],
        significance: 0.8,
        dateKey: "2026-07-20",
      });
      for (let index = 0; index < 5; index += 1) {
        db.upsertEpisodeDigest({
          id: `episode-global-${index}`,
          sessionId: `session-global-${index}`,
          scope: "global",
          repository: null,
          summary: `Global activity ${index}.`,
          actions: [],
          decisions: [],
          openItems: [],
          significance: 0.8,
          dateKey: "2026-07-28",
        });
      }

      const episodes = db.listMemoryHygieneEpisodes({
        repository: "fixture-repo",
        includeOtherRepositories: true,
        limit: 2,
      });

      assert.equal(episodes.length, 2);
      assert.equal(
        episodes.some((episode) => episode.sessionId === "session-own-global-pressure"),
        true,
      );
      assert.equal(episodes.some((episode) => episode.scope === "global"), true);
    } finally {
      cleanup();
    }
  });
});
