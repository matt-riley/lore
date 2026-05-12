import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildRecallEnvelope, reflectMemory } from "../../lib/memory-operations.mjs";

const TEST_CONFIG = {
  enabled: true,
  rollout: {
    memoryOperations: true,
    workstreamOverlays: true,
    directives: false,
  },
};

function buildReflectDb({ overlays = [] } = {}) {
  return {
    config: TEST_CONFIG,
    explainPromptContext() {
      return {
        text: "",
        trace: {
          lookups: {},
          output: {
            sectionTitles: [],
            sectionDetails: [],
          },
        },
      };
    },
    searchSemantic({ types = [] } = {}) {
      return types.includes("workstream_overlay") ? overlays : [];
    },
  };
}

function makeWorkstreamRow() {
  return {
    id: "overlay-1",
    type: "workstream_overlay",
    repository: "fixture-repo",
    updated_at: "2024-05-01T00:00:00.000Z",
    content: "Hotspot cleanup workstream",
    metadata: {
      title: "Hotspot cleanup",
      mission: "Stabilize the hotspot cleanup",
      objective: "Reduce the remaining audit noise",
      constraints: ["Keep output stable"],
      blockers: ["Pending recall split"],
      nextActions: ["Refactor the envelope helper"],
      decisions: ["Avoid broad suppressions"],
      reflectPriorities: ["Preserve lookup ordering"],
      status: "active",
    },
  };
}

describe("memory-operations hotspot coverage", () => {
  test("buildRecallEnvelope keeps filtered-reason summaries and deduped supporting facts stable", () => {
    const envelope = buildRecallEnvelope({
      repository: "fixture-repo",
      estimatedTokens: 42,
      text: "Context",
      overlays: [],
      trace: {
        lookups: {
          localEpisodes: {
            enabled: true,
            reason: "included_match",
            rows: [{ summary: "Past fix" }],
            includedRows: [{ summary: "Past fix" }],
            rankedRows: [{ summary: "Past fix" }],
            filtered: [{ reason: "cutoff" }, { reason: "cutoff" }],
          },
          recentTurns: {
            enabled: true,
            reason: "fallback",
            rows: [{ summary: "Past fix" }],
            includedRows: [{ summary: "Past fix" }],
            rankedRows: [],
            filtered: [{ reason: "scope" }],
          },
        },
        output: {
          sectionTitles: ["Relevant Knowledge"],
          sectionDetails: [
            {
              title: "Relevant Knowledge",
              source: "localEpisodes",
              budget: 120,
              usedTokens: 60,
              entryCount: 2,
            },
          ],
        },
      },
    });

    assert.deepEqual(envelope.supportingFacts, ["Past fix"]);
    assert.deepEqual(
      envelope.lookups.map((lookup) => lookup.filteredReasons),
      [["cutoff x2"], ["scope x1"]],
    );
  });

  test("reflectMemory preserves workstream ranking semantics for mixed scalar and list entries", () => {
    const reflection = reflectMemory({
      db: buildReflectDb({ overlays: [makeWorkstreamRow()] }),
      prompt: "What's next for the workstream?",
      repository: "fixture-repo",
      focus: "summary",
    });

    assert.deepEqual(
      reflection.insights.map((entry) => entry.text),
      [
        "Avoid broad suppressions",
        "Hotspot cleanup workstream",
        "Keep output stable",
        "Pending recall split",
      ],
    );
  });
});
