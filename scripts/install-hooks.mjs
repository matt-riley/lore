import { readFile, lstat, mkdir, copyFile, writeFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildCliHookConfig, mergeCliHookConfig } from "../lib/clients/cli-hook-config.mjs";

const help = `Install Lore for Copilot, Pi, Codex, Claude Code, or Antigravity:
  npm run setup
  npm run setup -- --clients all --dry-run

This advanced helper only manages native lifecycle hooks:
  npm run install-hooks -- <codex|claude|antigravity> [--project PATH | --global] [--write] [--remove]
It previews by default; --write applies changes. Antigravity requires --global.
Use npm run setup for automatic client detection and Copilot/Pi installation.`;

async function main() {
  const [client, ...args] = process.argv.slice(2);
  if (!client || client === "--help" || client === "-h") {
    console.log(help);
    return;
  }
  if (!["codex", "claude", "antigravity"].includes(client)) {
    throw new Error(`This command only manages native hooks.\n\n${help}`);
  }
  const options = { write: false, remove: false, global: false, project: process.cwd() };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--write") options.write = true;
    else if (args[i] === "--dry-run") options.write = false;
    else if (args[i] === "--remove") options.remove = true;
    else if (args[i] === "--global") options.global = true;
    else if (args[i] === "--project" && args[i + 1] && !args[i + 1].startsWith("--")) options.project = path.resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (client === "antigravity" && !options.global) {
    throw new Error("Antigravity CLI 1.1.19 does not discover project hooks; use --global for ~/.gemini/config/hooks.json");
  }
  const fragment = buildCliHookConfig(client, { nodePath: process.execPath, entryPath: fileURLToPath(new URL("../lore-cli.mjs", import.meta.url)) });
  const home = os.homedir();
  const target = options.global
    ? { codex: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "hooks.json"),
      claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json"),
      antigravity: path.join(home, ".gemini", "config", "hooks.json") }[client]
    : path.join(options.project, { codex: ".codex/hooks.json", claude: ".claude/settings.local.json", antigravity: ".agents/hooks.json" }[client]);
  let existing = {};
  let original = null;
  try {
    if (!(await lstat(target)).isFile()) throw new Error("Hook config must be a regular file, not a symlink");
    original = await readFile(target, "utf8");
    existing = JSON.parse(original);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const merged = mergeCliHookConfig(existing, fragment, client, options);
  if (!options.write) {
    console.log(`Dry run: would ${options.remove ? "remove Lore hooks from" : "merge Lore hooks into"} ${target}`);
    console.log(JSON.stringify(fragment, null, 2));
  } else if (JSON.stringify(existing) === JSON.stringify(merged)) {
    console.log(`Already up to date: ${target}`);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    const suffix = randomUUID();
    if (original !== null) {
      const backup = `${target}.lore-backup-${suffix}`;
      await copyFile(target, backup, constants.COPYFILE_EXCL);
      console.log(`Backup: ${backup}`);
    }
    const temporary = `${target}.lore-${suffix}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      // Refuse to overwrite concurrent changes made since the initial read.
      const current = await readFile(target, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (current !== original) throw new Error("Hook config changed during installation; retry after reviewing it");
      await rename(temporary, target);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    console.log(`${options.remove ? "Removed" : "Installed"} Lore hooks: ${target}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`lore install-hooks: ${error.message}`);
  process.exitCode = 1;
}
