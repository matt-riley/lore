import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { extractSessionMemories } from "../../lib/sessions/rule-extractor.mjs";
import { MEMORY_SCOPE, classifySemanticMemory } from "../../lib/memory/memory-scope.mjs";
import { enhanceSessionExtractionWithLocalInference } from "../../lib/inference/local-inference-extraction.mjs";

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

  test("accepts natural explicit directives and scoped preambles", () => {
    const extraction = extract({
      turns: [{
        user_message: [
          "Prefer a compact release note for every patch.",
          "For this repository, please prefer deterministic fixtures.",
          "Please use two-space indentation.",
          "Across all my projects, I prefer plain ESM.",
        ].join(" "),
      }],
    });

    const preferences = semantic(extraction, "user_preference");
    assert.deepEqual(preferences.map((memory) => memory.content), [
      "Prefer a compact release note for every patch.",
      "For this repository, please prefer deterministic fixtures.",
      "Please use two-space indentation.",
      "Across all my projects, I prefer plain ESM.",
    ]);
    assert.deepEqual(preferences.map((memory) => memory.scope), [
      MEMORY_SCOPE.REPO,
      MEMORY_SCOPE.REPO,
      MEMORY_SCOPE.REPO,
      MEMORY_SCOPE.GLOBAL,
    ]);
    assert.equal(preferences[3].repository, null);
  });

  test("keeps context around a direct request after a rationale", () => {
    const extraction = extract({
      turns: [{
        user_message: "It helps me when implementation notes lead with the user impact and then explain the code, so please use that order in this project.",
      }],
    });

    const preference = semantic(extraction, "user_preference")[0];
    assert.match(preference.content, /implementation notes/);
    assert.match(preference.content, /user impact/);
    assert.equal(preference.scope, MEMORY_SCOPE.REPO);
  });

  test("recognizes an explicit cross-project work style", () => {
    const extraction = extract({
      turns: [{
        user_message: "Across projects I work best with direct, concise status updates that name uncertainty instead of hiding it.",
      }],
    });

    const preference = semantic(extraction, "user_preference")[0];
    assert.equal(preference.scope, MEMORY_SCOPE.GLOBAL);
  });

  test("recognizes a corrected imperative without treating the old form as current here", () => {
    const extraction = extract({
      turns: [{
        user_message: "Actually, that is wrong: use a 45 second timeout because the upstream batch window is longer.",
      }],
    });

    assert.deepEqual(semantic(extraction, "user_preference").map((memory) => memory.content), [
      "Actually, that is wrong: use a 45 second timeout because the upstream batch window is longer.",
    ]);
  });

  test("does not retain one-off incident actions as durable memories", () => {
    const extraction = extract({
      turns: [
        { user_message: "Please include the failing request in the bug report." },
        { user_message: "Please check the failing endpoint and attach the logs." },
        { user_message: "Please run the reproduction and report the result." },
        { user_message: "Please preserve the failing response for debugging." },
        { user_message: "Please use the captured request to reproduce this bug." },
        { user_message: "Please keep this bug report updated." },
        { user_message: "Please write the failing response into the issue." },
        { user_message: "Please make the failing endpoint reproducible." },
        { user_message: "Please ask for the failing logs." },
        { user_message: "Please do not include the failing request in the bug report." },
        { user_message: "Please avoid retrying the failing payment request for this incident." },
      ],
    });

    assert.deepEqual(extraction.semanticMemories, []);
  });

  test("retains explicit policies and general failure or payment constraints", () => {
    const cases = [
      ["In future, always include the failing request in the bug report.", "user_preference"],
      ["As a policy, never include the failing request in the bug report.", "rejected_approach"],
      ["Please avoid silently retrying payment mutations. A duplicate charge is worse than a visible failure, so retries need an idempotency key.", "rejected_approach"],
      ["Always preserve failure evidence for future reviews.", "user_preference"],
      ["Never retry payment mutations without an idempotency key.", "rejected_approach"],
      ["Please use payment idempotency keys for mutations.", "user_preference"],
      ["Please keep failure reports concise for every incident.", "user_preference"],
      ["Never retain personal customer names in debugging memories.", "rejected_approach"],
      ["From now on, please include the failing request in the bug report.", "user_preference"],
      ["For this repository, as a policy, please include the failing request in the bug report.", "user_preference"],
    ];
    for (const [user_message, type] of cases) {
      const memories = extract({ turns: [{ user_message }] }).semanticMemories;
      assert.equal(memories.length, 1, user_message);
      assert.equal(memories[0].type, type, user_message);
      assert.equal(memories[0].scope, MEMORY_SCOPE.REPO);
    }
  });

  test("keeps explicitly temporary requests out of enduring directives", () => {
    for (const user_message of [
      "Please use payment idempotency keys just this once.",
      "For this incident, please preserve failure evidence.",
      "Please run the tests now.",
      "Please write a bug report.",
      "Please use the attachment.",
      "Please make a reproduction.",
      "Please keep this request open.",
      "I prefer verbose logging for this run only.",
      "Please avoid retrying payment mutations for this incident only.",
    ]) {
      assert.deepEqual(extract({ turns: [{ user_message }] }).semanticMemories, [], user_message);
    }
  });

  test("does not detach directive clauses from questions, quotations, or hypothetical qualifiers", () => {
    for (const user_message of [
      "Should we prefer Redis and never use SQLite?",
      "If we need caching, prefer Redis and never use SQLite.",
      "The old guide says 'Prefer Redis and never use SQLite.'",
      "The old guide says `Prefer Redis and never use SQLite.`",
      "Prefer Redis and never use SQLite if the prototype needs caching.",
    ]) {
      assert.deepEqual(extract({ turns: [{ user_message }] }).semanticMemories, [], user_message);
    }
  });

  test("keeps standing safety constraints despite incident request guards", () => {
    const extraction = extract({
      turns: [
        { user_message: "Never expose credentials in logs." },
        { user_message: "As a policy, never expose credentials in logs." },
        { user_message: "In future, never expose credentials in logs." },
      ],
    });

    assert.deepEqual(semantic(extraction, "rejected_approach").map((memory) => memory.content), [
      "Never expose credentials in logs.",
      "As a policy, never expose credentials in logs.",
      "In future, never expose credentials in logs.",
    ]);
  });

  test("does not infer a durable assistant goal from one ordinary incident", () => {
    const extraction = extract({
      turns: [{
        user_message: "The API returned a 502 after the proxy upgrade. Please inspect the timeout and include the failing request in the bug report.",
        assistant_response: "I will inspect the proxy timeout and reproduce the failing request before proposing a change.",
      }],
    });

    assert.deepEqual(extraction.semanticMemories, []);
  });

  test("does not promote preferences with trailing or parenthetical conditions", () => {
    const extraction = extract({
      turns: [{
        user_message: [
          "I prefer Redis if we ever need a cache.",
          "I prefer SQLite (only if the fixture stays local).",
          "Please use Postgres when we need concurrent writers.",
          "Prefer the fallback unless the provider is available.",
        ].join(" "),
      }],
    });

    assert.deepEqual(semantic(extraction, "user_preference"), []);
  });

  test("extracts independent preference and rejection clauses in one sentence", () => {
    const extraction = extract({
      turns: [{
        user_message: "For edge services, prefer bounded queues and never drop the request identifier from logs; both rules matter.",
      }],
    });

    assert.deepEqual(semantic(extraction, "user_preference").map((memory) => memory.content), [
      "For edge services, prefer bounded queues",
    ]);
    assert.deepEqual(semantic(extraction, "rejected_approach").map((memory) => memory.content), [
      "never drop the request identifier from logs",
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

  test("can extract an explicit sentence after quoted text", () => {
    const extraction = extract({
      turns: [{
        user_message: "I disagree with the sentence \"Prefer one huge review commit.\" For this work, split changes by behavior so each commit can be reverted.",
      }],
    });

    assert.deepEqual(semantic(extraction, "user_preference").map((memory) => memory.content), [
      "For this work, split changes by behavior so each commit can be reverted.",
    ]);
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

  test("rejects uncertain, open, hypothetical, and questionary decision claims", () => {
    const extraction = extract({
      turns: [
        { user_message: "I asked whether we chose PostgreSQL, but we have not decided." },
        { assistant_response: "People asked why we chose PostgreSQL, but the decision is still open." },
        { user_message: "It is unclear whether we chose PostgreSQL or SQLite." },
        { user_message: "We chose PostgreSQL for billing, but this is only a hypothetical example." },
        { assistant_response: "I think we chose PostgreSQL, but I have not verified it." },
      ],
    });

    assert.deepEqual(semantic(extraction, "decision"), []);
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

  test("retires only a prior decision with the same meaningful topic", () => {
    const extraction = extract({
      turns: [
        { user_message: "We decided to use PostgreSQL for billing because deployment is simple." },
        { user_message: "Instead, we chose SQLite for analytics because deployment is embedded." },
        { user_message: "We decided to use PostgreSQL for notifications." },
        { user_message: "We chose SQLite for notifications instead." },
      ],
    });

    const decisions = semantic(extraction, "decision");
    assert.equal(decisions.length, 4);
    assert.deepEqual(extraction.retiredEvidenceKeys, [
      decisions[2].evidence.key,
    ]);
  });

  test("shared rationales and generic subject words cannot retire distinct decisions", () => {
    for (const [earlier, later] of [
      ["We decided to use Redis for billing because reliability matters.", "Instead, we chose PostgreSQL for analytics because reliability matters."],
      ["We chose Redis for billing API because performance matters.", "Instead, we chose PostgreSQL for analytics API because performance matters."],
      ["We chose Redis for catalog invalidation.", "Instead, we chose PostgreSQL for inventory invalidation because losing invalidations is unacceptable."],
      ["We chose Redis because reliability matters.", "Instead, we chose PostgreSQL because reliability matters."],
      ["We chose Redis for catalog invalidation.", "Instead, we chose PostgreSQL because catalog invalidation was mentioned in the review."],
    ]) {
      const extraction = extract({ turns: [{ user_message: earlier }, { assistant_response: later }] });
      assert.equal(semantic(extraction, "decision").length, 2);
      assert.deepEqual(extraction.retiredEvidenceKeys, [], `${earlier} / ${later}`);
    }
  });

  test("an entity reference must identify one prior decision subject before retirement", () => {
    const extraction = extract({ turns: [
      { user_message: "We chose Redis for catalog invalidation." },
      { user_message: "We chose polling for inventory invalidation." },
      { assistant_response: "The decision changed after review: use PostgreSQL notifications instead, because losing invalidations is unacceptable." },
    ] });
    assert.equal(semantic(extraction, "decision").length, 3);
    assert.deepEqual(extraction.retiredEvidenceKeys, []);
  });

  test("only completion context can introduce an attributed decision", () => {
    for (const text of [
      "Perhaps we chose PostgreSQL for billing.",
      "The draft says we chose PostgreSQL for billing.",
      "In a hypothetical review, we chose PostgreSQL for billing.",
      "We chose PostgreSQL for billing, or maybe we did not.",
    ]) {
      for (const role of ["user_message", "assistant_response"]) {
        assert.deepEqual(semantic(extract({ turns: [{ [role]: text }] }), "decision"), [], text);
      }
    }
  });

  test("questions and hypothetical or quoted repeated failures do not infer repair goals", () => {
    for (const [first, second] of [
      ["Did the build fail?", "Did the build fail again?"],
      ["Did the build fail? Please inspect the logs.", "Did the build fail again? Please inspect the logs."],
      ["Suppose the build failed.", "Suppose the build failed again."],
      ["The example says \"The build failed.\"", "The example says \"The build failed again.\""],
    ]) {
      const extraction = extract({ turns: [{ assistant_response: first }, { assistant_response: second }] });
      assert.deepEqual(extraction.semanticMemories, [], `${first} / ${second}`);
    }
  });

  test("recognizes common decision reversal phrasing", () => {
    const extraction = extract({
      turns: [
        { user_message: "We decided to use PostgreSQL for billing." },
        { user_message: "We changed to SQLite for billing." },
        { user_message: "We decided to use Redis for caching." },
        { user_message: "We chose Memcached for caching instead." },
      ],
    });

    const decisions = semantic(extraction, "decision");
    assert.equal(decisions.length, 4);
    assert.equal(decisions[1].metadata.decisionStatus, "reversal");
    assert.equal(decisions[3].metadata.decisionStatus, "reversal");
    assert.deepEqual(extraction.retiredEvidenceKeys, [
      decisions[0].evidence.key,
      decisions[2].evidence.key,
    ]);
  });

  test("extracts initially chosen decisions and retires a linked contextual reversal", () => {
    const extraction = extract({
      sessionId: "catalog-reversal",
      turns: [
        { user_message: "We initially chose Redis for catalog invalidation." },
        { user_message: "The decision changed after the durability review: use PostgreSQL notifications instead, because losing invalidations is unacceptable." },
      ],
    });

    const decisions = semantic(extraction, "decision");
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].content, "Decision: Redis for catalog invalidation.");
    assert.equal(decisions[1].metadata.decisionStatus, "reversal");
    assert.deepEqual(extraction.retiredEvidenceKeys, [decisions[0].evidence.key]);
  });

  test("does not retire an unrelated decision after an adjacent contextual reversal", () => {
    const extraction = extract({
      turns: [
        { user_message: "We decided to use Redis for billing." },
        { user_message: "After review, we chose PostgreSQL notifications instead." },
      ],
    });

    const decisions = semantic(extraction, "decision");
    assert.equal(decisions.length, 2);
    assert.equal(decisions[1].metadata.decisionStatus, "reversal");
    assert.deepEqual(extraction.retiredEvidenceKeys, []);
  });

  test("attributes repeated failure goals to the selected assistant evidence", () => {
    const extraction = extract({
      sessionId: "failure-evidence",
      turns: [
        {
          source_record_id: "assistant-failure-1",
          source_revision: "assistant-revision-1",
          user_message: "Can you help with the build?",
          assistant_response: "The build failed.",
        },
        {
          source_record_id: "assistant-failure-2",
          user_message: "Please continue.",
          assistant_response: "The build failed again.",
        },
      ],
    });

    const goal = semantic(extraction, "assistant_goal")[0];
    assert.ok(goal);
    assert.equal(goal.sourceRecordId, "assistant-failure-2");
    assert.equal(goal.metadata.sourceRole, "assistant");
    assert.deepEqual(goal.metadata.sourceAttribution, {
      sessionId: "failure-evidence",
      sourceRecordId: "assistant-failure-2",
      sourceRole: "assistant",
    });
    assert.equal(goal.evidence.sourceRecordId, "assistant-failure-2");
    assert.equal(goal.evidence.revision, createHash("sha256")
      .update(JSON.stringify({ role: "assistant", text: "The build failed again." }))
      .digest("hex"));
  });

  test("extracts a completed decision after contextual wording", () => {
    const extraction = extract({
      turns: [{
        assistant_response: "After comparing compatibility and tooling, we chose Avro with a schema registry; the earlier JSON suggestion is not final.",
      }],
    });

    const decisions = semantic(extraction, "decision");
    assert.equal(decisions.length, 1);
    assert.match(decisions[0].content, /Avro with a schema registry/);
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

  test("changes fallback revision when the source record changes", () => {
    const first = extract({
      sessionId: "revision-session",
      turns: [{
        source_record_id: "record-1",
        user_message: "Always use fixtures. Extra context A.",
      }],
    });
    const second = extract({
      sessionId: "revision-session",
      turns: [{
        source_record_id: "record-1",
        user_message: "Always use fixtures. Extra context B.",
      }],
    });
    const firstPreference = semantic(first, "user_preference")[0];
    const secondPreference = semantic(second, "user_preference")[0];

    assert.equal(firstPreference.content, secondPreference.content);
    assert.notEqual(firstPreference.evidence.revision, secondPreference.evidence.revision);
    assert.equal(firstPreference.evidence.key, secondPreference.evidence.key);
  });

  test("attributes each assistant decision to its own source record", () => {
    const extraction = extract({ turns: [{
      source_record_id: "user-1",
      source_revision: "user-revision",
      user_message: "What did we choose?",
      assistant_response: "We chose Redis for billing. We chose Avro for serialization.",
      assistant_source_records: [
        { source_record_id: "assistant-1", source_revision: "assistant-revision-1", text: "We chose Redis for billing." },
        { source_record_id: "assistant-2", source_revision: "assistant-revision-2", text: "We chose Avro for serialization." },
      ],
    }] });
    const decisions = semantic(extraction, "decision");
    assert.equal(decisions.length, 2);
    assert.deepEqual(decisions.map((memory) => memory.evidence.sourceRecordId), ["assistant-1", "assistant-2"]);
    assert.deepEqual(decisions.map((memory) => memory.evidence.revision), ["assistant-revision-1", "assistant-revision-2"]);
    assert.deepEqual(decisions.map((memory) => memory.metadata.sourceAttribution.sourceRecordId), ["assistant-1", "assistant-2"]);
    assert.ok(decisions.every((memory) => memory.metadata.sourceAttribution.sourceRole === "assistant"));
    assert.ok(decisions.every((memory) => memory.metadata.verificationStatus === "unverified_assistant_claim"));
  });

  test("assistant record fallback revisions track only that record's text", () => {
    const turn = {
      source_record_id: "user-1",
      source_revision: "aggregate-revision",
      user_message: "What did we choose?",
      assistant_response: "Combined assistant text is a compatibility field.",
      assistant_source_records: [{ source_record_id: "assistant-1", text: "We chose Avro for serialization. Context A." }],
    };
    const first = semantic(extract({ turns: [turn] }), "decision")[0];
    const changedUser = semantic(extract({ turns: [{ ...turn, user_message: "Different user context", source_revision: "aggregate-revision-2" }] }), "decision")[0];
    const changedAssistant = semantic(extract({ turns: [{ ...turn, assistant_source_records: [{ source_record_id: "assistant-1", text: "We chose Avro for serialization. Context B." }] }] }), "decision")[0];
    assert.ok(first);
    assert.equal(first.evidence.key, changedUser.evidence.key);
    assert.equal(first.evidence.revision, changedUser.evidence.revision);
    assert.equal(first.evidence.key, changedAssistant.evidence.key);
    assert.notEqual(first.evidence.revision, changedAssistant.evidence.revision);
    assert.equal(first.evidence.revision, createHash("sha256")
      .update(JSON.stringify({ role: "assistant", text: "We chose Avro for serialization. Context A." }))
      .digest("hex"));
  });

  test("authoritative assistant records cannot replay stale combined text", () => {
    const extraction = extract({ turns: [{
      user_message: "What did we choose?",
      assistant_response: "We chose Redis for billing.",
      assistant_source_records: [],
    }] });
    assert.deepEqual(extraction.semanticMemories, []);
  });

  test("inferred repair goals use the actual assistant failure record", () => {
    const extraction = extract({ turns: [1, 2].map((index) => ({
      source_record_id: `user-${index}`,
      source_revision: `user-revision-${index}`,
      user_message: "Please continue.",
      assistant_response: "Combined compatibility response.",
      assistant_source_records: [
        { source_record_id: `assistant-${index}`, source_revision: `assistant-revision-${index}`, text: `The build failed${index === 2 ? " again" : ""}.` },
        { source_record_id: `assistant-note-${index}`, text: "I will investigate." },
      ],
    })) });
    const goal = semantic(extraction, "assistant_goal")[0];
    assert.ok(goal);
    assert.equal(goal.evidence.sourceRecordId, "assistant-2");
    assert.equal(goal.evidence.revision, "assistant-revision-2");
    assert.equal(goal.metadata.sourceAttribution.sourceRole, "assistant");
  });

  test("local inference enhancement preserves extraction retirement keys", async () => {
    const extraction = {
      episodeDigest: {
        sessionId: "enhancement-session",
        summary: "Deterministic summary",
        actions: [],
        decisions: [],
        learnings: [],
        openItems: [],
        themes: [],
      },
      semanticMemories: [],
      retiredEvidenceKeys: ["prior-evidence-key"],
    };
    const enhanced = await enhanceSessionExtractionWithLocalInference({
      config: {
        enabled: true,
        model: "fixture-model",
        baseUrl: "http://127.0.0.1:1234",
      },
      sessionArtifacts: {
        session: {},
        checkpoints: [],
        turns: [],
        files: [],
        refs: [],
      },
      extraction,
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ summary: "Model summary" }),
          },
        }],
      }), { status: 200 }),
    });

    assert.deepEqual(enhanced.retiredEvidenceKeys, ["prior-evidence-key"]);
  });
});

