import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

test("lore server tool/lifecycle/slash RPC covers the shared verb surface", { skip: SKIP_NO_FTS5 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-rpc-"));
  const copilotHome = path.join(home, ".copilot");
  mkdirSync(copilotHome, { recursive: true });
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
    },
  }));
  writeFileSync(path.join(copilotHome, "copilot-instructions.md"), "");

  const server = startServer(home, configPath);
  try {
    const status = await server.request("status");
    assert.equal(status.ok, true);

    const retained = await server.request("tool", {
      name: "lore_retain",
      args: { content: "pi rpc prefers bun", type: "user_preference" },
    });
    assert.equal(retained.ok, true);
    assert.match(String(retained.result), /Retained semantic memory/);

    const saveAlias = await server.request("tool", {
      name: "lore_save",
      args: { content: "pi rpc save alias", type: "user_preference" },
    });
    assert.equal(saveAlias.ok, true);
    assert.match(String(saveAlias.result), /Retained semantic memory/);

    const slashForgetShape = await server.request("slash", { args: "forget mem-missing" });
    assert.equal(slashForgetShape.ok, true);

    const slashStatus = await server.request("slash", { args: "status" });
    assert.equal(slashStatus.ok, true);
    assert.match(String(slashStatus.result), /enabled: true/);

    const doctor = await server.request("slash", { args: "doctor" });
    assert.equal(doctor.ok, true);

    const lifecycle = await server.request("lifecycle", { event: "session_start", prompt: "" });
    assert.equal(lifecycle.ok, true);
    assert.equal(typeof lifecycle.result.text, "string");
  } finally {
    const result = await server.exit();
    assert.equal(result.code, 0, `server exited with ${JSON.stringify(result)}`);
    rmSync(home, { recursive: true, force: true });
  }
});

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

test("Pi archive queue resumes a partial import beyond four MiB", { skip: SKIP_NO_FTS5 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-large-"));
  const sessions = path.join(home, "sessions"); mkdirSync(sessions);
  const configPath = path.join(home, "lore.json"); const dbPath = path.join(home, "lore.db");
  writeFileSync(configPath, JSON.stringify({ enabled: true, paths: { copilotHome: home, derivedStorePath: dbPath, piSessionDir: sessions } }));
  const file = path.join(sessions, "large.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id: "large", cwd: home }) + "\n"
    + JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }) + "\n"
    + (JSON.stringify({ type: "compaction", content: "x".repeat(1024) }) + "\n").repeat(5000)
    + JSON.stringify({ type: "message", message: { role: "user", content: "Across all repositories, I prefer jadeanchor focused unit tests." } }) + "\n");
  const old = new Date("2026-01-01T00:00:00Z"); utimesSync(file, old, old);
  const server = startServer(home, configPath);
  try {
    await server.request("status"); await server.request("backfill", { max: 1 });
    const result = await server.exit(); assert.equal(result.code, 0);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.ok(db.prepare("SELECT id FROM semantic_memory WHERE content LIKE '%jadeanchor%'").get());
      assert.equal(db.prepare("SELECT pending_bytes FROM ingestion_checkpoint WHERE session_id='large'").get().pending_bytes, 0);
    } finally { db.close(); }
  } finally { server.proc.kill(); rmSync(home, { recursive: true, force: true }); }
});

