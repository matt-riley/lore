import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { SessionStoreReader } from "../../lib/session-store-reader.mjs";
import { buildFixtureConfig } from "../helpers/fixture-config.mjs";

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-session-store-"));
}

function buildRawStore(tempHome, sessions) {
  const rawStorePath = path.join(tempHome, "session-store.db");
  const db = new DatabaseSync(rawStorePath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      branch TEXT,
      summary TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO sessions (id, repository, branch, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [id, repo, branch, summary, created, updated] of sessions) {
    insert.run(id, repo, branch, summary, created, updated);
  }
  db.close();
  return rawStorePath;
}

describe("SessionStoreReader.initialize", () => {
  test("throws a clear error when session-store.db is missing", () => {
    const tempHome = makeTempDir();
    try {
      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      assert.throws(
        () => reader.initialize(),
        /session-store\.db not found .*Lore requires the Copilot CLI session store/i,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("opens a readonly raw store when the file exists", () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
      const db = new DatabaseSync(rawStorePath);
      db.close();

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      assert.ok(reader.db, "expected session-store reader to hold an open database");
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("SessionStoreReader.searchIndex", () => {
  test("sanitizes FTS queries before matching", () => {
    const reader = new SessionStoreReader({
      paths: {
        copilotHome: "/ignored",
      },
    });
    let capturedQuery = null;
    reader.db = {
      prepare() {
        return {
          all(query) {
            capturedQuery = query;
            return [];
          },
        };
      },
    };

    const rows = reader.searchIndex({ query: "lore", limit: 5 });

    assert.deepStrictEqual(rows, []);
    assert.strictEqual(capturedQuery, "lore memory");
  });
});

describe("SessionStoreReader.getRecentSessionsWindow", () => {
  test("returns hydrated rows with limit and offset applied", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-1", "repo-one", null, "first", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-2", "repo-two", null, "second", "2026-03-30T10:01:00Z", "2026-03-30T10:01:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.getRecentSessionsWindow({ limit: 1, offset: 1 });

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, "session-1");
      assert.strictEqual(rows[0].repository, "repo-one");
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("uses a deterministic tiebreaker when updated_at timestamps match", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-a", "repo-one", null, "a", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-c", "repo-one", null, "c", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-b", "repo-one", null, "b", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();

      const firstWindow = reader.getRecentSessionsWindow({ limit: 2, offset: 0 });
      const secondWindow = reader.getRecentSessionsWindow({ limit: 2, offset: 2 });

      assert.deepStrictEqual(
        firstWindow.map((row) => row.id),
        ["session-c", "session-b"],
      );
      assert.deepStrictEqual(
        secondWindow.map((row) => row.id),
        ["session-a"],
      );
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("supports keyset pagination for stable follow-on windows", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-a", "repo-one", null, "a", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-c", "repo-one", null, "c", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-b", "repo-one", null, "b", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();

      const firstWindow = reader.getRecentSessionsWindow({ limit: 2 });
      const secondWindow = reader.getRecentSessionsWindow({
        limit: 2,
        cursor: {
          updatedAt: firstWindow[1].updated_at ?? "",
          id: firstWindow[1].id,
        },
      });

      assert.deepStrictEqual(
        firstWindow.map((row) => row.id),
        ["session-c", "session-b"],
      );
      assert.deepStrictEqual(
        secondWindow.map((row) => row.id),
        ["session-a"],
      );
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("exposes raw session-store updated_at for keyset cursors when hydration overrides updated_at", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-a", "repo-one", null, "a", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-b", "repo-one", null, "b", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z"],
      ]);

      const workspaceDir = path.join(tempHome, "session-state", "session-b");
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(workspaceDir + "/workspace.yaml", "updated_at: 2026-03-31T10:00:00Z\n");

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();

      const firstWindow = reader.getRecentSessionsWindow({ limit: 1 });
      assert.strictEqual(firstWindow[0].id, "session-b");
      assert.strictEqual(firstWindow[0].updated_at, "2026-03-31T10:00:00Z");
      assert.strictEqual(firstWindow[0].sessionStoreUpdatedAt, "2026-03-30T10:00:00Z");

      const secondWindow = reader.getRecentSessionsWindow({
        limit: 1,
        cursor: {
          updatedAt: firstWindow[0].sessionStoreUpdatedAt,
          id: firstWindow[0].id,
        },
      });

      assert.deepStrictEqual(
        secondWindow.map((row) => row.id),
        ["session-a"],
      );
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("SessionStoreReader.findSessionsByDate", () => {
  test("filters sessions by the provided date key", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-match-1", "repo-one", "main", "match one", "2026-03-29T08:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-match-2", "repo-two", "feature", "match two", "2026-03-30T09:00:00Z", null],
        ["session-other", "repo-one", "main", "other date", "2026-03-31T09:00:00Z", "2026-03-31T10:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.findSessionsByDate({
        dateKey: "2026-03-30",
        includeOtherRepositories: true,
        limit: 10,
      });

      assert.deepStrictEqual(
        rows.map((row) => row.session_id),
        ["session-match-1", "session-match-2"],
      );
      assert.strictEqual(rows[0].repository, "repo-one");
      assert.strictEqual(rows[0].summary, "match one");
      assert.strictEqual(rows[1].repository, "repo-two");
      assert.strictEqual(rows[1].summary, "match two");
      assert.strictEqual(rows[0].workspaceSummary, null);
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("applies repository filtering after hydration and retains raw session-store timestamps", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-workspace", "raw-repo", "raw-branch", "raw summary", "2026-03-30T08:00:00Z", "2026-03-30T10:00:00Z"],
      ]);

      const workspaceDir = path.join(tempHome, "session-state", "session-workspace");
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(
        path.join(workspaceDir, "workspace.yaml"),
        [
          "repository: hydrated-repo",
          "branch: hydrated-branch",
          "updated_at: 2026-03-31T07:00:00Z",
          "summary: hydrated workspace summary",
        ].join("\n"),
      );

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.findSessionsByDate({
        dateKey: "2026-03-30",
        repository: "hydrated-repo",
        includeOtherRepositories: false,
        limit: 5,
      });

      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(rows[0], {
        session_id: "session-workspace",
        repository: "hydrated-repo",
        branch: "hydrated-branch",
        created_at: "2026-03-30T08:00:00Z",
        updated_at: "2026-03-31T07:00:00Z",
        sessionStoreCreatedAt: "2026-03-30T08:00:00Z",
        sessionStoreUpdatedAt: "2026-03-30T10:00:00Z",
        summary: "raw summary",
        workspaceSummary: "hydrated workspace summary",
      });
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("honors cross-repo inclusion and local-only restrictions", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["local-session", "repo-local", "main", "local", "2026-03-30T08:00:00Z", "2026-03-30T11:00:00Z"],
        ["other-session", "repo-other", "main", "other", "2026-03-30T08:00:00Z", "2026-03-30T10:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();

      const localOnly = reader.findSessionsByDate({
        dateKey: "2026-03-30",
        repository: "repo-local",
        includeOtherRepositories: false,
        limit: 5,
      });
      const crossRepo = reader.findSessionsByDate({
        dateKey: "2026-03-30",
        repository: "repo-local",
        includeOtherRepositories: true,
        limit: 5,
      });

      assert.deepStrictEqual(
        localOnly.map((row) => row.session_id),
        ["local-session"],
      );
      assert.deepStrictEqual(
        crossRepo.map((row) => row.session_id),
        ["local-session", "other-session"],
      );
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("returns bounded rows using deterministic updated-at ordering", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-a", "repo-one", "main", "a", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-c", "repo-one", "main", "c", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-b", "repo-one", "main", "b", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-new", "repo-one", "main", "new", "2026-03-30T07:00:00Z", "2026-03-30T11:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.findSessionsByDate({
        dateKey: "2026-03-30",
        includeOtherRepositories: true,
        limit: 3,
      });

      assert.deepStrictEqual(
        rows.map((row) => row.session_id),
        ["session-new", "session-c", "session-b"],
      );
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("falls back to the default limit when passed a non-numeric limit", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(
        tempHome,
        Array.from({ length: 6 }, (_, i) => [
          `session-${i}`,
          "repo-one",
          "main",
          `summary ${i}`,
          `2026-03-30T0${i}:00:00Z`,
          `2026-03-30T1${i}:00:00Z`,
        ]),
      );

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.findSessionsByDate({
        dateKey: "2026-03-30",
        includeOtherRepositories: true,
        limit: "abc",
      });

      assert.strictEqual(rows.length, 5);
      assert.deepStrictEqual(
        rows.map((row) => row.session_id),
        ["session-5", "session-4", "session-3", "session-2", "session-1"],
      );
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("SessionStoreReader.findSessionsSince", () => {
  test("filters sessions at or after the provided ISO cutoff", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-before", "repo-one", "main", "too old", "2026-03-28T08:00:00Z", "2026-03-28T09:00:00Z"],
        ["session-at-cutoff", "repo-one", "main", "exactly at cutoff", "2026-03-29T08:00:00Z", "2026-03-29T12:00:00Z"],
        ["session-after", "repo-two", "feature", "well within window", "2026-03-30T09:00:00Z", null],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.findSessionsSince({
        sinceIso: "2026-03-29T12:00:00Z",
        includeOtherRepositories: true,
        limit: 10,
      });

      assert.deepStrictEqual(
        rows.map((row) => row.session_id),
        ["session-after", "session-at-cutoff"],
      );
      assert.strictEqual(rows[0].repository, "repo-two");
      assert.strictEqual(rows[1].summary, "exactly at cutoff");
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("honors cross-repo inclusion and local-only restrictions", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["local-session", "repo-local", "main", "local", "2026-03-30T08:00:00Z", "2026-03-30T11:00:00Z"],
        ["other-session", "repo-other", "main", "other", "2026-03-30T08:00:00Z", "2026-03-30T10:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();

      const localOnly = reader.findSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        repository: "repo-local",
        includeOtherRepositories: false,
        limit: 5,
      });
      const crossRepo = reader.findSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        repository: "repo-local",
        includeOtherRepositories: true,
        limit: 5,
      });

      assert.deepStrictEqual(
        localOnly.map((row) => row.session_id),
        ["local-session"],
      );
      assert.deepStrictEqual(
        crossRepo.map((row) => row.session_id),
        ["local-session", "other-session"],
      );
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("returns bounded rows using deterministic updated-at ordering", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-a", "repo-one", "main", "a", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-c", "repo-one", "main", "c", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-b", "repo-one", "main", "b", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-new", "repo-one", "main", "new", "2026-03-30T07:00:00Z", "2026-03-30T11:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.findSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        includeOtherRepositories: true,
        limit: 3,
      });

      assert.deepStrictEqual(
        rows.map((row) => row.session_id),
        ["session-new", "session-c", "session-b"],
      );
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("falls back to the default limit when passed a non-numeric limit", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(
        tempHome,
        Array.from({ length: 22 }, (_, i) => [
          `session-${i}`,
          "repo-one",
          "main",
          `summary ${i}`,
          `2026-03-30T${String(i).padStart(2, "0")}:00:00Z`,
          `2026-03-30T${String(i).padStart(2, "0")}:30:00Z`,
        ]),
      );

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const rows = reader.findSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        includeOtherRepositories: true,
        limit: "abc",
      });

      assert.strictEqual(rows.length, 20);
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("SessionStoreReader.countSessionsSince", () => {
  test("returns an exact cross-repo count that exceeds findSessionsSince's evidence-fetch limit", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(
        tempHome,
        Array.from({ length: 22 }, (_, i) => [
          `session-${i}`,
          "repo-one",
          "main",
          `summary ${i}`,
          `2026-03-30T${String(i).padStart(2, "0")}:00:00Z`,
          `2026-03-30T${String(i).padStart(2, "0")}:30:00Z`,
        ]),
      );

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();

      // findSessionsSince caps its evidence array at 20 rows (see the
      // sibling "falls back to the default limit" test above); the true
      // count must not inherit that cap.
      const evidenceRows = reader.findSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        includeOtherRepositories: true,
        limit: "abc",
      });
      const { count, capped } = reader.countSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        includeOtherRepositories: true,
      });

      assert.strictEqual(evidenceRows.length, 20);
      assert.strictEqual(count, 22);
      assert.strictEqual(capped, false);
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("filters at or after the provided ISO cutoff", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-before", "repo-one", "main", "too old", "2026-03-28T08:00:00Z", "2026-03-28T09:00:00Z"],
        ["session-at-cutoff", "repo-one", "main", "exactly at cutoff", "2026-03-29T08:00:00Z", "2026-03-29T12:00:00Z"],
        ["session-after", "repo-two", "feature", "well within window", "2026-03-30T09:00:00Z", null],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const { count, capped } = reader.countSessionsSince({
        sinceIso: "2026-03-29T12:00:00Z",
        includeOtherRepositories: true,
      });

      assert.strictEqual(count, 2);
      assert.strictEqual(capped, false);
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("scopes the count to the effective (hydrated) repository, not the raw column", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-workspace", "raw-repo", "raw-branch", "raw summary", "2026-03-30T08:00:00Z", "2026-03-30T10:00:00Z"],
        ["session-other", "repo-other", "main", "other", "2026-03-30T08:00:00Z", "2026-03-30T10:00:00Z"],
      ]);

      const workspaceDir = path.join(tempHome, "session-state", "session-workspace");
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(
        path.join(workspaceDir, "workspace.yaml"),
        ["repository: hydrated-repo", "updated_at: 2026-03-31T07:00:00Z"].join("\n"),
      );

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const { count, capped } = reader.countSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        repository: "hydrated-repo",
        includeOtherRepositories: false,
      });

      assert.strictEqual(count, 1);
      assert.strictEqual(capped, false);
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("honors cross-repo inclusion and local-only restrictions", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["local-session", "repo-local", "main", "local", "2026-03-30T08:00:00Z", "2026-03-30T11:00:00Z"],
        ["other-session", "repo-other", "main", "other", "2026-03-30T08:00:00Z", "2026-03-30T10:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();

      const localOnly = reader.countSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        repository: "repo-local",
        includeOtherRepositories: false,
      });
      const crossRepo = reader.countSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        repository: "repo-local",
        includeOtherRepositories: true,
      });

      assert.strictEqual(localOnly.count, 1);
      assert.strictEqual(crossRepo.count, 2);
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("flags capped:true when the repository-scoped fetch hits its ceiling", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(
        tempHome,
        Array.from({ length: 505 }, (_, i) => [
          `session-${i}`,
          "repo-one",
          "main",
          `summary ${i}`,
          `2026-03-30T00:00:00Z`,
          new Date(Date.parse("2026-03-30T00:00:00Z") + i * 1000).toISOString(),
        ]),
      );

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const { count, capped } = reader.countSessionsSince({
        sinceIso: "2026-03-29T00:00:00Z",
        repository: "repo-one",
        includeOtherRepositories: false,
      });

      assert.strictEqual(count, 500);
      assert.strictEqual(capped, true);
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("returns zero when no sessions match", () => {
    const tempHome = makeTempDir();
    try {
      buildRawStore(tempHome, [
        ["session-before", "repo-one", "main", "too old", "2026-03-28T08:00:00Z", "2026-03-28T09:00:00Z"],
      ]);

      const reader = new SessionStoreReader(buildFixtureConfig(tempHome));
      reader.initialize();
      const { count, capped } = reader.countSessionsSince({
        sinceIso: "2026-03-29T12:00:00Z",
        includeOtherRepositories: true,
      });

      assert.strictEqual(count, 0);
      assert.strictEqual(capped, false);
      reader.db.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("SessionStoreReader.collectRelevantSessionMatches", () => {
  test("keeps the strongest hydrated match per session and drops repository mismatches", () => {
    const reader = new SessionStoreReader({
      paths: {
        copilotHome: "/ignored",
      },
    });
    reader.hydrateSessionRow = (row) => ({
      id: row.id,
      repository: row.id === "session-1" ? "hydrated-repo" : "other-repo",
      branch: `${row.id}-branch`,
      updated_at: row.updated_at,
    });

    const matches = reader.collectRelevantSessionMatches({
      rows: [
        {
          session_id: "session-1",
          repository: "raw-repo",
          branch: "raw-branch",
          updated_at: "2026-03-30T10:00:00Z",
          source_type: "turn",
          content: "auth rollback follow-up",
        },
        {
          session_id: "session-1",
          repository: "raw-repo",
          branch: "raw-branch",
          updated_at: "2026-03-30T11:00:00Z",
          source_type: "checkpoint_history",
          content: "auth rollback migration checkpoint summary",
        },
        {
          session_id: "session-2",
          repository: "raw-other",
          branch: "raw-other-branch",
          updated_at: "2026-03-30T12:00:00Z",
          source_type: "checkpoint_overview",
          content: "auth rollback notes in another repo",
        },
      ],
      promptTerms: ["auth", "rollback"],
      repository: "hydrated-repo",
    });

    assert.deepStrictEqual(matches, [
      {
        session_id: "session-1",
        repository: "hydrated-repo",
        branch: "session-1-branch",
        updated_at: "2026-03-30T11:00:00Z",
        score: 3.5,
        source_type: "checkpoint_history",
        excerpt: "auth rollback migration checkpoint summary",
      },
    ]);
  });
});
