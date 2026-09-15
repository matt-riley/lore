# Slice 5B: migration, backup and recovery

Status: planned. Depends on G4 policy/extraction evidence. Exit contributes to G5.
References: `lib/db/schema.mjs`, `lib/db/db-snapshot-lifecycle.mjs`, `lib/maintenance/recovery.mjs`, `tests/fixtures/released-upgrades/`, `tests/unit/snapshot-manual-suppression.test.mjs`.

## Safety model and command surface

Migration imports a recognized v1 snapshot into a separate v2 destination. It never upgrades a live v1 database in place. A migrated installation is not activated by import. Real data operations require explicit commands and reviewable previews; tests use synthetic fixtures and isolated homes.

Planned Rust CLI commands:

```text
lore migrate v1 --source <v1-db> --destination <new-v2-dir> --dry-run
lore migrate v1 --source <v1-db> --destination <new-v2-dir> --apply --plan <fingerprint> --clients-stopped
lore migrate status --destination <v2-dir> --run <id>
lore migrate resume --destination <v2-dir> --run <id> --apply
lore backup --destination <explicit-backup-file>
lore restore --from <snapshot> --dry-run
lore restore --from <snapshot> --apply --plan <fingerprint> --clients-stopped
```

Preview is the default for migrate/restore. It opens sources read-only, does not create a destination DB, schema, run row or backup, and returns a bounded report to stdout. An optional explicit report output file is separate from store mutation. Apply locks the target, verifies the fingerprint and creates staging/run state. A stale preview requires a new preview.

Snapshot creation is explicitly requested by backup or is a documented prerequisite of an apply operation. Automatic snapshots do not authorize data deletion. Validate source/destination canonical identities and kinds, available space, permissions and recognized schema before copying.

## Released-schema support

Initial import support is exactly the authentic checked-in fixture set:

| v1 schema | Fixture release | Required reader |
| --- | --- | --- |
| 13 | v0.2.0 | Version-specific field/default mapping |
| 15 | v0.3.0 | Version-specific field/default mapping |
| 18 | v0.10.0 | Version-specific field/default mapping |
| 19 | v0.14.0 | Version-specific field/default mapping |
| 20 | v0.15.0 fixture; current baseline schema | Complete current mapping |

This is a planned support set, not implemented importer support today. Other/intermediate versions, missing/multiple conflicting version markers and future schemas fail closed. Add authentic released fixtures and explicit mappings before broadening it. Do not stamp unknown schemas as version 20 or run arbitrary v1 upgrade code on originals. The normal v2 migration command is Rust and does not require Node.

Read the source schema/version and table shape together; a version number alone is insufficient. Run integrity and foreign-key checks, then inventory every recognized and extra table/column. Unknown populated structures block apply until accounted for; an empty unknown structure is reported, never silently treated as migrated.

## Snapshot, staging and resumability

1. Preview inspects a consistent read-only source snapshot, validates identities, computes a logical source fingerprint and reports schema, rows, expected bytes, invalid fields, missing mappings and destination collisions.
2. Final apply requires stopped v1 clients and checks observed source state against the preview. Detection is best effort; document that the operator must stop unregistered writers as well. No competing v1 capture continues through final cutover.
3. Create a private immutable import snapshot using SQLite backup, validate it, fsync and record its checksum. A live main-file copy without WAL state is invalid. No schema writes or checkpoint commands target the original.
4. Initialize a separate staging v2 store with a new store ID and `MIGRATION_INCOMPLETE`. It cannot serve Recall or accept normal writes. Persist migration manifest, source fingerprint and mappings.
5. Import suppression/retirement and repository mapping before any derived content can be made eligible. Import in bounded transactions with stable table/key cursors, destination mappings and per-item disposition.
6. Validate field/provenance/relationship accounting, policies and checksums. Rebuild FTS and leave embedding intents pending; imported unverified v1 vectors are discarded as derived data. Embedding coverage is not a prerequisite for durable import completion.
7. Mark the staged import validated only when all rows are accounted for. Publish the destination with atomic rename on the same filesystem and directory fsync. Cutover remains a separate stage-7 action.

Resume always uses the same immutable snapshot, manifest and mapping fingerprint. Input changes start a new preview/run; never append a different snapshot to an existing cursor. Cancellation stops after the current transaction and preserves the stage for inspection/resume. A failed validation preserves originals and stage; it never activates a partially imported store.

## Field and entity accounting

| v1 data | v2 treatment | Required accounting |
| --- | --- | --- |
| semantic_memory | Preserve content/type, explicit authority, scope, confidence, tags, expiry, canonical identity and supersession | Preserve valid IDs; deterministic ID mapping for invalid/colliding legacy IDs, with every reference remapped |
| memory_suppression | Preserve active/retired state, scoped ID and canonical/evidence fingerprints, repair-candidate semantics | Imported before eligibility; forgotten manual IDs remain hidden |
| session_evidence / memory_evidence | Preserve source, proposition identity, role, revisions and retired links | No active auto row backed only by retired evidence |
| repository_identity_mapping | Preserve approved unambiguous mappings | Host/nested paths/local identities retained; ambiguous aliases quarantined |
| episode_digest / day_summary | Preserve content, date/provenance and retirement; mark unverifiable derived claims ineligible | All constituent links or explicit unresolved disposition |
| memory_domain / refreshable_observation | Preserve manual fields, source links, freshness/expiry and scope | Generated state cannot overwrite manual input |
| scope_override_audit / intent_journal | Preserve identities, actors, reasons, decisions and timestamps | Audit lineage and user-authored state retained |
| improvement_backlog / trajectory_artifact | Preserve workflow state, sourceCaseId, approval/integrity references | Imported proposals remain inactive; no automatic execution |
| deferred_extraction / ingestion_checkpoint | Preserve source/progress history; validate checkpoint anchors before reuse | Reconcile idempotently; unverified checkpoints restart safely with evidence deduplication |
| backfill_run / backfill_run_item / maintenance_run / maintenance_task_state | Preserve run history and map restartable work | In-flight v1 leases become interrupted, never assumed completed |
| lore_activity_state / retrieval_trace_sample / error_telemetry | Preserve bounded operational history in a separate restricted historical namespace | Raw trace samples require explicit include-sensitive-history selection; exclusions reported |
| memory_embedding / FTS tables | Rebuild in v2 | Count discarded derived rows; never count as lost authoritative content |
| lore_schema_version | Provenance only | Independent v2 schema version |
| raw session stores/files and v1 backups | Remain at original paths; register source roots only after explicit selection | No relocation, deletion, or modification |