test("a reversal retires every corroborating old source while retaining corroborating current sources", () => {
  const turns = [
    { turn_index: 1, source_record_id: "u1", user_message: "We chose Redis for catalog invalidation.", assistant_response: "", assistant_source_records: [{ source_record_id: "a1", text: "We chose Redis for catalog invalidation." }] },
    { turn_index: 2, source_record_id: "u2", user_message: "We switched to PostgreSQL for catalog invalidation because durability matters.", assistant_response: "", assistant_source_records: [{ source_record_id: "a2", text: "We switched to PostgreSQL for catalog invalidation because durability matters." }] },
  ];
  const result = extractSessionMemories({
    sessionId: "corroborated-reversal", repository: "owner/catalog",
    sessionArtifacts: { session: {}, checkpoints: [], files: [], refs: [], turns },
    workspace: { workspace: {} },
  });
  const retired = new Set(result.retiredEvidenceKeys);
  assert.deepEqual(result.semanticMemories.filter((row) => retired.has(row.evidence.key)).map((row) => row.evidence.sourceRecordId).sort(), ["a1", "u1"]);
  assert.deepEqual(result.semanticMemories.filter((row) => !retired.has(row.evidence.key)).map((row) => row.evidence.sourceRecordId).sort(), ["a2", "u2"]);
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

  test("recognizes all my projects as an explicit global scope", () => {
    assert.deepEqual(classifySemanticMemory({
      type: "user_preference",
      repository: "owner/repo",
      content: "Across all my projects, I prefer plain ESM.",
    }), {
      scope: MEMORY_SCOPE.GLOBAL,
      repository: null,
      metadata: {
        originRepository: "owner/repo",
      },
    });
  });
});
