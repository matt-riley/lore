#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COMMON_PATH_ARG_HANDLERS, consumeValueArg, parseArgsWith, resolveDefaultLoreConfigPath, finalizeScriptConfig } from "./shared-args.mjs";
import { LoreDb } from "../lib/db.mjs";
import { SessionStoreReader } from "../lib/session-store-reader.mjs";
import { USER_CONFIG_DEFAULTS, isPlainObject, mergeDeep, loadFileConfigSync } from "../lib/config.mjs";
import { createTraceRecorder } from "../lib/trace-recorder.mjs";
import { runMaintenanceSweep, TASK_ORDER } from "../lib/maintenance-scheduler.mjs";

function parseTaskList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyActionArg(args, action) {
  args.action = action;
  args.dryRun = true;
}

const ARG_HANDLERS = Object.freeze({
  "--dry-run": (args) => {
    args.dryRun = true;
    return false;
  },
  "--force": (args) => {
    args.force = true;
    return false;
  },
  "--status": (args) => {
    applyActionArg(args, "status");
    return false;
  },
  "--recommended-schedule": (args) => {
    applyActionArg(args, "recommended-schedule");
    return false;
  },
  "--help": (args) => {
    applyActionArg(args, "help");
    return false;
  },
  "-h": (args) => {
    applyActionArg(args, "help");
    return false;
  },
  "--tasks": (args, value) => consumeValueArg(args, "tasks", value, parseTaskList),
  ...COMMON_PATH_ARG_HANDLERS,
});

export function parseArgs(argv) {
  return parseArgsWith(ARG_HANDLERS, { action: "run", dryRun: false, force: false, tasks: [] }, argv);
}

function renderHelp() {
  return [
    "Usage:",
    "  node scripts/run-maintenance.mjs [options]",
    "",
    "The supported out-of-session entry point for Lore maintenance tasks.",
    "Designed for use with cron, launchd, or any external scheduler.",
    "Operates only on the configured Lore database; never touches test fixtures.",
    "",
    "Options:",
    "  --status                   Show current scheduler/task status (dry-run).",
    "  --dry-run                  Plan a maintenance sweep without state mutation.",
    "  --force                    Ignore cadence and force selected tasks due.",
    `  --tasks <csv>              Task subset: ${TASK_ORDER.join(",")}.`,
    "  --repository <name>        Optional repository scope override.",
    "  --config <path>            Optional lore.json path.",
    "  --derived-store-path <p>   Override derived lore DB path.",
    "  --raw-store-path <p>       Override session-store DB path.",
    "  --backup-dir <path>        Override backup directory.",
    "  --recommended-schedule     Show recommended external schedule guidance.",
    "  --help, -h                 Show this help text.",
    "",
    "Exit codes:",
    "  0  Sweep completed (or dry-run/status planned) successfully.",
    "  1  Error: any unknown task name in --tasks (fail-closed, DB never opened), DB failure, or unhandled exception.",
    "",
    "Environment variables:",
    "  LORE_COPILOT_HOME     Override ~/.copilot home directory (all path defaults derived from it).",
    "  LORE_CONFIG           Override lore.json path directly (takes priority over LORE_COPILOT_HOME).",
  ].join("\n");
}

