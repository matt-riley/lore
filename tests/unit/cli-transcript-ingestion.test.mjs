import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingestCliTranscript, validateCliTranscriptIdentity } from "../../lib/clients/cli-transcript-ingestion.mjs";

test("explicit capture validates native transcript identities before ingestion", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-capture-identity-"));
  try {
    const cases = [
      ["codex", "codex-id", { type: "session_meta", payload: { id: "codex-id" } }],
      ["claude", "claude-id", { sessionId: "claude-id" }],
      ["pi", "pi-id", { type: "session", id: "pi-id" }],
    ];
    for (const [client, nativeId, record] of cases) {
      const file = path.join(home, `${client}.jsonl`);
      await writeFile(file, `${JSON.stringify(record)}\n`);
      assert.equal(await validateCliTranscriptIdentity(file, { client, nativeId }), nativeId);
      await assert.rejects(
        validateCliTranscriptIdentity(file, { client, nativeId: "different-id" }),
        (error) => error.code === "SOURCE_SESSION_MISMATCH",
      );
    }
    const missing = path.join(home, "missing-identity.jsonl");
    await writeFile(missing, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "hello" } })}\n`);
    await assert.rejects(
      validateCliTranscriptIdentity(missing, { client: "codex", nativeId: "codex-id" }),
      (error) => error.code === "SOURCE_SESSION_ID_MISSING",
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("ingestion validates the native identity on the same source read", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-capture-bound-identity-"));
  try {
    const file = path.join(home, "transcript.jsonl");
    await writeFile(file, [
      { type: "session_meta", payload: { id: "wrong-id" } },
      { type: "response_item", payload: { type: "message", role: "user", content: "should not capture" } },
    ].map(JSON.stringify).join("\n") + "\n");
    const db = fakeDb();
    await assert.rejects(
      ingestCliTranscript({ db, client: "codex", sessionId: "codex:right-id", nativeId: "right-id", transcriptPath: file, cwd: home }),
      (error) => error.code === "SOURCE_SESSION_MISMATCH",
    );
    assert.equal(db.getIngestionCheckpoint(), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

function fakeDb() {
  let checkpoint = null;
  return {
    getIngestionCheckpoint() { return checkpoint; },
    withSemanticMemoryTransaction(callback) { return callback(); },
    saveIngestionCheckpoint(_client, _sessionId, state) {
      if (this.bumpBeforeSave) {
        this.bumpBeforeSave = false;
        this.bumpCheckpoint();
      }
      const expected = state.expectedCheckpointRevision ?? 0;
      if (expected !== (checkpoint?.checkpointRevision ?? 0)) {
        const error = new Error("stale");
        error.code = "CHECKPOINT_REVISION_CONFLICT";
        throw error;
      }
      checkpoint = {
        ...state,
        checkpointRevision: (checkpoint?.checkpointRevision ?? 0) + 1,
        adapterState: state.adapterState,
        health: state.health,
      };
      return checkpoint;
    },
    bumpCheckpoint() {
      checkpoint = { ...checkpoint, checkpointRevision: (checkpoint?.checkpointRevision ?? 0) + 1 };
    },
  };
}

test("ingestion resumes bounded records and persists only normalized conversation state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-ingestion-"));
  try {
    const file = path.join(home, "transcript.jsonl");
    await writeFile(file, [
      { type: "response_item", payload: { type: "reasoning", summary: "private" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Remember 🥝" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
    ].map(JSON.stringify).join("\n") + "\n");
    const db = fakeDb();
    const captures = [];
    let result;
    do {
      result = await ingestCliTranscript({
        db,
        client: "codex",
        sessionId: "codex:fixture",
        transcriptPath: file,
        cwd: home,
        repository: "fixture/repo",
        maxBytes: 32,
        capture: (artifacts) => captures.push(artifacts),
      });
    } while (result.pending);
    assert.equal(captures.at(-1).turns[0].user_message, "Remember 🥝");
    assert.equal(captures.at(-1).turns[0].assistant_response, "Done");
    assert.equal(JSON.stringify(db.getIngestionCheckpoint("codex", "codex:fixture").adapterState).includes("private"), false);
    assert.equal(db.getIngestionCheckpoint("codex", "codex:fixture").checkpointRevision > 1, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("large excluded prefixes stay bounded and unchanged turns keep their revision", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-ingestion-large-"));
  try {
    const file = path.join(home, "transcript.jsonl");
    const excluded = `${JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: "x".repeat(1024) } })}\n`;
    await writeFile(file, excluded.repeat(33_000) + [
      { type: "response_item", payload: { type: "message", role: "user", content: "first" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: "done" } },
    ].map(JSON.stringify).join("\n") + "\n");
    const db = fakeDb();
    const captures = [];
    let result;
    do {
      result = await ingestCliTranscript({
        db, client: "codex", sessionId: "codex:large", transcriptPath: file, cwd: home,
        repository: "fixture/repo", capture: (artifacts) => captures.push(artifacts),
      });
      assert.equal(result.checkpoint.offset <= result.checkpoint.adapterState.readerCheckpoint.sourceSize, true);
    } while (result.pending);
    const firstRevision = captures.at(-1).turns[0].source_revision;
    await writeFile(file, await readFile(file, "utf8")
      + `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "second" } })}\n`);
    const next = await ingestCliTranscript({
      db, client: "codex", sessionId: "codex:large", transcriptPath: file, cwd: home,
      repository: "fixture/repo", capture: (artifacts) => captures.push(artifacts),
    });
    assert.equal(next.pending, false);
    assert.equal(captures.at(-1).turns[0].source_revision, firstRevision);
    assert.equal(captures.at(-1).turns.at(-1).user_message, "second");
    assert.equal(db.getIngestionCheckpoint("codex", "codex:large").adapterState.processedRecordIds.length <= 4_096, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude branch replacement reports abandoned source records", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-ingestion-branch-"));
  try {
    const file = path.join(home, "transcript.jsonl");
    await writeFile(file, [
      { uuid: "u", parentUuid: null, type: "user", message: { role: "user", content: "question" } },
      { uuid: "a", parentUuid: "u", type: "assistant", message: { role: "assistant", content: "old answer" } },
    ].map(JSON.stringify).join("\n") + "\n");
    const db = fakeDb();
    const captures = [];
    await ingestCliTranscript({ db, client: "claude", sessionId: "claude:branch", transcriptPath: file, cwd: home, repository: "fixture/repo", capture: (a) => captures.push(a) });
    await writeFile(file, [
      { uuid: "u", parentUuid: null, type: "user", message: { role: "user", content: "question" } },
      { uuid: "b", parentUuid: "u", type: "assistant", message: { role: "assistant", content: "new answer" } },
    ].map(JSON.stringify).join("\n") + "\n");
    await ingestCliTranscript({ db, client: "claude", sessionId: "claude:branch", transcriptPath: file, cwd: home, repository: "fixture/repo", capture: (a) => captures.push(a) });
    assert.deepEqual(captures.at(-1).retiredSourceRecordIds.length > 0, true);
    assert.equal(captures.at(-1).turns.at(-1).assistant_response, "new answer");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stale checkpoint writers do not invoke capture", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-ingestion-stale-"));
  try {
    const file = path.join(home, "transcript.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "one" } })}\n`);
    const db = fakeDb();
    await ingestCliTranscript({ db, client: "codex", sessionId: "codex:stale", transcriptPath: file, cwd: home, repository: "fixture/repo" });
    await writeFile(file, await readFile(file, "utf8") + `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "two" } })}\n`);
    db.bumpBeforeSave = true;
    let captured = false;
    const result = await ingestCliTranscript({ db, client: "codex", sessionId: "codex:stale", transcriptPath: file, cwd: home, repository: "fixture/repo", capture: () => { captured = true; } });
    assert.equal(result.status, "stale");
    assert.equal(captured, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("assistant records retain independent identities and injected content is stripped", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-source-records-"));
  try {
    const file = path.join(home, "t.jsonl");
    const line = (role, content) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content } }) + "\n";
    await writeFile(file, line("user", "<lore_context>injected</lore_context> question") + line("assistant", "first answer"));
    const db = fakeDb();
    const args = { db, client: "codex", sessionId: "c", transcriptPath: file, cwd: home };
    await ingestCliTranscript(args);
    const first = structuredClone(db.getIngestionCheckpoint().adapterState.turns[0]);
    await writeFile(file, await readFile(file, "utf8") + line("assistant", "second answer"));
    await ingestCliTranscript(args);
    const next = db.getIngestionCheckpoint().adapterState.turns[0];
    assert.equal(next.user_message, "question");
    assert.equal(next.source_revision, first.source_revision, "assistant appends must not revise user evidence");
    assert.equal(next.assistant_source_records.length, 2);
    assert.deepEqual(next.assistant_source_records[0], first.assistant_source_records[0]);
    assert.equal(db.getIngestionCheckpoint().adapterState.sourcePath, file);
    assert.equal(db.getIngestionCheckpoint().adapterState.sourceCwd, home);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Antigravity updated and empty steps preserve correct source identities", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-step-revision-"));
  try {
    const file = path.join(home, "t.jsonl");
    const line = (step, content) => JSON.stringify({ step_index: step, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content }) + "\n";
    await writeFile(file, line(0, "old preference"));
    const db = fakeDb(); const args = { db, client: "antigravity", sessionId: "a", transcriptPath: file };
    await ingestCliTranscript(args);
    const oldId = db.getIngestionCheckpoint().adapterState.turns[0].source_record_id;
    await writeFile(file, await readFile(file, "utf8") + line(0, "new preference") + line(1, ""));
    const captures = [];
    await ingestCliTranscript({ ...args, capture: (a) => captures.push(a) });
    const turn = captures.at(-1).turns[0];
    assert.notEqual(turn.source_record_id, oldId);
    assert.equal(turn.step_index, 0);
    assert.equal(captures.at(-1).retiredSourceRecordIds.includes(oldId), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("long Claude branches retain their leaf without retiring window evictions", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-long-branch-"));
  try {
    const file = path.join(home, "t.jsonl");
    const line = (i) => JSON.stringify({ uuid: `u${i}`, parentUuid: i ? `u${i - 1}` : null, type: "user", message: { role: "user", content: `turn ${i}` } }) + "\n";
    await writeFile(file, Array.from({ length: 4_097 }, (_, i) => line(i)).join(""));
    const db = fakeDb(); const captures = [];
    const args = { db, client: "claude", sessionId: "c", transcriptPath: file, capture: (a) => captures.push(a) };
    let result;
    do { result = await ingestCliTranscript(args); } while (result.pending);
    assert.ok(db.getIngestionCheckpoint().adapterState.nodes.u4096);
    await writeFile(file, await readFile(file, "utf8") + line(4097));
    await ingestCliTranscript(args);
    assert.equal(captures.at(-1).turns.at(-1).user_message, "turn 4097");
    assert.equal(captures.flatMap((a) => a.retiredSourceRecordIds).length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("repeated assistant text remains bounded and excluded Claude records are resumable", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-state-budget-"));
  try {
    const file = path.join(home, "t.jsonl");
    const line = (role, content) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content } }) + "\n";
    await writeFile(file, line("user", "question") + line("assistant", "x".repeat(128 * 1024)).repeat(40));
    const db = fakeDb(); let result;
    do {
      result = await ingestCliTranscript({ db, client: "codex", sessionId: "c", transcriptPath: file });
      assert.ok(result.records <= 8);
      assert.ok(Buffer.byteLength(JSON.stringify(result.checkpoint.adapterState)) < 6 * 1024 * 1024);
    } while (result.pending);
    assert.ok(result.checkpoint.adapterState.turns[0].assistant_source_records.length <= 20);
    await writeFile(file, JSON.stringify({ type: "progress", data: "excluded" }) + "\n");
    const excluded = await ingestCliTranscript({ db: fakeDb(), client: "claude", sessionId: "x", transcriptPath: file });
    assert.equal(excluded.status, "captured");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("large revisions to earlier Antigravity steps are captured before window eviction", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-step-eviction-"));
  try {
    const file = path.join(home, "t.jsonl");
    const line = (step, content) => JSON.stringify({ step_index: step, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content }) + "\n";
    await writeFile(file, line(0, "first") + line(1, "second"));
    const db = fakeDb(); const args = { db, client: "antigravity", sessionId: "a", transcriptPath: file };
    await ingestCliTranscript(args);
    const revised = "background ".repeat(30_000) + "For this repository, I prefer focused unit tests.";
    await writeFile(file, await readFile(file, "utf8") + line(0, revised));
    const captured = [];
    await ingestCliTranscript({ ...args, capture: (a) => captured.push(a) });
    assert.ok(captured.at(-1).turns.some((turn) => turn.user_message === revised));
  } finally { await rm(home, { recursive: true, force: true }); }
});
