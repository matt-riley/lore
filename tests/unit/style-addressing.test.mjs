import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildStyleAddressingSection } from "../../lib/style-addressing.mjs";

function renderSemantic(row) {
  return row.content;
}

describe("buildStyleAddressingSection", () => {
  test("returns empty text when ambient persona is suppressed for temporal prompts", () => {
    const result = buildStyleAddressingSection({
      prompt: "What did we do last Thursday?",
      promptNeed: {
        wantsStyleContext: false,
        identityOnly: false,
        seriousPrompt: false,
        hasTemporalSignal: true,
      },
      config: {
        rollout: {
          ambientPersonaMode: true,
        },
      },
      assistantPersonaRows: [
        {
          type: "interaction_style",
          content: "Use a collaborative tone.",
        },
      ],
      relationshipPreferenceRows: [],
      renderSemantic,
    });

    assert.equal(result.text, "");
    assert.equal(result.trace.enabled, false);
    assert.equal(result.trace.includeAmbient, false);
    assert.equal(result.trace.reason, "ambient_suppressed_for_serious_or_temporal_prompt");
  });

  test("renders ambient style and addressing guidance when enabled", () => {
    const result = buildStyleAddressingSection({
      prompt: "Continue with the memory rollout.",
      promptNeed: {
        wantsStyleContext: false,
        identityOnly: false,
        seriousPrompt: false,
        hasTemporalSignal: false,
        suppressHumor: false,
      },
      config: {
        rollout: {
          ambientPersonaMode: true,
        },
      },
      assistantPersonaRows: [
        {
          type: "interaction_style",
          content: "Use a conversational teammate-like tone.",
          metadata: {
            profile: {
              voice: "colleague",
              warmth: "warm",
              humor: "light",
              humorFrequency: "occasional",
              collaborative: true,
              useNameNaturally: true,
            },
          },
        },
      ],
      relationshipPreferenceRows: [
        {
          type: "user_identity",
          content: "The user's preferred name is Matt.",
        },
      ],
      renderSemantic,
    });

    assert.match(result.text, /## Response Style And Addressing/);
    assert.match(result.text, /Use a warm, collaborative, colleague-like tone/);
    assert.match(result.text, /Light humor is fine when it fits/);
    assert.match(result.text, /Address the user as Matt naturally/);
    assert.match(result.text, /Keep name use natural and sparse/);
    assert.equal(result.trace.enabled, true);
    assert.equal(result.trace.includeAmbient, true);
    assert.equal(result.trace.reason, "included");
  });

  test("renders prompt-local overrides without ambient persona lines", () => {
    const result = buildStyleAddressingSection({
      prompt: "Call me Matt and be more concise.",
      promptNeed: {
        wantsStyleContext: false,
        identityOnly: false,
        seriousPrompt: false,
        hasTemporalSignal: false,
      },
      config: {
        rollout: {
          ambientPersonaMode: true,
        },
      },
      assistantPersonaRows: [],
      relationshipPreferenceRows: [],
      renderSemantic,
    });

    assert.match(result.text, /- Prompt-local overrides:/);
    assert.match(result.text, /Address the user as "Matt" for this prompt\./);
    assert.match(result.text, /be more concise\./);
    assert.doesNotMatch(result.text, /Use a conversational, teammate-like tone/);
    assert.equal(result.trace.promptLocal.hasOverride, true);
    assert.equal(result.trace.includeAmbient, false);
  });
});