function renderRecommendedSchedule(config) {
  const cadence = config.maintenanceScheduler?.taskCadenceMinutes ?? {};
  const cadenceFor = (name, fallback) => {
    const value = Number(cadence[name]);
    return Number.isFinite(value) ? value : fallback;
  };
  return [
    "Recommended maintenance schedule (external runner):",
    "",
    "Cadence model:",
    "- Session hooks (onSessionStart, onSessionEnd) do NOT guarantee wall-clock cadence.",
    "  They fire only when Copilot CLI sessions are active, so infrequent users may go",
    "  hours or days between hook invocations. Use an external scheduler for reliable upkeep.",
    "- On session start, Lore only auto-selects the deferredExtraction task.",
    "- All other tasks are for external or manual sweeps via this script.",
    "",
    "Maintenance modes:",
    "  automatic       deferredExtraction runs at session start when enabled and due.",
    "  manual          maintenance_schedule_run tool (in-session); --dry-run / --status flags.",
    "  external        This script, driven by cron, launchd, or another scheduler.",
    "",
    "Suggested cadences:",
    `- validationCorpus: every ${cadenceFor("validationCorpus", 12 * 60)} minutes (12 h)`,
    `- replayCorpus: every ${cadenceFor("replayCorpus", 24 * 60)} minutes (24 h)`,
    `- backlogReview: every ${cadenceFor("backlogReview", 6 * 60)} minutes (6 h)`,
    `- traceCompaction: every ${cadenceFor("traceCompaction", 60)} minutes (1 h)`,
    `- indexUpkeep: every ${cadenceFor("indexUpkeep", 12 * 60)} minutes (12 h)`,
    `- doctorSnapshot: every ${cadenceFor("doctorSnapshot", 24 * 60)} minutes (24 h, optional; requires rollout.loreDoctor=true and maintenanceScheduler.tasks.doctorSnapshot=true)`,
    "",
    "── cron examples (default ~/.copilot install) ─────────────────────────────",
    "# redirect stderr to a log file so failures are not silently discarded",
    "0 */6 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview >> ~/.copilot/lore-maintenance.log 2>&1",
    "15 2 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks replayCorpus,indexUpkeep,traceCompaction >> ~/.copilot/lore-maintenance.log 2>&1",
    "30 3 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks doctorSnapshot >> ~/.copilot/lore-maintenance.log 2>&1",
    "",
    "# non-standard install (LORE_COPILOT_HOME overrides ~/.copilot)",
    "0 */6 * * * LORE_COPILOT_HOME=/path/to/copilot-home node /path/to/lore/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview >> /path/to/lore-maintenance.log 2>&1",
    "",
    "── launchd example (macOS, default ~/.copilot install) ─────────────────────",
    "# Save as ~/Library/LaunchAgents/com.lore.maintenance.plist, then:",
    "#   launchctl load ~/Library/LaunchAgents/com.lore.maintenance.plist",
    "#   launchctl start com.lore.maintenance",
    "#",
    "# <?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "# <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\"",
    "#   \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "# <plist version=\"1.0\">",
    "# <dict>",
    "#   <key>Label</key>",
    "#   <string>com.lore.maintenance</string>",
    "#   <key>ProgramArguments</key>",
    "#   <array>",
    "#     <string>/usr/local/bin/node</string>",
    "#     <string>/Users/YOU/.copilot/extensions/lore/scripts/run-maintenance.mjs</string>",
    "#     <string>--tasks</string>",
    "#     <string>validationCorpus,backlogReview,traceCompaction</string>",
    "#   </array>",
    "#   <key>StartInterval</key>",
    "#   <integer>21600</integer>",
    "#   <key>StandardOutPath</key>",
    "#   <string>/Users/YOU/.copilot/lore-maintenance.log</string>",
    "#   <key>StandardErrorPath</key>",
    "#   <string>/Users/YOU/.copilot/lore-maintenance.log</string>",
    "#   <key>EnvironmentVariables</key>",
    "#   <dict>",
    "#     <key>LORE_COPILOT_HOME</key>",
    "#     <string>/Users/YOU/.copilot</string>",
    "#   </dict>",
    "# </dict>",
    "# </plist>",
    "",
    "Inspect status at any time:",
    "  node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --status",
    "  node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --dry-run",
    "",
    "See docs/maintenance-scheduling.md for the full guide.",
  ].join("\n");
}

function validateTaskNames(tasks) {
  if (tasks.length === 0) return null;
  const unknown = tasks.filter((t) => !TASK_ORDER.includes(t));
  if (unknown.length === 0) return null;
  return unknown;
}
function buildConfig(args) {
  // LORE_CONFIG env var provides a portable default config path that does
  // not depend on the working directory, useful for cron/CI/fixture environments.
  const defaultConfigPath = resolveDefaultLoreConfigPath();
  const fileConfig = loadFileConfigSync(args.configPath ?? defaultConfigPath);
  if (isPlainObject(fileConfig.maintenance) && !isPlainObject(fileConfig.maintenanceScheduler)) {
    fileConfig.maintenanceScheduler = fileConfig.maintenance;
  }
  const merged = mergeDeep(USER_CONFIG_DEFAULTS, fileConfig);
  const configPath = args.configPath ?? (existsSync(defaultConfigPath) ? defaultConfigPath : "(defaults)");
  return finalizeScriptConfig(merged, args, configPath);
}

