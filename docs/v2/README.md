# Lore v2 implementation roadmap

Status: approved design direction; implementation has not started.
Planning baseline: branch `v2`, commit `4771816`, 2026-09-15.

## Outcome

Replace Lore's per-client memory infrastructure with one per-user Rust daemon and a Rust CLI. All five clients share durable memory, policy, ingestion, extraction, and scheduling through a local socket. New queries receive bounded semantic retrieval; long archive and indexing work progresses between agent sessions.

This is a full replacement roadmap, including administration, recovery, optional capabilities, and the dashboard. A successful early proof does not establish full v1 parity. Each capability remains unavailable in v2 until its implementation and acceptance evidence exist.

The user selected Rust core and CLI, HTTP/JSON over Unix sockets, a per-user background service, full replacement scope, and a 100 ms query-embedding allowance within a 200 ms prompt-hook deadline. These decisions supersede the earlier gRPC, cache-only, and reject-Retain-on-embedding-backlog proposals. The [review disposition](review-disposition.md) records how all seven reviews influenced the design.

## Current evidence and problem statement

The checked-in [v1 performance report](../v1-release-evidence.md#performance) recorded 10k-memory prompt p95 of 1.13 ms on Node 24.0.0 and 1.27 ms on Node 26.8.1 on an Apple M5. Those historical core measurements excluded host launch and model inference; they are not a current semantic-latency baseline. The new proof must measure both rather than using 100 ms as an excuse for slower lexical retrieval.

At this baseline, `lib/memory/semantic-search.mjs` uses a 10,000 ms default semantic deadline and can request query/missing-memory embeddings during retrieval; Pi awaits prompt recall. Client-owned workers and session-triggered archive processing do not provide one continuous scheduler across hosts. The Pi archive scanner also excludes files above its default 10 MiB eligibility cap. These are the specific behaviors the daemon boundary changes; stages 2-3 measure their effect, and stage 4 replaces permanent file exclusion with bounded incremental progress.

## Read and implement in this order

| Stage | Deliverable | Implementation plan | Exit evidence |
| --- | --- | --- | --- |
| Foundation | Decisions, configuration, parity inventory, evaluation rules | [Decisions](architecture-decisions.md), [configuration/storage](configuration-storage.md), [parity](capability-parity.md), [validation](validation.md) | Requirements and fixtures frozen before handlers |
| 1 | HTTP/JSON contract and minimal Rust/Node/Bun socket proof | [Contracts](01-contracts.md) | Wire, host-loading, cold-process, identity and deadline tests |
| 2 | Durable Status, Retain, Forget and lexical Recall | [Daemon core](02-daemon-core.md) | Two clients, safety fixtures, crash/retry proof, lexical baseline |
| 3 | Background memory embeddings and bounded query inference | [Embeddings](03-background-embeddings.md) | Cold-query quality, degraded retrieval, resource and backlog report |
| 4 | Background source discovery and checkpointed capture | [Ingestion](04-ingestion.md) | Every client format; replacement, compaction and restart evidence |
| 5A | Rust extraction and complete context assembly | [Extraction](05-extraction.md) | Reliability, mandatory-context and provenance gates |
| 5B | Explicit v1 migration, backup and suppression-safe recovery | [Migration/recovery](05-migration-recovery.md) | Released-schema accounting and recovery rehearsal |
| 6A | Thin adapters and compatible human/script interfaces | [Client adapters](06-client-adapters.md) | Pi, Copilot, Codex, Claude Code, Antigravity host evidence |
| 6B | Administration, optional operations and dashboard parity | [Administration/dashboard](06-administration-dashboard.md) | All parity rows implemented, bounded and verified |
| 7 | Packaging, service management, cutover, soak and retirement | [Rollout](07-rollout.md) | Install/upgrade/recovery drills and client soak |

The [former later-slices document](04-later-slices.md) remains a navigation bridge for existing links. Stage numbers are stable identifiers; 5A/5B and 6A/6B split the old broad slices without dropping scope.

## Architecture

```text
Copilot/Pi host glue     Native CLI hooks / human lore CLI
          \                    /
           HTTP/JSON over an owned Unix socket
                         |
                   lored (Rust)
       policy + context assembly + operation dispatch
                         |
         one SQLite writer / bounded read workers
            |                         |
  memories, evidence, tombstones    derived vectors
            ^                         ^
  discovery -> capture -> extraction -> embedding scheduler

Recall -> bounded query embedding -> configured provider
                (lexical fallback on deadline/failure)

Explicit lore browser -> read-only loopback gateway -> socket API
```

Production ownership is one selected store and service per OS user. Explicit additional isolated stores are possible with distinct store locks and endpoints; they are not an implicit repository-to-store split. Repositories share one store with enforced scope. The service runs between client sessions; it does not imply work while the machine is asleep or the user service is stopped.

## Non-negotiable contracts

- Preserve configured paths, raw sources, legacy storage, suppression, evidence retirement, expiry, and manual authority. Never migrate personal data implicitly.
- One active installation mode writes authoritative data. No dual writes, automatic mode changes, or uncertain-write retries against v1.
- An absent repository means global-only recall. Explicit cross-repository recall admits transferable evidence; administrative search has a separate explicit selection contract.
- The daemon owns policy and all store mutations. Adapters translate host inputs and outputs; they do not extract, rank, embed, or open SQLite.
- Recall never embeds memories or triggers transcript discovery. Query inference is cancellable and bounded; provider availability is not a prerequisite for lexical recall or valid manual saves.
- Forgotten data cannot return through extraction, old IDs, derived aggregates, idempotency replay, or backup restoration. A fresh deliberate manual save may create a new ID.
- Normal logs/metrics contain no memory/query text, raw source paths, vectors, credentials, or provider response bodies.
- The daemon has no TCP listener. The optional dashboard is a separate, explicitly launched loopback-only process. Same-user processes are within the socket trust boundary.

## Milestones and decisions to continue

Gate G1 (stage 1): practical HTTP/JSON interoperability, cold CLI cost, JSON validation, and repository identity work on macOS/Linux. Build the smallest executable boundary first; no second Node daemon implementation.

Gate G2 (stage 2): acknowledged writes survive process failure; retries and Forget work through the actual API; scope fixtures have zero leaks; lexical recall meets its measured baseline gate.

Gate G3 (stage 3): first-seen query quality, fallback quality, memory coverage, latency, RSS, write contention, and recovery all meet [validation](validation.md). Publish the report and record an explicit go/no-go before starting the large extraction port. A failed gate blocks expansion; it does not authorize a silent threshold change or language switch.

Gate G4 (stages 4-5A): source capture is accounted for and the independent reliability corpus passes. Empty queues cannot establish capture completeness.

Gate G5 (stages 5B-6B): migration and recovery are rehearsed, all capability rows are implemented, and each host has real integration evidence. Pi may enter an explicitly partial experimental cohort earlier on synthetic data; full replacement claims wait for G5.

Gate G6 (stage 7): release artifacts, service lifecycle and cutover pass, and all clients finish the documented soak. Only then schedule v1 retirement with a deprecation notice and migration guide.

## Delivery discipline

Use TDD for runtime slices: failing behavior test, minimum implementation, refactor, regression and acceptance evidence. Tests use isolated homes and synthetic data. Personal transcripts are never a CI corpus; a user-selected local replay is optional and stays local.

Keep changes atomic. During coexistence, v1 receives correctness/security and required compatibility fixes; any policy change updates shared fixtures and the v2 parity ledger. Do not undertake unrelated v1 feature expansion as part of this rewrite. Reconcile the inventory against the current manifest before every gate.

The owner of a slice records its tested commit, toolchain, platforms, commands, pass/fail counts, performance artifact hashes, known limitations, and gate outcome. Maintain evidence under `docs/v2/evidence/` when implementation begins; sensitive local results belong outside the repository. Missing evidence is `not_run`, never a pass.

Update the public README, website, capability manifest and support matrix together when functionality ships. These plans describe future behavior and do not upgrade current support claims. Windows, remote daemon access, embedded inference, ANN indexing, and general extraction plugins are outside this release.
