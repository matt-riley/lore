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

describe("SessionStoreReader.getRecentSessionsWindow", () => {
  test("returns hydrated rows with limit and offset applied", () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
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
      db.prepare(`
        INSERT INTO sessions (id, repository, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("session-1", "repo-one", "first", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      db.prepare(`
        INSERT INTO sessions (id, repository, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("session-2", "repo-two", "second", "2026-03-30T10:01:00Z", "2026-03-30T10:01:00Z");
      db.close();

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
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
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
        INSERT INTO sessions (id, repository, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      insert.run("session-a", "repo-one", "a", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-c", "repo-one", "c", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-b", "repo-one", "b", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      db.close();

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
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
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
        INSERT INTO sessions (id, repository, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      insert.run("session-a", "repo-one", "a", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-c", "repo-one", "c", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-b", "repo-one", "b", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      db.close();

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
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
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
        INSERT INTO sessions (id, repository, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      insert.run("session-a", "repo-one", "a", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-b", "repo-one", "b", "2026-03-30T10:00:00Z", "2026-03-30T10:00:00Z");
      db.close();

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
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
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
      insert.run("session-match-1", "repo-one", "main", "match one", "2026-03-29T08:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-match-2", "repo-two", "feature", "match two", "2026-03-30T09:00:00Z", null);
      insert.run("session-other", "repo-one", "main", "other date", "2026-03-31T09:00:00Z", "2026-03-31T10:00:00Z");
      db.close();

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

  test("applies repository filtering after workspace metadata hydration", () => {
    const tempHome = makeTempDir();
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
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
      db.prepare(`
        INSERT INTO sessions (id, repository, branch, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "session-workspace",
        "raw-repo",
        "raw-branch",
        "raw summary",
        "2026-03-30T08:00:00Z",
        "2026-03-30T10:00:00Z",
      );
      db.close();

      const workspaceDir = path.join(tempHome, "session-state", "session-workspace");
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(
        path.join(workspaceDir, "workspace.yaml"),
        [
          "repository: hydrated-repo",
          "branch: hydrated-branch",
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
        updated_at: "2026-03-30T10:00:00Z",
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
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
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
      insert.run("local-session", "repo-local", "main", "local", "2026-03-30T08:00:00Z", "2026-03-30T11:00:00Z");
      insert.run("other-session", "repo-other", "main", "other", "2026-03-30T08:00:00Z", "2026-03-30T10:00:00Z");
      db.close();

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
    const rawStorePath = path.join(tempHome, "session-store.db");
    try {
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
      insert.run("session-a", "repo-one", "main", "a", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-c", "repo-one", "main", "c", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-b", "repo-one", "main", "b", "2026-03-30T06:00:00Z", "2026-03-30T10:00:00Z");
      insert.run("session-new", "repo-one", "main", "new", "2026-03-30T07:00:00Z", "2026-03-30T11:00:00Z");
      db.close();

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
});
