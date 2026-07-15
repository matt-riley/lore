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
  test("uses local inference and embeddings only with explicit per-call opt-in", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          embeddings: {
            enabled: true,
            model: "local-embedding-model",
          },
        },
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
        id: "reflect-local-inference-seed",
        type: "decision",
        content: "Keep local inference disabled unless a surface opts in.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["local-inference"],
      });
      db.insertSemanticMemory({
        id: "reflect-local-inference-override",
        type: "decision",
        content: "Explicit per-call local inference overrides take precedence over persistent defaults.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["local-inference"],
      });
      db.upsertEpisodeDigest({
        id: "reflect-local-inference-episode",
        sessionId: "reflect-local-inference-source",
        repository: "fixture-repo",
        summary: "Designed the local inference opt-in contract.",
        actions: ["Added explicit provider and tool gates."],
        decisions: ["Keep local inference disabled unless a surface opts in."],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 8,
        themes: ["local-inference"],
        openItems: [],
        dateKey: "2026-07-14",
        createdAt: "2026-07-14T12:00:00.000Z",
      });
      db.upsertEpisodeDigest({
        id: "reflect-local-inference-override-episode",
        sessionId: "reflect-local-inference-override-source",
        repository: "fixture-repo",
        summary: "Confirmed explicit reflection overrides take precedence.",
        actions: [],
        decisions: ["Explicit per-call local inference overrides take precedence over persistent defaults."],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 8,
        themes: ["local-inference"],
        openItems: [],
        dateKey: "2026-07-15",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
      const requestUrls = [];
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, {
          localInferenceFetch: async (url, init) => {
            requestUrls.push(url);
            const body = JSON.parse(init.body);
            if (url.endsWith("/embeddings")) {
              return new Response(JSON.stringify({
                data: body.input.map((_, index) => ({
                  index,
                  embedding: index === 0 ? [1, 0] : [0.8, 0.2],
                })),
              }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify({
                    summary: "Local inference confirms that model-backed behavior must stay explicitly opted in.",
                    insights: [{
                      text: "Require both provider configuration and a per-call reflection opt-in.",
                      evidenceIndex: 0,
                    }],
                   consolidations: [{
                     text: "The provider and tool gates form one local-inference safety policy.",
                     evidenceIndexes: [0, 1],
                   }],
                   contradictions: [{
                     text: "Persistent defaults remain subordinate to explicit per-call overrides.",
                     evidenceIndexes: [0, 1],
                   }],
                   trends: [{
                     text: "Local-inference work repeatedly preserved explicit safety gates.",
                     evidenceIndexes: [0, 1],
                     occurrences: 2,
                   }],
                  }),
                },
              }],
            }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      });

      const output = await findTool(tools, "lore_reflect").handler({
        prompt: "local inference",
        focus: "decisions",
        useLocalInference: true,
        persistObservation: true,
        observationKey: "reflect-local-inference-observation",
      }, {
        sessionId: "reflect-local-inference",
      });

      assert.equal(requestUrls.filter((url) => url.endsWith("/embeddings")).length, 3);
      assert.equal(requestUrls.filter((url) => url.endsWith("/chat/completions")).length, 1);
      assert.match(output, /localInference: used \(embeddings: used\)/);
      assert.match(
        output,
        /localInferenceGrounding: candidates=\d+ selected=\d+ grounded=1 discarded=0 summary=grounded/,
      );
      assert.match(output, /Local inference confirms that model-backed behavior must stay explicitly opted in\./);
      assert.match(output, /## Memory Consolidation Proposals/);
      assert.match(output, /## Contradictions And Possible Supersessions/);
      assert.match(output, /## Recurring Trends/);
      assert.match(
        output,
        /localInferenceAnalysis: consolidations=1 contradictions=1 trends=1 grounded=3 discarded=0/,
      );

      const observation = db.getObservation("reflect-local-inference-observation");
      assert.equal(
        observation.summary,
        "Local inference confirms that model-backed behavior must stay explicitly opted in.",
      );
      assert.equal(observation.trace?.localInferenceUsed, true);
      assert.equal(observation.trace?.localEmbeddingsUsed, true);
    } finally {
      cleanup();
    }
  });

  test("reports quality diagnostics when configured evaluation accepts generated reflection", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          analysis: {
            qualityEvaluation: {
              enabled: true,
              minSupport: 0.8,
              minSpecificity: 0.6,
              minUsefulness: 0.6,
            },
          },
        },
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });

    try {
      db.insertSemanticMemory({
        id: "reflect-quality-success",
        type: "decision",
        content: "Keep reflection claims specific and evidence-backed.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["quality"],
      });
      db.upsertEpisodeDigest({
        id: "reflect-quality-success-episode",
        sessionId: "reflect-quality-success-source",
        repository: "fixture-repo",
        summary: "Adopted an evidence-backed reflection quality rule.",
        actions: [],
        decisions: ["Keep reflection claims specific and evidence-backed."],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 8,
        themes: ["quality"],
        openItems: [],
        dateKey: "2026-07-15",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
      let requestCount = 0;
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, {
          localInferenceFetch: async (_url, init) => {
            requestCount += 1;
            const body = JSON.parse(init.body);
            if (body.messages[0].content.includes("evaluate Lore reflection output")) {
              return new Response(JSON.stringify({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      items: [
                        { id: "summary", support: 0.95, specificity: 0.9, usefulness: 0.9 },
                        { id: "insight:0", support: 0.95, specificity: 0.9, usefulness: 0.9 },
                      ],
                    }),
                  },
                }],
              }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify({
                    summary: "Reflection quality stayed evidence-backed.",
                    insights: [{
                      text: "Keep generated claims specific and evidence-backed.",
                      evidenceIndex: 0,
                    }],
                  }),
                },
              }],
            }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      });

      const output = await findTool(tools, "lore_reflect").handler({
        prompt: "reflection claims specific evidence backed",
        focus: "decisions",
        useLocalInference: true,
      }, {
        sessionId: "reflect-quality-success",
      });

      assert.equal(requestCount, 2, output);
      assert.match(output, /Reflection quality stayed evidence-backed\./);
      assert.match(output, /localInferenceQuality: used accepted=2 rejected=0/);
    } finally {
      cleanup();
    }
  });

  test("falls back to deterministic reflection when quality evaluation rejects every insight", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          analysis: {
            qualityEvaluation: {
              enabled: true,
              minSupport: 0.8,
              minSpecificity: 0.6,
              minUsefulness: 0.6,
            },
          },
        },
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });

    try {
      db.insertSemanticMemory({
        id: "reflect-quality-fallback",
        type: "decision",
        content: "Preserve deterministic reflection when generated quality is too low.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["quality"],
      });
      db.upsertEpisodeDigest({
        id: "reflect-quality-fallback-episode",
        sessionId: "reflect-quality-fallback-source",
        repository: "fixture-repo",
        summary: "Defined deterministic fallback for low-quality generated reflection.",
        actions: [],
        decisions: ["Preserve deterministic reflection when generated quality is too low."],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 8,
        themes: ["quality"],
        openItems: [],
        dateKey: "2026-07-15",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
      let requestCount = 0;
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, {
          localInferenceFetch: async (_url, init) => {
            requestCount += 1;
            const body = JSON.parse(init.body);
            if (body.messages[0].content.includes("evaluate Lore reflection output")) {
              return new Response(JSON.stringify({
                choices: [{
                  message: {
                    content: JSON.stringify({
                      items: [
                        { id: "summary", support: 0.2, specificity: 0.2, usefulness: 0.2 },
                        { id: "insight:0", support: 0.2, specificity: 0.2, usefulness: 0.2 },
                      ],
                    }),
                  },
                }],
              }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify({
                    summary: "This generated summary must be rejected.",
                    insights: [{
                      text: "This generated insight must be rejected.",
                      evidenceIndex: 0,
                    }],
                  }),
                },
              }],
            }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      });

      const output = await findTool(tools, "lore_reflect").handler({
        prompt: "deterministic reflection generated quality low",
        focus: "decisions",
        useLocalInference: true,
      }, {
        sessionId: "reflect-quality-fallback",
      });

      assert.equal(requestCount, 2, output);
      assert.match(
        output,
        /localInference: deterministic fallback \(local inference reflection produced no quality-approved insights\)/,
      );
      assert.doesNotMatch(output, /This generated summary must be rejected/);
      assert.match(output, /Defined deterministic fallback for low-quality generated reflection/);
    } finally {
      cleanup();
    }
  });

  test("does not call local inference without both provider and per-call opt-in", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
        },
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });

    try {
      db.insertSemanticMemory({
        id: "reflect-local-inference-opt-in-seed",
        type: "user_preference",
        content: "Prefer explicit opt-in for model-backed reflection.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["local-inference"],
      });
      let requestCount = 0;
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, {
          localInferenceFetch: async () => {
            requestCount += 1;
            throw new Error("unexpected request");
          },
        }),
      });
      const reflect = findTool(tools, "lore_reflect");

      const defaultOutput = await reflect.handler({
        prompt: "What reflection approach should we prefer?",
        focus: "patterns",
      }, {
        sessionId: "reflect-local-inference-default-off",
      });
      assert.equal(requestCount, 0);
      assert.doesNotMatch(defaultOutput, /localInference:/);

      config.localInference.enabled = false;
      const disabledOutput = await reflect.handler({
        prompt: "What reflection approach should we prefer?",
        focus: "patterns",
        useLocalInference: true,
      }, {
        sessionId: "reflect-local-inference-provider-disabled",
      });
      assert.equal(requestCount, 0);
      assert.match(disabledOutput, /localInference: deterministic fallback \(provider disabled\)/);
    } finally {
      cleanup();
    }
  });

  test("uses the configured reflection default while preserving an explicit false override", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          reflection: {
            enabledByDefault: true,
          },
        },
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });

    try {
      db.insertSemanticMemory({
        id: "reflect-local-inference-config-default",
        type: "decision",
        content: "Use configured local inference for routine reflections.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["local-inference"],
      });
      db.upsertEpisodeDigest({
        id: "reflect-local-inference-config-default-episode",
        sessionId: "reflect-local-inference-config-default-source",
        repository: "fixture-repo",
        summary: "Configured local inference is the default for routine reflections.",
        actions: [],
        decisions: ["Use configured local inference for routine reflections."],
        learnings: [],
        filesChanged: [],
        refs: [],
        significance: 8,
        themes: ["local-inference"],
        openItems: [],
        dateKey: "2026-07-14",
        createdAt: "2026-07-14T12:00:00.000Z",
      });
      let requestCount = 0;
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, {
          localInferenceFetch: async () => {
            requestCount += 1;
            return new Response(JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify({
                    summary: "Configured local inference is active.",
                    insights: [{
                      text: "Routine reflections use the configured model default.",
                      evidenceIndex: 0,
                    }],
                  }),
                },
              }],
            }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      });
      const reflect = findTool(tools, "lore_reflect");

      const defaultOutput = await reflect.handler({
        prompt: "Should routine reflections use configured local inference?",
        focus: "decisions",
      }, {
        sessionId: "reflect-config-default-on",
      });
      assert.equal(requestCount, 1);
      assert.match(defaultOutput, /localInference: used/);

      const disabledOutput = await reflect.handler({
        prompt: "Should routine reflections use configured local inference?",
        focus: "decisions",
        useLocalInference: false,
      }, {
        sessionId: "reflect-config-default-explicit-off",
      });
      assert.equal(requestCount, 1);
      assert.doesNotMatch(disabledOutput, /localInference:/);
    } finally {
      cleanup();
    }
  });

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
        countSessionsSince() {
          return { count: 1, capped: false };
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
      assert.equal(findSessionsSinceCalls[0].limit, 12);
      assert.match(findSessionsSinceCalls[0].sinceIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      assert.match(output, /lookbackHours: 24 \(sessions found: 1\)/);
      assert.match(output, /Fixed the reflect tool lookback bug end to end\./);

      const observation = db.getObservation("reflect-tool-lookback-observation");
      assert.ok(observation, "expected the observation row to be persisted");
      assert.equal(observation.trace?.lookbackHours, 24);
      assert.equal(observation.trace?.recentSessionCount, 1);
      assert.equal(observation.trace?.recentSessionCountCapped, false);
    } finally {
      cleanup();
    }
  });

  test("widens the recent-session candidate pool for embedding-ranked reflection", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          reflection: {
            enabledByDefault: true,
          },
          embeddings: {
            enabled: true,
            model: "local-embedding-model",
            maxInputs: 50,
          },
        },
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
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
          return [{
            session_id: "candidate-pool-session",
            repository: "fixture-repo",
            branch: "main",
            summary: "Completed GitHub Actions maintenance.",
            created_at: "2026-07-15T08:00:00.000Z",
            updated_at: "2026-07-15T09:00:00.000Z",
          }];
        },
        countSessionsSince() {
          return { count: 39, capped: false };
        },
      };
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, {
          sessionStore,
          localInferenceFetch: async () => {
            throw new Error("local provider unavailable");
          },
        }),
      });

      const output = await findTool(tools, "lore_reflect").handler({
        prompt: "Review Git and CI maintenance from the past week.",
        lookbackHours: 168,
      }, {
        sessionId: "reflect-candidate-pool",
      });

      assert.equal(findSessionsSinceCalls.length, 1);
      assert.equal(findSessionsSinceCalls[0].limit, 40);
      assert.match(output, /localInference: deterministic fallback \(local provider unavailable\)/);
    } finally {
      cleanup();
    }
  });

  test("reports the true session count even when it exceeds the evidence-fetch limit", { skip: SKIP_NO_FTS5 }, async () => {
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
      const sessionStore = {
        findRelevantSessions() {
          return [];
        },
        // Evidence-fetch path stays capped (only 2 rows), simulating the
        // pre-existing Math.max(3, Math.min(limit*2, 20)) evidence limit.
        findSessionsSince() {
          return [
            {
              session_id: "session-recent-1",
              repository: "fixture-repo",
              branch: "main",
              summary: "First evidence row.",
              created_at: "2026-07-03T08:00:00.000Z",
              updated_at: "2026-07-03T11:00:00.000Z",
              workspaceSummary: null,
            },
            {
              session_id: "session-recent-2",
              repository: "fixture-repo",
              branch: "main",
              summary: "Second evidence row.",
              created_at: "2026-07-02T08:00:00.000Z",
              updated_at: "2026-07-02T11:00:00.000Z",
              workspaceSummary: null,
            },
          ];
        },
        // True count is decoupled from the evidence limit above and should
        // be what actually gets reported, not the 2-row evidence array length.
        countSessionsSince() {
          return { count: 47, capped: false };
        },
      };

      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, { sessionStore }),
      });
      const reflect = findTool(tools, "lore_reflect");

      const output = await reflect.handler({
        prompt: "Analyze the last month of activity across repos and summarize my patterns and preferences.",
        focus: "patterns",
        lookbackHours: 720,
        persistObservation: true,
        observationKey: "reflect-tool-true-count-observation",
      }, {
        sessionId: "reflect-true-count",
      });

      assert.match(output, /lookbackHours: 720 \(sessions found: 47\)/);

      const observation = db.getObservation("reflect-tool-true-count-observation");
      assert.equal(observation.trace?.recentSessionCount, 47);
      assert.equal(observation.trace?.recentSessionCountCapped, false);
    } finally {
      cleanup();
    }
  });

  test("annotates the reported session count when the repository-scoped count hits its ceiling", { skip: SKIP_NO_FTS5 }, async () => {
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
      const sessionStore = {
        findRelevantSessions() {
          return [];
        },
        findSessionsSince() {
          return [];
        },
        countSessionsSince() {
          return { count: 500, capped: true };
        },
      };

      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, { sessionStore }),
      });
      const reflect = findTool(tools, "lore_reflect");

      const output = await reflect.handler({
        prompt: "Analyze the last month of activity across repos and summarize my patterns and preferences.",
        focus: "patterns",
        lookbackHours: 720,
      }, {
        sessionId: "reflect-capped-count",
      });

      assert.match(output, /lookbackHours: 720 \(sessions found: 500\+ \(capped\)\)/);
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
        countSessionsSince() {
          return { count: 0, capped: false };
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
