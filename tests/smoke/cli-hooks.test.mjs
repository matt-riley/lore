import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { LORE_CLIENT_HOOKS } from "../../lib/capability-manifest.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const entry = fileURLToPath(new URL("../../lore-cli.mjs", import.meta.url));
const installer = fileURLToPath(new URL("../../scripts/install-hooks.mjs", import.meta.url));

test("native hooks capture, recall across clients, refresh once, preserve source files, and fail open", { skip: !FTS5_AVAILABLE }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-hooks-"));
  const env = { ...process.env, HOME: home, LORE_HOME: home, LORE_CONFIG: path.join(home, "lore.json"), LORE_ENABLED: "true", LORE_REPOSITORY: "owner/shared" };
  writeFileSync(env.LORE_CONFIG, JSON.stringify({ enabled: true, rollout: { postToolUse: true, errorTelemetry: true } }));
  const run = (args, payload, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [entry, ...args], { env: { ...env, ...extraEnv }, input: JSON.stringify(payload), encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const hook = (client, event, payload) => JSON.parse(run(["hook", client, event], payload).stdout);
  try {
    const saved = run(["tool", "memory_save"], { content: "quartzanchor preference: use SQLite for shared persistence", type: "user_preference" }).stdout;
    assert.match(saved, /Saved semantic memory/);
    const id = saved.trim().split(" ").at(-1);
    const transcript = path.join(home, "transcript.jsonl");
    for (const client of Object.keys(LORE_CLIENT_HOOKS)) {
      const messages = client === "codex" ? [
        { type: "response_item", timestamp: "2026-09-06T12:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "quartzanchor: remember that I prefer focused tests." }] } },
        { type: "response_item", timestamp: "2026-09-06T12:01:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "We decided to run focused tests." }] } },
      ] : client === "claude" ? [
        { uuid: "a", parentUuid: null, type: "user", timestamp: "2026-09-06T12:00:00Z", message: { role: "user", content: "quartzanchor: remember that I prefer focused tests." } },
        { uuid: "b", parentUuid: "a", type: "assistant", timestamp: "2026-09-06T12:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "We decided to run focused tests." }] } },
      ] : [
        { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: "2026-09-06T12:00:00Z", content: "quartzanchor: remember that I prefer focused tests." },
        { step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: "2026-09-06T12:01:00Z", content: "We decided to run focused tests." },
      ];
      const raw = messages.map(JSON.stringify).join("\n") + "\n";
      writeFileSync(transcript, raw);
      const payload = client === "antigravity"
        ? { conversationId: "same-id", workspacePaths: [home], transcriptPath: transcript, invocationNum: 0, fullyIdle: true }
        : { session_id: "same-id", cwd: home, transcript_path: transcript, prompt: "quartzanchor", hook_event_name: "UserPromptSubmit" };
      const recall = hook(client, client === "antigravity" ? "PreInvocation" : "UserPromptSubmit", payload);
      assert.match(JSON.stringify(recall), /quartzanchor/);
      for (const event of LORE_CLIENT_HOOKS[client]) {
        const result = run(["hook", client, event], { ...payload, tool_name: "Bash", toolCall: { name: "run_command" }, error: event === "PostToolUseFailure" ? "secret-error" : undefined });
        assert.doesNotMatch(result.stderr, /\[lore\]/, `${client}/${event}: ${result.stderr}`);
        assert.ok(JSON.parse(result.stdout));
      }
      const db = new DatabaseSync(path.join(home, "lore.db"), { readOnly: true });
      const before = db.prepare("SELECT * FROM episode_digest WHERE session_id = ?").get(`${client}:same-id`);
      assert.ok(before, client);
      assert.ok(db.prepare("SELECT id FROM semantic_memory WHERE source_session_id = ? AND content LIKE '%focused tests%'").get(`${client}:same-id`), "automatic capture should retain durable preferences");
      hook(client, "Stop", payload);
      assert.deepEqual(db.prepare("SELECT * FROM episode_digest WHERE session_id = ?").get(`${client}:same-id`), before);
      await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [entry, "hook", client, "Stop"], { env, timeout: 10000 }, (error, stdout, stderr) => {
          if (error || stderr.includes("[lore]")) reject(error ?? new Error(stderr));
          else { assert.ok(JSON.parse(stdout)); resolve(); }
        });
        child.stdin.end(JSON.stringify(payload));
      })));
      assert.deepEqual(db.prepare("SELECT * FROM episode_digest WHERE session_id = ?").get(`${client}:same-id`), before, "racing unchanged events must not repeat capture");
      assert.equal(readFileSync(transcript, "utf8"), raw);
      const revised = raw.replace("We decided to run focused tests.", "We decided to run focused tests and check jadeanchor.");
      writeFileSync(transcript, revised);
      hook(client, "Stop", payload);
      const after = db.prepare("SELECT * FROM episode_digest WHERE session_id = ?").get(`${client}:same-id`);
      assert.equal(after.id, before.id, "growing transcripts refresh the existing session");
      assert.notEqual(after.source, before.source);
      db.close();
      assert.equal(readFileSync(transcript, "utf8"), revised);
      assert.deepEqual(hook(client, "Stop", { ...payload, transcriptPath: "/missing", transcript_path: "/missing" }), client === "antigravity" ? { decision: "stop" } : {});
    }
    const db = new DatabaseSync(path.join(home, "lore.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS n FROM episode_digest").get().n, 3);
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM error_telemetry").all()), /secret-error/);
    db.close();
    assert.match(run(["tool", "memory_status"], {}).stdout, /episodeCount: 3/);
    assert.match(run(["tool", "lore_recall"], { prompt: "quartzanchor" }).stdout, /quartzanchor/);
    assert.match(run(["tool", "lore_onboard"], { userName: "Tester" }).stdout, /Tester/);
    assert.match(run(["tool", "lore_retain"], { content: "Remember jadeanchor", type: "decision" }).stdout, /./);
    run(["tool", "memory_forget"], { id });
    assert.doesNotMatch(run(["tool", "memory_search"], { query: "quartzanchor" }).stdout, /use SQLite for shared persistence/);
    const disabled = path.join(home, "disabled.json");
    writeFileSync(disabled, JSON.stringify({ enabled: false }));
    assert.equal(run(["hook", "claude", "SessionStart"], { session_id: "x", cwd: home }, { LORE_CONFIG: disabled, LORE_ENABLED: "false" }).stdout.trim(), "{}");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("installer dry runs, preserves other hooks/settings, is idempotent, and removes only Lore", () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "lore-hook-install-'"));
  try {
    for (const client of Object.keys(LORE_CLIENT_HOOKS)) {
      const relative = { codex: ".codex/hooks.json", claude: ".claude/settings.local.json", antigravity: ".gemini/config/hooks.json" }[client];
      const target = path.join(project, relative);
      const run = (...args) => {
        const scope = client === "antigravity" ? ["--global"] : ["--project", project];
        const result = spawnSync(process.execPath, [installer, client, ...scope, ...args], { encoding: "utf8", env: { ...process.env, HOME: project } });
        assert.equal(result.status, 0, result.stderr);
      };
      run();
      assert.equal(existsSync(target), false);
      mkdirSync(path.dirname(target), { recursive: true });
      const original = client === "antigravity" ? { other: { Stop: [{ command: "true" }] } } : { permissions: { deny: ["Bash(rm:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } };
      writeFileSync(target, JSON.stringify(original));
      run("--write");
      const first = readFileSync(target, "utf8");
      run("--write");
      assert.equal(readFileSync(target, "utf8"), first);
      run("--remove", "--write");
      assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), original);
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
});
