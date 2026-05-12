import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool } from "../helpers/tool-helpers.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function buildRuntime(db, config) {
  return {
    initialized: true,
    lastError: null,
    db,
    config,
    repository: "fixture-repo",
    sessionStore: null,
  };
}

describe("lore_reflect tool", () => {
  test("renders summary and full reflection detail levels with the expected sections", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });

    try {
      db.insertSemanticMemory({
        id: "reflect-pattern-1",
        type: "user_preference",
        content: "Prefer helper-driven report formatting for hotspot refactors.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["refactor"],
      });
      db.insertSemanticMemory({
        id: "reflect-pattern-2",
        type: "recurring_mistake",
        content: "Add targeted regression tests before splitting complex handlers.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["tests"],
      });

      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config),
      });
      const reflect = findTool(tools, "lore_reflect");

      const summaryOutput = await reflect.handler({
        prompt: "What patterns should we keep using for hotspot refactors?",
        detailLevel: "summary",
      }, {
        sessionId: "reflect-summary",
      });
      const fullOutput = await reflect.handler({
        prompt: "What patterns should we keep using for hotspot refactors?",
        detailLevel: "full",
      }, {
        sessionId: "reflect-full",
      });

      assert.match(summaryOutput, /## Reflection/);
      assert.match(summaryOutput, /## Key Insights/);
      assert.doesNotMatch(summaryOutput, /## Supporting Evidence/);
      assert.match(fullOutput, /## Supporting Evidence/);
      assert.match(fullOutput, /## Source Accounting/);
      assert.match(fullOutput, /## Lookup Coverage/);
    } finally {
      cleanup();
    }
  });

  test("rejects persisted observations when refreshable observations are disabled", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
          refreshableObservations: false,
        },
      },
    });

    try {
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config),
      });
      const output = await findTool(tools, "lore_reflect").handler({
        prompt: "Summarize current patterns.",
        persistObservation: true,
      }, {
        sessionId: "reflect-disabled-observation",
      });

      assert.equal(output, "refreshable observations rollout is disabled");
    } finally {
      cleanup();
    }
  });
});
