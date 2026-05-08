import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createTraceRecorder } from "../../lib/trace-recorder.mjs";

function buildRecorder() {
  return createTraceRecorder({
    rollout: {
      traceRecorder: true,
    },
    traceRecorder: {
      durableSampleRate: 1,
      maxPromptChars: 80,
      maxRowChars: 80,
      maxContextChars: 120,
    },
  });
}

describe("createTraceRecorder", () => {
  test("records fallback router decisions and compact lookup payloads", () => {
    const recorder = buildRecorder();
    const result = recorder.record({
      hook: "onSessionStart",
      prompt: "What did we do for the diagnostics follow-up?",
      repository: "fixture-repo",
      latencyMs: 18.4,
      contextText: "## Recent Related Work\n\n- Added regression coverage for diagnostics rendering.",
      promptNeed: {
        requiresLookup: true,
        wantsContinuity: true,
        allowCrossRepoFallback: true,
        identityOnly: false,
      },
      trace: {
        mode: "legacy_prompt_context",
        eligibility: {
          local: ["repo:fixture-repo"],
          crossRepo: ["transferable"],
        },
        lookups: {
          localEpisodes: {
            query: "diagnostics rendering",
            scopes: ["repo"],
            eligibleScopes: ["repo:fixture-repo"],
            rows: [{ summary: "Added regression coverage for diagnostics rendering.", repository: "fixture-repo" }],
            includedRows: [{ summary: "Added regression coverage for diagnostics rendering.", repository: "fixture-repo" }],
            filtered: [{ stage: "rank", reason: "cutoff", row: { text: "Older diagnostics note" } }],
          },
        },
        output: {
          estimatedTokens: 23,
          sectionTitles: ["Recent Related Work"],
          sectionDetails: [
            {
              title: "Recent Related Work",
              source: "episode_digest",
              usedTokens: 14,
              budget: 80,
              entryCount: 1,
            },
          ],
        },
        omissions: [{ stage: "style", reason: "suppressed_for_temporal_prompt" }],
      },
    });

    assert.equal(result.durableSelected, true);
    const [record] = recorder.getRecent(1);
    assert.equal(record.routerDecision.route, "session_start_capsule");
    assert.equal(record.routerDecision.includeOtherRepositories, true);
    assert.deepEqual(record.eligibility.local, ["repo:fixture-repo"]);
    assert.equal(record.lookups.localEpisodes.matchedCount, 1);
    assert.equal(record.lookups.localEpisodes.includedCount, 1);
    assert.equal(record.lookups.localEpisodes.droppedCount, 1);
    assert.equal(record.output.contextInjected, true);
    assert.equal(record.output.sectionTitles[0], "Recent Related Work");
    assert.equal(record.omissions[0].reason, "suppressed_for_temporal_prompt");
  });

  test("uses hook-specific fallback routing and truncates prompt previews", () => {
    const recorder = buildRecorder();
    recorder.record({
      hook: "onUserPromptSubmitted",
      prompt: "x".repeat(120),
      repository: null,
      latencyMs: 11,
      trace: {
        mode: "memory_recall",
        output: {
          sectionTitles: [],
        },
      },
    });

    const [record] = recorder.getRecent(1);
    assert.equal(record.routerDecision.route, "memory_recall");
    assert.equal(record.output.contextInjected, false);
    assert.equal(record.repository, null);
    assert.match(record.promptPreview, /…$/);
    assert.equal(record.promptPreview.length <= 80, true);
  });
});
