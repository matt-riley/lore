import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool } from "../helpers/tool-helpers.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function buildRuntime(db, config, overrides = {}) {
  return {
    initialized: true,
    lastError: null,
    db,
    config,
    repository: "fixture-repo",
    sessionStore: null,
    ...overrides,
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

  test("persists a refreshable observation when rollout is enabled", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
          memoryDomains: true,
          refreshableObservations: true,
        },
      },
    });

    try {
      db.insertSemanticMemory({
        id: "reflect-observation-seed",
        type: "user_preference",
        content: "Prefer helper-driven report formatting for hotspot refactors.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["refactor"],
      });

      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config),
      });
      const output = await findTool(tools, "lore_reflect").handler({
        prompt: "What patterns should we keep using for hotspot refactors?",
        focus: "patterns",
        persistObservation: true,
        observationKey: "reflect-tool-test-observation",
      }, {
        sessionId: "reflect-persist-observation",
      });

      assert.match(output, /Saved observation reflect-tool-test-observation\./);

      const observation = db.getObservation("reflect-tool-test-observation");
      assert.ok(observation, "expected the observation row to be persisted");
      assert.equal(observation.title, "Patterns reflection");
      assert.equal(observation.focus, "patterns");
      assert.ok(observation.summary.length > 0);
    } finally {
      cleanup();
    }
  });

  test("surfaces recent session evidence and trace metadata when lookbackHours is set", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
          memoryDomains: true,
          refreshableObservations: true,
        },
      },
    });

    try {
      const findSessionsSinceCalls = [];
      const sessionStore = {
        findRelevantSessions() {
          return [];
        },
        findSessionsSince(args) {
          findSessionsSinceCalls.push(args);
          return [
            {
              session_id: "session-recent-1",
              repository: "fixture-repo",
              branch: "main",
              summary: "Fixed the reflect tool lookback bug end to end.",
              created_at: "2026-07-03T08:00:00.000Z",
              updated_at: "2026-07-03T11:00:00.000Z",
              workspaceSummary: null,
            },
          ];
        },
      };

      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, { sessionStore }),
      });
      const reflect = findTool(tools, "lore_reflect");

      const output = await reflect.handler({
        prompt: "Analyze the last day of activity across repos and summarize my patterns and preferences.",
        focus: "patterns",
        detailLevel: "full",
        lookbackHours: 24,
        persistObservation: true,
        observationKey: "reflect-tool-lookback-observation",
      }, {
        sessionId: "reflect-lookback",
      });

      assert.equal(findSessionsSinceCalls.length, 1);
      assert.equal(findSessionsSinceCalls[0].repository, "fixture-repo");
      assert.match(findSessionsSinceCalls[0].sinceIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      assert.match(output, /lookbackHours: 24 \(sessions found: 1\)/);
      assert.match(output, /Fixed the reflect tool lookback bug end to end\./);

      const observation = db.getObservation("reflect-tool-lookback-observation");
      assert.ok(observation, "expected the observation row to be persisted");
      assert.equal(observation.trace?.lookbackHours, 24);
      assert.equal(observation.trace?.recentSessionCount, 1);
    } finally {
      cleanup();
    }
  });

  test("reports zero recent sessions gracefully when no sessionStore is available", { skip: SKIP_NO_FTS5 }, async () => {
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
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, { sessionStore: null }),
      });
      const reflect = findTool(tools, "lore_reflect");

      const output = await reflect.handler({
        prompt: "Analyze the last day of activity across repos and summarize my patterns and preferences.",
        focus: "patterns",
        lookbackHours: 24,
      }, {
        sessionId: "reflect-lookback-no-store",
      });

      assert.match(output, /lookbackHours: 24 \(sessions found: 0\)/);
    } finally {
      cleanup();
    }
  });

  test("clamps out-of-range lookbackHours and ignores non-positive values", { skip: SKIP_NO_FTS5 }, async () => {
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
      const sinceIsoCalls = [];
      const sessionStore = {
        findRelevantSessions() {
          return [];
        },
        findSessionsSince({ sinceIso }) {
          sinceIsoCalls.push(sinceIso);
          return [];
        },
      };
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, { sessionStore }),
      });
      const reflect = findTool(tools, "lore_reflect");

      const overLimitOutput = await reflect.handler({
        prompt: "Analyze the last month of activity across repos and summarize my patterns.",
        focus: "patterns",
        lookbackHours: 10000,
      }, {
        sessionId: "reflect-lookback-clamped",
      });
      assert.match(overLimitOutput, /lookbackHours: 720 \(sessions found: 0\)/);

      const zeroOutput = await reflect.handler({
        prompt: "Summarize current patterns.",
        focus: "patterns",
        lookbackHours: 0,
      }, {
        sessionId: "reflect-lookback-zero",
      });
      assert.doesNotMatch(zeroOutput, /lookbackHours:/);
      assert.equal(sinceIsoCalls.length, 1, "findSessionsSince should only run for the valid lookbackHours request");
    } finally {
      cleanup();
    }
  });
});
