# Session-start backfill snapshot policy design

## Problem

Lore currently snapshots `lore.db` for every new controlled backfill run, including the automatic session-start archive import path. In practice that produces a full database copy on many session starts even when the run only creates derived records for a small number of newly discovered sessions. Those snapshots accumulate in `~/.copilot/backups/lore` and consume disk without adding much recovery value for the automatic startup flow.

## Goal

Stop automatic session-start backfill from creating snapshots while preserving the existing restoreable snapshot behavior for manual controlled backfill starts and schema-migration safety backups.

## Non-goals

- Changing schema-migration backup behavior in `LoreDb.initialize()`
- Redesigning manual controlled backfill restore semantics
- Adding backup retention or pruning in this change

## Chosen approach

Introduce an explicit snapshot-policy input for controlled backfill starts.

- `startControlledBackfillRun(...)` accepts a snapshot-policy option.
- Automatic session-start backfill passes `never`.
- Manual controlled backfill starts keep the current default behavior, which continues creating a snapshot when the run has candidates.

This makes the behavioral split explicit at the call site instead of inferring it from `refreshExisting`, candidate actions, or config state.

## Alternatives considered

### 1. Infer snapshot behavior from `refreshExisting`

Only snapshot when `refreshExisting === true`.

Rejected because it makes restoreability depend on an indirect flag rather than the actual product intent. It would also be easy to break later if new backfill modes are added that are destructive without using `refreshExisting`.

### 2. Add a config flag for automatic session-start snapshots

Expose a setting to keep or disable automatic startup snapshots.

Rejected because the product decision is already clear: startup runs should not snapshot. Adding config would preserve the bad default, widen the surface area, and leave the codepath more complex than necessary.

## Design details

### API shape

Add a narrow snapshot policy to controlled backfill starts, for example:

- `auto` — current behavior; snapshot when the run has candidates
- `never` — never create a snapshot for the run

The initial implementation only needs the modes required by current callers.

### Callers

#### Automatic session-start backfill

`maybeRunSessionStartBackfill(...)` passes `never` when it calls `startControlledBackfillRun(...)`.

Result:

- startup runs still create `backfill_run` rows
- startup runs still process candidates
- startup runs store `snapshot_path = null`
- existing progress/status formatting continues to work and will render `snapshot: none`

#### Manual controlled backfill

The `memory_backfill` tool continues calling `startControlledBackfillRun(...)` without overriding the default snapshot behavior.

Result:

- manual starts still create snapshots
- restore-by-run remains available for those manual runs

### Restore behavior

No restore behavior changes are required in this change.

Runs created with `snapshot_path = null` already fail clearly in `restoreControlledBackfillRun(...)` with `backfill run <id> does not have a snapshot path`, which is acceptable for the new startup-run behavior.

## Data flow

1. Session starts.
2. Lore runtime initializes normally.
3. If session-start archive import is enabled and candidates exist, Lore starts a controlled backfill run with snapshot policy `never`.
4. Lore creates the `backfill_run` row with `snapshot_path = null`.
5. Lore processes backfill items and updates run progress as it does today.
6. Manual controlled backfill continues to use the default snapshot behavior and stores a `snapshot_path`.

## Affected files

- `lib/backfill.mjs` — add snapshot-policy handling inside `startControlledBackfillRun(...)`
- `extension.mjs` — pass the no-snapshot policy from the automatic session-start path
- `tests/unit/...` — add regression coverage for startup vs manual behavior

## Error handling

- Starting automatic session-start backfill should continue succeeding without a snapshot.
- Manual restore of a run without a snapshot should continue failing with the existing explicit error.
- No silent fallback to snapshot creation should occur in the startup path.

## Testing

Add focused tests for:

1. automatic session-start backfill starts a run with `snapshot_path = null`
2. manual controlled backfill start still produces a snapshot path
3. restore still fails clearly for runs that do not have a snapshot

## Rollout notes

This is a behavior change only for the automatic session-start archive import path. Manual controlled backfill and migration safety backups remain unchanged, so the rollout risk is low and localized.
