import { describe, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { LoreDb } from "../../lib/db.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";
import { buildFixtureConfig } from "../helpers/fixture-config.mjs";

const TEST_NOW = new Date("2024-03-27T12:00:00.000Z");

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-temporal-provenance-"));
}

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function makeDb(tempHome) {
  const loreDb = new LoreDb(buildFixtureConfig(tempHome, {
    now: TEST_NOW,
    rollout: {
      memoryOperations: true,
      temporalQueryNormalization: true,
    },
  }));
  loreDb.initialize();
  return loreDb;
}

function yesterdayDateKey() {
  const d = new Date(TEST_NOW);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const TEST_REPO = "owner/test-repo";

// "what did we do yesterday" is a pure temporal recall: no content terms extracted
const PURE_TEMPORAL_PROMPT = "what did we do yesterday";

function seedDaySummary(loreDb, { date = yesterdayDateKey(), repository = TEST_REPO } = {}) {
  loreDb.upsertEpisodeDigest({
    id: `ep-${date}`,
    sessionId: `session-${date}`,
    repository,
    summary: "Implemented the feature for that day.",
    actions: ["wrote code"],
    decisions: [],
    learnings: [],
    filesChanged: [],
    refs: [],
    significance: 7,
    themes: ["feature"],
    openItems: [],
    dateKey: date,
    createdAt: `${date}T10:00:00.000Z`,
  });
  loreDb.refreshDaySummary({ date, repository });
}

function seedEpisodeOnly(loreDb, { date = yesterdayDateKey(), repository = TEST_REPO } = {}) {
  loreDb.upsertEpisodeDigest({
    id: `ep-only-${date}`,
    sessionId: `session-only-${date}`,
    repository,
    summary: "Refactored the pipeline on that day.",
    actions: ["refactored"],
    decisions: [],
    learnings: [],
    filesChanged: [],
    refs: [],
    significance: 5,
    themes: ["refactor"],
    openItems: [],
    dateKey: date,
    createdAt: `${date}T09:00:00.000Z`,
  });
  // No refreshDaySummary — episode exists but no day_summary row for this date
}

describe("temporal provenance — trace.temporal contract", () => {
  test("trace.temporal is null when hasTemporalSignal is false", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      const { trace } = loreDb.explainPromptContext({
        prompt: "what are my open commitments",
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: false,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });
      assert.equal(trace.temporal, null);
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("high confidence when day summary is included", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedDaySummary(loreDb);

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.ok(trace.temporal, "trace.temporal should be present");
      assert.equal(trace.temporal.confidence, "high");
      assert.equal(trace.temporal.source, "day_summary");
      assert.equal(trace.temporal.verifierUsed, false);
      assert.equal(trace.temporal.verifierReason, null);
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("medium confidence when episodes included but no day summary", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedEpisodeOnly(loreDb);

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.ok(trace.temporal, "trace.temporal should be present");
      assert.equal(trace.temporal.confidence, "medium");
      assert.equal(trace.temporal.source, "episode_fallback");
      assert.equal(trace.temporal.verifierUsed, false);
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("none confidence when temporal signal but no usable evidence", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      // No data seeded — nothing to find for the date

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.ok(trace.temporal, "trace.temporal should be present");
      assert.equal(trace.temporal.confidence, "none");
      assert.equal(trace.temporal.source, "none");
      assert.equal(trace.temporal.verifierUsed, false);
      assert.equal(trace.temporal.verifierReason, "missing_day_summary");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("verifierReason is missing_day_summary when no day_summary row exists", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.equal(trace.temporal?.verifierReason, "missing_day_summary");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("scope is local when allowCrossRepoFallback is false", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedDaySummary(loreDb);

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.equal(trace.temporal?.scope, "local");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("scope is cross_repo when allowCrossRepoFallback is true and pure temporal recall", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedDaySummary(loreDb);

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: true,
        },
      });

      assert.equal(trace.temporal?.scope, "cross_repo");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("verifierUsed is false when day summary evidence exists", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedDaySummary(loreDb);

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.equal(trace.temporal?.verifierUsed, false);
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("unresolved temporal dates use a distinct trace reason", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      const sessionStore = {
        findSessionsByDate() {
          throw new Error("temporal verifier should not run without a normalized date");
        },
      };

      const { text, trace } = loreDb.explainPromptContext({
        prompt: "what did we do last week",
        repository: TEST_REPO,
        sessionStore,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.equal(trace.temporal?.date, null);
      assert.equal(trace.temporal?.source, "none");
      assert.equal(trace.temporal?.confidence, "none");
      assert.equal(trace.temporal?.verifierUsed, false);
      assert.equal(trace.temporal?.verifierReason, "unresolved_temporal_date");
      assert.equal(trace.lookups.daySummary.reason, "unresolved_temporal_date");
      assert.equal(trace.lookups.temporalVerifier.reason, "unresolved_temporal_date");
      assert.ok(!text.includes("Temporal recall:"), "unresolved dates should not render a provenance note");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("provenance note appears in injected context text before temporal sections", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedDaySummary(loreDb);

      const { text } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.ok(text.includes("Temporal recall:"), "provenance note should appear in text");
      assert.ok(text.includes("high confidence"), "note should include confidence level");
      assert.ok(text.includes("day summary"), "note should identify source as day summary");

      const provenanceIndex = text.indexOf("Temporal recall:");
      const summaryIndex = text.indexOf("## Relevant Day Summary");
      assert.ok(
        provenanceIndex < summaryIndex,
        "provenance note must precede the Relevant Day Summary section",
      );
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("no provenance note when there is no temporal evidence", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);

      const { text } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.ok(!text.includes("Temporal recall:"), "no provenance note when no evidence is found");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("episode fallback provenance note appears when only episodes are available", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedEpisodeOnly(loreDb);

      const { text, trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.ok(text.includes("Temporal recall:"), "provenance note should appear in text");
      assert.ok(text.includes("medium confidence"), "note should say medium confidence");
      assert.ok(text.includes("episode fallback"), "note should identify source as episode fallback");

      const provenanceIndex = text.indexOf("Temporal recall:");
      const priorWorkIndex = text.indexOf("## Relevant Prior Work");
      assert.ok(
        provenanceIndex < priorWorkIndex,
        "provenance note must precede the Relevant Prior Work section",
      );
      assert.equal(trace.temporal?.confidence, "medium");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("existing lookups.daySummary and lookups.localEpisodes shapes are preserved", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedDaySummary(loreDb);

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      // daySummary lookup fields intact
      assert.ok("date" in trace.lookups.daySummary, "daySummary.date should exist");
      assert.ok(Array.isArray(trace.lookups.daySummary.rows), "daySummary.rows should be an array");
      assert.ok(Array.isArray(trace.lookups.daySummary.includedRows), "daySummary.includedRows should be an array");
      assert.ok("included" in trace.lookups.daySummary, "daySummary.included should exist");

      // localEpisodes lookup fields intact
      assert.ok("includeOtherRepositories" in trace.lookups.localEpisodes, "localEpisodes.includeOtherRepositories should exist");
      assert.ok(Array.isArray(trace.lookups.localEpisodes.includedRows), "localEpisodes.includedRows should be an array");

      // trace.temporal is additive and does not replace existing lookup shapes
      assert.ok(trace.temporal !== undefined, "trace.temporal should be defined");
      assert.ok(trace.lookups.daySummary !== undefined, "lookups.daySummary should still be present");
      assert.ok(trace.lookups.localEpisodes !== undefined, "lookups.localEpisodes should still be present");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("low confidence when raw session-store verification supplies the answer", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      const sessionStore = {
        findSessionsByDate({ dateKey, repository, includeOtherRepositories, limit }) {
          assert.equal(dateKey, yesterdayDateKey());
          assert.equal(repository, TEST_REPO);
          assert.equal(includeOtherRepositories, false);
          assert.equal(limit, 2);
          return [{
            session_id: "verified-session",
            repository: TEST_REPO,
            branch: "main",
            created_at: `${dateKey}T08:00:00.000Z`,
            updated_at: `${dateKey}T09:00:00.000Z`,
            summary: "Verified raw session history summary",
            workspaceSummary: "Verified workspace summary",
          }];
        },
      };

      const { text, trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        sessionStore,
        limit: 2,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.equal(trace.temporal?.source, "session_store_verifier");
      assert.equal(trace.temporal?.confidence, "low");
      assert.equal(trace.temporal?.verifierUsed, true);
      assert.equal(trace.temporal?.verifierReason, "missing_day_summary");
      assert.equal(trace.lookups.temporalVerifier.reason, null);
      assert.equal(trace.lookups.temporalVerifier.includedRows.length, 1);
      assert.ok(text.includes("low confidence, verified from raw session history"), "should render verifier provenance note");
      assert.ok(text.includes("## Verified Session History"), "should include verified session history section");
      assert.ok(text.includes("Verified workspace summary"), "should render verifier session content");
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("does not run temporal verifier when primary temporal evidence already exists", { skip: SKIP_NO_FTS5 }, () => {
    const tempHome = makeTempDir();
    try {
      const loreDb = makeDb(tempHome);
      seedDaySummary(loreDb);
      let verifierCalls = 0;
      const sessionStore = {
        findSessionsByDate() {
          verifierCalls += 1;
          return [];
        },
      };

      const { trace } = loreDb.explainPromptContext({
        prompt: PURE_TEMPORAL_PROMPT,
        repository: TEST_REPO,
        sessionStore,
        promptNeed: {
          hasTemporalSignal: true,
          identityOnly: false,
          directAddressed: false,
          wantsContinuity: false,
          wantsStyleContext: false,
          wantsCrossRepoExamples: false,
          wantsRepoLocalTaskContext: true,
          allowCrossRepoFallback: false,
        },
      });

      assert.equal(verifierCalls, 0);
      assert.equal(trace.lookups.temporalVerifier.reason, "primary_temporal_evidence_available");
      assert.equal(trace.lookups.temporalVerifier.includedRows.length, 0);
      loreDb.close();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
