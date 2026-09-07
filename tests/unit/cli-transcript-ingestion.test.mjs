import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

