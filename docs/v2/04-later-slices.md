# Later slices: outline only

Status: deferred until slices 1–3 prove the daemon boundary. Expand each section into its own implementation plan before work starts.

## Slice 4: background transcript ingestion

Move discovery and checkpointed reading into the daemon. Adapters provide session locations/events as hints; periodic reconciliation supplies correctness when file-watch events are missed. Start with Pi JSONL, then add the other supported formats independently.

Requirements:

- Read-only source access, explicit configured roots, bounded record/byte/time budgets.
- Durable per-client/session checkpoints and source revisions.
- Handle append, partial trailing records, truncation, replacement, branches, compaction, and unavailable sources without inventing complete capture.
- Separate stable source identity from volatile filesystem identifiers. Investigate macOS device-number changes without weakening replacement detection or silently trusting inode equality.
- Resume large transcripts incrementally; expose oversized records/files as skipped with reasons rather than quietly leaving them out of backlog totals.
- Progress distinguishes discovered, eligible, queued, running, retrying, skipped, failed, caught-up, and actively growing sources. Byte counts are not counts of useful memories.
- File-watch work and extraction scheduling never run on Recall.
- Do not run competing v1/v2 capture writers against one authoritative store.

Proof: crash/restart, missed file-watch events, concurrent append/rewrite, invalid records, large files, and source-byte preservation tests. Report exact unresolved/skipped work instead of declaring completion from an empty queue.

## Slice 5: extraction and migration

Port semantics only after ingestion produces stable normalized evidence. Use the existing rule extractor and independent reliability corpus as behavioral references. Do not treat the old implementation's every output as correct.

Requirements:

- Preserve manual authority, evidence identity, scope, confidence, expiry, correction/reversal, suppression, and idempotent extraction.
- Bring episode summaries, temporal recall, persona, domains, and workstreams across deliberately, with per-capability parity decisions.
- Chat-based enrichment remains optional and background-only; use the configured chat model, not the embedding model.
- Version extraction rules so reprocessing is explicit and observable.
- Migration is an explicit command into a separate v2 destination from a consistent read-only v1 snapshot. Preserve originals and verified backup/recovery paths.
- Enumerate supported released schema versions and unresolved legacy rows. Future/unknown schemas fail closed.
- Preserve forget/purge suppression before any derived content becomes queryable. A rollback must not resurrect forgotten content.

Proof: released-schema fixtures, dry-run/no-mutation tests, interruption recovery, field/provenance accounting, and frozen quality/scope-isolation gates. Define exact rollback semantics before importing real data; do not present a v2-to-v1 downgrade as available without evidence.

## Slice 6: thin client adapters

Replace per-agent storage/model workers with small protocol clients. Adapters translate lifecycle events, canonical repository identity, tool inputs, and rendered context. They do not independently extract, rank, embed, or choose storage policy.

Requirements:

- Start with one Pi adapter as an opt-in integration; then Copilot, Codex, Claude Code, and Antigravity.
- Deadline/cancellation propagation, capability negotiation, bounded retries, and idempotency-key persistence for uncertain writes.
- Prompt handling never waits for daemon startup, archive processing, or PrepareQuery completion; use a bounded readiness check and explicit unavailable behavior.
- No per-keystroke transcript/query uploads. Preparation is optional and limited to submitted prompts.
- Agent UI diagnostics use supported notifications, never arbitrary stderr output through the terminal renderer.
- A stopped daemon does not crash or hang the host. Unknown future capabilities are not advertised as supported.

Proof: real-host and subprocess tests for reload, session switch, shutdown, reconnect, model tools, slash/CLI commands, two simultaneous agents, and repository isolation. Keep capability manifest, support matrix, README, and website aligned when shipping.

## Slice 7: rollout and fallback

Package `lored` and introduce per-user launchd/systemd management after the foreground process is stable. Publish explicit architecture/OS support and signed or checksum-verified artifacts appropriate to the distribution channel.

Requirements:

- Install, upgrade, remove, and rollback preserve config, databases, transcripts, and unrelated host settings.
- Single-instance ownership, service restart policy, health reporting, log rotation, and version skew handling.
- Opt-in cohort first, with measured latency, memory, capture coverage, and retrieval quality.
- One authoritative write target per installation. Never retry an uncertain v2 Retain against v1.
- Daemon failure defaults to agent operation without Lore context plus a visible diagnostic. An optional read-only v1 fallback must be explicitly configured and must honor the latest suppression state; otherwise do not enable it.
- Keep v1 available as a separately selected mode until migration and rollback are proven. Avoid silent automatic mode changes.
- Retire v1 only after supported clients pass parity and an operator can verify backlog completion, skipped sources, and recovery evidence.

Proof: isolated installer lifecycle tests, host compatibility matrix, upgrade/restart drills, lost-connection write tests, and a documented rollback rehearsal. No automatic migration or deletion of personal data.
