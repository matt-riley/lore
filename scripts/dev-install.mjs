#!/usr/bin/env node
/**
 * scripts/dev-install.mjs
 *
 * Installs (or re-installs) the Lore extension into your Copilot CLI extensions
 * directory as a symlink pointing to this repo root.
 *
 * Usage:
 *   node scripts/dev-install.mjs [--dry-run] [--copilot-home <path>]
 *
 * By default, installs to ~/.copilot/extensions/coherence -> <this repo root>.
 * Pass --dry-run to preview what would happen without making changes.
 * Pass --copilot-home <path> to override the ~/.copilot home directory.
 *
 * Safe to re-run: if the symlink already points here, it is left in place.
 * If the target exists but is NOT a symlink, the script refuses and exits 1.
 */

import { existsSync, lstatSync, readlinkSync, symlinkSync, mkdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { dryRun: false, copilotHome: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") { args.dryRun = true; continue; }
    if (argv[i] === "--copilot-home") { args.copilotHome = argv[i + 1]; i++; continue; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const copilotHome = args.copilotHome ?? path.join(os.homedir(), ".copilot");
  const extensionsDir = path.join(copilotHome, "extensions");
  const linkTarget = path.join(extensionsDir, "coherence");
  const label = args.dryRun ? "[dry-run] " : "";

  console.log(`${label}Lore dev-install`);
  console.log(`  repo root   : ${REPO_ROOT}`);
  console.log(`  link target : ${linkTarget}`);

  // Ensure extensions directory exists.
  if (!existsSync(extensionsDir)) {
    console.log(`${label}Creating extensions dir: ${extensionsDir}`);
    if (!args.dryRun) mkdirSync(extensionsDir, { recursive: true });
  }

  // Check existing state at the link path.
  if (existsSync(linkTarget) || isSymlink(linkTarget)) {
    const stat = lstatSync(linkTarget);
    if (!stat.isSymbolicLink()) {
      console.error(`ERROR: ${linkTarget} exists but is not a symlink.`);
      console.error("Remove or rename it manually, then re-run this script.");
      process.exit(1);
    }

    const currentDest = readlinkSync(linkTarget);
    if (currentDest === REPO_ROOT) {
      console.log("✓ Symlink already points to this repo. Nothing to do.");
      return;
    }

    console.log(`${label}Replacing existing symlink:`);
    console.log(`  current -> ${currentDest}`);
    console.log(`  new     -> ${REPO_ROOT}`);
    if (!args.dryRun) unlinkSync(linkTarget);
  }

  console.log(`${label}Creating symlink: ${linkTarget} -> ${REPO_ROOT}`);
  if (!args.dryRun) {
    symlinkSync(REPO_ROOT, linkTarget, "dir");
    console.log("✓ Installed. Restart your Copilot CLI session to activate Lore.");
  } else {
    console.log("[dry-run] No changes made.");
  }
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

main();
