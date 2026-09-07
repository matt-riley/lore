import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceSectionBudget, filterTraceIncludedRows } from "../../lib/context/output-budget.mjs";
import { estimateTokens } from "../../lib/utils/token-estimator.mjs";

test("total budget keeps substantive persona entries before optional evidence without cutting conditions", () => {
  const persona = "- Keep answers concise unless the user requests a detailed explanation.";
  const result = enforceSectionBudget({
    sections: [
      { title: "Related work", text: `## Related work\n\n- ${"Background details. ".repeat(50)}` },
      { title: "Response Style And Addressing", text: `## Response Style And Addressing\n\n${persona}\n- ${"A long secondary preference. ".repeat(30)}` },
    ],
    totalBudget: 40,
    requiredTitles: [/^Response Style And Addressing$/u],
  });
  assert.ok(result.text.includes(persona));
  assert.equal(result.text.includes("Background"), false);
  assert.equal(result.text.includes("…"), false);
  assert.ok(estimateTokens(result.text) <= 40);
});

test("budget reserves one complete entry for each required section and accounts for separators", () => {
  const sections = [
    { title: "One", text: "## One\n\n- First complete rule.\n- A second optional rule with extra detail." },
    { title: "Two", text: "## Two\n\n- Another complete rule." },
  ];
  const expected = "## One\n\n- First complete rule.\n\n## Two\n\n- Another complete rule.";
  const result = enforceSectionBudget({ sections, totalBudget: estimateTokens(expected), requiredTitles: [/One|Two/u] });
  assert.equal(result.text, expected);
  assert.equal(result.estimatedTokens, estimateTokens(expected));
});

test("required section allocation backtracks to shorter entries when that preserves later sections", () => {
  const sections = [
    { title: "One", text: "## One\n\n- A moderately long first rule here.\n- Tiny rule." },
    { title: "Two", text: "## Two\n\n- Another required rule." },
  ];
  const expected = "## One\n\n- Tiny rule.\n\n## Two\n\n- Another required rule.";
  const result = enforceSectionBudget({ sections, totalBudget: estimateTokens(expected), requiredTitles: ["One", "Two"] });
  assert.equal(result.text, expected);
});

test("trace contains only rendered evidence and cannot claim hidden decisions or heading-only persona", () => {
  const trace = { lookups: {
    semantic: { includedRows: [{ id: "a", content: "Visible full rule." }, { id: "b", content: "Hidden full rule." }, { id: "partial", content: "Use PostgreSQL" }] },
    persona: { includedRows: [{ id: "p", content: "Unrendered preference." }] },
    episodes: { includedRows: [{ id: "e", summary: "A completed outcome.", decisions: ["Visible decision.", "Hidden decision."] }] },
  }, output: {} };
  const filtered = filterTraceIncludedRows(trace, "## Persona\n\n## Evidence\n\n- Visible full rule.\n- Use PostgreSQL for writes.\n- A completed outcome. — Visible decision.");
  assert.deepEqual(filtered.lookups.semantic.includedRows.map((row) => row.id), ["a"]);
  assert.deepEqual(filtered.lookups.persona.includedRows, []);
  assert.deepEqual(filtered.lookups.episodes.includedRows[0].decisions, ["Visible decision."]);

  const daySummary = filterTraceIncludedRows({
    lookups: { daySummary: { includedRows: [{ id: "day", summary: "- Rendered day summary." }] } },
  }, "## Relevant Day Summary\n\n- Rendered day summary.");
  assert.deepEqual(daySummary.lookups.daySummary.includedRows.map((row) => row.id), ["day"]);

  const parenthetical = filterTraceIncludedRows({
    lookups: { semantic: { includedRows: [{ id: "partial-parenthetical", content: "Use PostgreSQL" }] } },
  }, "## Evidence\n\n- Use PostgreSQL (for writes).");
  assert.deepEqual(parenthetical.lookups.semantic.includedRows, []);
});
