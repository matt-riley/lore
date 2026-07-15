import assert from "node:assert/strict";
import { test } from "node:test";

import { assembleMemoryCapsule } from "../../lib/capsule-assembler.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("ambient capsule uses configured query expansion and evidence-preserving compression", { skip: SKIP_NO_FTS5 }, async () => {
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
        contextCompression: {
          enabled: true,
          minInputTokens: 1,
          targetTokens: 500,
          maxSections: 8,
        },
        embeddings: {
          enabled: false,
          model: "",
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
      id: "ambient-query-expansion-memory",
      type: "blocker",
      content: "GitHub Actions deployment checks were repeatedly failing.",
      repository: "fixture-repo",
      scope: "repo",
      confidence: 1,
      tags: ["ci"],
    });
    const requestKinds = [];

    const result = await assembleMemoryCapsule({
      prompt: "Continue the recurring deployment maintenance.",
      repository: "fixture-repo",
      proceduralProfile: "Follow repository instructions and preserve evidence.",
      db,
      sessionStore: null,
      config,
      includeTrace: true,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        const systemPrompt = body.messages[0].content;
        if (systemPrompt.includes("expand a retrieval query")) {
          requestKinds.push("expand");
          return jsonResponse({
            choices: [{
              message: {
                content: JSON.stringify({
                  terms: ["github actions", "deployment checks"],
                }),
              },
            }],
          });
        }
        requestKinds.push("compress");
        const compressionInput = JSON.parse(body.messages[1].content);
        const required = compressionInput.sections.filter((section) => section.required);
        const relevant = compressionInput.sections.find((section) => (
          section.text.includes("GitHub Actions deployment checks")
        ));
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                sections: [
                  ...required.map((section) => ({
                    title: section.title,
                    text: section.text,
                    sourceIndexes: [section.index],
                  })),
                  ...(relevant ? [{
                    title: "Relevant Knowledge",
                    text: "GitHub Actions deployment checks were repeatedly failing.",
                    sourceIndexes: [relevant.index],
                  }] : []),
                ],
              }),
            },
          }],
        });
      },
    });

    assert.deepEqual(requestKinds, ["expand", "compress"]);
    assert.equal(result.trace.localInference.queryExpansion.used, true);
    assert.equal(result.trace.localInference.contextCompression.used, true);
    assert.match(result.text, /GitHub Actions deployment checks were repeatedly failing\./);
    assert.ok(result.estimatedTokens <= 500);
  } finally {
    cleanup();
  }
});

test("ambient augmentation stays default-off and makes no model request", { skip: SKIP_NO_FTS5 }, async () => {
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
    let requestCount = 0;
    const result = await assembleMemoryCapsule({
      prompt: "Continue repository maintenance.",
      repository: "fixture-repo",
      proceduralProfile: "Follow repository instructions.",
      db,
      sessionStore: null,
      config,
      includeTrace: true,
      fetchImpl: async () => {
        requestCount += 1;
        throw new Error("unexpected model request");
      },
    });

    assert.equal(requestCount, 0);
    assert.equal(result.trace.localInference.queryExpansion.requested, false);
    assert.equal(result.trace.localInference.contextCompression.requested, false);
  } finally {
    cleanup();
  }
});

test("ambient augmentation preserves deterministic context on provider and malformed-output failures", { skip: SKIP_NO_FTS5 }, async () => {
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
        contextCompression: {
          enabled: true,
          minInputTokens: 1,
          targetTokens: 500,
          maxSections: 8,
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
      id: "ambient-fallback-memory",
      type: "decision",
      content: "Keep deterministic repository maintenance context available.",
      repository: "fixture-repo",
      scope: "repo",
      confidence: 1,
      tags: ["maintenance"],
    });
    const baselineConfig = structuredClone(config);
    baselineConfig.localInference.queryExpansion.enabled = false;
    baselineConfig.localInference.contextCompression.enabled = false;
    const baseline = await assembleMemoryCapsule({
      prompt: "Continue repository maintenance.",
      repository: "fixture-repo",
      proceduralProfile: "Follow repository instructions.",
      db,
      sessionStore: null,
      config: baselineConfig,
      includeTrace: true,
    });

    config.localInference.enabled = false;
    const providerDisabled = await assembleMemoryCapsule({
      prompt: "Continue repository maintenance.",
      repository: "fixture-repo",
      proceduralProfile: "Follow repository instructions.",
      db,
      sessionStore: null,
      config,
      includeTrace: true,
      fetchImpl: async () => {
        throw new Error("unexpected model request");
      },
    });
    assert.equal(providerDisabled.text, baseline.text);
    assert.equal(providerDisabled.trace.localInference.queryExpansion.error, "provider disabled");
    assert.equal(providerDisabled.trace.localInference.contextCompression.error, "provider disabled");

    config.localInference.enabled = true;
    const malformed = await assembleMemoryCapsule({
      prompt: "Continue repository maintenance.",
      repository: "fixture-repo",
      proceduralProfile: "Follow repository instructions.",
      db,
      sessionStore: null,
      config,
      includeTrace: true,
      fetchImpl: async () => jsonResponse({
        choices: [{ message: { content: "{}" } }],
      }),
    });
    assert.equal(malformed.text, baseline.text);
    assert.equal(malformed.trace.localInference.queryExpansion.used, false);
    assert.equal(malformed.trace.localInference.contextCompression.used, false);
    assert.match(
      malformed.trace.localInference.contextCompression.error,
      /omitted required source/,
    );
  } finally {
    cleanup();
  }
});
