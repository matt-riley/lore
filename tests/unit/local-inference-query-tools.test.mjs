import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createMemoryTools } from "../../lib/memory-tools.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";
import { findTool } from "../helpers/tool-helpers.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function buildRuntime(db, config, localInferenceFetch, overrides = {}) {
  return {
    initialized: true,
    lastError: null,
    db,
    config,
    repository: "fixture-repo",
    sessionStore: null,
    localInferenceFetch,
    ...overrides,
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("local inference query expansion tools", () => {
  test("lore_recall uses configured query expansion and reports the added terms", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          queryExpansion: {
            enabled: true,
            maxTerms: 4,
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
        id: "query-expansion-ci-memory",
        type: "blocker",
        content: "Fixed the GitHub Actions Node setup workflow.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["ci"],
      });
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, async () => jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                terms: ["github actions", "node setup"],
              }),
            },
          }],
        })),
      });

      const output = await findTool(tools, "lore_recall").handler({
        prompt: "What deployment trouble did we fix?",
        detailLevel: "evidence",
      }, {
        sessionId: "query-expansion-recall",
      });

      assert.match(output, /queryExpansion: used added=github actions, node setup/);
      assert.match(output, /Fixed the GitHub Actions Node setup workflow\./);
    } finally {
      cleanup();
    }
  });

  test("lore_recall falls back to the deterministic query when expansion retrieves no evidence", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          queryExpansion: {
            enabled: true,
            maxTerms: 4,
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
        id: "query-expansion-fallback-memory",
        type: "blocker",
        content: "Deployment retries were fixed with a bounded backoff.",
        repository: "fixture-repo",
        scope: "repo",
        confidence: 1,
        tags: ["deployment"],
      });
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(db, config, async () => jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                terms: ["unrelated typography"],
              }),
            },
          }],
        })),
      });

      const output = await findTool(tools, "lore_recall").handler({
        prompt: "deployment retries",
        detailLevel: "evidence",
      }, {
        sessionId: "query-expansion-fallback",
      });

      assert.match(output, /queryExpansion: deterministic retrieval fallback/);
      assert.match(output, /Deployment retries were fixed with a bounded backoff\./);
    } finally {
      cleanup();
    }
  });

  test("lore_reflect retries deterministic retrieval when only lookback evidence survives expansion", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        enabled: true,
        localInference: {
          enabled: true,
          model: "local-chat-model",
          queryExpansion: {
            enabled: true,
            maxTerms: 4,
          },
        },
        rollout: {
          memoryOperations: true,
          temporalQueryNormalization: true,
        },
      },
    });

    try {
      db.upsertEpisodeDigest({
        id: "query-expansion-reflect-fallback",
        sessionId: "query-expansion-reflect-fallback-source",
        repository: "fixture-repo",
        summary: "Deployment retries were fixed with bounded backoff.",
        actions: [],
        decisions: [],
        learnings: ["Deployment retries were fixed with bounded backoff."],
        filesChanged: [],
        refs: [],
        significance: 8,
        themes: ["deployment"],
        openItems: [],
        dateKey: "2026-07-15",
        createdAt: "2026-07-15T12:00:00.000Z",
      });
      const sessionStore = {
        findRelevantSessions() {
          return [];
        },
        findSessionsSince() {
          return [{
            session_id: "recent-unrelated-session",
            repository: "fixture-repo",
            branch: "main",
            summary: "Reviewed typography and formatting.",
            created_at: "2026-07-15T13:00:00.000Z",
            updated_at: "2026-07-15T13:30:00.000Z",
          }];
        },
        countSessionsSince() {
          return { count: 1, capped: false };
        },
      };
      const tools = createMemoryTools({
        getRuntime: async () => buildRuntime(
          db,
          config,
          async () => jsonResponse({
            choices: [{
              message: {
                content: JSON.stringify({
                  terms: ["unrelated typography"],
                }),
              },
            }],
          }),
          { sessionStore },
        ),
      });

      const output = await findTool(tools, "lore_reflect").handler({
        prompt: "deployment retries",
        detailLevel: "evidence",
        lookbackHours: 24,
      }, {
        sessionId: "query-expansion-reflect-fallback",
      });

      assert.match(output, /queryExpansion: deterministic retrieval fallback/);
      assert.match(output, /Deployment retries were fixed with bounded backoff\./);
    } finally {
      cleanup();
    }
  });
});
