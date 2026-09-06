# External maintenance scheduling

← [README](../README.md) · [Support matrix](support-matrix.md) · [Compatibility](compatibility.md) · [CONTRIBUTING](../CONTRIBUTING.md)

This document covers how to run Lore maintenance tasks reliably outside of Copilot CLI sessions using `scripts/run-maintenance.mjs` as the supported external entry point.

---

## Maintenance modes

Lore maintenance runs in three modes. Understanding which tasks belong to each mode is essential for scheduling.

| Mode | Trigger | Tasks |
|---|---|---|
| **Automatic** | `onSessionStart` hook | Bounded deferred `memoryHygiene` and `deferredExtraction` |
| **Manual / in-session** | `maintenance_schedule_run` tool; `--status`; `--dry-run` | Any enabled task |
| **External / scheduled** | `scripts/run-maintenance.mjs` via cron or launchd | Any enabled task |

### Automatic maintenance (session start)

When `maintenanceScheduler.enabled: true` and `maintenanceScheduler.autoRunOnSessionStart: true`, Lore evaluates the maintenance plan on `onSessionStart` and only selects `memoryHygiene` and `deferredExtraction` when they are enabled and due. Both run as bounded deferred work so the hook can return without waiting for them.

### Manual / in-session maintenance

Within an active session, use the `maintenance_schedule_run` tool to trigger a sweep or inspect the plan:

```
maintenance_schedule_run({ dryRun: true })   # plan without mutation
maintenance_schedule_run({ tasks: ["validationCorpus"] })
maintenance_schedule_run({ action: "rollback_hygiene", marker: "auto-hygiene:<run-id>", actor: "operator", reason: "false positive" })
```

You can also run `--status` or `--dry-run` from a terminal at any time — these do not require an active CLI session:

```sh
node scripts/run-maintenance.mjs --status
node scripts/run-maintenance.mjs --dry-run
```

### External / scheduled maintenance

