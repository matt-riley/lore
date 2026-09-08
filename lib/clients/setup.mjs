import { accessSync, constants, existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, cpSync, rmSync, realpathSync, readdirSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveLorePaths } from "../core/lore-paths.mjs";
import { buildCliHookConfig, mergeCliHookConfig, shellQuote } from "./cli-hook-config.mjs";
import { isPlainObject } from "../core/config.mjs";

export const LORE_PATH_SHIM_MARKER = "# lore-path-shim";

export const SETUP_CLIENTS = Object.freeze([
  { id: "copilot", name: "GitHub Copilot CLI", executable: "copilot", kind: "directory" },
  { id: "pi", name: "Pi", executable: "pi", kind: "directory" },
  { id: "codex", name: "Codex CLI", executable: "codex", kind: "hooks" },
  { id: "claude", name: "Claude Code", executable: "claude", kind: "hooks" },
  { id: "antigravity", name: "Antigravity CLI", executable: "agy", kind: "hooks" },
]);
const SOURCE = fileURLToPath(new URL("../../", import.meta.url));
const RUNTIME_FILES = ["package.json", "extension.mjs", "lore-pi.ts", "lore-server.mjs", "lore-server-runtime.mjs", "lore-cli.mjs", "pi-session-reader.mjs", "lib", "schemas", "browser", "scripts", "lore.example.json"];
const INSTALL_MANIFEST = "install-manifest.json";
const INSTALL_MARKER = ".lore-install.json";

function clientKind(id) {
  const client = SETUP_CLIENTS.find((candidate) => candidate.id === id);
  if (!client) throw new Error(`Unknown client: ${id}`);
  return client.kind;
}

export function isLorePathShim(content) {
  return String(content ?? "").includes(LORE_PATH_SHIM_MARKER);
}

export function formatLorePathExport(loreHome) {
  return `export PATH="${loreHome}/bin:$PATH"`;
}

export function buildLorePathShimScript({ nodePath, cliPath } = {}) {
  const node = shellQuote(nodePath);
  const cli = shellQuote(cliPath);
  return `#!/bin/sh
${LORE_PATH_SHIM_MARKER}
NODE="\${LORE_NODE:-}"
CLI="\${LORE_CLI:-}"
if [ -z "$NODE" ]; then
  NODE=${node}
fi
if [ -z "$CLI" ]; then
  CLI=${cli}
fi
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node)" || { echo "lore: Node.js >=24 not found; set LORE_NODE" >&2; exit 1; }
fi
exec "$NODE" "$CLI" "$@"
`;
}

export function findWritablePathDirectory(env = process.env, {
  home = os.homedir(),
  skip = [],
  destName = "lore",
  allowDest = null,
} = {}) {
  const skipped = new Set([...skip].map((value) => path.resolve(value)));
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir));
  const preferred = path.resolve(home, ".local", "bin");
  const ordered = dirs.includes(preferred) ? [preferred, ...dirs.filter((dir) => dir !== preferred)] : dirs;
  for (const resolved of ordered) {
    if (skipped.has(resolved)) continue;
    try {
      if (!statSync(resolved).isDirectory()) continue;
      accessSync(resolved, constants.W_OK);
    } catch {
      continue;
    }
    const dest = path.join(resolved, destName);
    try {
      if (allowDest && !allowDest(dest)) continue;
    } catch {
      continue;
    }
    return resolved;
  }
  return null;
}

function destIsReusableLoreShim(dest) {
  const stat = targetStat(dest);
  if (!stat) return true;
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  try {
    return isLorePathShim(readFileSync(dest, "utf8"));
  } catch {
    return false;
  }
}

