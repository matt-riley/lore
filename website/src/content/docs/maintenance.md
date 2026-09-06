---
title: "Maintenance"
description: "Keep Lore healthy with bounded in-session, automatic, or scheduled maintenance."
section: "Understand Lore"
order: 6
---

Lore maintenance is local and bounded. Session hooks do not provide wall-clock scheduling: automatic work runs when a session starts, so use the maintenance script with cron or launchd when timing matters.

## Choose a mode

| Mode | Entry point | Best for |
| --- | --- | --- |
| Automatic | `onSessionStart` | Deferred extraction and hygiene when a session begins |
| Manual | `maintenance_schedule_run` | A dry run, one task, or an explicit rollback |
| Scheduled | `scripts/run-maintenance.mjs` | Reliable upkeep every few hours or days |

## Inspect before changing anything

From the Lore checkout:

```sh
node scripts/run-maintenance.mjs --status
node scripts/run-maintenance.mjs --dry-run
```

The in-session equivalent is `maintenance_schedule_run({ dryRun: true })`. Start with a dry run when enabling a new task.

## Useful task cadence

The built-in defaults suggest validation every 12 hours, replay every 24 hours, backlog review every 6 hours, and index upkeep every 12 hours when enabled. `traceCompaction` is hourly and `doctorSnapshot` is daily when their rollout gates are enabled.

## Memory hygiene

Hygiene is report-only in `shadow` mode. After reviewing candidates, `apply` may supersede open-loop or assistant-goal memories only when deterministic later evidence satisfies the scope rules. Applied rows receive an `auto-hygiene:<run-id>` marker.

To reverse one exact run:

```text
maintenance_schedule_run({
  action: "rollback_hygiene",
  marker: "auto-hygiene:<run-id>",
  actor: "operator",
  reason: "false positive"
})
```

Rollback restores rows carrying that marker and records an audit artifact.

## Schedule outside sessions

Example cron entry:

```text
0 */6 * * * LORE_HOME=/Users/YOU/.config/lore /path/to/node /Users/YOU/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview >> /Users/YOU/.config/lore/maintenance.log 2>&1
```

Use an absolute Node path because cron has a minimal `PATH`. Set `LORE_HOME` or `LORE_CONFIG` explicitly; use `LORE_COPILOT_HOME` when Copilot input files are elsewhere. Without a configured Lore home, legacy fallback remains available until the new home exists. On macOS, launchd is the recommended scheduler; the full property-list example lives in `docs/maintenance-scheduling.md`.

## Recovery and isolation

Stale deferred jobs and abandoned maintenance runs are reclaimed after their configured 30-minute defaults. Failed migrations and tasks use forward recovery and leave the database intact. Point maintenance only at the configured Lore database; do not aim it at fixtures or another user's data.
