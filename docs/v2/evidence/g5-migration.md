# G5 evidence — stage 5B migration, backup and recovery

Gate: G5 (stages 5B-6B) per [05-migration-recovery](../05-migration-recovery.md).
This record covers the stage-5B half; G5 also requires adapter host evidence
and full capability parity, which remain open.
Outcome: **migration, backup and suppression-safe restore implemented and
proven; the supported v1 set and explicit exclusions are recorded below.**
Platform: macOS arm64 (Apple M5); hermetic CI for the Rust suites.

## Supported source set

| v1 schema | Marker table | Imported |
| --- | --- | --- |
| 13 | `coherence_schema_version` | semantic memory, and v13's optional tables when present |
| 15 | `lore_schema_version` | semantic memory |
| 18 | `lore_schema_version` | semantic memory |
| 19 | `lore_schema_version` | semantic memory, suppressions, evidence links, repository mappings |
| 20 | `lore_schema_version` | semantic memory, suppressions, evidence links, repository mappings |

Any other version, missing marker, or multiple conflicting markers fails
closed (`MIGRATE_VERSION_*`). An unknown populated table blocks apply
(`MIGRATE_BLOCKED`) rather than being dropped silently. Recognized but
not-yet-imported tables (episode digests, day summaries, domains,
observations, runs, telemetry, embeddings) are `excluded_by_selection` with
row counts in the preview and manifest.

## Commands

```text
lore migrate v1 --source <v1-db> --destination <new-v2-dir> --dry-run
lore migrate v1 --source <v1-db> --destination <new-v2-dir> \
  --apply --plan <fingerprint> --clients-stopped
lore migrate status --destination <v2-dir> --run <id>
lore migrate resume --destination <v2-dir> --run <id> --apply
lore backup --destination <file>
lore restore --from <snapshot> [--dry-run | --apply --plan <fp> --clients-stopped]
```

Preview is the default. It opens the source read-only and creates nothing:
verified by `preview_creates_nothing_and_reports_accounting`, which asserts
the destination path does not exist afterwards. Apply requires the exact
preview fingerprint plus `--clients-stopped`; a changed input invalidates the
plan (`MIGRATE_STALE_PLAN`), proven in
`stale_plans_and_changed_inputs_are_rejected`.

## Import safety

- The original is never written: a SQLite online backup produces a private
  immutable snapshot, and byte equality of the source before/after apply is
  asserted.
- Imports run in 512-row transactions with a persisted rowid cursor per table
  and per-table dispositions; replaying the same snapshot neither duplicates
  nor skips rows (`resume_replays_idempotently_from_the_snapshot`).
- Valid v1 ids are preserved; invalid ids map deterministically (`mig_…`) and
  every supersession reference is remapped through the id map.
- Suppressions import before any content can become eligible; matching rows
  become forgotten and leave the FTS index, so a forgotten v1 memory cannot
  surface through Recall.
- Timestamps convert exactly to UTC epoch milliseconds; naive or malformed
  timestamps are unresolved (counted), never defaulted.
- Scope policy is preserved: repository-scoped rows without a repository are
  unresolved rather than promoted to global.
- Accounting is explicit per table: `imported` + `unresolved` (+
  `excluded_by_selection`) reconciles with the source inventory in the
  preview and the manifest.
- A staged store carries `migration_manifest.state = 'incomplete'`; the
  daemon reports readiness `unavailable` with `MIGRATION_INCOMPLETE` and
  rejects memory operations (`unfinished_import_stores_are_unavailable`).

## Backup and restore

- `backup` produces a consistent snapshot, runs `integrity_check` and
  `foreign_key_check`, writes a 0600 file plus a manifest with store id,
  schema, revision, entity counts and SHA-256 checksum.
- `restore` previews compatibility (store id, schema, unfinished imports) and
  computes a plan fingerprint. Apply requires the fingerprint and
  `--clients-stopped`, takes a rescue snapshot, stages the snapshot, merges
  current suppressions and idempotency receipts, re-forgets suppressed rows,
  validates integrity, then swaps atomically and preserves the rescue file.
- `backup_and_restore_preserve_later_deletions` proves the critical recovery
  fixture: snapshot → forget → restore keeps the memory deleted, keeps the
  suppression ledger, and leaves the rescue artifact on disk.

## Verification

`cargo test --manifest-path daemon/Cargo.toml` passes 23 suites (including
`migration_proof`: 7 tests and `migration_gate`); clippy `-D warnings` and
`cargo fmt --check` are clean. CI runs the same suites on Ubuntu and macOS.

## Known gaps (honest boundary)

- Snapshot/import/restore failpoints are covered by atomic transactions and
  replay tests, not injected I/O failures; power-loss durability is not
  certified, and the docs say so.
- Restore merges suppression, receipts and forgotten-row state; it does not
  yet merge every ledger (domain/overlay manual fields, run history), and a
  missing/corrupt suppression set is refused rather than guessed.
- `lore paths move`, v2-to-v1 export and quarantine-acceptance workflows are
  not implemented.
- Rule-version reprocessing has no preview report enumerating affected
  sources (stage-5A gap carried forward).
- Episode digests, day summaries, domains, observations and operational
  history are excluded by selection in this pass; importing them is future
  work with the same accounting discipline.
