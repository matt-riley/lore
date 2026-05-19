import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { createTraceRecorder } from "../../lib/trace-recorder.mjs";

let traceHotspotsPromise = null;

async function loadTraceHotspots() {
  if (!traceHotspotsPromise) {
    const tracePath = "/Users/matthew.riley/.copilot/extensions/lore/lib/trace-recorder.mjs";
    const traceUrl = pathToFileURL(tracePath).href;
    const source = readFileSync(tracePath, "utf8")
      .replace(/from "\.\/data-utils\.mjs"/g, `from "${pathToFileURL("/Users/matthew.riley/.copilot/extensions/lore/lib/data-utils.mjs").href}"`)
      .replace("function buildTraceRecord(event, options, index) {", "export function buildTraceRecord(event, options, index) {")
      .replace("function normalizeRecorderOptions(config) {", "export function normalizeRecorderOptions(config) {");
    traceHotspotsPromise = import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=${traceUrl}\n`).toString("base64")}`);
  }
  return traceHotspotsPromise;
}

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

  test("falls back to the default durable sample rate when config is non-numeric", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0.2;
    try {
      const { normalizeRecorderOptions } = await loadTraceHotspots();
      const recorder = createTraceRecorder({
        rollout: {
          traceRecorder: true,
        },
        traceRecorder: {
          durableSampleRate: "not-a-number",
          persistDurableSample: true,
          maxPromptChars: 80,
          maxRowChars: 80,
          maxContextChars: 120,
        },
      });

      const result = recorder.record({
        hook: "onUserPromptSubmitted",
        prompt: "Remember the replay-failure ranking miss lane.",
        latencyMs: 12,
        trace: {
          mode: "memory_recall",
          output: {
            sectionTitles: [],
          },
        },
      });

      assert.equal(result.durableSelected, true);
      assert.equal(normalizeRecorderOptions({
        traceRecorder: {
          durableSampleRate: "not-a-number",
        },
      }).durableSampleRate, 0.25);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("buildTraceRecord falls back to trace-sourced repository and prompt need", async () => {
    const { buildTraceRecord } = await loadTraceHotspots();
    const record = buildTraceRecord({
      hook: "onUserPromptSubmitted",
      prompt: "How did we refactor the trace recorder follow-up lane for diagnostics ranking misses?",
      latencyMs: 19.8,
      contextText: "## Relevant Prior Work\n\n- Captured replay failure artifacts for diagnostics.",
      trace: {
        mode: "memory_recall",
        repository: "fixture-repo",
        promptNeed: {
          requiresLookup: true,
          wantsContinuity: true,
          allowCrossRepoFallback: false,
          directAddressed: true,
          seriousPrompt: false,
        },
        eligibility: {
          local: ["repo:fixture-repo"],
        },
        lookups: {
          workstreamOverlays: {
            includedRows: [{ summary: "Trace recorder cleanup lane", repository: "fixture-repo" }],
          },
        },
        output: {
          estimatedTokens: 17,
          sectionTitles: ["Relevant Prior Work"],
          sectionDetails: [
            {
              title: "Relevant Prior Work",
              source: "episode_digest",
              usedTokens: 12,
              budget: 60,
              entryCount: 1,
            },
          ],
        },
      },
    }, {
      maxPromptChars: 60,
      maxRowChars: 80,
      maxContextChars: 90,
      maxRowsPerLookup: 3,
      maxFilteredRowsPerLookup: 3,
    }, 7);

    assert.equal(record.id, "trace-7");
    assert.equal(record.mode, "memory_recall");
    assert.equal(record.repository, "fixture-repo");
    assert.deepEqual(record.promptNeed, {
      requiresLookup: true,
      wantsContinuity: true,
      wantsStyleContext: false,
      wantsCrossRepoExamples: false,
      wantsRepoLocalTaskContext: false,
      allowCrossRepoFallback: false,
      identityOnly: false,
      directAddressed: true,
      hasTemporalSignal: false,
      seriousPrompt: false,
    });
    assert.equal(record.routerDecision.route, "memory_recall");
    assert.equal(record.routerDecision.usedWorkstreamOverlays, true);
    assert.equal(record.output.contextInjected, true);
    assert.equal(record.output.sectionDetails[0].title, "Relevant Prior Work");
  });
});
