import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assembleRecall, fuseLexicalAndVector } from "../../lib/context/recall-assembler.mjs";
import { DEFAULT_MIN_SIMILARITY } from "../../lib/memory/semantic-search.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

describe("fuseLexicalAndVector", () => {
  test("ranks overlapping lexical and vector hits with RRF k=60", () => {
    const fused = fuseLexicalAndVector(
      [
        { id: "lexical-only", content: "Lexical only", updated_at: "2026-01-01T00:00:00.000Z" },
        { id: "shared", content: "Shared", updated_at: "2026-01-02T00:00:00.000Z" },
      ],
      [
        { id: "shared", content: "Shared", score: 0.9, updated_at: "2026-01-02T00:00:00.000Z" },
        { id: "vector-only", content: "Vector only", score: 0.8, updated_at: "2026-01-03T00:00:00.000Z" },
      ],
      { limit: 3 },
    );
    assert.deepEqual(fused.map((row) => row.id), ["shared", "lexical-only", "vector-only"]);
    assert.equal(fused[0].rrfScore > fused[1].rrfScore, true);
  });
});

describe("ranking, TTL, keys, and recall types", () => {
  test("ranking/conflict: newer memory outranks an older higher-confidence duplicate", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const olderId = db.insertSemanticMemory({
        id: "conflict-old",
        type: "decision",
        content: "Decision: use SQLite",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 0.99,
        metadata: { decisionChoice: "use SQLite" },
      });
      const newerId = db.insertSemanticMemory({
        id: "conflict-new",
        type: "decision",
        content: "Decision: use PostgreSQL",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 0.7,
        metadata: { decisionChoice: "use PostgreSQL" },
      });
      db.db.prepare("UPDATE semantic_memory SET updated_at = ? WHERE id = ?")
        .run("2026-01-01T00:00:00.000Z", olderId);
      db.db.prepare("UPDATE semantic_memory SET updated_at = ? WHERE id = ?")
        .run("2026-06-01T00:00:00.000Z", newerId);
      const rows = db.searchSemantic({
        query: "",
        repository: "fixture-repo",
        types: ["decision"],
        limit: 2,
      });
      assert.deepEqual(rows.map((row) => row.id), [newerId, olderId]);
    } finally {
      cleanup();
    }
  });

  test("conversational AND-miss still hits via OR retry", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "or-hit",
        type: "user_preference",
        content: "Prefer PostgreSQL for concurrent writers.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
      });
      const andMiss = db.searchSemantic({
        query: "which database engine handles lots of simultaneous writers",
        repository: "fixture-repo",
        types: ["user_preference"],
        limit: 6,
      });
      assert.equal(andMiss.some((row) => row.id === "or-hit"), true);
    } finally {
      cleanup();
    }
  });

  test("TTL applies to new volatile writes only", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      const goalId = db.insertSemanticMemory({
        id: "ttl-goal",
        type: "assistant_goal",
        content: "Current assistant goal: land the patch",
        repository: "fixture-repo",
        scope: "repo",
        metadata: { goal: "land the patch" },
      });
      const loopId = db.insertSemanticMemory({
        id: "ttl-loop",
        type: "open_loop",
        content: "Finish the auth migration.",
        repository: "fixture-repo",
        scope: "repo",
      });
      const blockerId = db.insertSemanticMemory({
        id: "ttl-blocker",
        type: "blocker",
        content: "Deploy checks are failing.",
        repository: "fixture-repo",
        scope: "repo",
      });
      const prefId = db.insertSemanticMemory({
        id: "ttl-pref",
        type: "user_preference",
        content: "Prefer bun",
        repository: "fixture-repo",
        scope: "repo",
      });
      const rows = Object.fromEntries(
        db.getSemanticMemoryByIds([goalId, loopId, blockerId, prefId])
          .map((row) => [row.id, row.expires_at]),
      );
      const goalMs = Date.parse(rows[goalId]);
      const loopMs = Date.parse(rows[loopId]);
      const blockerMs = Date.parse(rows[blockerId]);
      assert.ok(Number.isFinite(goalMs));
      assert.ok(Math.abs(goalMs - (Date.now() + 24 * 60 * 60 * 1000)) < 60_000);
      assert.ok(Math.abs(loopMs - (Date.now() + 7 * 24 * 60 * 60 * 1000)) < 60_000);
      assert.ok(Math.abs(blockerMs - (Date.now() + 7 * 24 * 60 * 60 * 1000)) < 60_000);
      assert.equal(rows[prefId], null);

      db.db.prepare("UPDATE semantic_memory SET expires_at = NULL WHERE id = ?").run(goalId);
      db.insertSemanticMemory({
        type: "assistant_goal",
        content: "Current assistant goal: land the patch",
        repository: "fixture-repo",
        scope: "repo",
        metadata: { goal: "land the patch" },
      });
      assert.equal(db.getSemanticMemoryByIds([goalId])[0].expires_at, null);
    } finally {
      cleanup();
    }
  });

  test("learned_rule is recalled and new directives dual-read historical extractor preferences", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: { memoryOperations: true, directives: true },
      },
    });
    try {
      db.insertSemanticMemory({
        id: "learned-1",
        type: "learned_rule",
        content: "Always pin Node to the documented major.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
      });
      db.insertSemanticMemory({
        id: "directive-1",
        type: "directive",
        content: "Secrets must be redacted at rest.",
        repository: "fixture-repo",
        scope: "repo",
        tags: ["directive", "policy", "user"],
        metadata: { source: "rule_extractor" },
      });
      db.insertSemanticMemory({
        id: "hist-pref",
        type: "user_preference",
        content: "Always include the failing request in the bug report.",
        repository: "fixture-repo",
        scope: "repo",
        tags: ["preference", "user"],
        metadata: { source: "rule_extractor", confidenceBasis: "explicit_preference_sentence" },
      });
      db.insertSemanticMemory({
        id: "manual-pref",
        type: "user_preference",
        content: "I like teal dashboards.",
        repository: "fixture-repo",
        scope: "repo",
        tags: ["preference", "manual"],
        metadata: { source: "memory_save" },
      });

      const learned = db.searchSemantic({
        query: "documented major",
        repository: "fixture-repo",
        types: ["learned_rule"],
        limit: 6,
      });
      assert.equal(learned.some((row) => row.id === "learned-1"), true);

      const recall = await assembleRecall({
        db,
        prompt: "What standing rules apply to this repo?",
        repository: "fixture-repo",
        config,
      });
      assert.match(recall.text, /Secrets must be redacted at rest/);
      assert.match(recall.text, /Always include the failing request/);
      assert.equal(recall.text.includes("teal dashboards"), false);
      assert.equal(recall.text.includes("## Semantic Matches"), false);
      assert.equal(DEFAULT_MIN_SIMILARITY, 0.35);
    } finally {
      cleanup();
    }
  });
});
