# Slice 5A: extraction, authority and complete context

Status: planned. Depends on stage 4 normalized evidence and G3 go decision. Exit: G4 with ingestion.
References: `lib/sessions/rule-extractor.mjs`, `lib/sessions/extraction-grammar.mjs`, `lib/sessions/directive-corrections.mjs`, `lib/context/recall-assembler.mjs`, `tests/fixtures/reliability-corpus.mjs`.

## Outcome

Port deterministic extraction and all context sections into Rust without importing v1's implementation errors as requirements. Shared fixtures express correct user intent, role, scope, evidence and retrieval expectations. The v1 implementation is one comparator, not the oracle.

Extraction consumes only verified normalized evidence. The daemon owns rule versions, proposition identity, authority, corrections, suppression and transaction application. Adapters cannot supply generated authority metadata through Retain.

## Normalized input and extraction result

Input: client/native session identity, canonical repository or unresolved state, source generation, turn/record IDs, timestamps, speaker role, bounded text, parent/branch lineage, completeness and evidence revision. Distinguish direct user statements, assistant proposals/reports, tool output, quoted text and compaction summaries.

Result: semantic proposals with evidence links and confidence, current directives/preferences/commitments, corrections/reversals, episode digest and temporal facts, retired evidence keys and extraction diagnostics. Each result carries ruleVersion, input fingerprint and target checkpoint revision. Unsupported or incomplete evidence cannot silently become a complete source.

Persist ruleVersion in the store and every extraction run. A deployment does not silently re-extract all history with changed rules. New evidence uses the active version; existing evidence is reprocessed by an explicit previewed run or a documented approved upgrade step. Show affected sources, old/new version and expected coverage before apply.

## Authority and scope rules

- Manual saves, onboarding, manual corrections and explicit overrides retain their declared authority. Automatic similarity or a newer transcript does not overwrite them.
- Auto extraction defaults to the verified repository. Infer global scope only from explicit evidence of a general preference/directive under the frozen global-intent grammar. Missing repository information is unresolved, not global.
- Questions, hypothetical plans, quotations, rejected approaches and assistant suggestions are not direct standing instructions. Preserve rejection/proposal attribution when they are useful historical evidence.
- Explicit corrections and reversals retire the superseded automatic proposition and its obsolete evidence; do not leave contradictory mandatory guidance active. Manual corrections require the administrative contract.
- Expired, forgotten, superseded, retired or unverified evidence cannot feed semantic results, episodes, summaries, working profiles, reflections or mandatory sections.
- Scoped ID/fingerprint suppression is checked before proposal creation and again before apply. The same forgotten proposition remains suppressed across extractor versions, repaired checkpoints and source rereads.
- New manual save with new ID/key may restore a proposition. Replaying a prior save or importing its old ID is not a restoration.

Preserve verified legacy repository mappings. Ambiguous mappings and previously unscoped automatic directives remain unresolved/quarantined during migration; never promote them to global for convenience.

## Application transaction and reprocessing

Claim extraction with the durable lease/token machinery. Compute outside the writer; apply only if source generation, input hash, rule version, lease token and current evidence remain valid.

Commit proposal changes, memory/evidence links, retirements, scoped aggregates, FTS, memory revision, embedding intents, per-source extraction watermark and run-item result atomically. Reject stale results and requeue only the current target. Idempotent reprocessing uses stable source/proposition identity; do not duplicate a memory on retry.

All derived aggregates record constituent evidence/memory IDs. On Forget/Correct/source retirement, invalidate affected aggregates in the authoritative mutation transaction so they are immediately ineligible; rebuild asynchronously. A missing rebuild cannot justify serving the old aggregate. Manual domain/overlay fields are distinct from generated summaries and cannot be overwritten during rebuild.

## Full context assembly

Port the current section responsibilities: standing directives, response style/addressing, user/assistant identity, commitments/preferences, working profile, procedural guidance, relevant prior work/episodes, temporal day summaries, workstreams/domains and explicit cross-repository hints. Include the existing render fixtures and support policy for each section in the parity report.

Required sections are independent of topical query similarity and are assembled even when a query has no topical terms. Order: current standing directives, response style/identity, active commitments/working profile, then topical procedural/semantic/episode/domain material. Within sections retain current explicit priority rules and stable ID ties. Historical evidence is labeled historical and never relabeled as a current instruction.

Use shared byte budgeting. Preserve required sections before topical ones, report `MANDATORY_CONTEXT_TRUNCATED` if required content exceeds the allowed budget, and expose omitted counts/IDs in bounded diagnostics. Tests with normally sized required guidance must include it in full; pathological input remains bounded instead of hiding omission.

Temporal requests use an explicit client timezone (IANA identifier, default UTC when absent) plus evaluation time. Store UTC milliseconds, derive date windows using that zone, and test DST/midnight boundaries. Query only captured indexed evidence/episodes/day summaries during Recall. The v1 raw-store fallback becomes a background repair request through explicit operations; Recall itself never scans raw archives. Report missing temporal coverage without inventing a complete history.

Session-start capsule and prompt recall use the same authoritative policy. Session-start may omit topical search but must include configured identity/style/directives. No adapter-only persona cache can outlive Forget or a correction without revision/expiry invalidation.

## Domains, workstreams and enrichment

Extend typed operations for existing Retain kinds: semantic memory, domain and workstream overlay, preserving each field in the current capability schema. Invalid combinations fail explicitly. User-authored title, mission, objective, constraints, blockers, decisions and priorities remain manual inputs; automatic hydration adds attributable evidence without changing their authority.

Port fresh/stale refreshable observations, explicit persistence, scope overrides/audits and profile assembly with the current rollout flag dependencies. An observation's refresh must honor evidence retirement and expiry.

Chat enrichment remains optional, disabled by default, background-only and separate from embedding identity. Validate bounded structured output against schema and supporting evidence. On failure keep valid deterministic extraction, record enrichment failure and never convert model prose into unsupported facts.

Query expansion and context compression are covered as compatibility features: expose explicit background preparation/analysis operations when enabled, but do not introduce chat inference into the 200 ms prompt path. Existing configs enabling synchronous v1 augmentation receive an explicit migration warning and mapped disabled-on-prompt behavior. Their deliberate semantic difference is tested and listed in the parity matrix; no hidden feature drop.

## TDD and quality gates

1. Extract a language-independent fixture subset before Rust rules: explicit versus inferred scope, questions, quoted directives, role confusion, rejected options, reversals and exact short anchors.
2. Add negative and independent held-out cases; share grammar production functions rather than duplicate regex variants per path.
3. Test same source twice, different source same proposition, correction after manual save, Forget then reread, rule-version change and invalid source generation.
4. Test aggregate invalidation across episodes, day summaries, domains, overlays, observations, temporal paths and persona.
5. Port required-section, byte-budget, negative-query, date-window and repository-isolation render fixtures.
6. Run the full independent reliability corpus across every client normalization format with existing extraction precision/recall and zero-critical-failure gates.
7. Test optional enrichment offline, slow, malformed and unsupported claims; deterministic output and foreground latency remain correct.
8. Benchmark extraction backlog with concurrent Recall/Retain and crash at every apply boundary.

G4 requires the [validation](validation.md) thresholds, no missing mandatory scenarios, complete supported section accounting, and no unlabelled policy difference from v1. Store a corpus/version/hash report and per-client failure examples using synthetic content. Migration cannot proceed on a partial persona or suppression port.
