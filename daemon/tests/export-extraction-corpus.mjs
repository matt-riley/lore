#!/usr/bin/env node
// Export the v1 reliability corpus into a language-independent extraction
// fixture: normalized turns plus expected/forbidden anchors. The v1 corpus is
// the comparator, not the oracle; both implementations read this file.
//
//   node daemon/tests/export-extraction-corpus.mjs

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { RELIABILITY_BLUEPRINTS } from "../../tests/fixtures/reliability-corpus.mjs";



function turnsFor(blueprint) {
  const turns = [];
  for (let index = 0; index < (blueprint.turnsBefore ?? 0); index += 1) {
    turns.push({
      role: "user",
      text: `Unrelated status question ${index + 1}: how is the release checklist looking today?`,
    });
    turns.push({
      role: "assistant",
      text: `Checklist item ${index + 1} is unchanged.`,
    });
  }
  if (blueprint.user) {
    turns.push({ role: "user", text: blueprint.user });
  }
  if (blueprint.assistant) {
    turns.push({ role: "assistant", text: blueprint.assistant });
  }
  if (blueprint.correction) {
    turns.push({ role: "user", text: blueprint.correction.user });
    if (blueprint.correction.assistant) {
      turns.push({ role: "assistant", text: blueprint.correction.assistant });
    }
  }
  return turns;
}

const blueprints = RELIABILITY_BLUEPRINTS.filter((blueprint) => blueprint.user).map((blueprint) => ({
  id: blueprint.id,
  family: blueprint.family ?? null,
  repository: blueprint.repository ?? null,
  turns: turnsFor(blueprint),
  expected: blueprint.expected ?? [],
  forbidden: blueprint.forbidden ?? [],
  query: blueprint.query ?? null,
  negativeQuery: blueprint.negativeQuery ?? null,
  suppress: Boolean(blueprint.suppress),
  mandatoryRecall: Boolean(blueprint.mandatoryRecall),
  critical: blueprint.critical ?? [],
}));

const fixture = {
  version: 1,
  source: "tests/fixtures/reliability-corpus.mjs",
  fillerTurns: 0,
  blueprints,
};
const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
const hash = createHash("sha256").update(serialized).digest("hex");
writeFileSync(
  new URL("../../tests/v2/fixtures/extraction-corpus.json", import.meta.url),
  serialized,
);
console.log(`blueprints=${blueprints.length} hash=${hash}`);
