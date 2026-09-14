#!/usr/bin/env node
/**
 * scripts/dev-install.mjs
 *
 * Refreshes a Lore development checkout into the Copilot CLI extensions
 * directory through the same preserving installer used by `npm run setup`.
 *
 * The primary supported distribution flow is to clone Lore directly into
 * ~/.copilot/extensions/lore. This helper exists for contributors who prefer to
 * work from a checkout elsewhere and copy that checkout into the live extension
 * directory.
 *
 * Unlike the old copy helper, this wrapper:
 *   - refuses unrelated or modified destinations instead of deleting them
 *   - copies only the runtime files (not website/, tests/, .git, or worktrees)
 *   - writes ownership metadata compatible with `npm run setup -- --remove`
 *   - backs up and rolls back on failure
 *   - never installs the PATH shim (that belongs to full setup)
 *
 * Usage:
 *   node scripts/dev-install.mjs [--dry-run] [--copilot-home <path>]
 *
 * By default, installs to ~/.copilot/extensions/lore/.
 * Pass --dry-run to preview what would happen without making changes.
 * Pass --copilot-home <path> to override the ~/.copilot home directory.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planSetup, applySetup } from "../lib/clients/setup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { dryRun: false, copilotHome: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") { args.dryRun = true; continue; }
    if (argv[i] === "--copilot-home") { args.copilotHome = argv[i + 1]; i++; continue; }
    throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  return args;
}

function describeTarget(targetPath) {
  if (!existsSync(targetPath)) {
    return { exists: false, type: "missing" };
  }
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    return { exists: true, type: "symlink" };
  }
  if (stat.isDirectory()) {
    return { exists: true, type: "directory" };
  }
  return { exists: true, type: "other" };
}

function isSameInstall(sourcePath, targetPath) {
  if (!existsSync(sourcePath) || !existsSync(targetPath)) {
    return false;
  }
  const targetStat = lstatSync(targetPath);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    return false;
  }
  return realpathSync(sourcePath) === realpathSync(targetPath);
}

function logDryRunNoChanges() {
  console.log("[dry-run] Copilot CLI discovery is more reliable with a real directory install than a symlink.");
  console.log("[dry-run] No changes made.");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const copilotHome = path.resolve(args.copilotHome ?? path.join(os.homedir(), ".copilot"));
  const installTarget = path.join(copilotHome, "extensions", "lore");
  const label = args.dryRun ? "[dry-run] " : "";

  console.log(`${label}Lore dev-install`);
  console.log(`  repo root   : ${REPO_ROOT}`);
  console.log(`  install dir : ${installTarget}`);
  console.log(`  mode        : directory install (shared preserving installer)`);

  if (isSameInstall(REPO_ROOT, installTarget)) {
    console.log(`${label}Lore is already running from the install directory.`);
    console.log(`${label}Use 'git pull' in ${installTarget} to update this checkout.`);
    if (args.dryRun) {
      logDryRunNoChanges();
    }
    return;
  }

  const plan = planSetup(["copilot"], {
    env: { ...process.env, LORE_COPILOT_HOME: copilotHome },
    home: os.homedir(),
    source: REPO_ROOT,
    shim: false,
  });

  if (args.dryRun) {
    console.log(`${label}Would refresh the Copilot extension directory through the shared preserving installer.`);
    console.log(`${label}Unrelated or modified destinations are refused, never deleted in place; runtime files only.`);
    logDryRunNoChanges();
    return;
  }

  const backup = applySetup(plan);
  console.log("✓ Installed Lore as a real directory copy.");
  if (backup) {
    console.log(`Recoverable backups: ${backup}`);
  }
  console.log("Restart the Copilot CLI process to force extension rediscovery.");
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
