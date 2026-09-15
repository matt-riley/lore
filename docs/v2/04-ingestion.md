# Slice 4: background transcript ingestion

Status: planned. Depends on G3 go decision. Exit contributes to G4.
References: `lib/clients/bounded-jsonl-reader.mjs`, `lib/clients/cli-transcript-ingestion.mjs`, `pi-session-reader.mjs`, `lib/sessions/pi-archive-scanner.mjs`, `lib/sessions/session-store-reader.mjs`.

## Outcome and ownership

The daemon discovers and captures approved client sources without depending on prompt hooks or session restarts. Adapters send source/session hints; periodic reconciliation supplies correctness. Capture produces durable normalized evidence and extraction intent. It does not directly promote arbitrary transcript text into memories.

Implement parsing as versioned Rust modules behind a common normalized-record interface, not executable plugins or JS subprocesses. Start with Pi, then the native JSONL sources and Copilot source database. Every parser has separate golden fixtures. Do not assume the public v1 backfill command reads Pi archives.

## Source adapters

| Client/source | Input and reference | Required semantics |
| --- | --- | --- |
| Pi | JSONL session trees; `pi-session-reader.mjs` | Native session/header, record IDs and parent chain, branch/compaction handling |
| Codex | Approved session JSONL; `cli-transcript-ingestion.mjs` | Validate native session identity, role attribution, turn boundaries, partial writes |
| Claude Code | Approved JSONL record graph; same reference | Parent/branch reconstruction, duplicate/tool records, compaction and rewritten files |
| Antigravity | Approved configured transcript exports; same reference | Verify observed format/version and identity; shared mounted workspace paths are explicit |
| Copilot | Read-only raw session-store SQLite and approved session/workspace files; `session-store-reader.mjs` and `workspace-reader.mjs` | Consistent bounded reads, stable session/turn IDs, updates as well as new rows |

These describe the checked-out adapters, not a promise that future host formats are unchanged. Before certifying each host, capture a synthetic real-host session, record host/version/format, and rerun its fixtures. An unsupported or ambiguous format is visible skipped work, not guessed text extraction.

## Source registration and hints

Config contains approved source roots/stores per client; roots are disabled until explicitly configured. `sources/register` accepts client, root ID, native session ID, absolute path and optional repository/CWD hints. It may register a source only within an already approved root. It does not expand allowed roots. `sources/hint` accepts source ID, event ID and categorical event such as append/session-end/compaction. Both return source ID and accepted/coalesced status within the normal RPC budget.

Registration uses idempotencyKey; repeated event IDs coalesce. Daemon validates native identity from the source header/database against the hint before checkpoint advancement. A hint is untrusted attribution, not permission to read an arbitrary file. File symlinks escaping an approved root are rejected. Open and validate the file handle to avoid pathname replacement races.

Repository hints go through the shared resolver/mapping fixtures. A source without verified repository identity cannot automatically create global memories. Preserve it as `repository_unresolved` for an explicit mapping decision. Changing a mapping invalidates affected extraction intent and requires an observed reprocessing run.

`sources/status` is paginated, supports client/repository filters, and returns per-source sourceId, generation, state, byte offset, observed size, checkpoint revision, pending normalized/extraction work, skipped record counts, last progress time and categorical reason. Raw paths appear only in an explicit local detailed diagnostic, never normal Status/logs.

## Durable identity and checkpoint algorithm

Stable identity includes client, native session identity and approved source namespace. Device/inode/mtime are hints, not identity. A generation also stores header identity, prefix digest, last committed boundary/anchor digest and parser version. Linked paths to the same native session are resolved only with verified matching content; ambiguous duplicates are reported.

For each bounded quantum:

1. Validate open handle, approved root and native identity. Compare current generation anchors with the prior checkpoint.
2. Read at most the source byte/record/time quantum. Incrementally decode complete records; retain a bounded trailing partial record.
3. Parse role-attributed normalized records with stable evidence keys derived from client/session/record or turn identity and content revision.
4. In one writer transaction compare checkpoint revision, persist normalized records and evidence, enqueue/coalesce extraction intent, and advance offset/parser state/checkpoint revision.
5. Publish progress only after commit. A crash before commit replays the same evidence IDs; a crash after commit resumes at the next complete boundary.

