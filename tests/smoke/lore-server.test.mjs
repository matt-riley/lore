import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = path.join(REPO_ROOT, "lore-server.mjs");
const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function makeSession(directory, id, cwd) {
  const filePath = path.join(directory, `${id}.jsonl`);
  writeFileSync(filePath, [
    JSON.stringify({ type: "session", id, cwd, timestamp: "2026-01-01T00:00:00.000Z" }),
    JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: `Remember ${id}` } }),
    JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: `Completed ${id}` } }),
  ].join("\n") + "\n");
  const old = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(filePath, old, old);
  return filePath;
}

function startServer(home, configPath) {
  const proc = spawn(process.execPath, [SERVER], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, LORE_COPILOT_HOME: path.dirname(configPath), LORE_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readline = createInterface({ input: proc.stdout });
  const pending = new Map();
  readline.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    } catch {
      // Ignore non-protocol output; the server writes diagnostics to stderr.
    }
  });
  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  function exit() {
    return new Promise((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code, signal) => resolve({ code, signal }));
      proc.stdin.end();
    });
  }
  return { proc, request, exit };
}

test("lore server handles status/save/recall/extract, backfill, and graceful EOF", { skip: SKIP_NO_FTS5 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-server-"));
  const copilotHome = path.join(home, ".copilot");
  const sessions = path.join(home, "sessions");
  const project = path.join(home, "project");
  mkdirSync(copilotHome, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(project, { recursive: true });
  const configPath = path.join(copilotHome, "lore.json");
  const dbPath = path.join(copilotHome, "lore.db");
  writeFileSync(configPath, JSON.stringify({
    enabled: true,
    paths: {
      copilotHome,
      rawStorePath: path.join(copilotHome, "session-store.db"),
      derivedStorePath: dbPath,
      backupDir: path.join(copilotHome, "backups"),
      instructionsPath: path.join(copilotHome, "copilot-instructions.md"),
      scopedInstructionsDir: path.join(copilotHome, "instructions"),
      piSessionDir: sessions,
    },
  }));
  writeFileSync(path.join(copilotHome, "copilot-instructions.md"), "");
  const extractPath = makeSession(sessions, "extract-session", project);
  makeSession(sessions, "backfill-session", project);

  const server = startServer(home, configPath);
  try {
    const status = await server.request("status");
    assert.equal(status.ok, true);
    const saved = await server.request("save", {
      type: "user_preference",
      content: "archive smoke anchor",
      repository: "lore-test",
    });
    assert.equal(saved.ok, true);
    assert.ok(saved.result.id);
    const recalled = await server.request("recall", { prompt: "archive smoke anchor", repository: "lore-test" });
    assert.equal(recalled.ok, true);
    assert.ok(recalled.result.includedRows >= 1);
    const extracted = await server.request("extract", { path: extractPath, repository: "lore-test" });
    assert.equal(extracted.ok, true);
    assert.equal(extracted.result.extracted, true);
    const backfill = await server.request("backfill", { max: 1, currentSessionId: "current-session" });
    assert.equal(backfill.ok, true);
    assert.equal(backfill.result.pending, true);
    assert.equal(backfill.result.queued, 0);
    const foreground = await server.request("status");
    assert.equal(foreground.ok, true);
  } finally {
    const result = await server.exit();
    assert.equal(result.code, 0, `server exited with ${JSON.stringify(result)}`);
  }

  try {
    assert.equal(existsSync(`${dbPath}.pi-archive-cursor.json`), true, "archive cursor should live beside derived DB");
    assert.equal(existsSync(path.join(sessions, ".lore-archive-cursor.json")), false, "raw archive should remain untouched");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT session_id FROM episode_digest WHERE session_id = ?").get("backfill-session");
      assert.ok(row, "EOF should drain the queued archive extraction before closing");
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
