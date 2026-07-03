import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectAssistantIdentityDeclaration,
  detectAssistantIdentityName,
} from "../../lib/memory-scope.mjs";

// detectAssistantIdentityName is the loose, general-purpose detector used at
// prompt time (capsule-assembler.mjs, db.mjs) to recognize when the *current*
// prompt is greeting/addressing the assistant, so identity context can be
// retrieved. False positives here are cheap (worst case: an extra identity
// lookup), so it intentionally still matches greeting/vocative shapes.
describe("detectAssistantIdentityName", () => {
  test("matches explicit naming phrases", () => {
    assert.equal(detectAssistantIdentityName("Shall I call you Coda from now on?"), "Coda");
    assert.equal(detectAssistantIdentityName("Ok, call yourself Nova please."), "Nova");
    assert.equal(detectAssistantIdentityName("Your name is Juno now."), "Juno");
    assert.equal(detectAssistantIdentityName("Please use the name Zed for this."), "Zed");
    assert.equal(detectAssistantIdentityName("I used the name Axel in that doc."), "Axel");
    assert.equal(detectAssistantIdentityName("Why I used the name Vega is a long story."), "Vega");
  });

  test("still recognizes greeting-shaped direct address for prompt-time lookups", () => {
    // e.g. "Hi Jules, how are you?" - this is the exact shape diagnostics.mjs's
    // "identity-greeting" validation case exercises to decide whether to fetch
    // identity context for the current prompt.
    assert.equal(detectAssistantIdentityName("Hi Jules, how are you?"), "Jules");
    assert.equal(detectAssistantIdentityName("Coda, can you check this?"), "Coda");
  });

  test("returns null for text with no identity signal", () => {
    assert.equal(detectAssistantIdentityName(""), null);
    assert.equal(detectAssistantIdentityName("What patterns should we keep using for hotspot refactors?"), null);
  });
});

// detectAssistantIdentityDeclaration is the strict detector used only when
// *persisting* a new assistant_identity memory (rule-extractor.mjs, scanning
// historical messages). Only explicit naming vocabulary counts here.
describe("detectAssistantIdentityDeclaration", () => {
  test("matches explicit naming phrases", () => {
    assert.equal(detectAssistantIdentityDeclaration("Shall I call you Coda from now on?"), "Coda");
    assert.equal(detectAssistantIdentityDeclaration("Ok, call yourself Nova please."), "Nova");
    assert.equal(detectAssistantIdentityDeclaration("Your name is Juno now."), "Juno");
    assert.equal(detectAssistantIdentityDeclaration("Please use the name Zed for this."), "Zed");
    assert.equal(detectAssistantIdentityDeclaration("I used the name Axel in that doc."), "Axel");
    assert.equal(detectAssistantIdentityDeclaration("Why I used the name Vega is a long story."), "Vega");
  });

  test("does not treat sentence-initial interjections as a name", () => {
    // Regression coverage: detectAssistantIdentityName used to be the only
    // detector, and its bare vocative pattern
    // (`/^([a-z][a-z0-9_-]{2,20})[,:!?]\s/i`) fired on the first word of any
    // message followed by punctuation, producing garbage assistant_identity
    // memories ("Sorry", "Error", "Review", "E5108", "Nope", "Commit", ...).
    assert.equal(detectAssistantIdentityDeclaration("Sorry, spw-lead-scoring-response-transport can be ignored"), null);
    assert.equal(detectAssistantIdentityDeclaration("Error: something failed during the build"), null);
    assert.equal(detectAssistantIdentityDeclaration("Review: this branch and make sure it passes"), null);
    assert.equal(detectAssistantIdentityDeclaration("E5108: Lua error in nvim_exec2()"), null);
    assert.equal(detectAssistantIdentityDeclaration("Nope, that's not what I meant"), null);
    assert.equal(detectAssistantIdentityDeclaration("Commit: fix the flaky test"), null);
    assert.equal(detectAssistantIdentityDeclaration("Hiya! I would like to replace tpack with tpm"), null);
  });

  test("does not treat a casual greeting target as a name", () => {
    // Regression coverage: the old greeting pattern
    // (`/^(?:hi|hello|hey)\s+([a-z][a-z0-9_-]{2,20})(?:[!?,.\s]|$)/i`) matched
    // "Hey dude, ..." and produced an assistant_identity memory for "Dude".
    assert.equal(detectAssistantIdentityDeclaration("Hey dude, #902 has a comment about console.info logs"), null);
    assert.equal(detectAssistantIdentityDeclaration("Hi there, quick question about the release"), null);
    assert.equal(detectAssistantIdentityDeclaration("Hello team, status update below"), null);
  });

  test("returns null for text with no identity signal", () => {
    assert.equal(detectAssistantIdentityDeclaration(""), null);
    assert.equal(detectAssistantIdentityDeclaration("What patterns should we keep using for hotspot refactors?"), null);
  });

  test("still applies the stopword guard for explicit patterns", () => {
    assert.equal(detectAssistantIdentityDeclaration("Please use the name please for this"), null);
    assert.equal(detectAssistantIdentityDeclaration("Call yourself assistant from now on"), null);
  });
});