function targetStat(target) {
  try { return lstatSync(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function detectClients(env = process.env) {
  return SETUP_CLIENTS.map((client) => {
    const executablePath = (env.PATH || "").split(path.delimiter).filter(Boolean)
      .map((directory) => path.resolve(directory, client.executable)).find((candidate) => {
        try { accessSync(candidate, constants.X_OK); return lstatSync(realpathSync(candidate)).isFile(); } catch { return false; }
      });
    return { ...client, executablePath };
  });
}

export function selectClients(value, clients) {
  const available = clients.filter((client) => client.executablePath);
  const tokens = value.trim().toLowerCase().split(/[\s,]+/u).filter(Boolean);
  if (!tokens.length) return [];
  const ids = tokens.length === 1 && tokens[0] === "all" ? available.map((client) => client.id)
    : tokens.map((token) => /^\d+$/u.test(token) ? available[Number(token) - 1]?.id : token);
  if (ids.some((id) => !available.some((client) => client.id === id))) throw new Error("Select only detected clients by number or name (or all).");
  return [...new Set(ids)];
}

function readTarget(target) {
  try {
    if (!lstatSync(target).isFile()) throw new Error(`Expected a regular file, not a symlink: ${target}`);
    const original = readFileSync(target, "utf8");
    const value = JSON.parse(original);
    if (!isPlainObject(value)) throw new Error(`Expected a JSON object: ${target}`);
    return { original, value };
  } catch (error) {
    if (error.code === "ENOENT") return { original: null, value: {} };
    throw error;
  }
}

function readManifest(target) {
  const fail = (reason, cause) => {
    throw new Error(`Invalid Lore installation manifest at ${target}: ${reason}. Restore it from a known-good backup or repair its ownership records before retrying. No changes were made.`, { cause });
  };
  const nonEmptyString = (value) => typeof value === "string" && Boolean(value.trim());
  let original, manifest;
  try {
    ({ original, value: manifest } = readTarget(target));
  } catch (error) {
    if (error.code) throw error;
    fail(error.message, error);
  }
  if (original === null) return { version: 1, installs: {} };
  if (manifest.version !== 1) fail("expected version 1");
  if (!isPlainObject(manifest.installs)) fail("expected an installs object");
  for (const [id, record] of Object.entries(manifest.installs)) {
    const kind = SETUP_CLIENTS.find((client) => client.id === id)?.kind;
    if (!kind) fail(`unknown client ${id}`);
    if (!isPlainObject(record)) fail(`${id}: ownership record is not an object`);
    if (record.kind !== kind) fail(`${id}: expected kind ${kind}`);
    if (!nonEmptyString(record.target)) fail(`${id}: missing target`);
    if (kind === "hooks" && !(Array.isArray(record.commands) && record.commands.length && record.commands.every(nonEmptyString))) {
      fail(`${id}: commands must be a non-empty array of strings`);
    }
  }
  return manifest;
}

function hookCommands(fragment, client) {
  if (client === "antigravity") return Object.values(fragment.lore).flatMap((value) => value.flatMap((hook) => hook.command || hook.hooks?.[0]?.command));
  return Object.values(fragment.hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command));
}

function fingerprint(root, names = RUNTIME_FILES) {
  const hash = createHash("sha256");
  const visit = (current, relative) => {
    const stat = lstatSync(current);
    hash.update(`${relative}:${stat.mode}:${stat.size}:${stat.isDirectory() ? "d" : "f"}\n`);
    if (stat.isDirectory()) for (const name of readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name));
    else hash.update(readFileSync(current));
  };
  for (const name of names) visit(path.join(root, name), name);
  return hash.digest("hex");
}

function markerFor(client, source) {
  return { version: 1, client, source: path.resolve(source), files: [...RUNTIME_FILES], fingerprint: fingerprint(source) };
}

function readMarker(target) {
  try { return readTarget(path.join(target, INSTALL_MARKER)).value; } catch { return null; }
}

function hasOnlyRuntimeFiles(target, marker) {
  if (!marker || marker.version !== 1 || !Array.isArray(marker.files) || typeof marker.fingerprint !== "string") return false;
  const allowed = new Set([...marker.files, INSTALL_MARKER]);
  return readdirSync(target).every((entry) => allowed.has(entry))
    && marker.fingerprint === fingerprint(target);
}

export function planSetup(ids, { env = process.env, home = os.homedir(), source = SOURCE } = {}) {
  if (env.LORE_ENABLED && !["1", "true", "yes", "on"].includes(env.LORE_ENABLED.toLowerCase())) throw new Error("Unset LORE_ENABLED or set it to true before setup; the environment override would disable Lore.");
  const paths = resolveLorePaths({ env, home });
  const changes = [];
  const addJson = (target, update) => {
    const { original, value } = readTarget(target);
    const merged = update(value);
    if (JSON.stringify(value) !== JSON.stringify(merged)) changes.push({ type: "json", target, original, content: `${JSON.stringify(merged, null, 2)}\n` });
  };
  addJson(paths.configPath, (value) => ({ ...value, enabled: true }));
  const manifestPath = path.join(paths.loreHome, INSTALL_MANIFEST);
  const manifest = readManifest(manifestPath);
  const targets = {
    copilot: path.join(paths.copilotHome, "extensions", "lore"),
    pi: path.join(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "extensions", "lore"),
    codex: path.join(env.CODEX_HOME || path.join(home, ".codex"), "hooks.json"),
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json"),
    antigravity: path.join(home, ".gemini", "config", "hooks.json"),
  };
  const destinations = [paths.configPath, ...ids.map((id) => targets[id]).filter(Boolean)];
  for (let i = 0; i < destinations.length; i++) {
    for (let j = i + 1; j < destinations.length; j++) {
      const a = path.resolve(destinations[i]);
      const b = path.resolve(destinations[j]);
      if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) throw new Error(`Installation targets overlap: ${a} and ${b}`);
    }
  }
  for (const id of ids) {
    const target = targets[id];
    if (clientKind(id) === "directory") {
      const stat = targetStat(target);
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Review existing non-directory installation: ${target}`);
        if (realpathSync(target) === realpathSync(source)) continue;
        const pkg = readTarget(path.join(target, "package.json")).value;
        if (pkg.name !== "lore" || !existsSync(path.join(target, "extension.mjs"))) throw new Error(`Refusing to replace an unrelated directory: ${target}`);
      }
      changes.push({ type: "directory", target, source, client: id, existed: Boolean(stat), inode: stat?.ino });
      manifest.installs[id] = { kind: "directory", target, marker: INSTALL_MARKER, source: path.resolve(source) };
    } else {
      const fragment = buildCliHookConfig(id, { nodePath: process.execPath, entryPath: path.join(source, "lore-cli.mjs") });
      const ownedCommands = manifest.installs?.[id]?.commands;
      addJson(target, (value) => {
        const cleaned = ownedCommands?.length ? mergeCliHookConfig(value, fragment, id, { remove: true, ownedCommands }) : value;
        return mergeCliHookConfig(cleaned, fragment, id);
      });
      manifest.installs[id] = { kind: "hooks", target, commands: hookCommands(fragment, id) };
    }
  }
  const addFile = (target, content, mode = 0o755) => {
    const stat = targetStat(target);
    let original = null;
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Review existing non-file installation: ${target}`);
      original = readFileSync(target, "utf8");
      if (original === content) return;
    }
    changes.push({ type: "file", target, original, content, mode, existed: original !== null });
  };
  const homeBin = path.join(paths.loreHome, "bin", "lore");
  const shimScript = buildLorePathShimScript({
    nodePath: process.execPath,
    cliPath: path.join(source, "lore-cli.mjs"),
  });
  const pathDir = findWritablePathDirectory(env, {
    home,
    skip: [path.dirname(homeBin)],
    allowDest: destIsReusableLoreShim,
  });
  const pathCopy = pathDir ? path.join(pathDir, "lore") : null;
  manifest.shim = {
    homeBin,
    pathCopy: pathCopy && path.resolve(pathCopy) !== path.resolve(homeBin) ? pathCopy : null,
  };
  addJson(manifestPath, () => manifest);
  addFile(homeBin, shimScript);
  if (manifest.shim.pathCopy) addFile(manifest.shim.pathCopy, shimScript);
  return {
    paths,
    changes,
    targets: ids.map((id) => ({ id, target: targets[id] })),
    shim: manifest.shim,
    pathExport: manifest.shim.pathCopy ? null : formatLorePathExport(paths.loreHome),
  };
}

