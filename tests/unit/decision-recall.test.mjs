import assert from "node:assert/strict";
import { test } from "node:test";

import { extractSessionMemories } from "../../lib/sessions/rule-extractor.mjs";
import { applySessionExtraction } from "../../lib/sessions/backfill.mjs";
import { recallMemory } from "../../lib/memory/memory-operations.mjs";
import { semanticSearch } from "../../lib/memory/semantic-search.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function buildDecisionSession() {
  return {
    session: {
      id: "decision-recall-session",
      repository: "fixture/repo",
      branch: "main",
      summary: "Database selection discussion",
      updated_at: "2026-09-07T10:00:00.000Z",
    },
    checkpoints: [],
    files: [],
    refs: [],
    turns: [
      {
        turn_index: 1,
        user_message: "What database should we use?",
        assistant_response: "",
      },
      {
        turn_index: 2,
        user_message: "",
        assistant_response: "We decided to use PostgreSQL because we need concurrent writers.",
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        turn_index: index + 3,
        user_message: `Neutral follow-up ${index + 1}.`,
        assistant_response: "Acknowledged.",
      })),
    ],
  };
}

function decisionEmbedding(text) {
  const lower = String(text).toLowerCase();
  return [
    lower.includes("postgresql") ? 1 : 0,
    lower.includes("concurrent") ? 1 : 0,
    lower.includes("writers") ? 1 : 0,
    lower.includes("sqlite") ? 1 : 0,
    1,
  ];
}

function fakeEmbeddingFetch(_url, options) {
  const input = JSON.parse(options.body).input;
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      data: input.map((text, index) => ({ index, embedding: decisionEmbedding(text) })),
    }),
  });
}

test("decisions captured before a long neutral tail remain available to prompt recall", { skip: SKIP_NO_FTS5 }, async () => {
  const fixture = await withFixtureDb();
  try {
    const sessionArtifacts = buildDecisionSession();
    const extraction = extractSessionMemories({
      sessionId: sessionArtifacts.session.id,
      repository: "fixture/repo",
      sessionArtifacts: {
        ...sessionArtifacts,
        turns: sessionArtifacts.turns.slice(0, 2),
      },
      workspace: { workspace: null },
    });
    applySessionExtraction({
      db: fixture.db,
      sessionId: sessionArtifacts.session.id,
      repository: "fixture/repo",
      sessionArtifacts,
      workspace: { workspace: null },
      extraction,
    });

    // A later bounded extraction refreshes the episode with only neutral
    // turns. Generated evidence remains active, so the decision must still be
    // discoverable through every recall route.
    const neutralExtraction = extractSessionMemories({
      sessionId: sessionArtifacts.session.id,
      repository: "fixture/repo",
      sessionArtifacts: {
        ...sessionArtifacts,
        turns: sessionArtifacts.turns.slice(2),
      },
      workspace: { workspace: null },
    });
    applySessionExtraction({
      db: fixture.db,
      sessionId: sessionArtifacts.session.id,
      repository: "fixture/repo",
      sessionArtifacts,
      workspace: { workspace: null },
      extraction: neutralExtraction,
    });

    const activeDecision = fixture.db.searchSemantic({
      query: "PostgreSQL concurrent writers",
      repository: "fixture/repo",
      types: ["decision"],
    });
    assert.equal(activeDecision.length, 1);
    assert.match(activeDecision[0].content, /PostgreSQL/);

    const recall = recallMemory({
      db: fixture.db,
      repository: "fixture/repo",
      prompt: "Which database did we choose for concurrent writers?",
    });
    assert.match(recall.text, /PostgreSQL/, "prompt recall should include the retained decision");
  } finally {
    fixture.cleanup();
  }
});

test("default vector recall searches decisions while enforcing repository eligibility", { skip: SKIP_NO_FTS5 }, async () => {
  const fixture = await withFixtureDb({
    configOverrides: {
      localInference: {
        enabled: true,
        embeddings: { enabled: true, model: "decision-test-model", minSimilarity: 0.2 },
      },
    },
  });
  try {
    fixture.db.insertSemanticMemory({
      id: "local-decision",
      type: "decision",
      content: "Decision: use PostgreSQL because we need concurrent writers.",
      repository: "fixture/repo",
      scope: "repo",
    });
    fixture.db.insertSemanticMemory({
      id: "foreign-decision",
      type: "decision",
      content: "Decision: use SQLite because this service has one writer.",
      repository: "other/repo",
      scope: "repo",
    });

    const result = await semanticSearch({
      db: fixture.db,
      query: "Which database did we choose for concurrent writers?",
      repository: "fixture/repo",
      fetchImpl: fakeEmbeddingFetch,
      config: fixture.config,
    });
    assert.equal(result.enabled, true);
    assert.equal(result.rows[0].id, "local-decision");
    assert.equal(result.rows.some((row) => row.id === "foreign-decision"), false);
  } finally {
    fixture.cleanup();
  }
});