Append preserves the generation when anchors match. Truncation, header replacement, conflicting record identity or changed anchors starts a new generation. Mark the previous generation unverified/retired for automatic context eligibility in the same transaction; rescan incrementally and reconcile evidence under the new generation. Do not leave known-stale evidence visible during rescan.

An unavailable file is different from known replacement: retry an unavailable source without deleting previously verified evidence. If a device number changes after macOS resume but native identity and boundary/prefix anchors match, resume the same generation. Inode equality alone cannot prove continuity. Failure to establish continuity is `SOURCE_AMBIGUOUS`, never silent checkpoint reuse.

For source databases, use stable session/turn keys plus content hashes and a persisted scan cursor. Poll updated records as well as appended IDs. Read within short consistent snapshots, retain a reconciliation cursor over the complete eligible keyspace, and recheck revisions before capture commit. Never write or migrate the host database.

## Branches, compaction and incomplete capture

Preserve parent relationships and selected active branch. Reject cycles and conflicting IDs. Missing ancestors, bounded graph overflow and incomplete compaction records remain unresolved; do not flatten them into invented chronology. Persist branch reconstruction cursor so a large history can finish over several quanta.

Compaction summaries are attributed summaries, not new direct user instructions. Keep pre-compaction evidence lineage where available; retired or abandoned branches cannot remain active sources for current automatic guidance. Extraction receives completeness and role information explicitly.

Remove the old permanent 10 MiB file eligibility ceiling. Large files progress over quanta. A single record larger than 1 MiB is streamed past to its delimiter without materializing it, recorded as skipped with offset/reason, and later records still progress. Keep a count and extent, not raw oversized text. Invalid JSON/UTF-8 records are similarly accounted for; a trailing incomplete record remains pending until completed or replaced.

## Scheduling and progress accounting

Use native file notifications as wake-up hints and a 60-second reconciliation sweep with durable directory/key cursors. Traverse 256 entries per page, round-robin across approved roots, clients and repositories. Respect store pressure and the shared writer budget. Source polls, parsing and extraction enqueueing never run inside Recall.

States: `discovered`, `eligible`, `queued`, `running`, `retry_wait`, `skipped`, `failed`, `caught_up`, `growing`, `unavailable`, `ambiguous`. Counts reconcile at a documented observed time. Caught-up means the observed source extent is durably captured and its required downstream work is accounted for, not that a live file can never grow again.

Keep discovery completion, captured bytes, normalized turns, extraction coverage and embedding coverage separate. A source can be captured yet have extraction failures. A run with skipped/unresolved records finishes as `complete_with_gaps`; an empty job queue cannot turn it into complete.

Retry transient read errors with bounded exponential backoff and jitter, maximum 60 seconds between automatic discovery probes. Malformed unsupported formats do not hot-loop; retry after source/config/parser revision changes or explicit user retry. Diagnostics list remediation without claiming the source was fully imported.

## TDD and acceptance

1. Golden parser fixtures for all clients: valid, malformed, role attribution, tool output, quoted instructions, parent/branch/compaction and ambiguous identity.
2. Checkpoint transaction failpoints and concurrent capture claims: neither lost evidence nor advanced offset without captured data.
3. Append/partial UTF-8/partial JSON, truncation, atomic replacement, same inode with changed content, changed device with same anchors, rename and missing source.
4. Missed notifications followed by polling, restart with a large directory cursor, and fairness while another source grows continuously.
5. Files above 10 MiB, oversized individual records, parser-state overflow and invalid middle records; useful later work is processed and gaps remain visible.
6. Read-only raw SQLite source, host concurrent writes, replaced source database and unknown schema; verify source bytes and metadata are not altered by Lore.
7. Unknown/foreign repository hints, escaped source paths, native ID mismatch and retired branches never produce active foreign/global guidance.
8. Load capture while four clients Recall/Retain; foreground gates still pass and memory remains bounded.

G4 ingestion evidence must enumerate every approved synthetic source and disposition at the final watermark. Source hash/byte checks, captured-turn counts and crash recovery must pass before extraction parity can be accepted.
