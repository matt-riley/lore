#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

const LEGACY_CURSOR = "lore.db.pi-archive-cursor.json";

function defaultTargetDir() {
  const homeOverride = process.env.LORE_HOME?.trim();
  if (homeOverride) return path.resolve(homeOverride);
  const configHome = process.env.XDG_CONFIG_HOME?.trim();
  const absoluteConfigHome = configHome && path.isAbsolute(configHome)
    ? configHome
    : path.join(os.homedir(), ".config");
  return path.resolve(absoluteConfigHome, "lore");
}

function defaultSourceDir() {
  return path.resolve(process.env.LORE_COPILOT_HOME?.trim() || path.join(os.homedir(), ".copilot"));
}

function absolute(value) {
  return path.resolve(value);
}

function isSamePath(value, expected) {
  return typeof value === "string" && absolute(value) === absolute(expected);
}

function parseArgs(argv) {
  const args = { sourceDir: defaultSourceDir(), targetDir: defaultTargetDir(), help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--from") {
      args.sourceDir = argv[++index];
    } else if (arg === "--to") {
      args.targetDir = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.sourceDir || !args.targetDir) throw new Error("--from and --to require a path");
  return args;
}

export async function migrateLoreHome({ sourceDir, targetDir } = {}) {
  const source = absolute(sourceDir ?? defaultSourceDir());
  const target = absolute(targetDir ?? defaultTargetDir());
  if (source === target) throw new Error("source and target must be different directories");
  if (target.startsWith(`${source}${path.sep}`)) {
    throw new Error("target must not be inside the source directory");
  }
  await assertDirectory(source, "source does not exist");
  await assertAbsent(target, "target already exists");

  const configPath = path.join(source, "lore.json");
  const sourceDb = path.join(source, "lore.db");
  const hasConfig = await isFile(configPath);
  const hasDatabase = await isFile(sourceDb);
  if (!hasConfig && !hasDatabase) throw new Error("source contains no Lore config or database");

  const config = hasConfig ? JSON.parse(await readFile(configPath, "utf8")) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("source lore.json must contain a JSON object");
  }
  const paths = config.paths && typeof config.paths === "object" && !Array.isArray(config.paths)
    ? config.paths
    : (config.paths = {});
  const legacyDb = path.join(source, "lore.db");
  const legacyBackup = path.join(source, "backups", "lore");
  const copyDatabase = paths.derivedStorePath === undefined || isSamePath(paths.derivedStorePath, legacyDb);
  const copyBackups = paths.backupDir === undefined || isSamePath(paths.backupDir, legacyBackup);
  if (copyDatabase) paths.derivedStorePath = path.join(target, "lore.db");
  if (copyBackups) paths.backupDir = path.join(target, "backups");
  paths.copilotHome ??= source;
  paths.rawStorePath ??= path.join(source, "session-store.db");
  paths.instructionsPath ??= path.join(source, "copilot-instructions.md");
  paths.scopedInstructionsDir ??= path.join(source, "instructions");

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = path.join(parent, `.${path.basename(target)}.migration-${process.pid}-${randomUUID()}`);
  const copiedDatabase = copyDatabase && hasDatabase;
  const copiedBackups = copyBackups && await exists(legacyBackup);
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await writeFile(path.join(stage, "lore.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    if (copiedDatabase) await vacuumInto(sourceDb, path.join(stage, "lore.db"));
    if (copiedBackups) {
      await assertNoSymlinks(legacyBackup);
      await cp(legacyBackup, path.join(stage, "backups"), { recursive: true, force: false });
    }
    const cursor = path.join(source, LEGACY_CURSOR);
    if (copiedDatabase && await exists(cursor)) await copyFile(cursor, path.join(stage, LEGACY_CURSOR));
    await chmod(stage, 0o700);
    await chmod(path.join(stage, "lore.json"), 0o600);
    if (copiedDatabase) await chmod(path.join(stage, "lore.db"), 0o600);
    if (await exists(path.join(stage, LEGACY_CURSOR))) await chmod(path.join(stage, LEGACY_CURSOR), 0o600);
    if (await exists(path.join(stage, "backups"))) await restrictTree(path.join(stage, "backups"));
    await assertAbsent(target, "target already exists");
    await rename(stage, target);
  } catch (cause) {
    await rm(stage, { recursive: true, force: true });
    throw cause;
  }
  return { sourceDir: source, targetDir: target, copiedDatabase, copiedBackups };
}

async function restrictTree(root) {
  await chmod(root, 0o700);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) await restrictTree(entryPath);
    else await chmod(entryPath, 0o600);
  }
}

async function assertNoSymlinks(root) {
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`backup contains unsupported symlink: ${root}`);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`backup contains unsupported symlink: ${entryPath}`);
    if (entry.isDirectory()) await assertNoSymlinks(entryPath);
  }
}

async function isFile(filePath) {
  try { return (await stat(filePath)).isFile(); } catch { return false; }
}

async function vacuumInto(sourcePath, targetPath) {
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const escaped = targetPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function assertAbsent(filePath, message) {
  if (await exists(filePath)) throw new Error(message);
}

async function assertDirectory(dirPath, message) {
  try {
    if (!(await stat(dirPath)).isDirectory()) throw new Error(message);
  } catch (cause) {
    if (cause.message === message) throw cause;
    throw new Error(message, { cause });
  }
}

function printHelp() {
  console.log("Usage: node scripts/migrate-home.mjs [--from <legacy-dir>] [--to <lore-dir>]");
  console.log("\nMigrates Lore data from ~/.copilot to ~/.config/lore safely.");
  console.log("Defaults: --from LORE_COPILOT_HOME or ~/.copilot; --to LORE_HOME, XDG_CONFIG_HOME/lore, or ~/.config/lore.");
  console.log("Stop Lore sessions before migrating to avoid split writes.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) printHelp();
    else {
      const result = await migrateLoreHome({ sourceDir: args.sourceDir, targetDir: args.targetDir });
      console.log(`Migrated Lore home to ${result.targetDir}. Original files were retained.`);
      console.log("For a custom destination, set LORE_HOME to that directory in every harness. Update or unset any LORE_CONFIG override pointing at the old config.");
    }
  } catch (cause) {
    console.error(`[lore] migration failed: ${cause.message}`);
    process.exitCode = 1;
  }
}
