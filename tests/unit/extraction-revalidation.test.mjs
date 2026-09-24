import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  EXTRACTOR_VERSION,
  classifyStandingContent,
  revalidateGeneratedMemory,
} from "../../lib/sessions/extraction-revalidation.mjs";
import {
  rollbackExtractionRevalidation,
  runExtractionRevalidation,
} from "../../lib/memory/extraction-revalidation.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

function ruleExtractedRow(overrides = {}) {
  return {
    id: "legacy-1",
    type: "rejected_approach",
    content: "placeholder",
    scope: "global",
    repository: null,
    metadata: { source: "rule_extractor" },
    scopeSource: "auto",
    tags: [],
    ...overrides,
  };
}

// Real rows this task was filed against: all active, scope: "global",
// classified by an August-2026 extractor. The current grammar produces
// nothing for any of them (see tests/unit/rule-extractor.test.mjs for the
// live-extraction side of the same fix).
const LEGACY_EXAMPLES = [
  {
    type: "rejected_approach",
    content: "Review git diff --cached, falling back to git diff if nothing is staged. Return every actionable finding as path:line with severity, covering logic bugs, security issues, error-handling gaps, and edge cases. Do not edit files.",
  },
  {
    type: "rejected_approach",
    content: "Draft a conventional commit message from git diff --cached: type(scope): imperative subject, lowercase, no trailing period. Add a short body only when the diff needs explanation. Output only the message; do not run git commit.",
  },
  {
    type: "rejected_approach",
    content: "Would there be a better language to use rather than Go (or Typescript - in regards to the source material)? I just don't like TS CLI's",
  },
  {
    type: "rejected_approach",
    content: "Yes can we build a web search tool which uses web fetch and DDG to get results so I can ask you something and you can search the internet for an answer if you don't already know it",
  },
  {
    type: "rejected_approach",
    content: "I would like you to review the go code in this project and tell me if there is anything which needs improving or fixing. Do not make any code changes",
  },
  {
    type: "rejected_approach",
    content: "Don't forget to monitor for review comments too",
  },
  {
    type: "user_preference",
    content: "what do I prefer?",
  },
  {
    type: "user_preference",
    content: "Always on, we want to make sure every plan is fully scoped and understood by both the user and the model",
  },
];

describe("classifyStandingContent (pure grammar replay)", () => {
  for (const example of LEGACY_EXAMPLES) {
    test(`recognizes nothing standing in: ${example.content.slice(0, 60)}...`, () => {
      assert.equal(classifyStandingContent(example.content).size, 0);
    });
  }

  test("still recognizes a legitimate standing rejection", () => {
    assert.ok(classifyStandingContent("Never commit secrets to the repo").has("rejected_approach"));
  });
});

