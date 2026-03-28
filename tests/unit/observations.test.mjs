import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildRefreshableObservation, OBSERVATION_STATUS } from "../../lib/observations.mjs";

describe("buildRefreshableObservation", () => {
  test("normalizes observation metadata and bounds freshness/confidence", () => {
    const observation = buildRefreshableObservation({
      observationKey: "  Repo:Summary  ",
      domainKey: " Repo:Core ",
      title: " Summary Snapshot ",
      prompt: "What matters here?",
      focus: "patterns",
      summary: "Lore keeps choosing local-first changes.",
      confidence: 2,
      repository: " mattriley/lore ",
      scope: "repo",
      freshnessHours: 999999,
      source: "lore_reflect",
      trace: { sectionCount: 3 },
      metadata: { detailLevel: "summary" },
      status: OBSERVATION_STATUS.CURRENT,
    });

    assert.deepEqual(observation, {
      observationKey: "repo:summary",
      domainKey: "repo:core",
      title: "Summary Snapshot",
      prompt: "What matters here?",
      focus: "patterns",
      summary: "Lore keeps choosing local-first changes.",
      confidence: 1,
      repository: "mattriley/lore",
      scope: "repo",
      freshnessHours: 24 * 365,
      source: "lore_reflect",
      trace: { sectionCount: 3 },
      metadata: { detailLevel: "summary" },
      status: "current",
    });
  });

  test("returns null when summary sanitizes away", () => {
    assert.equal(buildRefreshableObservation({ summary: "   " }), null);
  });
});