// Preflight the complete plan before any writes. Backups live outside extension
// discovery paths; interrupted/failed updates never recursively erase an install.
function quarantine(target, backupRoot) {
  if (!existsSync(target)) return null;
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(backupRoot, `quarantine-${randomUUID()}`);
  renameSync(target, destination);
  console.warn(`Concurrent edits preserved at ${destination}`);
  return destination;
}

function installedDirectoryIsUntouched(target) {
  const marker = readMarker(target);
  return Boolean(marker && hasOnlyRuntimeFiles(target, marker));
}

export function applySetup(plan, { afterApply = null } = {}) {
  const completed = [];
  const backupRoot = path.join(plan.paths.loreHome, "install-backups", randomUUID());
  const ensureBackups = () => {
    if (existsSync(backupRoot)) return;
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const manifest = plan.changes.map((change, index) => ({ target: change.target, type: change.type,
      existed: change.type === "json" ? change.original !== null : change.existed, backup: String(index) }));
    writeFileSync(path.join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  };
  try {
    for (const [index, change] of plan.changes.entries()) {
      mkdirSync(path.dirname(change.target), { recursive: true });
      const backup = path.join(backupRoot, String(index));
      const temporary = `${change.target}.lore-setup-${randomUUID()}.tmp`;
      let restoreFrom = backup;
      try {
        if (change.type === "json") {
          if (readTarget(change.target).original !== change.original) throw new Error(`Config changed during setup: ${change.target}`);
          writeFileSync(temporary, change.content, { mode: 0o600, flag: "wx" });
          if (change.original !== null) {
            ensureBackups();
            writeFileSync(backup, change.original, { mode: 0o600, flag: "wx" });
          }
        } else if (change.type === "directory") {
          mkdirSync(temporary);
          for (const file of RUNTIME_FILES) cpSync(path.join(change.source, file), path.join(temporary, file), { recursive: true, dereference: false });
          writeFileSync(path.join(temporary, INSTALL_MARKER), `${JSON.stringify(markerFor(change.client, change.source), null, 2)}\n`, { mode: 0o600, flag: "wx" });
          const current = targetStat(change.target);
          if (Boolean(current) !== change.existed || (current && (!current.isDirectory() || current.ino !== change.inode))) throw new Error(`Installation changed during setup: ${change.target}`);
          if (change.existed) {
            ensureBackups();
            try { renameSync(change.target, backup); } catch (error) {
              if (error.code !== "EXDEV") throw error;
              // Keep the original on its own volume until the entire plan
              // commits. The independent backup can reside on another volume.
              cpSync(change.target, backup, { recursive: true, errorOnExist: true, force: false });
              restoreFrom = `${change.target}.lore-setup-original-${randomUUID()}`;
              renameSync(change.target, restoreFrom);
            }
          }
        } else if (change.type === "directory-remove") {
          const current = targetStat(change.target);
          if (!current || !current.isDirectory() || current.isSymbolicLink() || current.ino !== change.inode || !installedDirectoryIsUntouched(change.target)) throw new Error(`Installation changed during removal: ${change.target}`);
          ensureBackups();
          renameSync(change.target, backup);
          restoreFrom = backup;
        } else if (change.type === "file") {
          const currentOriginal = existsSync(change.target) && lstatSync(change.target).isFile() && !lstatSync(change.target).isSymbolicLink()
            ? readFileSync(change.target, "utf8")
            : null;
          if (currentOriginal !== change.original) throw new Error(`Installation changed during setup: ${change.target}`);
          writeFileSync(temporary, change.content, { mode: change.mode ?? 0o755, flag: "wx" });
          if (change.original !== null) {
            ensureBackups();
            writeFileSync(backup, change.original, { mode: 0o600, flag: "wx" });
          }
        } else if (change.type === "file-remove") {
          const currentOriginal = existsSync(change.target) && lstatSync(change.target).isFile()
            ? readFileSync(change.target, "utf8")
            : null;
          if (currentOriginal !== change.original) throw new Error(`Installation changed during removal: ${change.target}`);
          ensureBackups();
          renameSync(change.target, backup);
          restoreFrom = backup;
        } else {
          throw new Error(`Unknown setup change type: ${change.type}`);
        }
        completed.push({ ...change, backup, restoreFrom });
        if (change.type !== "directory-remove" && change.type !== "file-remove") renameSync(temporary, change.target);
        if (change.type === "json" && readFileSync(change.target, "utf8") !== change.content) throw new Error(`Verification failed: ${change.target}`);
        if (change.type === "file") {
          if (readFileSync(change.target, "utf8") !== change.content) throw new Error(`Verification failed: ${change.target}`);
          chmodSync(change.target, change.mode ?? 0o755);
        }
        if (change.type === "directory" && !existsSync(path.join(change.target, "extension.mjs"))) throw new Error(`Verification failed: ${change.target}`);
        if (change.type === "directory-remove" && existsSync(change.target)) throw new Error(`Verification failed: ${change.target}`);
        if (change.type === "file-remove" && existsSync(change.target)) throw new Error(`Verification failed: ${change.target}`);
        if (afterApply) afterApply(change);
      } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
    }
  } catch (error) {
    for (const change of completed.reverse()) {
      if (change.type === "json") {
        const current = targetStat(change.target);
        const unchanged = current && current.isFile() && readFileSync(change.target, "utf8") === change.content;
        if (!unchanged && current) quarantine(change.target, backupRoot);
        if (change.original === null) {
          if (unchanged) rmSync(change.target, { force: true });
        } else writeFileSync(change.target, change.original, { mode: 0o600 });
      } else if (change.type === "directory") {
        if (existsSync(change.target)) {
          if (installedDirectoryIsUntouched(change.target)) rmSync(change.target, { recursive: true, force: true });
          else quarantine(change.target, backupRoot);
        }
        if (change.existed) renameSync(change.restoreFrom, change.target);
      } else if (change.type === "directory-remove") {
        if (existsSync(change.target)) quarantine(change.target, backupRoot);
        renameSync(change.restoreFrom, change.target);
      } else if (change.type === "file") {
        const current = targetStat(change.target);
        const unchanged = current && current.isFile() && readFileSync(change.target, "utf8") === change.content;
        if (!unchanged && current) quarantine(change.target, backupRoot);
        if (change.original === null) {
          if (unchanged) rmSync(change.target, { force: true });
        } else {
          writeFileSync(change.target, change.original, { mode: change.mode ?? 0o755 });
        }
      } else if (change.type === "file-remove") {
        if (existsSync(change.target)) quarantine(change.target, backupRoot);
        renameSync(change.restoreFrom, change.target);
      }
    }
    throw error;
  }
  for (const change of completed) {
    if (change.restoreFrom !== change.backup) {
      try { rmSync(change.restoreFrom, { recursive: true, force: true }); } catch (error) {
        console.warn(`Lore installed, but could not remove the retired extension at ${change.restoreFrom}: ${error.message}. Move it out of the extensions directory before restarting the client.`);
      }
    }
  }
  return existsSync(backupRoot) ? backupRoot : null;
}

function setupTargets(paths, env, home) {
  return {
    copilot: path.join(paths.copilotHome, "extensions", "lore"),
    pi: path.join(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "extensions", "lore"),
    codex: path.join(env.CODEX_HOME || path.join(home, ".codex"), "hooks.json"),
    claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json"),
    antigravity: path.join(home, ".gemini", "config", "hooks.json"),
  };

}

function legacyHookCommands(value, client) {
  const found = [];
  const expected = new Set(hookCommands(buildCliHookConfig(client, { nodePath: process.execPath, entryPath: path.join(SOURCE, "lore-cli.mjs") }), client));
  const visit = (item) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return;
    if (typeof item.command === "string" && expected.has(item.command)) found.push(item.command);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return [...new Set(found)];
}

export function planRemove(ids, { env = process.env, home = os.homedir() } = {}) {
  const paths = resolveLorePaths({ env, home });
  const manifestPath = path.join(paths.loreHome, INSTALL_MANIFEST);
  const manifest = readManifest(manifestPath);
  const targets = setupTargets(paths, env, home);
  const changes = [];
  const next = structuredClone(manifest);
  for (const id of ids) {
    const record = manifest.installs?.[id];
    const target = record?.target || targets[id];
    if (clientKind(id) === "directory") {
      if (!record || record.kind !== "directory") {
        if (existsSync(manifestPath) && !targetStat(target)) { delete next.installs[id]; continue; }
        throw new Error(`Refusing to remove ${id}: no Lore ownership record was found.`);
      }
      const stat = targetStat(target);
      const marker = stat && stat.isDirectory() && !stat.isSymbolicLink() ? readMarker(target) : null;
      if (!stat || !marker || marker.client !== id || !hasOnlyRuntimeFiles(target, marker)) throw new Error(`Refusing to remove ${id}: the installed runtime is missing ownership metadata or contains modified content.`);
      changes.push({ type: "directory-remove", target, existed: true, inode: stat.ino });
    } else {
      const { original, value } = readTarget(target);
      if (original === null) { delete next.installs[id]; continue; }
      const fragment = buildCliHookConfig(id, { nodePath: process.execPath, entryPath: path.join(SOURCE, "lore-cli.mjs") });
      const commands = record?.commands?.length ? record.commands : legacyHookCommands(value, id);
      if (!commands.length) {
        if (existsSync(manifestPath)) { delete next.installs[id]; continue; }
        throw new Error(`Refusing to remove ${id}: no identifiable Lore hook ownership was found.`);
      }
      const merged = mergeCliHookConfig(value, fragment, id, { remove: true, ownedCommands: commands });
      if (JSON.stringify(value) !== JSON.stringify(merged)) changes.push({ type: "json", target, original, content: `${JSON.stringify(merged, null, 2)}\n` });
    }
    delete next.installs[id];
  }
  const addFileRemove = (target) => {
    if (!target) return;
    const stat = targetStat(target);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return;
    const original = readFileSync(target, "utf8");
    if (!isLorePathShim(original)) return;
    changes.push({ type: "file-remove", target, original, existed: true });
  };
  if (!Object.keys(next.installs || {}).length) {
    const homeBin = manifest.shim?.homeBin || path.join(paths.loreHome, "bin", "lore");
    const pathCopy = manifest.shim?.pathCopy || null;
    addFileRemove(homeBin);
    if (pathCopy && path.resolve(pathCopy) !== path.resolve(homeBin)) addFileRemove(pathCopy);
    delete next.shim;
  }
  if (Object.keys(next.installs || {}).length) {
    const current = readTarget(manifestPath);
    if (JSON.stringify(current.value) !== JSON.stringify(next)) changes.push({ type: "json", target: manifestPath, original: current.original, content: `${JSON.stringify(next, null, 2)}\n` });
  } else if (existsSync(manifestPath)) {
    const current = readTarget(manifestPath);
    changes.push({ type: "json", target: manifestPath, original: current.original, content: `${JSON.stringify({ version: 1, installs: {} }, null, 2)}\n` });
  }
  return { paths, changes, targets: ids.map((id) => ({ id, target: targets[id] })), shim: next.shim ?? null, pathExport: null };
}

export function applyRemove(plan) {
  return applySetup(plan);
}