describe("revalidateGeneratedMemory (pure)", () => {
  for (const example of LEGACY_EXAMPLES) {
    test(`rejects the legacy row: ${example.content.slice(0, 60)}...`, () => {
      const result = revalidateGeneratedMemory(ruleExtractedRow(example));
      assert.equal(result.verdict, "reject");
      assert.equal(result.reason, "no_longer_matches_grammar");
    });
  }

  test("keeps a legitimate legacy directive the grammar still recognizes", () => {
    const result = revalidateGeneratedMemory(ruleExtractedRow({
      type: "rejected_approach",
      content: "Never commit secrets to the repo",
      scope: "repo",
      repository: "acme/widgets",
    }));
    assert.equal(result.verdict, "keep");
    assert.equal(result.reason, "still_matches_current_grammar");
  });

  test("never touches a manual/explicit write, regardless of content or version", () => {
    const bySource = revalidateGeneratedMemory(ruleExtractedRow({
      type: "user_preference",
      content: "what do I prefer?",
      metadata: { source: "memory_save" },
    }));
    assert.equal(bySource.verdict, "keep");
    assert.equal(bySource.reason, "manual_write_excluded");

    const byScopeSource = revalidateGeneratedMemory(ruleExtractedRow({
      type: "user_preference",
      content: "what do I prefer?",
      scopeSource: "manual",
    }));
    assert.equal(byScopeSource.verdict, "keep");
    assert.equal(byScopeSource.reason, "manual_write_excluded");
  });

  test("keeps a row already stamped with the current extractor version", () => {
    const result = revalidateGeneratedMemory(ruleExtractedRow({
      type: "user_preference",
      content: "what do I prefer?",
      metadata: { source: "rule_extractor", extractorVersion: EXTRACTOR_VERSION },
    }));
    assert.equal(result.verdict, "keep");
    assert.equal(result.reason, "current_extractor_version");
  });

  test("demotes a global row with an originRepository when global scope is no longer supported", () => {
    const result = revalidateGeneratedMemory(ruleExtractedRow({
      type: "user_preference",
      content: "Always use tabs for indentation",
      scope: "global",
      repository: null,
      metadata: { source: "rule_extractor", originRepository: "acme/widgets" },
    }));
    assert.equal(result.verdict, "demote");
    assert.equal(result.targetScope, "repo");
    assert.equal(result.targetRepository, "acme/widgets");
  });

  test("rejects (rather than demotes) a global row with no repository provenance", () => {
    const result = revalidateGeneratedMemory(ruleExtractedRow({
      type: "user_preference",
      content: "Always use tabs for indentation",
      scope: "global",
      repository: null,
      metadata: { source: "rule_extractor" },
    }));
    assert.equal(result.verdict, "reject");
    assert.equal(result.reason, "global_scope_no_longer_supported_no_origin");
  });

  test("reclassifies a row whose type the current grammar assigns differently", () => {
    const result = revalidateGeneratedMemory(ruleExtractedRow({
      type: "directive",
      content: "You must never store customer PII in logs",
      scope: "repo",
      repository: "acme/widgets",
    }));
    assert.equal(result.verdict, "reclassify");
    assert.equal(result.reclassifiedType, "rejected_approach");
  });
});

