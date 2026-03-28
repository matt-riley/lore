#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { USER_CONFIG_DEFAULTS } from "../lib/config.mjs";
import { CoherenceDb } from "../lib/db.mjs";
import { runMaintenanceSweep } from "../lib/maintenance-scheduler.mjs";
import { SessionStoreReader } from "../lib/session-store-reader.mjs";
import { createTraceRecorder } from "../lib/trace-recorder.mjs";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeDeep(base[key], value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function parseArgs(argv) {
  const args = {
    action: "run",
    dryRun: false,
    force: false,
    tasks: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (part === "--force") {
      args.force = true;
      continue;
    }
    if (part === "--status") {
      args.action = "status";
      args.dryRun = true;
      continue;
    }
    if (part === "--recommended-schedule") {
      args.action = "recommended-schedule";
      args.dryRun = true;
      continue;
    }
    if (part === "--help" || part === "-h") {
      args.action = "help";
      args.dryRun = true;
      continue;
    }
    if (part === "--tasks") {
      args.tasks = String(argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (part === "--config") {
      args.configPath = path.resolve(process.cwd(), String(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }
    if (part === "--repository") {
      args.repository = String(argv[index + 1] ?? "").trim() || null;
      index += 1;
      continue;
    }
    if (part === "--derived-store-path") {
      args.derivedStorePath = path.resolve(process.cwd(), String(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }
    if (part === "--backup-dir") {
      args.backupDir = path.resolve(process.cwd(), String(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }
    if (part === "--raw-store-path") {
      args.rawStorePath = path.resolve(process.cwd(), String(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }
  }
  return args;
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
    "  --config <path>            Optional coherence.json path.",
    "  --derived-store-path <p>   Override derived coherence DB path.",
    "  --raw-store-path <p>       Override session-store DB path.",
    "  --backup-dir <path>        Override backup directory.",
    "  --recommended-schedule     Show recommended external schedule guidance.",
    "  --help, -h                 Show this help text.",
    "",
    "Environment variables:",
    "  COHERENCE_COPILOT_HOME     Override ~/.copilot home directory (all path defaults derived from it).",
    "  COHERENCE_CONFIG           Override coherence.json path directly (takes priority over COHERENCE_COPILOT_HOME).",
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
    `- doctorSnapshot: every ${cadenceFor("doctorSnapshot", 24 * 60)} minutes (optional; requires rollout.coherenceDoctor=true and maintenanceScheduler.tasks.doctorSnapshot=true)`,
    "",
    "Example cron entries (default ~/.copilot install):",
    "0 */6 * * * node ~/.copilot/extensions/coherence/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview",
    "15 2 * * * node ~/.copilot/extensions/coherence/scripts/run-maintenance.mjs --tasks replayCorpus,indexUpkeep,traceCompaction",
    "30 3 * * * node ~/.copilot/extensions/coherence/scripts/run-maintenance.mjs --tasks doctorSnapshot",
    "",
    "Non-standard install (set COHERENCE_COPILOT_HOME to override ~/.copilot):",
    "0 */6 * * * COHERENCE_COPILOT_HOME=/path/to/copilot-home node /path/to/coherence/scripts/run-maintenance.mjs --tasks validationCorpus,backlogReview",
  ].join("\n");
}

function loadFileConfig(configPath) {
  if (!configPath || !existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function buildConfig(args) {
  // COHERENCE_CONFIG env var provides a portable default config path that does
  // not depend on the working directory, useful for cron/CI/fixture environments.
  const envConfigPath = process.env.COHERENCE_CONFIG?.trim() || null;
  const envCopilotHome = process.env.COHERENCE_COPILOT_HOME?.trim() || null;
  const defaultConfigPath = envConfigPath
    ?? (envCopilotHome ? path.join(envCopilotHome, "coherence.json") : null)
    ?? path.resolve(process.cwd(), "coherence.json");
  const fileConfig = loadFileConfig(args.configPath ?? defaultConfigPath);
  if (isPlainObject(fileConfig.maintenance) && !isPlainObject(fileConfig.maintenanceScheduler)) {
    fileConfig.maintenanceScheduler = fileConfig.maintenance;
  }
  const merged = mergeDeep(USER_CONFIG_DEFAULTS, fileConfig);
  return {
    ...merged,
    paths: {
      ...merged.paths,
      rawStorePath: args.rawStorePath ?? merged.paths.rawStorePath,
      derivedStorePath: args.derivedStorePath ?? merged.paths.derivedStorePath,
      backupDir: args.backupDir ?? merged.paths.backupDir,
    },
    configPath: args.configPath ?? (existsSync(defaultConfigPath) ? defaultConfigPath : "(defaults)"),
  };
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
  const db = new CoherenceDb(config);
  db.initialize();
  const sessionStore = new SessionStoreReader(config);
  sessionStore.initialize();
  const traceRecorder = createTraceRecorder(config);
  const runtime = {
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
      sessionStart: {
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
      },
      userPromptSubmitted: {
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
      },
    },
  };

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
