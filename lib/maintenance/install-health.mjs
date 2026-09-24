/**
 * install-health.mjs — read-only signal collection for `lore doctor`.
 *
 * Inspects the recorded install manifest and the native hook config files it
 * points at (Codex, Claude Code, Antigravity) to find installs that would
 * silently fail: a hook command whose node binary or lore-cli.mjs entry no
 * longer exists, a hook pinned to a version-manager path likely to be pruned,
 * or the same client installed in both global and project scope for the
 * current working directory. Never writes anything, and never throws on a
 * missing or malformed settings file — callers get a reported problem
 * instead of an exception.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { setupTargets } from "../clients/setup.mjs";

const HOOK_CLIENT_IDS = Object.freeze(["codex", "claude", "antigravity"]);
const INSTALL_MANIFEST = "install-manifest.json";

export function isExecutable(candidatePath) {
  try {
    accessSync(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readJsonSafe(target) {
  try {
    return { value: JSON.parse(readFileSync(target, "utf8")), error: null, missing: false };
  } catch (error) {
    if (error.code === "ENOENT") return { value: null, error: null, missing: true };
    return { value: null, error: error.message, missing: false };
  }
}

function readManifestSafe(manifestPath) {
  const { value, error, missing } = readJsonSafe(manifestPath);
  if (missing) return { manifest: null, error: null };
  if (error) return { manifest: null, error: `could not be parsed (${error})` };
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.installs || typeof value.installs !== "object" || Array.isArray(value.installs)) {
    return { manifest: null, error: "does not look like a Lore install manifest" };
  }
  return { manifest: value, error: null };
}

// Find every `command` string nested anywhere in a hooks/settings JSON value,
// the same shape setup.mjs's hook fragments and legacy-detection walk use.
function extractCommands(value) {
  const found = [];
  const visit = (item) => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== "object") return;
    if (typeof item.command === "string") found.push(item.command);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return found;
}

// Lore hook commands look like: '<node>' '<entryPath>/lore-cli.mjs' hook <client> <event>
// (see cli-hook-config.mjs#buildCliHookConfig / shellQuote). Parse the first
// two POSIX-single-quoted tokens directly rather than pulling in a shell
// parser — the shape is fully controlled by Lore's own installer.
function parseLoreCommand(command) {
  const tokens = [];
  let i = 0;
  while (i < command.length && tokens.length < 2) {
    while (command[i] === " ") i += 1;
    if (command[i] !== "'") break;
    i += 1;
    let value = "";
    while (i < command.length) {
      if (command[i] === "'") {
        if (command.slice(i, i + 4) === "'\\''") { value += "'"; i += 4; continue; }
        i += 1;
        break;
      }
      value += command[i];
      i += 1;
    }
    tokens.push(value);
  }
  if (tokens.length < 2 || !tokens[1].endsWith("lore-cli.mjs") || !/\bhook\b/u.test(command)) return null;
  return { nodePath: tokens[0], entryPath: tokens[1] };
}

function projectHookTarget(client, projectDir) {
  return {
    codex: path.join(projectDir, ".codex", "hooks.json"),
    claude: path.join(projectDir, ".claude", "settings.local.json"),
    antigravity: path.join(projectDir, ".agents", "hooks.json"),
  }[client];
}

/**
 * Collect install-health signals for `lore doctor`. Read-only; never throws.
 * @param {object} [options]
 * @param {string} options.loreHome - Resolved Lore home (where install-manifest.json lives).
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @param {string} [options.cwd] - Used only to detect a duplicate project-scope install.
 * @returns {{ manifestPath: string, manifestError: string|null, clients: object[], duplicates: object[] }}
 */
export function collectInstallHealthSignals({ loreHome, env = process.env, home = os.homedir(), cwd = process.cwd() }) {
  const manifestPath = path.join(loreHome, INSTALL_MANIFEST);
  const { manifest, error: manifestError } = readManifestSafe(manifestPath);
  const clients = [];
  const duplicates = [];
  if (!manifest) return { manifestPath, manifestError, clients, duplicates };

  // Only the codex/claude/antigravity (hooks) targets matter here, so the
  // copilot/pi paths setupTargets also returns are unused; pass a stand-in
  // rather than resolving copilotHome (which would stat the real home when
  // no override is given).
  const globalTargets = setupTargets({ copilotHome: home }, env, home);
  const ids = Object.keys(manifest.installs).filter((id) => HOOK_CLIENT_IDS.includes(id));

  for (const id of ids) {
    const record = manifest.installs[id];
    const target = (record && typeof record.target === "string" && record.target) || globalTargets[id];
    const { value, error, missing } = readJsonSafe(target);
    const entry = { client: id, target, missing, error, commands: [] };
    if (value) {
      const owned = Array.isArray(record?.commands) && record.commands.length ? new Set(record.commands) : null;
      const allCommands = extractCommands(value);
      const relevant = owned ? allCommands.filter((command) => owned.has(command)) : allCommands.filter((command) => /lore-cli\.mjs/u.test(command));
      entry.commands = relevant.map((command) => ({ command, parsed: parseLoreCommand(command) })).filter((row) => row.parsed);
    }
    clients.push(entry);

    const projectTarget = projectHookTarget(id, cwd);
    if (projectTarget && path.resolve(projectTarget) !== path.resolve(target) && existsSync(projectTarget)) {
      const projectRead = readJsonSafe(projectTarget);
      const projectHasLoreHooks = projectRead.value && extractCommands(projectRead.value).some((command) => /lore-cli\.mjs/u.test(command));
      if (projectHasLoreHooks) duplicates.push({ client: id, globalTarget: target, projectTarget, cwd });
    }
  }

  return { manifestPath, manifestError, clients, duplicates };
}
