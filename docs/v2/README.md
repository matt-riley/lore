# Lore v2 daemon rewrite plan

Status: proposed implementation plan; no daemon or protocol implemented yet.
Branch: `v2`.

## Objective

Prove that a single per-user Rust daemon can serve multiple agent clients, keep ingestion and embedding work outside prompt handling, and preserve Lore's memory safety semantics. The first milestone is slices 1–3, not full v1 replacement.

The architectural gain is shared scheduling, storage ownership, and precomputed retrieval. Rust may reduce runtime overhead, but cannot remove model inference latency. Measure these gains rather than assuming them.

## Roadmap

| Slice | Deliverable | Plan |
| --- | --- | --- |
| 1 | Versioned protocol, storage boundary, compatibility fixtures | [Slice 1](01-contracts.md) |
| 2 | Rust daemon serving Status, Recall, Retain | [Slice 2](02-daemon-core.md) |
| 3 | Durable background embedding/indexing; cache-only recall | [Slice 3](03-background-embeddings.md) |
| 4 | Background transcript discovery and ingestion | [Later slices](04-later-slices.md#slice-4-background-transcript-ingestion) |
| 5 | Extraction parity and explicit migration | [Later slices](04-later-slices.md#slice-5-extraction-and-migration) |
| 6 | Thin production client adapters | [Later slices](04-later-slices.md#slice-6-thin-client-adapters) |
| 7 | Safe rollout, fallback, and v1 retirement | [Later slices](04-later-slices.md#slice-7-rollout-and-fallback) |

## Initial architecture

```text
Agent adapter / test client
  -> versioned protobuf/gRPC API over Unix domain socket
  -> lored (Rust, one instance per user and configured v2 store)
       -> foreground retrieval and explicit writes
       -> SQLite: authoritative memory, suppression, jobs, derived vectors
       -> background embedding worker -> configured inference provider

Later: transcript discovery -> ingestion -> extraction -> embedding jobs
```

Use Tokio, tonic/prost, and rusqlite as the proposed initial Rust stack. Slice 1 must prove Node-to-Rust gRPC over a Unix socket before adopting it. Binary encoding is a contract choice, not a performance claim. If the interoperability spike fails, record an ADR and evaluate HTTP/JSON over a Unix socket before building custom framing.

## Constraints

- macOS and Linux first. Windows transport/service support is deferred, not claimed.
- No TCP listener, remote access, account system, or multi-user service in the proof.
- A socket restricts access to the owning OS user; it cannot distinguish trusted from malicious processes running as that user.
- Foreground recall never contacts an inference provider, waits for indexing, or initiates archive scans.
- Explicit client repository identity and server-side scope policy remain mandatory.
- v1 data remains untouched. v2 uses a separate store and opt-in process until migration is proven.
- Do not discard suppression, expiry, provenance, or manual-memory authority to simplify the rewrite.
- No full v1 API parity, dashboard port, extraction rewrite, or service installer in slices 1–3.
- No automatic fallback writes to v1 when v2 is unavailable: that creates divergent authoritative stores.

## Existing behavior to use as evidence

- `lore-pi.ts`: lifecycle hooks and awaited prompt recall.
- `lore-server-runtime.mjs`: Pi archive queue and worker protocol.
- `lib/clients/cli-transcript-ingestion.mjs`: bounded capture and checkpoints.
- `lib/clients/bounded-jsonl-reader.mjs`: source identity, replacement detection, and byte budgets.
- `lib/context/recall-assembler.mjs`: context policy, rendering, fusion.
- `lib/memory/semantic-search.mjs`: embedding identity, current query-time inference, deadlines.
- `lib/db/db-retrieval-policy.mjs`: repository, expiry, and suppression eligibility.
- `lib/db/schema.mjs`, `tests/fixtures/released-upgrades/`: storage and upgrade evidence.
- `tests/fixtures/reliability-corpus.mjs`: behavioral evaluation inputs, not a license to port every feature immediately.

The current public backfill tool and Pi archive worker are separate paths. Do not assume `/lore backfill` operates on Pi transcripts. The Pi scanner also defaults to a 10 MiB per-file eligibility cap: repeated session starts alone cannot drain larger files. v2 progress must distinguish skipped, queued, processing, and complete work.

## Proof milestone and go/no-go

Slices 1–3 must demonstrate:

1. Two independent clients use one daemon and observe committed writes.
2. Recall remains available with inference offline, slow, or returning malformed results.
3. No provider request is attributable to a Recall RPC.
4. Process crashes cannot acknowledge lost writes or lose committed embedding jobs.
5. Wrong-repository, expired, forgotten, or superseded memories never escape through lexical, cached-query, or vector paths.
6. Memory/queue usage remains bounded under overload and limits are observable.
7. Reproducible latency and resource results support continuing the rewrite.

Provisional proof targets on a documented development machine: 10,000 synthetic memories, four clients, recall p95 <= 100 ms and p99 <= 250 ms under embedding backlog, idle RSS <= 100 MiB. These are acceptance targets, not measured guarantees. Record cold/warm results, hardware, OS, compiler profile, dataset, concurrency, and v1 comparison. Change targets only in a reviewed decision, not after silently weakening a failed gate.

Use TDD for each implementation slice: failing behavioral test, minimum implementation, regression suite. Documentation-only work does not justify changing runtime code. Keep plans grep-friendly Markdown and use stable RPC/status names.

## Rollout policy

Prove each slice before starting the next. Do not commit to a wholesale port until the slice-3 report is reviewed. Keep v1 operational during the proof; do not switch real agent hooks or migrate personal databases implicitly. Update README, website guidance, and the support matrix when functionality becomes available, not while it is merely planned.
