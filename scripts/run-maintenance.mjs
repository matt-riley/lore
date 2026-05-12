#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { USER_CONFIG_DEFAULTS, isPlainObject, mergeDeep, loadFileConfigSync } from "../lib/config.mjs";
import { LoreDb } from "../lib/db.mjs";
import { runMaintenanceSweep } from "../lib/maintenance-scheduler.mjs";
import { SessionStoreReader } from "../lib/session-store-reader.mjs";
import { createTraceRecorder } from "../lib/trace-recorder.mjs";
import { COMMON_PATH_ARG_HANDLERS, consumeValueArg, parseArgsWith, resolveDefaultLoreConfigPath, finalizeScriptConfig } from "./shared-args.mjs";

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
    "Options:",
    "  --status                   Show current scheduler/task status (dry-run).",
    "  --dry-run                  Plan a maintenance sweep without state mutation.",
    "  --force                    Ignore cadence and force selected tasks due.",
    "  --tasks <csv>              Task subset: deferredExtraction,validationCorpus,replayCorpus,backlogReview,traceCompaction,indexUpkeep,doctorSnapshot.",
    "  --repository <name>        Optional repository scope override.",
    "  --config <path>            Optional lore.json path.",
    "  --derived-store-path <p>   Override derived lore DB path.",
    "  --raw-store-path <p>       Override session-store DB path.",
    "  --backup-dir <path>        Override backup directory.",
    "  --recommended-schedule     Show recommended external schedule guidance.",
    "  --help, -h                 Show this help text.",
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
    "- Keep session-start cheap/bounded: only deferredExtraction auto-runs at session start.",
    "- Use this script for periodic upkeep from cron/launchd/system scheduler.",
    "",
    "Suggested cadences:",
    `- validationCorpus: every ${cadenceFor("validationCorpus", 12 * 60)} minutes`,
    `- replayCorpus: every ${cadenceFor("replayCorpus", 24 * 60)} minutes`,
    `- backlogReview: every ${cadenceFor("backlogReview", 6 * 60)} minutes`,
    `- traceCompaction: every ${cadenceFor("traceCompaction", 60)} minutes`,
    `- indexUpkeep: every ${cadenceFor("indexUpkeep", 12 * 60)} minutes`,
    `- doctorSnapshot: every ${cadenceFor("doctorSnapshot", 24 * 60)} minutes (optional; requires rollout.loreDoctor=true and maintenanceScheduler.tasks.doctorSnapshot=true)`,
    "",
    "Example cron entries (default ~/.copilot install):",
    "0 */6 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview",
    "15 2 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks replayCorpus,indexUpkeep,traceCompaction",
    "30 3 * * * node ~/.copilot/extensions/lore/scripts/run-maintenance.mjs --tasks doctorSnapshot",
    "",
    "Non-standard install (set LORE_COPILOT_HOME to override ~/.copilot):",
    "0 */6 * * * LORE_COPILOT_HOME=/path/to/copilot-home node /path/to/lore/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview",
  ].join("\n");
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
