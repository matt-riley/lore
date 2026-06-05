import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  appendPromptTemporalRecallIntro,
  setPromptTemporalVerifierTraceState,
} from "../../lib/db-temporal-recall.mjs";
import {
  appendPromptCrossRepoHintsSection,
  appendPromptTemporalVerifierSection,
} from "../../lib/db-temporal-sections.mjs";

function buildTrace() {
  return {
    lookups: {
      crossRepoHints: {},
      temporalVerifier: {},
    },
    omissions: [],
    output: {
      sectionTitles: [],
    },
  };
}

describe("db-temporal", () => {
  test("appendPromptTemporalRecallIntro records day-summary confidence", () => {
    const lines = [];
    const trace = buildTrace();

    appendPromptTemporalRecallIntro(lines, trace, {
      need: { hasTemporalSignal: true },
      temporalDate: "2026-06-05",
      allowCrossRepoFallback: false,
      pureTemporalRecall: false,
      hasIncludedDaySummary: true,
      hasIncludedEpisodes: false,
      temporalVerifierRows: [],
      daySummaryReason: null,
    });

    assert.deepEqual(lines, [
      "Temporal recall: high confidence via day summary (2026-06-05, local).",
    ]);
    assert.deepEqual(trace.temporal, {
      date: "2026-06-05",
      source: "day_summary",
      confidence: "high",
      scope: "local",
      verifierUsed: false,
      verifierReason: null,
    });
  });

  test("setPromptTemporalVerifierTraceState records serialized verifier rows", () => {
    const trace = buildTrace();

    setPromptTemporalVerifierTraceState({
      trace,
      repository: "fixture-repo",
      sessionStore: {},
      temporalDate: "2026-06-05",
      pureTemporalRecall: true,
      temporalVerifierEnabled: true,
      shouldRunTemporalVerifier: true,
      temporalVerifierRows: [{
        session_id: "session-1",
        source_type: "history",
        repository: "other-repo",
        updated_at: "2026-06-05T10:00:00.000Z",
        summary: " Investigated temporal fallback ",
      }],
    });

    assert.equal(trace.lookups.temporalVerifier.enabled, true);
    assert.equal(trace.lookups.temporalVerifier.rows.length, 1);
    assert.deepEqual(trace.lookups.temporalVerifier.rows[0], {
      sessionId: "session-1",
      sourceType: "history",
      repository: "other-repo",
      updatedAt: "2026-06-05T10:00:00.000Z",
      crossRepo: true,
      excerpt: "Investigated temporal fallback",
    });
    assert.equal(trace.lookups.temporalVerifier.reason, undefined);
  });

  test("appendPromptTemporalVerifierSection includes verified history rows", () => {
    const lines = [];
    const trace = buildTrace();
    const temporalVerifierRows = [{
      summary: "Reviewed yesterday's trace output",
      updated_at: "2026-06-05T10:00:00.000Z",
      repository: "fixture-repo",
      currentRepository: "fixture-repo",
      sessionStoreUpdatedAt: "2026-06-05T10:00:00.000Z",
    }];

    appendPromptTemporalVerifierSection(lines, trace, {
      repository: "fixture-repo",
      temporalVerifierRows,
      shouldRunTemporalVerifier: true,
      temporalDate: "2026-06-05",
    });

    assert.deepEqual(lines, [
      "## Verified Session History",
      "",
      "- 2026-06-05: Reviewed yesterday's trace output",
    ]);
    assert.equal(trace.lookups.temporalVerifier.includedRows.length, 1);
    assert.deepEqual(trace.output.sectionTitles, ["Verified Session History"]);
  });

  test("appendPromptCrossRepoHintsSection renders cross-repo examples", () => {
    const lines = [];
    const trace = buildTrace();

    appendPromptCrossRepoHintsSection(lines, trace, {
      repository: "fixture-repo",
      crossRepoEpisodes: [],
      crossRepoHints: [{
        repository: "other-repo",
        currentRepository: "fixture-repo",
        source_type: "session_store",
        updated_at: "2026-06-04T12:00:00.000Z",
        excerpt: "  Similar issue fixed in sibling repo  ",
      }],
      allowGenericCrossRepoFallback: true,
      pureTemporalRecall: false,
      sessionStore: {},
    });

    assert.deepEqual(lines, [
      "## Cross-Repo Hints",
      "",
      "- 2026-06-04: [session_store] Similar issue fixed in sibling repo [example from other-repo]",
    ]);
    assert.equal(trace.lookups.crossRepoHints.includedRows.length, 1);
    assert.deepEqual(trace.output.sectionTitles, ["Cross-Repo Hints"]);
  });
});
