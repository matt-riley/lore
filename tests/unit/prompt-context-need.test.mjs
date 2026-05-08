import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { detectPromptContextNeed } from "../../lib/capsule-assembler.mjs";

describe("detectPromptContextNeed", () => {
  test("keeps direct-address greetings on the identity-only path", () => {
    const result = detectPromptContextNeed("Hi Coda!");

    assert.equal(result.directAddressed, true);
    assert.equal(result.identityOnly, true);
    assert.equal(result.hasTemporalSignal, false);
    assert.equal(result.wantsRepoLocalTaskContext, false);
    assert.equal(result.allowCrossRepoFallback, false);
  });

  test("preserves explicit local temporal scope without cross-repo fallback", () => {
    const result = detectPromptContextNeed("What did we do last Thursday in this repo?");

    assert.equal(result.hasTemporalSignal, true);
    assert.equal(result.wantsRepoLocalTaskContext, true);
    assert.equal(result.allowCrossRepoFallback, false);
    assert.equal(result.identityOnly, false);
  });

  test("keeps temporal recall active when a direct-address prompt also asks about today", () => {
    const result = detectPromptContextNeed("Hi Coda, today.");

    assert.equal(result.directAddressed, true);
    assert.equal(result.hasTemporalSignal, true);
    assert.equal(result.identityOnly, false);
    assert.equal(result.allowCrossRepoFallback, true);
  });

  test("recognizes cross-repo example requests as transfer lookups", () => {
    const result = detectPromptContextNeed("Show me an example from another repo so we can reuse that pattern.");

    assert.equal(result.wantsCrossRepoExamples, true);
    assert.equal(result.allowCrossRepoFallback, true);
    assert.equal(result.requiresLookup, true);
    assert.equal(result.identityOnly, false);
  });
});
