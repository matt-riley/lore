#!/usr/bin/env node
import { inspectRecoveryTarget, createRecoverySnapshot, restoreRecoverySnapshot, resolveRecoveryConfig } from "../lib/recovery.mjs";
import path from "node:path";

const resolveArgPath = (value) => path.resolve(process.cwd(), String(value ?? ""));

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--") || ["status", "backup", "restore"].includes(value)) throw new Error(`${option} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const args = { action: "status", write: false, clientsStopped: false };
  let actionSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (["status", "backup", "restore"].includes(value)) {
      if (actionSeen) throw new Error("only one recovery command may be supplied");
      args.action = value; actionSeen = true;
    }
    else if (value === "--write") args.write = true;
    else if (value === "--clients-stopped") args.clientsStopped = true;
    else if (value === "--config") args.configPath = resolveArgPath(requiredValue(argv, i++, value));
    else if (value === "--derived-store-path") args.derivedStorePath = resolveArgPath(requiredValue(argv, i++, value));
    else if (value === "--raw-store-path") args.rawStorePath = resolveArgPath(requiredValue(argv, i++, value));
    else if (value === "--backup-dir") args.backupDir = resolveArgPath(requiredValue(argv, i++, value));
    else if (value === "--from") args.snapshotPath = resolveArgPath(requiredValue(argv, i++, value));
    else if (value === "--help" || value === "-h") args.action = "help";
    else throw new Error(`unknown option: ${value}`);
  }
  if (args.action !== "restore" && (args.write || args.clientsStopped || args.snapshotPath)) throw new Error("--write, --clients-stopped, and --from are valid only with restore");
  return args;
}

function help() {
  return "Usage: node scripts/recover.mjs <status|backup|restore> [--from <snapshot>] [--write --clients-stopped] [--config <path>] [--derived-store-path <path>] [--raw-store-path <path>] [--backup-dir <path>]";
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.action === "help") { console.log(help()); process.exit(0); }
  const config = resolveRecoveryConfig(args);
  const options = { derivedStorePath: config.paths.derivedStorePath, backupDir: config.paths.backupDir };
  let result;
  if (args.action === "status") result = inspectRecoveryTarget(options);
  else if (args.action === "backup") result = createRecoverySnapshot(options);
  else {
    if (!args.snapshotPath) throw new Error("restore requires --from <snapshot>");
    result = restoreRecoverySnapshot({ ...options, snapshotPath: args.snapshotPath, write: args.write, clientsStopped: args.clientsStopped });
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[lore] ${error.message}`);
  process.exitCode = 1;
}
