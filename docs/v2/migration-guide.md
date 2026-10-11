# Migrating from v1 to v2

Status: draft. Migration is implemented, preview-first and proven on fixtures.
One real v1 store (about 300 memories) has been migrated and is in pilot use;
that is the only real-store run so far. v1 is still the default mode. Treat
this guide as the runbook for further pilots, not an announcement.

## What changes

| | v1 | v2 |
| --- | --- | --- |
| Runtime | Node CLI + hooks, SQLite | Rust daemon (`lored`) + CLI, SQLite |
| Storage | `lore.db` in the lore home | `lore-v2.db` in the configured data dir |
| Clients | Copilot CLI, Pi, Codex, Claude, Antigravity hooks | same five, via adapters |
| Retrieval | lexical | lexical + optional embeddings, fused |
| Extractions | rule-based, in-process | rule-based, durable intent journal |
| Deletion | row removal | durable suppression rows, forget survives re-ingest |

Migration is **forward-only**. There is no v2 → v1 downgrade; the v1 source
database is never mutated, so v1 remains runnable after a v2 import.

## Before you start

1. Stop client sessions that write to v1 (hooks can keep running, but a quiet
   period makes the cutover obvious).
2. Take a v1 backup using the existing v1 tooling, and copy the whole lore
   home — including `lore.db`, its `-wal`/`-shm` siblings, config and
   integration files.
3. Confirm the v2 daemon runs against the *destination* directory:

   ```sh
   $LORE status --json          # schema, readiness, store id
   ```

4. Read the preflight in the migration plan output. It names the v1 schema
   version it found, the tables it will import, the rows it will exclude and
   why.

## Preview

```sh
$LORE migrate v1 \
  --source "$HOME/.lore/lore.db" \
  --destination "$HOME/.lore/v2" \
  --dry-run
```

The preview is read-only. It reports:

- per-table row counts that will be imported;
- excluded tables (for example v1-derived aggregates that v2 recomputes) with
  reasons — nothing is dropped silently;
- a **fingerprint** over the source bytes and the plan. The same fingerprint
  must be supplied to apply, so a source that changed between preview and
  apply is refused rather than half-imported.

Inspect the counts. If they disagree with your expectations, stop and
investigate before applying.

## Apply

```sh
$LORE migrate v1 \
  --source "$HOME/.lore/lore.db" \
  --destination "$HOME/.lore/v2" \
  --apply --plan <fingerprint> --clients-stopped
```

- `--clients-stopped` is required: it is your assertion that no writer is
  active. The importer takes a snapshot of the source in SQLite backup mode,
  so a writer that ignores this still cannot corrupt the source, but a run
  with active writers can miss rows written after the snapshot.
- The import stages into `<destination>/.lore-import/`, validates it, then
  activates it. A failure leaves the previous store untouched.
- Suppressions, evidence, receipts and revision counters are imported so that
  deletions and idempotency keep working.

## Verify

```sh
$LORE migrate status --destination "$HOME/.lore/v2"
$LORE status --json
$LORE recall "a phrase you remember saving"
$LORE search "a distinctive term" --output json
```

Check that:

- `migrate status` reports `validated`/`complete` and the same row counts as
  the preview;
- recall returns memories you recognise, with their original created/updated
  times;
- a memory you had deleted in v1 does **not** come back after a re-ingest;
- the dashboard (`$LORE browser --open`) shows counts in the same ballpark as
  v1.

## Cutover

1. Point clients at v2: `$LORE setup --clients all --dry-run` then `--apply`.
2. Record the mode: `$LORE mode select --mode v2 --dry-run`, then `--apply`.
3. Keep v1 installed but idle for the agreed soak window. Do not delete
   anything yet.
4. During the soak, `lore_recall`/`lore_retain` operate on v2 only. v1 will
   drift; that is expected and is why the v1 source is never mutated.

## Rollback

Within the soak window, rolling back means returning clients to v1:

```sh
$LORE mode select --mode v1 --apply
$LORE setup --remove --apply        # only lore-owned integration files
```

v1 keeps working because its database was never touched. v2 data written
during the soak is not imported back into v1; keep it as an archive. Re-running
the v1 import into a fresh v2 destination later re-imports the source, not the
soak-window additions.

## Known limits

- v2 does not read or write v1's database directly; the import is the only
  bridge.
- Episode digests and day summaries are recomputed by v2 from captured
  sources, so v1-derived aggregates are intentionally excluded.
- Trace samples, activity rows and other v1-derived history that v2 does not
  persist are excluded with reasons in the preview.
- Windows is out of scope.
