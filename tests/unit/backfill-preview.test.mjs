import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildSessionStartBackfillDecision,
  buildSessionStartBackfillPreview,
  summarizeBackfillRunProgress,
} from "../../lib/backfill.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

describe("backfill preview", () => {
  test("session-start backfill decision prefers resuming an existing running run", () => {
    const decision = buildSessionStartBackfillDecision({
      preview: { candidates: [{ sessionId: "session-a" }] },
      latestRun: {
        id: "run-123",
        status: "running",
        total_candidates: 12,
      },
    });

    assert.deepStrictEqual(decision, {
      action: "resume",
      reason: "existing_run",
      candidateCount: 12,
      runId: "run-123",
    });
  });

  test("session-start backfill decision skips when preview has no candidates", () => {
    const decision = buildSessionStartBackfillDecision({
      preview: { candidates: [] },
      latestRun: null,
    });

    assert.deepStrictEqual(decision, {
      action: "skip",
      reason: "up_to_date",
      candidateCount: 0,
      runId: null,
    });
  });

  test("summarizeBackfillRunProgress reports completed terminal state accurately", () => {
    const progress = summarizeBackfillRunProgress({
      status: "completed",
      total_candidates: 8,
      processed_count: 8,
      created_episode_count: 6,
      refreshed_episode_count: 2,
      failed_count: 0,
      skipped_count: 0,
      batch_size: 4,
    });

    assert.deepStrictEqual(progress, {
      totalCount: 8,
      completedCount: 8,
      createdCount: 6,
      refreshedCount: 2,
      failedCount: 0,
      skippedCount: 0,
      pendingCount: 0,
      runningCount: 0,
      progressPercent: 100,
      currentPhase: "complete",
    });
  });

  test("session-start backfill preview bounds candidates while scanning older sessions", async () => {
    const preview = await buildSessionStartBackfillPreview({
      db: {
        hasEpisodeDigest(sessionId) {
          return ["session-a", "session-b", "session-c"].includes(sessionId);
        },
      },
      sessionStore: {
        getRecentSessionsWindow({ cursor }) {
          if (!cursor) {
            return [
              { id: "session-a", repository: "fixture-repo", updated_at: null, summary: "a" },
              { id: "session-b", repository: "fixture-repo", updated_at: null, summary: "b" },
              { id: "session-c", repository: "fixture-repo", updated_at: null, summary: "c" },
              { id: "session-d", repository: "fixture-repo", updated_at: null, summary: "d" },
            ];
          }
          if (cursor.id === "session-d") {
            return [
              { id: "session-e", repository: "fixture-repo", updated_at: null, summary: "e" },
              { id: "session-f", repository: "fixture-repo", updated_at: null, summary: "f" },
            ];
          }
          return [];
        },
      },
      repository: "fixture-repo",
      includeOtherRepositories: false,
      maxCandidates: 2,
      refreshExisting: false,
      scanWindowSize: 4,
    });

    assert.strictEqual(preview.inspected, 6);
    assert.strictEqual(preview.skippedExisting, 3);
    assert.deepStrictEqual(
      preview.candidates.map((candidate) => candidate.sessionId),
      ["session-d", "session-e"],
    );
  });

  test("session-start backfill preview keeps raw null timestamps ahead of hydrated overrides", async () => {
    const preview = await buildSessionStartBackfillPreview({
      db: {
        hasEpisodeDigest() {
          return false;
        },
      },
      sessionStore: {
        getRecentSessionsWindow({ cursor }) {
          if (!cursor) {
            return [
              {
                id: "session-b",
                repository: "fixture-repo",
                updated_at: "2026-03-31T10:00:00Z",
                sessionStoreUpdatedAt: null,
                summary: "b",
              },
            ];
          }
          if (cursor.id === "session-b" && cursor.updatedAt === "") {
            return [
              {
                id: "session-a",
                repository: "fixture-repo",
                updated_at: null,
                sessionStoreUpdatedAt: null,
                summary: "a",
              },
            ];
          }
          return [];
        },
      },
      repository: "fixture-repo",
      includeOtherRepositories: false,
      maxCandidates: 2,
      refreshExisting: false,
      scanWindowSize: 1,
    });

    assert.deepStrictEqual(
      preview.candidates.map((candidate) => candidate.sessionId),
      ["session-b", "session-a"],
    );
  });

  test("session-start backfill preview reports a bounded partial scan", async () => {
    const preview = await buildSessionStartBackfillPreview({
      db: {
        hasEpisodeDigest() {
          return true;
        },
      },
      sessionStore: {
        getRecentSessionsWindow({ cursor, limit }) {
          if (!cursor) {
            return Array.from({ length: limit }, (_, index) => ({
              id: `session-${index + 1}`,
              repository: "fixture-repo",
              updated_at: `2026-03-30T10:00:${String(index).padStart(2, "0")}Z`,
              sessionStoreUpdatedAt: `2026-03-30T10:00:${String(index).padStart(2, "0")}Z`,
              summary: String(index + 1),
            }));
          }
          return [];
        },
      },
      repository: "fixture-repo",
      includeOtherRepositories: false,
      maxCandidates: 2,
      maxInspected: 3,
      refreshExisting: false,
      scanWindowSize: 10,
    });

    assert.strictEqual(preview.inspected, 3);
    assert.strictEqual(preview.inspectionLimit, 3);
    assert.strictEqual(preview.inspectionBoundReached, true);
    assert.strictEqual(preview.candidates.length, 0);
  });

  test("session-start backfill decision distinguishes bounded previews from fully up to date scans", () => {
    const decision = buildSessionStartBackfillDecision({
      preview: {
        candidates: [],
        inspectionBoundReached: true,
      },
      latestRun: null,
    });

    assert.deepStrictEqual(decision, {
      action: "skip",
      reason: "inspection_bound",
      candidateCount: 0,
      runId: null,
    });
  });
});