function formatRows(rows, render) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "- none";
  }
  return rows.map(render).join("\n");
}

function renderResult(result) {
  return [
    `status: ${result.status}`,
    `dryRun: ${result.dryRun === true}`,
    `trigger: ${result.trigger}`,
    `repository: ${result.repository ?? "all"}`,
    `taskCount: ${result.taskCount}`,
    `completedCount: ${result.completedCount}`,
    `needsAttentionCount: ${result.needsAttentionCount}`,
    `failedCount: ${result.failedCount}`,
    `skippedCount: ${result.skippedCount}`,
    result.runId ? `runId: ${result.runId}` : null,
    "",
    "## Tasks",
    "",
    formatRows(result.tasks, (task) => {
      const caseIds = Array.isArray(task.summary?.caseIds) && task.summary.caseIds.length > 0
        ? ` cases=${task.summary.caseIds.join(",")}`
        : "";
      return `- ${task.label} status=${task.status} durationMs=${task.durationMs}${caseIds}`;
    }),
    "",
    "## Planned Tasks",
    "",
    formatRows(result.plan?.tasks ?? [], (task) => (
      `- ${task.label} enabled=${task.enabled} selected=${task.selected} due=${task.due} reason=${task.dueReason}`
    )),
  ].filter((line) => line !== null).join("\n");
}

function buildEmptyLatencyMetric() {
  return {
    p50Ms: 0,
    p95Ms: 0,
    averageMs: 0,
    maxMs: 0,
    latestMs: 0,
    samples: 0,
    minSamples: 0,
    targetMs: 0,
    targetStatus: "warming_up",
    recentAverageMs: 0,
    previousAverageMs: 0,
    trend: "no_samples",
    trendDeltaMs: 0,
    readiness: "insufficient_samples",
  };
}

function buildScriptRuntime({ args, config }) {
  const db = new LoreDb(config);
  db.initialize();
  const sessionStore = new SessionStoreReader(config);
  sessionStore.initialize();
  const traceRecorder = createTraceRecorder(config);

  return {
    db,
    runtime: {
      initialized: true,
      config,
      db,
      sessionStore,
      traceRecorder,
      repository: args.repository ?? null,
      lastError: null,
      metrics: {
        sessionStartP95: 0,
        userPromptSubmittedP95: 0,
        sampleSize: {
          sessionStart: 0,
          userPromptSubmitted: 0,
        },
        sessionStart: buildEmptyLatencyMetric(),
        userPromptSubmitted: buildEmptyLatencyMetric(),
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.action === "help") {
    console.log(renderHelp());
    return;
  }

  // Validate task names before touching the DB so cron typos fail loudly.
  // Fail closed: any unknown name — even mixed with valid names — exits 1 without running tasks.
  if (args.tasks.length > 0) {
    const unknownTasks = validateTaskNames(args.tasks);
    if (unknownTasks !== null) {
      console.error(`Unknown task names: ${unknownTasks.join(", ")}. Valid tasks: ${TASK_ORDER.join(", ")}`);
      process.exit(1);
    }
  }

  const config = buildConfig(args);
  if (args.action === "recommended-schedule") {
    console.log(renderRecommendedSchedule(config));
    return;
  }
  const { db, runtime } = buildScriptRuntime({ args, config });

  try {
    const result = await runMaintenanceSweep({
      runtime,
      repository: runtime.repository,
      trigger: args.action === "status" ? "status" : "script",
      requestedTasks: args.tasks,
      force: args.force,
      dryRun: args.dryRun,
    });
    console.log(renderResult(result));
  } finally {
    db.close();
  }
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
