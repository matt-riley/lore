import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  compressContextWithLocalInference,
  evaluateReflectionQualityWithLocalInference,
  expandRetrievalQueryWithLocalInference,
} from "../../lib/local-inference-augmentation.mjs";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function buildConfig(overrides = {}) {
  return {
    enabled: true,
    baseUrl: "http://127.0.0.1:12434/v1",
    model: "local-chat-model",
    timeoutMs: 30000,
    maxInputChars: 24000,
    maxOutputTokens: 1200,
    temperature: 0,
    queryExpansion: {
      enabled: true,
      maxTerms: 8,
      ...overrides.queryExpansion,
    },
    ...overrides,
  };
}

describe("local inference query expansion", () => {
  test("adds bounded semantic terms without replacing the deterministic query", async () => {
    let requestBody = null;

    const result = await expandRetrievalQueryWithLocalInference({
      config: buildConfig(),
      prompt: "What recurring deployment problems did we fix?",
      deterministicQuery: "recurring deployment problems fix",
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                terms: [
                  "github actions",
                  "ci workflow",
                  "node setup",
                  "deployment checks",
                  "github actions",
                ],
              }),
            },
          }],
        });
      },
    });

    assert.match(requestBody.messages[0].content, /untrusted data/);
    assert.equal(
      result.query,
      "github actions ci workflow node setup deployment checks",
    );
    assert.equal(result.deterministicQuery, "recurring deployment problems fix");
    assert.deepEqual(result.addedTerms, [
      "github actions",
      "ci workflow",
      "node setup",
      "deployment checks",
    ]);
    assert.equal(result.used, true);
  });
});

describe("local inference quality evaluation", () => {
  test("accepts only candidates meeting every configured quality threshold", async () => {
    const result = await evaluateReflectionQualityWithLocalInference({
      config: buildConfig({
        analysis: {
          qualityEvaluation: {
            enabled: true,
            minSupport: 0.8,
            minSpecificity: 0.6,
            minUsefulness: 0.6,
          },
        },
      }),
      prompt: "What CI work was completed?",
      evidence: [
        "Updated the GitHub Actions Node setup step.",
      ],
      candidates: [
        { id: "summary", text: "The Node setup step was updated." },
        { id: "insight:0", text: "The CI workflow was fixed." },
        { id: "insight:1", text: "Docker remains broken." },
      ],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.match(body.messages[0].content, /untrusted data/);
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                items: [
                  {
                    id: "summary",
                    support: 0.95,
                    specificity: 0.8,
                    usefulness: 0.9,
                  },
                  {
                    id: "insight:0",
                    support: 0.9,
                    specificity: 0.7,
                    usefulness: 0.8,
                  },
                  {
                    id: "insight:1",
                    support: 0.2,
                    specificity: 0.9,
                    usefulness: 0.8,
                  },
                ],
              }),
            },
          }],
        });
      },
    });

    assert.deepEqual(result.acceptedIds, ["summary", "insight:0"]);
    assert.deepEqual(result.rejectedIds, ["insight:1"]);
    assert.equal(result.used, true);
  });

  test("evaluates every candidate allowed by the bounded reflection output shape", async () => {
    const candidates = Array.from({ length: 33 }, (_, index) => ({
      id: `candidate:${index}`,
      text: `Evidence-backed candidate ${index}.`,
    }));
    const result = await evaluateReflectionQualityWithLocalInference({
      config: buildConfig({
        analysis: {
          qualityEvaluation: {
            enabled: true,
            minSupport: 0.8,
            minSpecificity: 0.6,
            minUsefulness: 0.6,
          },
        },
      }),
      prompt: "Evaluate every bounded reflection candidate.",
      evidence: ["All candidates are supported by this bounded fixture evidence."],
      candidates,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        const submitted = JSON.parse(body.messages[1].content).candidates;
        assert.equal(submitted.length, 33);
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                items: submitted.map((candidate) => ({
                  id: candidate.id,
                  support: 0.95,
                  specificity: 0.9,
                  usefulness: 0.9,
                })),
              }),
            },
          }],
        });
      },
    });

    assert.equal(result.acceptedIds.length, 33);
    assert.deepEqual(result.rejectedIds, []);
  });
});

describe("local inference context compression", () => {
  test("compresses context with valid source citations while preserving required sections", async () => {
    const result = await compressContextWithLocalInference({
      config: buildConfig({
        contextCompression: {
          enabled: true,
          minInputTokens: 1,
          targetTokens: 120,
          maxSections: 6,
        },
        embeddings: {
          enabled: false,
          model: "",
        },
      }),
      prompt: "Continue the CI maintenance work.",
      sections: [
        {
          title: "Standing Directives",
          text: "Always keep workflow changes evidence-backed.",
          required: true,
        },
        {
          title: "Relevant Knowledge",
          text: "The Node setup action was upgraded in two repositories.",
          required: false,
        },
      ],
      fetchImpl: async () => jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              sections: [
                {
                  title: "Standing Directives",
                  text: "Keep workflow changes evidence-backed.",
                  sourceIndexes: [0],
                },
                {
                  title: "Relevant Knowledge",
                  text: "Node setup upgrades affected two repositories.",
                  sourceIndexes: [1],
                },
              ],
            }),
          },
        }],
      }),
    });

    assert.equal(result.used, true);
    assert.match(result.text, /## Standing Directives/);
    assert.match(result.text, /Keep workflow changes evidence-backed\./);
    assert.deepEqual(result.sourceIndexes, [0, 1]);
  });

  test("rejects compressed context that omits a required source section", async () => {
    await assert.rejects(
      () => compressContextWithLocalInference({
        config: buildConfig({
          contextCompression: {
            enabled: true,
            minInputTokens: 1,
            targetTokens: 120,
            maxSections: 6,
          },
          embeddings: {
            enabled: false,
            model: "",
          },
        }),
        prompt: "Continue the CI maintenance work.",
        sections: [
          {
            title: "Standing Directives",
            text: "Always keep workflow changes evidence-backed.",
            required: true,
          },
          {
            title: "Relevant Knowledge",
            text: "The Node setup action was upgraded.",
            required: false,
          },
        ],
        fetchImpl: async () => jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                sections: [{
                  title: "Relevant Knowledge",
                  text: "The Node setup action was upgraded.",
                  sourceIndexes: [1],
                }],
              }),
            },
          }],
        }),
      }),
      /omitted required source/,
    );
  });

  test("rejects compression when embedding grounding removes a required source", async () => {
    await assert.rejects(
      () => compressContextWithLocalInference({
        config: buildConfig({
          contextCompression: {
            enabled: true,
            minInputTokens: 1,
            targetTokens: 120,
            maxSections: 6,
          },
          embeddings: {
            enabled: true,
            model: "local-embedding-model",
            maxInputs: 24,
            groundingMinSimilarity: 0.8,
          },
        }),
        prompt: "Continue the CI maintenance work.",
        sections: [{
          title: "Standing Directives",
          text: "Always keep workflow changes evidence-backed.",
          required: true,
        }],
        fetchImpl: async (url) => {
          if (url.endsWith("/embeddings")) {
            return jsonResponse({
              data: [
                { index: 0, embedding: [1, 0] },
                { index: 1, embedding: [0, 1] },
              ],
            });
          }
          return jsonResponse({
            choices: [{
              message: {
                content: JSON.stringify({
                  sections: [{
                    title: "Standing Directives",
                    text: "Keep workflow changes evidence-backed.",
                    sourceIndexes: [0],
                  }],
                }),
              },
            }],
          });
        },
      }),
      /grounding removed required source/,
    );
  });
});
