import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  enhanceReflectionWithLocalInference,
  formatEmbeddingRetrievalInput,
} from "../../lib/local-inference-reflection.mjs";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function embeddingResponse(inputs, vectorsByText) {
  return jsonResponse({
    data: inputs.map((text, index) => ({
      index,
      embedding: vectorsByText.get(text) ?? [0, 1],
    })),
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
    reflection: {
      enabledByDefault: false,
    },
    embeddings: {
      enabled: true,
      model: "local-embedding-model",
      maxInputs: 24,
      topK: 2,
      minSimilarity: 0.5,
      groundingMinSimilarity: 0.8,
      ...overrides.embeddings,
    },
    ...overrides,
  };
}

function buildReflection() {
  return {
    prompt: "What Git and CI work was completed?",
    focus: "summary",
    summary: "Deterministic reflection summary.",
    insights: [
      {
        text: "Unrelated UI research",
        evidence: "Researched motion design trends.",
        source: "recent session activity",
        kind: "recent_session",
      },
    ],
    inferenceCandidates: [
      {
        text: "Unrelated UI research",
        evidence: "Researched motion design trends.",
        source: "recent session activity",
        kind: "recent_session",
      },
      {
        text: "Fixed CI workflow",
        evidence: "Updated GitHub Actions workflow dependencies and fixed the Node.js setup step.",
        source: "recent session activity",
        kind: "recent_session",
      },
      {
        text: "Unrelated model work",
        evidence: "Integrated a local language model.",
        source: "recent session activity",
        kind: "recent_session",
      },
      {
        text: "Checked deployment runs",
        evidence: "Reviewed GitHub Actions deployment checks for two pull requests.",
        source: "recent session activity",
        kind: "recent_session",
      },
    ],
  };
}

describe("local inference reflection grounding", () => {
  test("formats retrieval inputs for EmbeddingGemma and Nomic models", () => {
    assert.equal(
      formatEmbeddingRetrievalInput("embeddinggemma", "CI maintenance", "query"),
      "task: search result | query: CI maintenance",
    );
    assert.equal(
      formatEmbeddingRetrievalInput("embeddinggemma", "Fixed workflow", "document"),
      "title: Lore session evidence | text: Fixed workflow",
    );
    assert.equal(
      formatEmbeddingRetrievalInput("nomic-embed-text-v2-moe", "CI maintenance", "query"),
      "search_query: CI maintenance",
    );
    assert.equal(
      formatEmbeddingRetrievalInput("nomic-embed-text-v2-moe", "Fixed workflow", "document"),
      "search_document: Fixed workflow",
    );
    assert.equal(
      formatEmbeddingRetrievalInput("custom-embedding-model", "CI maintenance", "query"),
      "CI maintenance",
    );
  });

  test("ranks the full bounded candidate pool before selecting evidence for Gemma", async () => {
    const reflection = buildReflection();
    reflection.retrievalPrompt = "version control continuous integration repository maintenance";
    const config = buildConfig();
    config.embeddings.model = "docker.io/ai/embeddinggemma:latest";
    const embeddingQuery = `task: search result | query: ${reflection.retrievalPrompt}`;
    const evidenceInputs = reflection.inferenceCandidates.map(
      (candidate) => `title: Lore session evidence | text: ${candidate.evidence}`,
    );
    const groundedSummaryInput = "task: search result | query: Completed CI workflow maintenance and deployment verification.";
    const groundedClaimInput = "task: search result | query: The CI workflow dependency update was completed.";
    const vectorsByText = new Map([
      [embeddingQuery, [1, 0]],
      [evidenceInputs[0], [0, 1]],
      [evidenceInputs[1], [1, 0]],
      [evidenceInputs[2], [-1, 0]],
      [evidenceInputs[3], [0.9, 0.1]],
      [groundedSummaryInput, [1, 0]],
      [groundedClaimInput, [1, 0]],
    ]);
    const embeddingInputs = [];
    let chatEvidence = [];

    const result = await enhanceReflectionWithLocalInference({
      config,
      reflection,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith("/embeddings")) {
          embeddingInputs.push(body.input);
          return embeddingResponse(body.input, vectorsByText);
        }
        chatEvidence = JSON.parse(body.messages[1].content).evidence;
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "Completed CI workflow maintenance and deployment verification.",
                insights: [{
                  text: "The CI workflow dependency update was completed.",
                  evidenceIndex: 0,
                }],
              }),
            },
          }],
        });
      },
    });

    assert.equal(embeddingInputs.length, 2);
    assert.deepEqual(embeddingInputs[0], [
      embeddingQuery,
      ...evidenceInputs,
    ]);
    assert.deepEqual(embeddingInputs[1], [
      groundedSummaryInput,
      groundedClaimInput,
    ]);
    assert.deepEqual(
      chatEvidence.map((entry) => entry.text),
      [
        "Updated GitHub Actions workflow dependencies and fixed the Node.js setup step.",
        "Reviewed GitHub Actions deployment checks for two pull requests.",
      ],
    );
    assert.equal(result.summary, "Completed CI workflow maintenance and deployment verification.");
    assert.equal(result.insights[0].text, "The CI workflow dependency update was completed.");
    assert.equal(result.localInference.groundedInsightCount, 1);
    assert.equal(result.localInference.discardedInsightCount, 0);
  });

  test("rejects Gemma output when generated claims are not aligned with cited evidence", async () => {
    const reflection = buildReflection();
    const vectorsByText = new Map([
      [reflection.prompt, [1, 0]],
      ["Researched motion design trends.", [0, 1]],
      ["Updated GitHub Actions workflow dependencies and fixed the Node.js setup step.", [1, 0]],
      ["Integrated a local language model.", [-1, 0]],
      ["Reviewed GitHub Actions deployment checks for two pull requests.", [0.9, 0.1]],
      ["A Docker container remains broken.", [0, 1]],
      ["The Docker container error is the main blocker.", [0, 1]],
    ]);

    await assert.rejects(
      () => enhanceReflectionWithLocalInference({
        config: buildConfig(),
        reflection,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(init.body);
          if (url.endsWith("/embeddings")) {
            return embeddingResponse(body.input, vectorsByText);
          }
          return jsonResponse({
            choices: [{
              message: {
                content: JSON.stringify({
                  summary: "A Docker container remains broken.",
                  insights: [{
                    text: "The Docker container error is the main blocker.",
                    evidenceIndex: 0,
                  }],
                }),
              },
            }],
          });
        },
      }),
      /no grounded insights/,
    );
  });

  test("keeps the grounding embedding request within maxInputs", async () => {
    const reflection = buildReflection();
    const embeddingInputs = [];
    const vectorsByText = new Map([
      [reflection.prompt, [1, 0]],
      ["Researched motion design trends.", [1, 0]],
      ["Grounded summary.", [1, 0]],
      ["Grounded claim one.", [1, 0]],
      ["Grounded claim two.", [1, 0]],
      ["Grounded claim three.", [1, 0]],
    ]);

    const result = await enhanceReflectionWithLocalInference({
      config: buildConfig({
        embeddings: {
          enabled: true,
          model: "local-embedding-model",
          maxInputs: 2,
          topK: 1,
          minSimilarity: 0,
          groundingMinSimilarity: 0,
        },
      }),
      reflection,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith("/embeddings")) {
          embeddingInputs.push(body.input);
          return embeddingResponse(body.input, vectorsByText);
        }
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "Grounded summary.",
                insights: [
                  { text: "Grounded claim one.", evidenceIndex: 0 },
                  { text: "Grounded claim two.", evidenceIndex: 0 },
                  { text: "Grounded claim three.", evidenceIndex: 0 },
                ],
              }),
            },
          }],
        });
      },
    });

    assert.equal(embeddingInputs.length, 2);
    assert.equal(embeddingInputs[1].length, 2);
    assert.equal(result.insights.length, 1);
    assert.equal(result.localInference.discardedInsightCount, 2);
  });

  test("rejects enabled embeddings when no embedding model is configured", async () => {
    let requestCount = 0;

    await assert.rejects(
      () => enhanceReflectionWithLocalInference({
        config: buildConfig({
          embeddings: {
            enabled: true,
            model: "",
            maxInputs: 24,
            topK: 6,
            minSimilarity: 0.2,
            groundingMinSimilarity: 0.35,
          },
        }),
        reflection: buildReflection(),
        fetchImpl: async () => {
          requestCount += 1;
          throw new Error("unexpected request");
        },
      }),
      /embedding model is not configured/,
    );
    assert.equal(requestCount, 0);
  });

  test("uses deterministic ranked insights when embeddings are disabled", async () => {
    const reflection = buildReflection();
    reflection.insights = [{
      text: "Relevant deterministic CI insight",
      evidence: "Fixed the GitHub Actions deployment workflow.",
      source: "local episodes",
      kind: "decision",
    }];
    let chatEvidence = [];

    const result = await enhanceReflectionWithLocalInference({
      config: buildConfig({
        embeddings: {
          enabled: false,
          model: "",
          maxInputs: 24,
          topK: 6,
          minSimilarity: 0.2,
          groundingMinSimilarity: 0.35,
        },
      }),
      reflection,
      fetchImpl: async (url, init) => {
        assert.ok(url.endsWith("/chat/completions"));
        const body = JSON.parse(init.body);
        chatEvidence = JSON.parse(body.messages[1].content).evidence;
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "The CI workflow was fixed.",
                insights: [{
                  text: "The GitHub Actions deployment workflow was fixed.",
                  evidenceIndex: 0,
                }],
              }),
            },
          }],
        });
      },
    });

    assert.deepEqual(
      chatEvidence.map((entry) => entry.text),
      ["Fixed the GitHub Actions deployment workflow."],
    );
    assert.equal(result.localInference.embeddingsUsed, false);
  });

  test("returns grounded consolidation, contradiction, and recurring trend findings", async () => {
    const reflection = buildReflection();
    const embeddingInputs = [];

    const result = await enhanceReflectionWithLocalInference({
      config: buildConfig({
        analysis: {
          consolidation: {
            enabled: true,
            maxItems: 3,
          },
          contradictions: {
            enabled: true,
            maxItems: 3,
          },
          trends: {
            enabled: true,
            maxItems: 3,
            minOccurrences: 2,
          },
          qualityEvaluation: {
            enabled: false,
          },
        },
        embeddings: {
          enabled: true,
          model: "local-embedding-model",
          maxInputs: 24,
          topK: 2,
          minSimilarity: 0,
          groundingMinSimilarity: 0.8,
        },
      }),
      reflection,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith("/embeddings")) {
          embeddingInputs.push(body.input);
          return embeddingResponse(
            body.input,
            new Map(body.input.map((text) => [text, [1, 0]])),
          );
        }
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "CI workflow maintenance recurred across the evidence.",
                insights: [{
                  text: "The Node setup workflow was fixed.",
                  evidenceIndex: 0,
                }],
                consolidations: [{
                  text: "The workflow update and deployment checks form one CI maintenance theme.",
                  evidenceIndexes: [0, 1],
                }],
                contradictions: [{
                  text: "One item reports a workflow fix while another still required deployment verification.",
                  evidenceIndexes: [0, 1],
                }],
                trends: [{
                  text: "GitHub Actions maintenance recurred.",
                  evidenceIndexes: [0, 1],
                  occurrences: 2,
                }],
              }),
            },
          }],
        });
      },
    });

    assert.equal(embeddingInputs.length, 3);
    assert.equal(result.analysis.consolidations.length, 1);
    assert.deepEqual(result.analysis.consolidations[0].evidenceIndexes, [0, 1]);
    assert.equal(result.analysis.contradictions.length, 1);
    assert.equal(result.analysis.trends.length, 1);
    assert.equal(result.analysis.trends[0].occurrences, 2);
    assert.equal(result.localInference.groundedAnalysisCount, 3);
    assert.equal(result.localInference.discardedAnalysisCount, 0);
  });

  test("filters grounded reflection output through the configured quality evaluation", async () => {
    const reflection = buildReflection();
    reflection.insights = [
      {
        text: "Deterministic CI insight",
        evidence: "Updated the GitHub Actions Node setup step.",
        source: "local episodes",
        kind: "decision",
      },
      {
        text: "Deterministic deployment insight",
        evidence: "Reviewed the deployment workflow checks.",
        source: "local episodes",
        kind: "decision",
      },
    ];
    let chatRequestCount = 0;

    const result = await enhanceReflectionWithLocalInference({
      config: buildConfig({
        analysis: {
          qualityEvaluation: {
            enabled: true,
            minSupport: 0.8,
            minSpecificity: 0.6,
            minUsefulness: 0.6,
          },
        },
        embeddings: {
          enabled: false,
          model: "",
          maxInputs: 24,
          topK: 6,
          minSimilarity: 0.2,
          groundingMinSimilarity: 0.35,
        },
      }),
      reflection,
      fetchImpl: async (_url, init) => {
        chatRequestCount += 1;
        const body = JSON.parse(init.body);
        if (body.messages[0].content.includes("evaluate Lore reflection output")) {
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
                      specificity: 0.8,
                      usefulness: 0.9,
                    },
                    {
                      id: "insight:1",
                      support: 0.2,
                      specificity: 0.8,
                      usefulness: 0.9,
                    },
                  ],
                }),
              },
            }],
          });
        }
        return jsonResponse({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "The Node setup workflow was updated.",
                insights: [
                  {
                    text: "The GitHub Actions Node setup step was updated.",
                    evidenceIndex: 0,
                  },
                  {
                    text: "A Docker outage remains unresolved.",
                    evidenceIndex: 1,
                  },
                ],
              }),
            },
          }],
        });
      },
    });

    assert.equal(chatRequestCount, 2);
    assert.deepEqual(
      result.insights.map((insight) => insight.text),
      ["The GitHub Actions Node setup step was updated."],
    );
    assert.equal(result.localInference.qualityEvaluationUsed, true);
    assert.equal(result.localInference.qualityAcceptedCount, 2);
    assert.equal(result.localInference.qualityRejectedCount, 1);
  });
});