Use `scripts/run-maintenance.mjs` with cron, launchd, or another OS scheduler for wall-clock-driven upkeep. See the [cron](#cron) and [launchd](#launchd-macos) sections below.

---

## Hook cadence disclaimer

**Session hooks do not guarantee wall-clock cadence.**

`onSessionStart` fires when a Copilot CLI session begins. If you rarely start sessions — or go on holiday — the automatic `deferredExtraction` pass and any other session-start work may not run for hours or days. This is by design: Lore does not run background timers or daemons inside the extension process.

For tasks that require reliable periodic execution regardless of session frequency, wire them into an external scheduler.

---

## Supported tasks

| Task | Default enabled | Suggested cadence | Notes |
|---|---|---|---|
| `memoryHygiene` | `true` (mode defaults to `off`) | Automatic at session start | `shadow` records candidates without mutation; `apply` supersedes only deterministic matches and writes reversible `auto-hygiene:<run-id>` markers. Never blocks write tools. |
| `deferredExtraction` | `true` | Automatic at session start | Also runnable externally. Requires `deferredExtraction.enabled: true` and `deferredExtraction.autoProcessOnSessionStart: true` for session-start auto-run. |
| `validationCorpus` | `true` | Every 12 h | Runs the validation case corpus against current retrieval behavior. |
| `replayCorpus` | `true` | Every 24 h | Runs the replay corpus and reports ranking hits/misses. |
| `backlogReview` | `true` | Every 6 h | Processes accumulated improvement backlog items. |
| `traceCompaction` | `false` | Every 1 h | Compacts trace recorder samples. Requires `rollout.traceRecorder: true`. |
| `indexUpkeep` | `false` | Every 12 h | Refreshes the memory index. |
| `doctorSnapshot` | `false` | Every 24 h | Captures a doctor health snapshot. Requires `rollout.loreDoctor: true` and `maintenanceScheduler.tasks.doctorSnapshot: true`. |

---

## Configuration

Scheduled maintenance reads the same `lore.json` that the extension uses at session start. All paths, rollout flags, and task enablement apply.

### Path resolution order

The script resolves the config path in this order:

1. `--config <path>` flag
2. `LORE_CONFIG` environment variable (config file path without relocating the database)
3. `LORE_HOME`/XDG default Lore home joined with `lore.json`
4. `lore.json` relative to the current working directory

For cron and launchd, always set `LORE_HOME` or `LORE_CONFIG` explicitly so the script does not depend on the working directory. Set `LORE_COPILOT_HOME` when Copilot input files are elsewhere; without a configured Lore home, legacy fallback remains available until the new home exists.

### Database isolation rule

Scheduled maintenance operates **only on the configured Lore database** (`~/.config/lore/lore.db` or the path in your config). It must never be pointed at test fixtures, shared databases, or databases owned by other users.

The `--derived-store-path` and `--raw-store-path` flags exist for legitimate path overrides (e.g., non-standard install locations), not for pointing the scheduler at fixture databases.

**Failed migrations and jobs use forward recovery, not destructive downgrade.** If a schema migration or task fails, Lore records the failure and leaves the database intact. Re-running the sweep or restarting the CLI will retry the failed path forward. Do not attempt to roll back schema changes manually — see the [rollback guidance](releasing.md#scenario-3----db-schema-migration-causes-data-issues) in `docs/releasing.md` if you need to recover from a migration issue.

---

## cron

Add entries to your crontab with `crontab -e`. Always redirect stderr alongside stdout so failures are not silently discarded.

```cron
# Lore maintenance — default Lore home install
# Redirect both stdout and stderr so failures appear in the log
0 */6 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview >> ~/.config/lore/maintenance.log 2>&1
15 2 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks replayCorpus,indexUpkeep,traceCompaction >> ~/.config/lore/maintenance.log 2>&1
30 3 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks doctorSnapshot >> ~/.config/lore/maintenance.log 2>&1
```

For a non-standard Lore location, set `LORE_HOME`:

```cron
0 */6 * * * LORE_HOME=/path/to/lore-home node /path/to/lore/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview >> /path/to/maintenance.log 2>&1
```

**cron environment notes:**

- `cron` starts jobs with a minimal `PATH`. Use the full path to `node` (find it with `which node` or `$(command -v node)` from an interactive shell).
- Volta or nvm-managed Node installs may not be on the `PATH` in cron's environment. Either use the full absolute path (e.g., `/Users/you/.volta/bin/node`) or set `PATH` in the crontab header.
- The script exits 0 on success and 1 on error. Check the log for non-zero exits or `Unknown task names:` messages, which indicate an unrecognised name in `--tasks`. Any unknown name — even mixed with valid names — causes an immediate exit 1 before running anything.

---

## launchd (macOS)

launchd is the recommended scheduler on macOS. Create a property list at `~/Library/LaunchAgents/com.lore.maintenance.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lore.maintenance</string>

  <key>ProgramArguments</key>
  <array>
    <!-- Use the full path to node; find it with: which node -->
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/.copilot/extensions/lore/scripts/run-maintenance.mjs</string>
    <string>--tasks</string>
    <string>validationCorpus,backlogReview,traceCompaction</string>
  </array>

  <!-- Run every 6 hours (21600 seconds) -->
  <key>StartInterval</key>
  <integer>21600</integer>

  <!-- Capture both stdout and stderr -->
  <key>StandardOutPath</key>
    <string>/Users/YOU/.config/lore/maintenance.log</string>
  <key>StandardErrorPath</key>
    <string>/Users/YOU/.config/lore/maintenance.log</string>

  <!-- Explicit home path so the script does not depend on cwd -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>LORE_HOME</key>
    <string>/Users/YOU/.config/lore</string>
  </dict>
</dict>
</plist>
```

Replace `YOU` with your username. Then load and verify:

```sh
launchctl load ~/Library/LaunchAgents/com.lore.maintenance.plist
launchctl list | grep com.lore.maintenance   # should show PID when running
```

To trigger a manual run immediately:

```sh
launchctl start com.lore.maintenance
```

To unload (stop scheduling):

```sh
launchctl unload ~/Library/LaunchAgents/com.lore.maintenance.plist
```

**launchd notes:**

- `StandardOutPath` and `StandardErrorPath` pointing at the same file is the simplest way to capture interleaved output.
- If your `node` binary is managed by Volta, use `/Users/YOU/.volta/bin/node` as the `ProgramArguments` first entry.
- launchd jobs run as your user and inherit your keychain and file permissions. No special privilege is required.
- Use `StartCalendarInterval` instead of `StartInterval` if you need specific clock times (e.g., run at 02:15 daily).

---

## Failure detection and reporting

The script exits **0** on success and **1** on any of:

- Any unknown task name in `--tasks` — including a mix of valid and unknown names (fail-closed: the script exits immediately before opening the DB, so no partial task set runs)
- DB initialization or migration failure
- Unhandled exception during sweep execution

**Minimum viable failure detection for cron/launchd:**

1. **Log both stdout and stderr** — append both streams to a log file with `>> logfile 2>&1`.
2. **Scan the log for non-zero exits** — if you have a monitoring system, alert on lines containing `Unknown task names:` or process exit codes ≠ 0.
3. **Use `--dry-run` to probe** — a dry-run does not mutate state and will surface DB or config errors the same as a live run.

To check whether the last run was successful without a monitoring system:

```sh
# tail the last ~20 lines of the log
tail -20 ~/.config/lore/maintenance.log

# or run a status check on-demand
node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --status
```

---

## Inspecting status

At any time, run status or dry-run to see the current maintenance state:

```sh
# Current task states and cadence tracking (no DB write):
node scripts/run-maintenance.mjs --status

# Full plan with due/not-due and last-run ages (no DB write):
node scripts/run-maintenance.mjs --dry-run

# Scope to a specific repository:
node scripts/run-maintenance.mjs --status --repository my-repo

# Override paths for a non-standard install:
node scripts/run-maintenance.mjs --status \
  --derived-store-path /path/to/lore.db \
  --raw-store-path /path/to/session-store.db
```

Output fields:

| Field | Meaning |
|---|---|
| `status` | `ok`, `dry_run`, or error status |
| `taskCount` | Total tasks in the plan |
| `completedCount` | Tasks that ran and completed in this sweep |
| `skippedCount` | Tasks skipped (not due, not enabled, or not selected) |
| `failedCount` | Tasks that completed with errors |
| For each task: `due`, `dueReason`, `lastRunMinutesAgo`, `nextRunMinutes` | Cadence tracking |

---

## Quick reference

```sh
# Show help
node scripts/run-maintenance.mjs --help

# Show recommended schedule with cron/launchd examples
node scripts/run-maintenance.mjs --recommended-schedule

# Dry-run (plan only, no state change)
node scripts/run-maintenance.mjs --dry-run

# Live sweep of specific tasks
node scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview

# Force tasks regardless of cadence
node scripts/run-maintenance.mjs --tasks indexUpkeep --force

# Status check (reads DB, no writes)
node scripts/run-maintenance.mjs --status
```
