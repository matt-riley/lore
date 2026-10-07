# G4 evidence — stage 5A extraction and mandatory context

Gate: G4 (stages 4-5A) per [05-extraction](../05-extraction.md). Stage-4
capture is recorded in [g4](g4.md); this record covers the extraction half.
Outcome: **extraction quality gates passed; G4 closes for supported
capabilities, with the parity gaps listed below.**
Platform: macOS arm64 (Apple M5); hermetic CI for the Rust suites.

## What landed

| Piece | Detail |
| --- | --- |
| Rules | `lore-core/extraction.rs`, `RULE_VERSION = rules-v1`, deterministic; ports the v1 grammar's intent (preferences, standing directives, rejections, corrections, decisions) without importing its failures |
| Store | Schema 4: `memories.topic_key`, `memory_evidence`, extraction lease columns; deterministic memory IDs make re-extraction idempotent |
| Apply | One writer transaction per run: suppression check before create, supersession of the prior proposition, memory + FTS + embedding intent + evidence links, `memory_revision` maintained |
| Worker | `sources::extract_pending` claims intents with a lease, computes outside the writer, applies, completes or releases with jittered backoff; runs in the same sweep as capture |
| Routes | `/v2/extraction/retry` reprocesses completed/failed intents under a requested rule version, with idempotency receipts |
| Context | Required sections (`directives`, `identity`, `preferences`) assembled independently of topical similarity, protected before topical content, byte-budgeted with `mandatoryTruncated` / `mandatoryOmitted` diagnostics |

## Quality gates

Fixture: `tests/v2/fixtures/extraction-corpus.json`, exported from
`tests/fixtures/reliability-corpus.mjs` by
`daemon/tests/export-extraction-corpus.mjs`; sha256
`83e1e2c190b6abcd2a58044e6d73a3020e736a97e5d755627cd47b3c5d5d59ce`.
The v1 corpus is the comparator, not the oracle.

| Metric | Gate | Measured |
| --- | --- | --- |
| Independent scenarios | >= 120 | 160 blueprints (800 client-normalized scenarios; client formats are stage-4 evidence) |
| Extraction precision | >= 0.95 | **1.0000** (151/151 active propositions matched) |
| Explicit proposition recall | >= 0.90 | **1.0000** (151/151 expected) |
| Forbidden content | 0 | 0 |
| False global promotions | 0 | 0 |
| Critical failures | 0 | 0 |

Raw output: [`g4-extraction-metrics.txt`](g4-extraction-metrics.txt).
Command:

```sh
mise exec rust@1.99.0 -- cargo test --manifest-path daemon/Cargo.toml \
  -p lore-core --test extraction_quality -- --nocapture
```

Matching mirrors the v1 metric: all anchors present, exact short/numeric (and
number-word) anchors, >= 72% token overlap. Directive and `user_preference`
are treated as one standing-guidance class for proposition matching because
the corpus (and v1 itself) uses them interchangeably for the same sentence
shape; prohibitions remain distinct. This is recorded, not silent.

## Safety and recovery behaviour

- **Suppression**: `forgetting_an_extracted_memory_survives_reread` — forget an
  automatic memory, keep hinting the source and re-running capture/extraction;
  the proposition never returns (suppression is checked before create and
  again before apply).
- **Corrections**: `corrections_retire_the_superseded_memory` — a correction
  supersedes the prior automatic proposition in the same apply transaction;
  the obsolete row loses its FTS entry and evidence links are retired.
- **Scope**: automatic guidance is repository-scoped from verified identity;
  unresolved repository identity never becomes global (13 corpus cases carry
  explicit global-grammar expectations, all scoped correctly).
- **Idempotence**: deterministic memory IDs mean replaying a run duplicates
  nothing; `extraction.retry` reschedules work instead of rewriting history.
- **Leases**: claims are fenced by token; stale completions are rejected and
  failed runs back off without resetting their attempt budget.

## Context assembly

`required_sections_return_without_a_topical_match` proves that standing
guidance renders when the query has no matching terms, that section accounting
names the block, and that a pathological budget reports truncation instead of
hiding omissions. Ordering is directives, identity, preferences, then topical;
manual authority sorts before automatic; stable ID tie-breaks apply.

## Known gaps (honest boundary)

- The full v1 section set is not yet at parity: working profile, episodes,
  temporal/day summaries, workstreams/domains, procedural guidance and
  cross-repository hints are not assembled in this pass. Those rows stay
  planned in the parity ledger.
- Identity sections render only when identity memories exist; automatic
  identity extraction (`assistant_identity`, `user_identity`,
  `interaction_style`) and recurring-mistake inference are not ported here.
- Enrichment, domain/workstream hydration and observation refresh (stage 5A's
  later half) are unimplemented.
- Rule-version upgrades require the explicit `/v2/extraction/retry` call; no
  preview report enumerates affected sources yet.
- Failpoints are covered by atomic apply and lease tests, not injected I/O
  failures; power-loss durability is not certified here.
