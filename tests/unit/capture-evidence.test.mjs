import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freshDb } from "../helpers/fixture-db.mjs";
import { enabledConfig } from "../helpers/fixture-config.mjs";
import { ingestCliTranscript } from "../../lib/clients/cli-transcript-ingestion.mjs";
import { extractSessionMemories } from "../../lib/sessions/rule-extractor.mjs";
import { applySessionExtraction } from "../../lib/sessions/backfill.mjs";
import { reconcileCaptureEvidence } from "../../lib/clients/cli-capture-evidence.mjs";

async function fixture(client, fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-capture-evidence-"));
  const config = enabledConfig(home); const db = freshDb(config);
  const file = path.join(home, "t.jsonl"); const sessionId = `${client}:fixture`;
  const run = () => ingestCliTranscript({ db, client, sessionId, transcriptPath: file, cwd: home,
    repository: "fixture/repo", capture: (artifacts) => {
      const workspace = { workspace: { repository: "fixture/repo" } };
      const extraction = extractSessionMemories({ sessionId, repository: "fixture/repo", sessionArtifacts: artifacts, workspace, config });
      const state = reconcileCaptureEvidence({ db, sessionId, artifacts, extraction });
      applySessionExtraction({ db, sessionId, repository: "fixture/repo", sessionArtifacts: artifacts, workspace, extraction });
      return state;
    } });
  const active = () => db.db.prepare("SELECT sm.content FROM semantic_memory sm JOIN memory_evidence me ON me.memory_id=sm.id JOIN session_evidence se ON se.evidence_key=me.evidence_key WHERE me.retired_at IS NULL AND se.retired_at IS NULL").all().map((r) => r.content);
  try { await fn({ db, file, run, active }); } finally { db.close(); await rm(home, { recursive: true, force: true }); }
}
const codex = (text) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: text } }) + "\n";
const claude = (uuid, parentUuid, role, text) => JSON.stringify({ uuid, parentUuid, type: role, message: { role, content: text } }) + "\n";

test("ordinary append keeps prior evidence and rewritten sources retire only after bounded rescan", async () => {
  await fixture("codex", async ({ file, run, active }) => {
    const prefix = Array.from({ length: 16 }, (_, i) => codex(`unrelated message ${i}`)).join("");
    await writeFile(file, prefix + codex("For this repository, I prefer focused unit tests."));
    while ((await run()).pending) {}
    await appendFile(file, codex("Thank you.")); await run();
    assert.ok(active().some((text) => text.includes("focused unit tests")));
    await writeFile(file, Array.from({ length: 18 }, (_, i) => codex(`unrelated message ${i}`)).join(""));
    const first = await run(); assert.equal(first.pending, true);
    assert.ok(active().some((text) => text.includes("focused unit tests")), "unseen old evidence survives incomplete rescan");
    let next; do { next = await run(); } while (next.pending);
    assert.equal(active().some((text) => text.includes("focused unit tests")), false);
  });
});

test("Claude assistant branch replacement retires only the abandoned answer", async () => {
  await fixture("claude", async ({ file, run, active }) => {
    await writeFile(file, claude("u", null, "user", "For this repository, I prefer focused unit tests.")
      + claude("a", "u", "assistant", "We decided to use PostgreSQL because we need concurrent writers."));
    await run();
    assert.ok(active().some((text) => text.includes("PostgreSQL")));
    await appendFile(file, claude("b", "u", "assistant", "We decided to use SQLite because we need simple embedded storage."));
    await run();
    assert.equal(active().some((text) => text.includes("PostgreSQL")), false);
    assert.ok(active().some((text) => text.includes("SQLite")));
    assert.ok(active().some((text) => text.includes("focused unit tests")));
  });
});

test("Claude branch retirement reaches evidence older than the rolling turn window", async () => {
  await fixture("claude", async ({ file, run, active }) => {
    const entries = [claude("u0", null, "user", "For this repository, I prefer small pure functions.")];
    for (let i = 1; i <= 200; i += 1) entries.push(claude(`u${i}`, `u${i - 1}`, "user", i === 1 ? "For this repository, I prefer focused unit tests." : `ordinary message ${i}`));
    await writeFile(file, entries.join(""));
    while ((await run()).pending) {}
    assert.ok(active().some((text) => text.includes("focused unit tests")));
    await appendFile(file, claude("alternate", "u0", "assistant", "We decided to use SQLite because we need simple embedded storage."));
    while ((await run()).pending) {}
    assert.equal(active().some((text) => text.includes("focused unit tests")), false);
    assert.ok(active().some((text) => text.includes("small pure functions")));
  });
});
