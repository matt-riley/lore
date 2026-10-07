// Deterministic synthetic semantic corpus: 120 scenario families plus
// unrelated negative prompts and a forbidden canary memory.
//
//   node daemon/tests/semantic-corpus.mjs --write tests/v2/fixtures/semantic-corpus.json
//
// The committed fixture is frozen; runtime consumers only read it.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CORPUS_PATH = path.join(REPO_ROOT, "tests/v2/fixtures/semantic-corpus.json");

const SUBJECTS = [
  ["authentication layer", ["login service", "identity gateway"]],
  ["migration runner", ["schema upgrader", "database migrator"]],
  ["retrieval engine", ["search subsystem", "ranking service"]],
  ["ingestion pipeline", ["source capture pipeline", "transcript ingester"]],
  ["backup manager", ["snapshot service", "restore coordinator"]],
  ["notification dispatcher", ["alert router", "message fanout"]],
  ["scope policy engine", ["visibility rules", "authorization policy"]],
  ["repository identity resolver", ["repo normalizer", "identity canonicalizer"]],
  ["export coordinator", ["bundle exporter", "portable export service"]],
  ["reconciliation loop", ["consistency reconciler", "background reconciler"]],
  ["edit conflict resolver", ["merge resolver", "conflict handler"]],
  ["streaming parser", ["incremental parser", "chunked reader"]],
];

const DETAILS = [
  ["rotating signing keys", ["key rotation", "rotating credentials"]],
  ["schema versioning", ["versioned migrations", "schema upgrades"]],
  ["candidate ranking", ["result ordering", "ranked candidates"]],
  ["checkpoint resumption", ["resumable checkpoints", "checkpoint recovery"]],
  ["incremental snapshots", ["delta backups", "incremental backup copies"]],
  ["delivery retries", ["retry delivery", "message retries"]],
  ["deadline cancellation", ["cancelling expired work", "deadline-based cancellation"]],
  ["quota accounting", ["quota enforcement", "accounting for quotas"]],
  ["unicode tokenization", ["tokenizing unicode text", "unicode-aware tokenization"]],
  ["write-ahead logging", ["WAL durability", "write-ahead log durability"]],
];

const NEGATIVES = [
  "How do I bake sourdough bread with a crisp crust?",
  "What is the best time of year to plant tomatoes?",
  "Who won the football match last weekend?",
  "How do I tune a guitar to drop D?",
  "What causes thunder during a storm?",
  "How do I remove red wine stains from carpet?",
  "Which vitamins help with sleep quality?",
  "How do I assemble a flat-pack bookshelf?",
  "What is the melting point of beeswax?",
  "How do I train a puppy to sit?",
  "Which constellation is visible in July?",
  "How do I repair a bicycle puncture?",
  "What is the difference between espresso and filter coffee?",
  "How do I paint a room without streaks?",
  "Which language is spoken in Brazil?",
  "How do I store fresh basil for longer?",
  "What is the tallest mountain in Europe?",
  "How do I measure a room for carpet?",
  "Which spices go into a curry powder?",
  "How do I back up photos to a cloud drive?",
];

const CANARY = "project secret canary zxqv hidden phrase";

/** Deterministic corpus builder. */
export function buildCorpus() {
  const families = [];
  let index = 0;
  for (const [subject, subjectSynonyms] of SUBJECTS) {
    for (const [detail, detailSynonyms] of DETAILS) {
      index += 1;
      const id = `family-${String(index).padStart(3, "0")}`;
      families.push({
        id,
        memory: `The ${subject} is responsible for ${detail}.`,
        queries: [
          `How does the ${subjectSynonyms[0]} handle ${detailSynonyms[0]}?`,
          `Which component deals with ${detailSynonyms[1 % detailSynonyms.length]}?`,
        ],
        subject,
        detail,
      });
    }
  }
  return {
    seed: 20261007,
    canary: CANARY,
    negatives: NEGATIVES,
    families,
  };
}

function splitOf(family) {
  const digest = createHash("sha256").update(family.id).digest("hex");
  return Number.parseInt(digest.slice(0, 2), 16) < Math.floor(0.2 * 256)
    ? "calibration"
    : "held-out";
}

/** Families for a split, with their queries. */
export function splitFamilies(corpus, split) {
  return corpus.families.filter((family) => splitOf(family) === split);
}

export function corpusHash() {
  return createHash("sha256").update(readFileSync(CORPUS_PATH)).digest("hex");
}

if (process.argv[1] && process.argv[2] === "--write") {
  const target = path.resolve(REPO_ROOT, process.argv[3] ?? CORPUS_PATH);
  writeFileSync(target, `${JSON.stringify(buildCorpus(), null, 2)}\n`);
  console.log(`wrote ${target}`);
}
