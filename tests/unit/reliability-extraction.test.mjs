import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractSessionMemories } from "../../lib/sessions/rule-extractor.mjs";
import { MEMORY_SCOPE, classifySemanticMemory } from "../../lib/memory/memory-scope.mjs";

function extract({ repository = "owner/repo", turns, sessionId = "fixture-session" }) {
  return extractSessionMemories({
    sessionId,
    repository,
    sessionArtifacts: {
      session: {
        repository,
        branch: "main",
        summary: "Fixture extraction session",
        updated_at: "2026-09-07T10:00:00.000Z",
      },
      checkpoints: [],
      files: [],
      refs: [],
      turns: turns.map((turn, index) => ({
        turn_index: index + 1,
        ...turn,
      })),
    },
    workspace: { workspace: null },
  });
}

function semantic(extraction, type) {
  return extraction.semanticMemories.filter((memory) => memory.type === type);
}

describe("conservative rule extraction", () => {
  test("extracts explicit sentence-level preferences from long messages", () => {
    const extraction = extract({
      turns: [{
        user_message: "I prefer concise answers. Please keep each response focused and direct. The implementation can remain detailed where needed.",
        assistant_response: "Understood.",
      }],
    });

    const preferences = semantic(extraction, "user_preference");
    assert.deepEqual(preferences.map((memory) => memory.content), [
      "I prefer concise answers.",
      "Please keep each response focused and direct.",
    ]);
    assert.equal(preferences.every((memory) => memory.scope === MEMORY_SCOPE.REPO), true);
    assert.equal(preferences.every((memory) => memory.confidence < 0.9), true);
    assert.equal(preferences[0].metadata.confidenceBasis, "explicit_preference_sentence");
    assert.equal(preferences[0].metadata.sourceRole, "user");
  });

  test("retains explicit evidence from turns older than the usual rolling window", () => {
    const turns = Array.from({ length: 24 }, (_, index) => ({
      user_message: index === 0
        ? "I prefer deterministic fixture inputs."
        : `Routine implementation update ${index}.`,
    }));
    const preferences = semantic(extract({ turns }), "user_preference");
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0].sourceTurnIndex, 1);
  });

  test("accepts explicit first-person always language while excluding complaint language", () => {
    const extraction = extract({
      turns: [
        { user_message: "I always use fixture databases for tests." },
        { user_message: "You always break the fixture setup." },
        { user_message: "Please do not ever expose test credentials." },
      ],
    });
    assert.deepEqual(semantic(extraction, "user_preference").map((memory) => memory.content), [
      "I always use fixture databases for tests.",
    ]);
    assert.deepEqual(semantic(extraction, "rejected_approach").map((memory) => memory.content), [
      "Please do not ever expose test credentials.",
    ]);
  });

  test("does not promote questions, quotations, hypotheticals, negated preferences, or bug reports", () => {
    const extraction = extract({
      turns: [
        { user_message: "What do you prefer for storage?" },
        { user_message: "The old guide says \"always use SQLite\"." },
        { user_message: "If we ever need a cache, we might prefer Redis." },
        { user_message: "I don't prefer verbose output." },
        { user_message: "The test always fails on Windows." },
        { user_message: "The service never worked after the restart." },
      ],
    });

    assert.deepEqual(semantic(extraction, "user_preference"), []);
    assert.deepEqual(semantic(extraction, "rejected_approach"), []);
  });

  test("extracts completed decisions and rationale from both roles, with outcome attribution", () => {
    const extraction = extract({
      turns: [
        {
          source_record_id: "turn-a",
          source_revision: "rev-a",
          user_message: "What database should we use?",
          assistant_response: "We decided to use PostgreSQL because we need concurrent writers.",
        },
        {
          source_record_id: "turn-b",
          user_message: "We chose SQLite for the fixture database because it is portable.",
          assistant_response: "The question is still open for production.",
        },
      ],
    });

    const decisions = semantic(extraction, "decision");
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].content, "Decision: use PostgreSQL because we need concurrent writers.");
    assert.equal(decisions[0].metadata.sourceRole, "assistant");
    assert.equal(decisions[0].metadata.verificationStatus, "unverified_assistant_claim");
    assert.equal(decisions[1].metadata.sourceRole, "user");
    assert.match(decisions[1].content, /SQLite.*portable/);
    assert.equal(decisions.some((memory) => /What database/.test(memory.content)), false);
  });

  test("keeps a later decision reversal as evidence instead of a global instruction", () => {
    const extraction = extract({
      turns: [
        { user_message: "We decided to use PostgreSQL for notifications." },
        { user_message: "Instead, we chose SQLite for notifications because the deployment target is embedded." },
      ],
    });

    const decisions = semantic(extraction, "decision");
    assert.equal(decisions.length, 2);
    assert.equal(decisions[1].metadata.decisionStatus, "reversal");
    assert.equal(decisions[1].tags.includes("reversal"), true);
    assert.equal(decisions.every((memory) => memory.scope === MEMORY_SCOPE.REPO), true);
    assert.deepEqual(extraction.retiredEvidenceKeys, [decisions[0].evidence.key]);
  });
});

describe("extraction evidence", () => {
  test("attaches deterministic evidence descriptors using source identity and revision", () => {
    const args = {
      sessionId: "evidence-session",
      repository: "owner/repo",
      turns: [{
        source_record_id: "record-17",
        source_revision: "revision-3",
        user_message: "Always use the fixture database for tests.",
      }],
    };
    const first = extract(args);
    const second = extract(args);
    const memory = semantic(first, "user_preference")[0];
    const repeated = semantic(second, "user_preference")[0];

    assert.deepEqual(memory.evidence, repeated.evidence);
    assert.equal(memory.evidence.sourceRecordId, "record-17");
    assert.equal(memory.evidence.sourceKind, "preference");
    assert.equal(memory.evidence.revision, "revision-3");
    assert.match(memory.evidence.contentHash, /^[a-f0-9]{64}$/);
    assert.match(memory.evidence.key, /^session:evidence-session:record:record-17:type:user_preference:proposition:[a-f0-9]{64}$/);
    assert.deepEqual(memory.metadata.sourceAttribution, {
      sessionId: "evidence-session",
      sourceRecordId: "record-17",
      sourceRole: "user",
    });
  });
});

describe("scope classification", () => {
  test("defaults known origins to repo and leaves unknown origins out of global scope", () => {
    assert.deepEqual(classifySemanticMemory({
      type: "user_preference",
      content: "Prefer focused review comments.",
      repository: "owner/repo",
    }), {
      scope: MEMORY_SCOPE.REPO,
      repository: "owner/repo",
      metadata: {},
    });
    assert.deepEqual(classifySemanticMemory({
      type: "user_preference",
      content: "Prefer focused review comments.",
    }), {
      scope: MEMORY_SCOPE.REPO,
      repository: null,
      metadata: {},
    });
  });

  test("honors explicit cross-project scope declarations", () => {
    assert.deepEqual(classifySemanticMemory({
      type: "user_preference",
      repository: "owner/repo",
      content: "Across all projects, always use plain ESM.",
    }), {
      scope: MEMORY_SCOPE.GLOBAL,
      repository: null,
      metadata: {
        originRepository: "owner/repo",
      },
    });
  });
});
