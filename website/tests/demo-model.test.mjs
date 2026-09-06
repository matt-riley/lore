import assert from "node:assert/strict";
import test from "node:test";
import {
  createSession,
  retrievalExample,
  scopeMemories,
  transitionSession,
} from "../src/scripts/demo-model.mjs";

test("creates the draft session shown by the demo", () => {
  assert.deepEqual(createSession(), {
    phase: "draft",
    draft: "Use pnpm for package scripts.",
    memory: null,
    session: 1,
  });
});

test("edits the draft with trimmed content capped at 160 characters", () => {
  const edited = transitionSession(createSession(), "edit", "  Keep the local setup.  ");
  assert.equal(edited.draft, "Keep the local setup.");
  assert.equal(edited.phase, "draft");
  assert.equal(edited.memory, null);

  const long = transitionSession(createSession(), "edit", "x".repeat(200));
  assert.equal(long.draft.length, 160);
});

test("saves only non-empty trimmed draft content", () => {
  const saved = transitionSession(createSession(), "save");
  assert.equal(saved.phase, "saved");
  assert.deepEqual(saved.memory, {
    content: "Use pnpm for package scripts.",
    scope: "repo",
    repository: "demo/orchard",
    type: "user_preference",
  });

  const blank = transitionSession(transitionSession(createSession(), "edit", "  "), "save");
  assert.deepEqual(blank, transitionSession(createSession(), "edit", "  "));
});

test("requires the session ordering and keeps memory across a new session", () => {
  const saved = transitionSession(createSession(), "save");
  assert.deepEqual(transitionSession(createSession(), "next"), createSession());
  const next = transitionSession(saved, "next");
  assert.equal(next.phase, "new-session");
  assert.equal(next.session, 2);
  assert.deepEqual(next.memory, saved.memory);
  assert.equal(transitionSession(next, "recall").phase, "recalled");
});

test("invalid transitions leave state unchanged and reset restores defaults", () => {
  const saved = transitionSession(createSession(), "save");
  assert.deepEqual(transitionSession(createSession(), "recall"), createSession());
  assert.deepEqual(transitionSession(saved, "edit", "changed").memory, saved.memory);
  assert.deepEqual(transitionSession(saved, "reset"), createSession());
});

test("scope examples keep global memories eligible and repository memories isolated", () => {
  const orchard = scopeMemories("demo/orchard");
  const atlas = scopeMemories("demo/atlas");
  assert.equal(orchard.find((memory) => memory.id === "global-preference").eligible, true);
  assert.equal(orchard.find((memory) => memory.id === "orchard-sqlite").eligible, true);
  assert.equal(atlas.find((memory) => memory.id === "orchard-sqlite").eligible, false);
  assert.match(atlas.find((memory) => memory.id === "orchard-sqlite").reason, /repository/i);
  assert.equal(atlas.find((memory) => memory.id === "atlas-postgres").eligible, true);
});

test("retrieval examples show semantic augmentation and offline fallback", () => {
  const keyword = retrievalExample("keyword");
  assert.deepEqual(keyword.lexical, ["The database runs locally in SQLite."]);
  assert.deepEqual(keyword.semantic, []);
  assert.match(keyword.explanation, /keyword/i);

  const semantic = retrievalExample("semantic");
  assert.deepEqual(semantic.semantic, ["Keep project data on this machine; no hosted storage."]);

  const offline = retrievalExample("offline");
  assert.deepEqual(offline.lexical, keyword.lexical);
  assert.deepEqual(offline.semantic, []);
  assert.match(offline.explanation, /endpoint unavailable/i);
});