Every source row is `imported`, `rebuilt_derived`, `excluded_by_selection`, or `unresolved`, with reason and destination identity where applicable. Sum of dispositions must equal the source inventory per table, with field accounting for semantic payload and references. No unexplained loss is accepted.

Invalid timestamps are unresolved, not expired-by-default or permanent-by-default. Convert valid ISO timestamps to UTC epoch milliseconds exactly; test offset forms and boundary precision. Naive/ambiguous timestamps require an explicit mapping/timezone rule in the preview.

Unresolved repository/authority/evidence rows can be preserved in quarantine only after explicit acceptance of the itemized gap set. They remain ineligible and the import is `complete_with_gaps`. Lossless migration certification requires zero unresolved authoritative rows. Intentional quarantine of unsafe historical rows is a documented correction, not proof of full recall parity.

## Backup and restoration

Backup is a consistent, integrity-checked SQLite snapshot with a manifest containing store ID, schema, memory revision, included entities, creation time, checksum and tool version. Use 0600 files and 0700 directories, private staging, no payloads in logs. Required pre-apply snapshots must fit backup quotas; failure stops the mutation.

Restore preview checks source/target compatibility and computes the changes and suppression/receipt union. Apply quiesces clients and service, takes store/endpoint locks, snapshots the current target to a rescue location, and stages the older snapshot. It does not overwrite the live DB until validation passes.

Merge current durable ID tombstones, canonical/evidence suppression, retired identities and idempotency receipts into the stage before policy validation. Current records take precedence when monotonic deletion/retry state conflicts with a backup. A receipt referring to an absent/forgotten row remains a historical acknowledgement, never an instruction to reconstruct content.

Proposition-level suppression does not erase a later deliberate manual re-save; exact ID tombstones still do. Preserve deletion and explicit replacement lineage so correction and fresh-manual-save fixtures survive restore. Suppression is never removed solely because the backup predates Forget.

Revalidate all derived aggregates against the merged ledger, rebuild indexes and invalidate stale vectors. Validate integrity and ID/reference consistency, fsync stage, rename current target to rescue, rename validated stage into place, fsync directory and reopen before reporting success. On any failed reopen, restore the rescue where possible and preserve all artifacts with explicit paths in local output.

If the latest suppression/receipt state is unavailable, corrupt or from an incompatible store, refuse automatic restoration. A chosen historical backup alone cannot prove it includes later deletions. Do not offer an unsafe restore option disguised as normal recovery.

Forget/Purge are not secure erasure from source transcripts, WAL, snapshots, exports, OS storage or remote providers. Recovery documentation must say so; do not remove backups automatically in an attempt to implement secure erasure.

## Rollback boundaries

Before cutover, rollback means abandon the staged v2 import and continue using unchanged v1. Preserve the stage until explicitly removed.

Explicit home relocation compatibility uses `lore paths move --source <dir> --destination <dir> --dry-run`, then `--apply --plan <fingerprint> --clients-stopped`. Inventory and snapshot first, copy to a separate validated destination, preserve store identity, and show the required service/config path changes. Switch only owned selected settings after checksum/reopen validation. Retain the original directory as recovery material; deleting it is a separate explicit operation. This command never runs implicitly during setup or version migration.

After v2 has accepted writes, rollback means use a compatible prior v2 binary/store or restore through the suppression/receipt-preserving procedure. Do not resume v1 automatically: it lacks later saves/deletions and could resurrect forgotten context. A v2-to-v1 exporter is not included in this release. If safe backward binary compatibility is unavailable, disable Lore context and use forward recovery with the v2 data preserved.

## TDD and acceptance

Test every released fixture, corrupt/missing/future versions, unknown populated columns, invalid timestamps, legacy IDs, ambiguous mappings and manual authority. Verify source DB/WAL/files and unrelated configuration remain unchanged.

Use failpoints at snapshot publication, every import chunk, completion marker, both rename boundaries and reopen. Resume must neither duplicate nor skip a row. Dry-run must create no DB, directories or run state. Exercise disk-full, insufficient backup capacity, symlink targets, input changes and concurrent source writes.

Critical recovery fixtures: forget manual ID then restore old backup; forget auto proposition then re-extract; deliberately re-save new manual ID; replay old Retain after Forget/restore; purge shared aggregates; restore an older receipt set; missing latest suppression state. All retrieval paths must honor the resulting policy.

G5 migration evidence includes per-table/field accounting, checksums, approved exclusions, unresolved list, restore/recovery rehearsal and operator-readable commands. No real-user cutover until these tests pass.
