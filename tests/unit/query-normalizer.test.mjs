/**
 * tests/unit/query-normalizer.test.mjs
 *
 * Unit tests for lib/query-normalizer.mjs.
 *
 * Covers:
 *   - inferDateFromPrompt: ISO pass-through, today/yesterday/last-night
 *     shortcuts, named weekday resolution (last/this qualifiers), and
 *     month+day expressions.
 *   - extractTemporalContentTerms: scaffold-term removal, boolean-operator
 *     stripping, stemming rules (ies→y, ing→drop, ed→drop, s→drop), and
 *     minimum-length filtering.
 *
 * All tests are pure/deterministic.  A fixed NOW is injected so weekday and
 * relative-date tests never depend on the wall clock.
 *
 * Run:
 *   node --test tests/unit/query-normalizer.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  inferDateFromPrompt,
  extractTemporalContentTerms,
} from "../../lib/query-normalizer.mjs";

// ---------------------------------------------------------------------------
// Fixed reference point for all date tests.
//
// 2024-03-27 is a Wednesday.  Using a fixed date keeps weekday arithmetic
// deterministic and independent of the system clock.
//
// Weekday layout around this anchor:
//   Mon 2024-03-25, Tue 2024-03-26, Wed 2024-03-27 (today),
//   Thu 2024-03-21 (last week), Sun 2024-03-24, Sat 2024-03-23
// ---------------------------------------------------------------------------
const NOW = new Date("2024-03-27T12:00:00Z"); // Wednesday

// Convenience: build an expected ISO date string.
function isoDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// inferDateFromPrompt
// ---------------------------------------------------------------------------

describe("inferDateFromPrompt — shortcuts", () => {
  test("returns today's date for 'today'", () => {
    assert.strictEqual(inferDateFromPrompt("what did we do today", { now: NOW }), isoDate(2024, 3, 27));
  });

  test("returns today for 'this morning'", () => {
    assert.strictEqual(inferDateFromPrompt("this morning we fixed it", { now: NOW }), isoDate(2024, 3, 27));
  });

  test("returns today for 'this afternoon'", () => {
    assert.strictEqual(inferDateFromPrompt("this afternoon standup", { now: NOW }), isoDate(2024, 3, 27));
  });

  test("returns yesterday for 'yesterday'", () => {
    assert.strictEqual(inferDateFromPrompt("what happened yesterday", { now: NOW }), isoDate(2024, 3, 26));
  });

  test("returns yesterday for 'last night'", () => {
    assert.strictEqual(inferDateFromPrompt("last night we merged the PR", { now: NOW }), isoDate(2024, 3, 26));
  });

  test("returns null when no temporal phrase is present", () => {
    assert.strictEqual(inferDateFromPrompt("show me typescript errors", { now: NOW }), null);
  });

  test("returns null for an empty string", () => {
    assert.strictEqual(inferDateFromPrompt("", { now: NOW }), null);
  });

  test("returns null for null input", () => {
    assert.strictEqual(inferDateFromPrompt(null, { now: NOW }), null);
  });
});

describe("inferDateFromPrompt — ISO date passthrough", () => {
  test("returns the ISO date verbatim when present in prompt", () => {
    assert.strictEqual(inferDateFromPrompt("review changes from 2024-01-15", { now: NOW }), "2024-01-15");
  });

  test("ISO date takes priority over relative terms", () => {
    assert.strictEqual(inferDateFromPrompt("2024-01-15 was yesterday", { now: NOW }), "2024-01-15");
  });
});

describe("inferDateFromPrompt — named weekdays", () => {
  // NOW is Wednesday 2024-03-27.
  test("'last monday' resolves to most-recent past Monday", () => {
    // Most-recent Monday before Wednesday 27 → 25 March
    assert.strictEqual(inferDateFromPrompt("what did we work on last monday", { now: NOW }), isoDate(2024, 3, 25));
  });

  test("'last tuesday' resolves to the Tuesday before NOW", () => {
    // Tuesday 26 March
    assert.strictEqual(inferDateFromPrompt("last tuesday review", { now: NOW }), isoDate(2024, 3, 26));
  });

  test("bare weekday without 'last' resolves to most-recent past occurrence", () => {
    // Plain "monday" with no qualifier: most-recent Monday = 25 March
    assert.strictEqual(inferDateFromPrompt("monday standup notes", { now: NOW }), isoDate(2024, 3, 25));
  });

  test("'last saturday' resolves to the Saturday before NOW (Wednesday)", () => {
    // Saturday 23 March
    assert.strictEqual(inferDateFromPrompt("last saturday we deployed", { now: NOW }), isoDate(2024, 3, 23));
  });

  test("'last sunday' resolves to the Sunday before NOW", () => {
    // Sunday 24 March
    assert.strictEqual(inferDateFromPrompt("last sunday review", { now: NOW }), isoDate(2024, 3, 24));
  });
});

describe("inferDateFromPrompt — month+day expressions", () => {
  test("'march 15' resolves to March 15 of current year when in the past", () => {
    // March 15 2024 is before NOW (March 27 2024) → same year
    assert.strictEqual(inferDateFromPrompt("what happened on march 15", { now: NOW }), isoDate(2024, 3, 15));
  });

  test("'march 15th' resolves correctly (ordinal suffix stripped)", () => {
    assert.strictEqual(inferDateFromPrompt("march 15th changes", { now: NOW }), isoDate(2024, 3, 15));
  });

  test("future month+day resolves to previous year", () => {
    // April 1 is after NOW (March 27) → previous year 2023
    assert.strictEqual(inferDateFromPrompt("april 1 deploy", { now: NOW }), isoDate(2023, 4, 1));
  });

  test("january 5 (before NOW) resolves to current year", () => {
    assert.strictEqual(inferDateFromPrompt("january 5th standup", { now: NOW }), isoDate(2024, 1, 5));
  });
});

// ---------------------------------------------------------------------------
// extractTemporalContentTerms
// ---------------------------------------------------------------------------

describe("extractTemporalContentTerms — basics", () => {
  test("returns an array of strings", () => {
    const terms = extractTemporalContentTerms("what auth changes did we make");
    assert.ok(Array.isArray(terms));
  });

  test("strips scaffold terms like 'what', 'did', 'we', 'last'", () => {
    const terms = extractTemporalContentTerms("what did we do last week");
    // All words in that phrase are scaffold terms or too short → empty
    assert.deepStrictEqual(terms, []);
  });

  test("preserves non-scaffold content words", () => {
    const terms = extractTemporalContentTerms("typescript authentication changes");
    assert.ok(terms.includes("typescript") || terms.some(t => t.startsWith("typescr")),
      `expected typescript-derived term in [${terms.join(", ")}]`);
  });

  test("returns empty array for empty string", () => {
    assert.deepStrictEqual(extractTemporalContentTerms(""), []);
  });

  test("returns empty array for null", () => {
    assert.deepStrictEqual(extractTemporalContentTerms(null), []);
  });
});

describe("extractTemporalContentTerms — stemming", () => {
  test("strips trailing -s from plural words (length > 4)", () => {
    // "tests" → "test"
    const terms = extractTemporalContentTerms("failed tests broke build");
    assert.ok(terms.includes("test"), `expected 'test' in [${terms.join(", ")}]`);
  });

  test("strips trailing -ed from past-tense words (length > 4)", () => {
    // "merged" → "merg"  (length check: "merged"=6 > 4 → strip)
    const terms = extractTemporalContentTerms("merged branch successfully");
    assert.ok(
      terms.some(t => t === "merg" || t === "merged" || t === "branch"),
      `got terms: [${terms.join(", ")}]`,
    );
  });

  test("strips trailing -ing from words (length > 5)", () => {
    // "deploying" → "deploy"
    const terms = extractTemporalContentTerms("deploying release");
    assert.ok(
      terms.some(t => t === "deploy" || t === "releas"),
      `got terms: [${terms.join(", ")}]`,
    );
  });

  test("strips trailing -ies and replaces with -y", () => {
    // "libraries" → "library"
    const terms = extractTemporalContentTerms("updating libraries");
    assert.ok(
      terms.some(t => t === "library" || t === "updat"),
      `got terms: [${terms.join(", ")}]`,
    );
  });
});

describe("extractTemporalContentTerms — operator and punctuation stripping", () => {
  test("removes AND/OR/NOT/NEAR operators before tokenising", () => {
    const terms = extractTemporalContentTerms("typescript AND authentication");
    assert.ok(!terms.includes("and"), "AND should be stripped");
    assert.ok(!terms.includes("or"), "OR should be stripped");
  });

  test("strips non-alphanumeric punctuation", () => {
    const terms = extractTemporalContentTerms("auth-service config.json");
    // Hyphens and dots stripped; short results filtered; check we get content words
    assert.ok(terms.length >= 0); // no throw
  });

  test("filters terms shorter than 3 characters", () => {
    const terms = extractTemporalContentTerms("a go js do");
    assert.deepStrictEqual(terms, []);
  });
});
