import assert from "node:assert/strict";
import { describe, test } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { LoreDb } from "../../lib/db/db.mjs";
import { buildFixtureConfig } from "../helpers/fixture-config.mjs";
import { SessionSource, EpisodeSessionSource } from "../../lib/runtime/session-source.mjs";
import { assembleRecall } from "../../lib/context/recall-assembler.mjs";
import { openCliRuntime } from "../../lib/clients/cli-runtime.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-session-source-test-"));
}

describe("SessionSource and EpisodeSessionSource", () => {
  test("SessionSource base class defaults", () => {
    const source = new SessionSource();
    assert.deepEqual(source.findSessionsByDate(), []);
    assert.deepEqual(source.findRelevantSessions(), []);
    assert.doesNotThrow(() => source.close());
  });

  test("EpisodeSessionSource.findSessionsByDate queries episode_digest", () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome);
      const db = new LoreDb(config);
      db.initialize();

      db.db.prepare(`
        INSERT INTO episode_digest (session_id, repository, branch, date_key, summary, created_at, updated_at)
        VALUES
          ('s1', 'repo-a', 'main', '2026-06-04', 'Fixed auth bug', '2026-06-04T10:00:00.000Z', '2026-06-04T11:00:00.000Z'),
          ('s2', 'repo-b', 'feature', '2026-06-04', 'Refactored CSS', '2026-06-04T09:00:00.000Z', '2026-06-04T12:00:00.000Z'),
          ('s3', 'repo-a', 'main', '2026-06-05', 'Added tests', '2026-06-05T10:00:00.000Z', '2026-06-05T10:30:00.000Z')
      `).run();

      const source = new EpisodeSessionSource(db, { client: "codex" });

      // Local repository only
      const localMatches = source.findSessionsByDate({
        dateKey: "2026-06-04",
        repository: "repo-a",
        includeOtherRepositories: false,
        limit: 5,
      });
      assert.equal(localMatches.length, 1);
      assert.equal(localMatches[0].session_id, "s1");
      assert.equal(localMatches[0].repository, "repo-a");
      assert.equal(localMatches[0].summary, "Fixed auth bug");

      // Cross-repo inclusion
      const crossRepoMatches = source.findSessionsByDate({
        dateKey: "2026-06-04",
        repository: "repo-a",
        includeOtherRepositories: true,
        limit: 5,
      });
      assert.equal(crossRepoMatches.length, 2);
      assert.equal(crossRepoMatches[0].session_id, "s2"); // updated_at 12:00 > 11:00
      assert.equal(crossRepoMatches[1].session_id, "s1");

      source.close();
      db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("unknown repository identity returns global history only", async () => {
    const { db, cleanup } = await import("../helpers/fixture-db.mjs").then(({ withFixtureDb }) => withFixtureDb());
    try {
      db.db.prepare(`INSERT INTO episode_digest (session_id, repository, scope, date_key, summary, created_at, updated_at)
        VALUES ('foreign', 'private-repo', 'repo', '2026-06-04', 'PRIVATE_MARKER', '2026-06-04', '2026-06-04')`).run();
      const source = new EpisodeSessionSource(db);
      const rows = source.findSessionsByDate({ dateKey: "2026-06-04", repository: null });
      assert.equal(rows.some((row) => row.summary === "PRIVATE_MARKER"), false);
    } finally {
      cleanup();
    }
  });

  test("EpisodeSessionSource.findRelevantSessions searches episodes", () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome);
      const db = new LoreDb(config);
      db.initialize();

      db.upsertEpisodeDigest({
        sessionId: "session-auth",
        repository: "repo-auth",
        branch: "main",
        dateKey: "2026-06-04",
        summary: "Implemented OAuth authentication token exchange",
        source: "rule:codex:test",
        cwd: "/path/to/repo",
      });

      const source = new EpisodeSessionSource(db, { client: "codex" });
      const results = source.findRelevantSessions({
        prompt: "OAuth token exchange",
        repository: "repo-auth",
        limit: 5,
      });

      assert.ok(Array.isArray(results));
      assert.ok(results.length >= 1);
      assert.equal(results[0].session_id, "session-auth");
      assert.equal(results[0].source_type, "episode");
      assert.ok(results[0].excerpt.includes("OAuth"));

      source.close();
      db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("openCliRuntime initializes sessionSource over EpisodeSessionSource", async () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome, { enabled: true });

      const runtime = await openCliRuntime({ cwd: tempHome, client: "codex", config });
      assert.ok(runtime);
      assert.ok(runtime.sessionSource instanceof EpisodeSessionSource);
      assert.strictEqual(runtime.sessionStore, runtime.sessionSource);
      runtime.sessionSource.close();
      runtime.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("temporal recall on Codex with no Copilot session-store returns episode evidence", async () => {
    const tempHome = makeTempDir();
    try {
      const config = buildFixtureConfig(tempHome);
      const db = new LoreDb(config);
      db.initialize();

      const now = new Date();
      const startOfUtcDay = new Date(now);
      startOfUtcDay.setUTCHours(0, 0, 0, 0);
      const targetIndex = 4; // thursday
      const currentIndex = now.getUTCDay();
      const diff = (currentIndex - targetIndex + 7) % 7 || 7;
      const thursday = new Date(startOfUtcDay);
      thursday.setUTCDate(thursday.getUTCDate() - diff);
      const dateKey = thursday.toISOString().slice(0, 10);

      // Insert episode on last Thursday
      db.upsertEpisodeDigest({
        sessionId: "codex-session-compiler",
        repository: "engine-repo",
        branch: "main",
        dateKey,
        summary: "Worked on parser and compiler optimization passes",
        source: "rule:codex:test",
        cwd: "/path/to/engine",
      });

      const sessionSource = new EpisodeSessionSource(db, { client: "codex" });
      const recall = await assembleRecall({
        db,
        repository: "engine-repo",
        prompt: "What did we do last Thursday?",
        limit: 6,
        sessionSource,
        config,
      });

      assert.ok(recall);
      assert.ok(recall.text);
      assert.ok(recall.text.includes("compiler optimization passes"));
      sessionSource.close();
      db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
