import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { detectPromptContextNeed } from "../../lib/capsule-assembler.mjs";

const CAPSULE_ASSEMBLER_SOURCE = readFileSync(new URL("../../lib/capsule-assembler.mjs", import.meta.url), "utf8");

function findBalancedIndex(source, start, openChar, closeChar) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char !== closeChar) {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  throw new Error(`could not find closing ${closeChar} for ${openChar} at ${start}`);
}

function extractFunctionSource(name) {
  const markers = [`async function ${name}`, `function ${name}`];
  const start = markers
    .map((marker) => CAPSULE_ASSEMBLER_SOURCE.indexOf(marker))
    .find((index) => index !== -1);
  assert.notEqual(start, undefined, `expected ${name} to exist in capsule-assembler.mjs`);

  const paramsStart = CAPSULE_ASSEMBLER_SOURCE.indexOf("(", start);
  const paramsEnd = findBalancedIndex(CAPSULE_ASSEMBLER_SOURCE, paramsStart, "(", ")");
  const braceStart = CAPSULE_ASSEMBLER_SOURCE.indexOf("{", paramsEnd);
  const bodyEnd = findBalancedIndex(CAPSULE_ASSEMBLER_SOURCE, braceStart, "{", "}");
  return CAPSULE_ASSEMBLER_SOURCE.slice(start, bodyEnd + 1);
}

function loadPromptNeedFunctions(names) {
  const functionSources = names.map((name) => extractFunctionSource(name)).join("\n\n");
  return Function(`"use strict"; ${functionSources}; return { ${names.join(", ")} };`)();
}

describe("detectPromptContextNeed", () => {
  test("derivePromptNeedTemporalFlags keeps direct-address temporal prompts off the identity-only path", () => {
    const { derivePromptNeedTemporalFlags } = loadPromptNeedFunctions(["derivePromptNeedTemporalFlags"]);

    assert.deepStrictEqual(
      derivePromptNeedTemporalFlags({
        rawTemporalSignal: true,
        directAddressed: true,
        hasConsistencySignal: false,
        hasTransferSignal: false,
        contextualTaskTerms: [],
        wantsStyleContext: false,
      }),
      {
        hasTemporalSignal: false,
        identityOnly: true,
      },
    );

    assert.deepStrictEqual(
      derivePromptNeedTemporalFlags({
        rawTemporalSignal: true,
        directAddressed: true,
        hasConsistencySignal: false,
        hasTransferSignal: false,
        contextualTaskTerms: ["today"],
        wantsStyleContext: false,
      }),
      {
        hasTemporalSignal: true,
        identityOnly: false,
      },
    );
  });

  test("derivePromptNeedLookupFlags preserves repo-local and cross-repo routing decisions", () => {
    const { derivePromptNeedLookupFlags } = loadPromptNeedFunctions(["derivePromptNeedLookupFlags"]);

    assert.deepStrictEqual(
      derivePromptNeedLookupFlags({
        identityOnly: false,
        hasTemporalSignal: true,
        hasConsistencySignal: false,
        wantsCrossRepoExamples: false,
        contextualTaskTerms: [],
        explicitLocalTemporalScope: true,
      }),
      {
        wantsRepoLocalTaskContext: true,
        allowCrossRepoFallback: false,
      },
    );

    assert.deepStrictEqual(
      derivePromptNeedLookupFlags({
        identityOnly: true,
        hasTemporalSignal: false,
        hasConsistencySignal: false,
        wantsCrossRepoExamples: true,
        contextualTaskTerms: [],
        explicitLocalTemporalScope: false,
      }),
      {
        wantsRepoLocalTaskContext: false,
        allowCrossRepoFallback: true,
      },
    );
  });

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
