#!/usr/bin/env node
/**
 * scripts/dev-install.mjs
 *
 * Copies a Lore checkout into the Copilot CLI extensions directory as a real
 * directory install.
 *
 * The primary supported distribution flow is to clone Lore directly into
 * ~/.copilot/extensions/lore. This helper exists for contributors who prefer to
 * work from a checkout elsewhere and copy that checkout into the live extension
 * directory.
 *
 * Copilot CLI has proven more reliable at discovering directory installs than
 * symlinked extension roots, so the helper always uses a copied checkout.
 *
 * Usage:
 *   node scripts/dev-install.mjs [--dry-run] [--copilot-home <path>]
 *
 * By default, installs to ~/.copilot/extensions/lore/.
 * Pass --dry-run to preview what would happen without making changes.
 * Pass --copilot-home <path> to override the ~/.copilot home directory.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const COPY_EXCLUDES = new Set([".git", "node_modules", ".DS_Store"]);

function parseArgs(argv) {
  const args = { dryRun: false, copilotHome: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") { args.dryRun = true; continue; }
    if (argv[i] === "--copilot-home") { args.copilotHome = argv[i + 1]; i++; continue; }
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

function copyLoreInstall(sourcePath, targetPath) {
  cpSync(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (currentPath) => {
      const baseName = path.basename(currentPath);
      if (COPY_EXCLUDES.has(baseName)) {
        return false;
      }
      return true;
    },
  });
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const copilotHome = args.copilotHome ?? path.join(os.homedir(), ".copilot");
  const extensionsDir = path.join(copilotHome, "extensions");
  const installTarget = path.join(extensionsDir, "lore");
  const label = args.dryRun ? "[dry-run] " : "";
  const targetState = describeTarget(installTarget);

  console.log(`${label}Lore dev-install`);
  console.log(`  repo root   : ${REPO_ROOT}`);
  console.log(`  install dir : ${installTarget}`);
  console.log(`  mode        : directory-copy`);

  if (isSameInstall(REPO_ROOT, installTarget)) {
    console.log(`${label}Lore is already running from the install directory.`);
    console.log(`${label}Use 'git pull' in ${installTarget} to update this checkout.`);
    if (args.dryRun) {
      console.log("[dry-run] No changes made.");
    }
    return;
  }

  if (!existsSync(extensionsDir)) {
    console.log(`${label}Creating extensions dir: ${extensionsDir}`);
    if (!args.dryRun) {
      mkdirSync(extensionsDir, { recursive: true });
    }
  }

  if (targetState.type === "other") {
    console.error(`ERROR: ${installTarget} exists but is not a directory or symlink.`);
    console.error("Remove or rename it manually, then re-run this script.");
    process.exit(1);
  }

  if (targetState.type === "symlink") {
    console.log(`${label}Replacing existing symlink with a real directory install.`);
  } else if (targetState.type === "directory") {
    console.log(`${label}Refreshing existing Lore install directory.`);
  } else {
    console.log(`${label}Installing Lore into Copilot extensions.`);
  }

  if (args.dryRun) {
    console.log("[dry-run] Copilot CLI discovery is more reliable with a real directory install than a symlink.");
    console.log("[dry-run] No changes made.");
    return;
  }

  rmSync(installTarget, { recursive: true, force: true });
  mkdirSync(installTarget, { recursive: true });
  copyLoreInstall(REPO_ROOT, installTarget);

  console.log("✓ Installed Lore as a directory copy.");
  console.log("Restart the Copilot CLI process to force extension rediscovery.");
}

main();