test("legacy Pi archives bootstrap checkpoints after upgrade", { skip: SKIP_NO_FTS5 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-legacy-"));
  const sessions = path.join(home, "sessions"); mkdirSync(sessions);
  const configPath = path.join(home, "lore.json"); const dbPath = path.join(home, "lore.db");
  writeFileSync(configPath, JSON.stringify({ enabled: true, paths: { copilotHome: home, derivedStorePath: dbPath, piSessionDir: sessions } }));
  makeSession(sessions, "legacy", home);
  const first = startServer(home, configPath);
  try {
    assert.equal((await first.request("status")).ok, true);
    assert.equal((await first.exit()).code, 0);
  } finally { first.proc.kill(); }
  const legacyDb = new DatabaseSync(dbPath);
  try {
    legacyDb.prepare("INSERT INTO episode_digest(id, session_id, summary, date_key, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)").run(
      "legacy-episode", "legacy", "legacy import", "2026-01-01", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    );
  } finally { legacyDb.close(); }
  const second = startServer(home, configPath);
  try {
    assert.equal((await second.request("backfill", { max: 1 })).ok, true);
    assert.equal((await second.exit()).code, 0);
  } finally { second.proc.kill(); }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.ok(db.prepare("SELECT session_id FROM ingestion_checkpoint WHERE client='pi' AND session_id='legacy'").get());
    } finally { db.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Pi archive replacement with preserved size and mtime is rescanned", { skip: SKIP_NO_FTS5 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-rotate-"));
  const sessions = path.join(home, "sessions"); mkdirSync(sessions);
  const configPath = path.join(home, "lore.json"); const dbPath = path.join(home, "lore.db");
  writeFileSync(configPath, JSON.stringify({ enabled: true, paths: { copilotHome: home, derivedStorePath: dbPath, piSessionDir: sessions } }));
  const file = makeSession(sessions, "rotating", home);
  const first = startServer(home, configPath);
  try {
    await first.request("status"); await first.request("backfill", { max: 1 });
    assert.equal((await first.exit()).code, 0);
  } finally { first.proc.kill(); }
  const beforeDb = new DatabaseSync(dbPath, { readOnly: true });
  let before;
  try {
    const row = beforeDb.prepare("SELECT adapter_state_json FROM ingestion_checkpoint WHERE client='pi' AND session_id='rotating'").get();
    before = JSON.parse(row.adapter_state_json).readerCheckpoint;
  } finally { beforeDb.close(); }
  const original = readFileSync(file, "utf8");
  const replacement = original.replace("Completed rotating", "Rewritten rotating");
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  const replacementPath = `${file}.replacement`;
  writeFileSync(replacementPath, replacement);
  const old = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(replacementPath, old, old);
  renameSync(replacementPath, file);
  utimesSync(file, old, old);
  assert.notEqual(`${statSync(file).dev}:${statSync(file).ino}`, before.sourceIdentity);
  const second = startServer(home, configPath);
  try {
    await second.request("backfill", { max: 1 });
    assert.equal((await second.exit()).code, 0);
  } finally { second.proc.kill(); }
  try {
    const afterDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = afterDb.prepare("SELECT adapter_state_json FROM ingestion_checkpoint WHERE client='pi' AND session_id='rotating'").get();
      const after = JSON.parse(row.adapter_state_json).readerCheckpoint;
      assert.notEqual(after.sourceIdentity, before.sourceIdentity);
    } finally { afterDb.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Pi archive same-inode rewrite with preserved size and mtime is rescanned", { skip: SKIP_NO_FTS5 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-rewrite-"));
  const sessions = path.join(home, "sessions"); mkdirSync(sessions);
  const configPath = path.join(home, "lore.json"); const dbPath = path.join(home, "lore.db");
  writeFileSync(configPath, JSON.stringify({ enabled: true, paths: { copilotHome: home, derivedStorePath: dbPath, piSessionDir: sessions } }));
  const file = makeSession(sessions, "rotating", home);
  const first = startServer(home, configPath);
  try {
    await first.request("status"); await first.request("backfill", { max: 1 });
    assert.equal((await first.exit()).code, 0);
  } finally { first.proc.kill(); }
  const beforeDb = new DatabaseSync(dbPath, { readOnly: true });
  let before;
  try {
    const row = beforeDb.prepare("SELECT adapter_state_json FROM ingestion_checkpoint WHERE client='pi' AND session_id='rotating'").get();
    before = JSON.parse(row.adapter_state_json).readerCheckpoint;
  } finally { beforeDb.close(); }
  const original = readFileSync(file, "utf8");
  const replacement = original.replace("Completed rotating", "Rewritten rotating");
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  writeFileSync(file, replacement);
  const old = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(file, old, old);
  assert.equal(`${statSync(file).dev}:${statSync(file).ino}`, before.sourceIdentity);
  assert.equal(statSync(file).mtimeMs, before.sourceMtimeMs);
  assert.notEqual(statSync(file).ctimeMs, before.sourceCtimeMs);
  const second = startServer(home, configPath);
  try {
    await second.request("backfill", { max: 1 });
    assert.equal((await second.exit()).code, 0);
  } finally { second.proc.kill(); }
  try {
    const afterDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = afterDb.prepare("SELECT adapter_state_json FROM ingestion_checkpoint WHERE client='pi' AND session_id='rotating'").get();
      const after = JSON.parse(row.adapter_state_json).readerCheckpoint;
      assert.equal(after.sourceIdentity, before.sourceIdentity);
      assert.notEqual(after.generation, before.generation);
      assert.notEqual(after.sourceCtimeMs, before.sourceCtimeMs);
    } finally { afterDb.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
