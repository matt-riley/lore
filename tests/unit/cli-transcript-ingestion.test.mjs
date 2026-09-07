import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingestCliTranscript } from "../../lib/clients/cli-transcript-ingestion.mjs";

function fakeDb() {
  let checkpoint = null;
  return {
    getIngestionCheckpoint() { return checkpoint; },
    withSemanticMemoryTransaction(callback) { return callback(); },
    saveIngestionCheckpoint(_client, _sessionId, state) {
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