describe("runExtractionRevalidation / rollbackExtractionRevalidation (DB-backed)", () => {
  test("shadow mode reports candidates without mutating storage", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "legacy-reject",
        type: "user_preference",
        content: "what do I prefer?",
        scope: "global",
        repository: null,
        confidence: 0.78,
        metadata: { source: "rule_extractor" },
      });

      const result = runExtractionRevalidation({ db, mode: "shadow", runId: "run-shadow" });
      assert.equal(result.mode, "shadow");
      assert.equal(result.rejectCount, 1);
      assert.equal(result.appliedCount, 0);

      const row = db.db.prepare("SELECT superseded_by, content FROM semantic_memory WHERE id = ?").get("legacy-reject");
      assert.equal(row.superseded_by, null, "shadow mode must not mutate the row");
      assert.equal(row.content, "what do I prefer?");
    } finally {
      cleanup();
    }
  });

  test("apply supersedes a rejected row without creating a suppression, and rollback restores it exactly", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "legacy-reject",
        type: "rejected_approach",
        content: "Don't forget to monitor for review comments too",
        scope: "global",
        repository: null,
        confidence: 0.76,
        metadata: { source: "rule_extractor" },
      });

      const result = runExtractionRevalidation({ db, mode: "apply", runId: "run-apply-reject" });
      assert.equal(result.rejectCount, 1);
      assert.equal(result.appliedCount, 1);
      assert.equal(result.marker, "extractor-revalidation:run-apply-reject");

      const applied = db.db.prepare("SELECT superseded_by, content FROM semantic_memory WHERE id = ?").get("legacy-reject");
      assert.equal(applied.superseded_by, "extractor-revalidation:run-apply-reject");
      assert.equal(applied.content, "Don't forget to monitor for review comments too", "content is preserved, not deleted");

      const suppressionCount = db.db.prepare("SELECT COUNT(*) n FROM memory_suppression WHERE memory_id = ?").get("legacy-reject").n;
      assert.equal(suppressionCount, 0, "rejecting a stale extraction must never create a memory_suppression row");

      const rolled = rollbackExtractionRevalidation({
        db,
        marker: "extractor-revalidation:run-apply-reject",
        actor: "operator",
        reason: "verified false positive",
      });
      assert.deepEqual(rolled.restoredRejectedIds, ["legacy-reject"]);

      const restored = db.db.prepare("SELECT superseded_by, content FROM semantic_memory WHERE id = ?").get("legacy-reject");
      assert.equal(restored.superseded_by, null);
      assert.equal(restored.content, "Don't forget to monitor for review comments too");
    } finally {
      cleanup();
    }
  });

  test("manual rows are never touched even when their content matches nothing in the current grammar", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "manual-row",
        type: "user_preference",
        content: "what do I prefer?",
        scope: "global",
        repository: null,
        confidence: 0.9,
        metadata: { source: "memory_save" },
      });
      db.insertSemanticMemory({
        id: "legacy-row",
        type: "user_preference",
        content: "what do I prefer?",
        scope: "global",
        repository: "acme/other",
        confidence: 0.78,
        metadata: { source: "rule_extractor" },
      });

      const result = runExtractionRevalidation({ db, mode: "apply", runId: "run-manual-safe" });
      const touchedIds = result.items.map((item) => item.memoryId);
      assert.ok(!touchedIds.includes("manual-row"), "manual rows must never appear as candidates");

      const manualRow = db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id = ?").get("manual-row");
      assert.equal(manualRow.superseded_by, null);
    } finally {
      cleanup();
    }
  });

  test("dry run leaves a demotion candidate's scope untouched", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "global-tabs",
        type: "user_preference",
        content: "Always use tabs for indentation",
        scope: "global",
        repository: null,
        confidence: 0.78,
        metadata: { source: "rule_extractor", originRepository: "acme/widgets" },
      });

      const result = runExtractionRevalidation({ db, mode: "shadow", runId: "run-shadow-demote" });
      assert.equal(result.demoteCount, 1);

      const row = db.db.prepare("SELECT scope, repository, scope_source FROM semantic_memory WHERE id = ?").get("global-tabs");
      assert.equal(row.scope, "global");
      assert.equal(row.repository, null);
      assert.equal(row.scope_source, "auto");
    } finally {
      cleanup();
    }
  });

  test("demotes a global row with an originRepository, and rollback restores global scope", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "global-tabs",
        type: "user_preference",
        content: "Always use tabs for indentation",
        scope: "global",
        repository: null,
        confidence: 0.78,
        metadata: { source: "rule_extractor", originRepository: "acme/widgets" },
      });

      const result = runExtractionRevalidation({ db, mode: "apply", runId: "run-apply-demote" });
      assert.equal(result.demoteCount, 1);

      const demoted = db.db.prepare("SELECT scope, repository, scope_source FROM semantic_memory WHERE id = ?").get("global-tabs");
      assert.equal(demoted.scope, "repo");
      assert.equal(demoted.repository, "acme/widgets");
      assert.equal(demoted.scope_source, "manual");

      const audit = db.db.prepare("SELECT action, previous_scope, next_scope, source FROM scope_override_audit WHERE target_id = ?").get("global-tabs");
      assert.equal(audit.action, "set");
      assert.equal(audit.previous_scope, "global");
      assert.equal(audit.next_scope, "repo");
      assert.equal(audit.source, "extractor-revalidation:run-apply-demote");

      rollbackExtractionRevalidation({
        db,
        marker: "extractor-revalidation:run-apply-demote",
        actor: "operator",
        reason: "keep global for now",
      });

      const restored = db.db.prepare("SELECT scope, repository, scope_source FROM semantic_memory WHERE id = ?").get("global-tabs");
      assert.equal(restored.scope, "global");
      assert.equal(restored.repository, null);
      assert.equal(restored.scope_source, "auto");
    } finally {
      cleanup();
    }
  });

  test("reclassifies a row's type, and rollback restores the original type", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "should-be-rejection",
        type: "directive",
        content: "You must never store customer PII in logs",
        scope: "repo",
        repository: "acme/widgets",
        confidence: 0.78,
        metadata: { source: "rule_extractor" },
      });

      const result = runExtractionRevalidation({ db, mode: "apply", runId: "run-apply-reclassify" });
      assert.equal(result.reclassifyCount, 1);

      const reclassified = db.db.prepare("SELECT type FROM semantic_memory WHERE id = ?").get("should-be-rejection");
      assert.equal(reclassified.type, "rejected_approach");

      rollbackExtractionRevalidation({
        db,
        marker: "extractor-revalidation:run-apply-reclassify",
        actor: "operator",
        reason: "keep original type",
      });

      const restored = db.db.prepare("SELECT type FROM semantic_memory WHERE id = ?").get("should-be-rejection");
      assert.equal(restored.type, "directive");
    } finally {
      cleanup();
    }
  });

  test("a row already at the current extractor version is not a candidate", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "current-version",
        type: "user_preference",
        content: "what do I prefer?",
        scope: "global",
        repository: null,
        confidence: 0.78,
        metadata: { source: "rule_extractor", extractorVersion: EXTRACTOR_VERSION },
      });

      const candidates = db.listExtractionRevalidationCandidates({ extractorVersion: EXTRACTOR_VERSION });
      assert.deepEqual(candidates.map((row) => row.id), []);
    } finally {
      cleanup();
    }
  });

  test("apply never creates any memory_suppression row across mixed verdicts", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, cleanup } = await withFixtureDb();
    try {
      db.insertSemanticMemory({
        id: "reject-me",
        type: "user_preference",
        content: "what do I prefer?",
        scope: "global",
        repository: null,
        confidence: 0.78,
        metadata: { source: "rule_extractor" },
      });
      db.insertSemanticMemory({
        id: "demote-me",
        type: "user_preference",
        content: "Always use tabs for indentation",
        scope: "global",
        repository: null,
        confidence: 0.78,
        metadata: { source: "rule_extractor", originRepository: "acme/widgets" },
      });
      db.insertSemanticMemory({
        id: "reclassify-me",
        type: "directive",
        content: "You must never store customer PII in logs",
        scope: "repo",
        repository: "acme/widgets",
        confidence: 0.78,
        metadata: { source: "rule_extractor" },
      });
      db.insertSemanticMemory({
        id: "keep-me",
        type: "rejected_approach",
        content: "Never commit secrets to the repo",
        scope: "repo",
        repository: "acme/widgets",
        confidence: 0.76,
        metadata: { source: "rule_extractor" },
      });

      const result = runExtractionRevalidation({ db, mode: "apply", runId: "run-mixed" });
      assert.equal(result.rejectCount, 1);
      assert.equal(result.demoteCount, 1);
      assert.equal(result.reclassifyCount, 1);
      assert.equal(result.keepCount, 1);

      const suppressions = db.db.prepare("SELECT COUNT(*) n FROM memory_suppression").get().n;
      assert.equal(suppressions, 0);

      const kept = db.db.prepare("SELECT superseded_by, type, scope FROM semantic_memory WHERE id = ?").get("keep-me");
      assert.equal(kept.superseded_by, null);
      assert.equal(kept.type, "rejected_approach");
      assert.equal(kept.scope, "repo");
    } finally {
      cleanup();
    }
  });

  // Real pre-existing rule-extracted rows predate source-stamping: their
  // metadata_json is `{}` or `{"originRepository": "..."}` with no `source`
  // key at all. A strict `metadata.source = 'rule_extractor'` predicate would
  // silently skip every one of them forever, so candidate selection must also
  // recognize an unlabeled row that is still tied to its originating
  // turn/session and was never manually scoped.
  describe("legacy rows with no metadata.source at all (real-world shape)", () => {
    test("a legacy row with metadata {} and a turn index is a candidate and gets rejected", { skip: SKIP_NO_FTS5 }, async () => {
      const { db, cleanup } = await withFixtureDb();
      try {
        db.insertSemanticMemory({
          id: "unlabeled-legacy",
          type: "rejected_approach",
          content: "Don't forget to monitor for review comments too",
          scope: "repo",
          repository: "acme/repo1",
          confidence: 0.76,
          sourceSessionId: "session-legacy-1",
          sourceTurnIndex: 4,
          metadata: {},
        });

        const candidates = db.listExtractionRevalidationCandidates({ extractorVersion: EXTRACTOR_VERSION });
        assert.deepEqual(candidates.map((row) => row.id), ["unlabeled-legacy"]);

        const result = runExtractionRevalidation({ db, mode: "apply", runId: "run-unlabeled" });
        assert.equal(result.rejectCount, 1);

        const row = db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id = ?").get("unlabeled-legacy");
        assert.equal(row.superseded_by, "extractor-revalidation:run-unlabeled");
      } finally {
        cleanup();
      }
    });

    test("{\"originRepository\": ...} global rows with no source key are demoted or rejected per the rules", { skip: SKIP_NO_FTS5 }, async () => {
      const { db, cleanup } = await withFixtureDb();
      try {
        db.insertSemanticMemory({
          id: "unlabeled-demote",
          type: "user_preference",
          content: "Always use tabs for indentation",
          scope: "global",
          repository: null,
          confidence: 0.78,
          sourceSessionId: "session-legacy-2",
          sourceTurnIndex: 7,
          metadata: { originRepository: "acme/widgets" },
        });
        db.insertSemanticMemory({
          id: "unlabeled-reject",
          type: "user_preference",
          content: "what do I prefer?",
          scope: "global",
          repository: null,
          confidence: 0.78,
          sourceSessionId: "session-legacy-3",
          sourceTurnIndex: 2,
          metadata: { originRepository: "acme/other" },
        });

        const candidateIds = db.listExtractionRevalidationCandidates({ extractorVersion: EXTRACTOR_VERSION })
          .map((row) => row.id).sort();
        assert.deepEqual(candidateIds, ["unlabeled-demote", "unlabeled-reject"]);

        const result = runExtractionRevalidation({ db, mode: "apply", runId: "run-unlabeled-scope" });
        assert.equal(result.demoteCount, 1);
        assert.equal(result.rejectCount, 1);

        const demoted = db.db.prepare("SELECT scope, repository, scope_source FROM semantic_memory WHERE id = ?").get("unlabeled-demote");
        assert.equal(demoted.scope, "repo");
        assert.equal(demoted.repository, "acme/widgets");
        assert.equal(demoted.scope_source, "manual");

        const rejected = db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id = ?").get("unlabeled-reject");
        assert.equal(rejected.superseded_by, "extractor-revalidation:run-unlabeled-scope");
      } finally {
        cleanup();
      }
    });

    test("source 'pi' or 'lore_retain' rows with no turn index are never touched", { skip: SKIP_NO_FTS5 }, async () => {
      const { db, cleanup } = await withFixtureDb();
      try {
        db.insertSemanticMemory({
          id: "pi-manual",
          type: "rejected_approach",
          content: "Never commit secrets to the repo",
          scope: "repo",
          repository: "acme/repo1",
          confidence: 0.9,
          metadata: { source: "pi" },
        });
        db.insertSemanticMemory({
          id: "lore-retain-manual",
          type: "user_preference",
          content: "what do I prefer?",
          scope: "global",
          repository: null,
          confidence: 0.9,
          metadata: { source: "lore_retain" },
        });

        const candidates = db.listExtractionRevalidationCandidates({ extractorVersion: EXTRACTOR_VERSION });
        assert.deepEqual(candidates.map((row) => row.id), []);

        runExtractionRevalidation({ db, mode: "apply", runId: "run-manual-sources" });

        const piRow = db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id = ?").get("pi-manual");
        const retainRow = db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id = ?").get("lore-retain-manual");
        assert.equal(piRow.superseded_by, null);
        assert.equal(retainRow.superseded_by, null);
      } finally {
        cleanup();
      }
    });
  });
});
