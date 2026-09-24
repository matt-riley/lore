// Native CLI hooks (Codex, Claude Code, Antigravity) bake an absolute node
// path into the installed hook command at setup time. `process.execPath`
// often lives under a version manager's per-version install directory (mise,
// asdf, fnm, volta, nvm); once that manager prunes the version, the baked
// path disappears and every hook fails silently. Where a version manager
// exposes a version-independent alias/shim for the same install, prefer it.
//
// Kept dependency-free and side-effect-light so it is easy to unit test: all
// filesystem/env/version-check access is injectable.

import { accessSync, constants as fsConstants, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const MIN_NODE_MAJOR = 24;

const DEFAULT_FS = { accessSync, constants: fsConstants, readFileSync, readdirSync };

function isExecutableFile(candidatePath, fs) {
  try {
    fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultGetMajorVersion(nodePath) {
  try {
    const output = execFileSync(nodePath, ["--version"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = /^v?(\d+)/u.exec(output);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// Each detector recognizes its own version manager's pinned-install path
// shape and proposes version-independent alternatives, most preferred first.
// Adding a new manager only means adding one entry here.
function detectMiseCandidates(execPath) {
  const match = /^(.*[/\\]mise[/\\]installs[/\\]node)[/\\]([^/\\]+)[/\\]bin[/\\]node$/u.exec(execPath);
  if (!match) return [];
  const [, installsDir, version] = match;
  const major = /^v?(\d+)/u.exec(version)?.[1];
  const miseRoot = path.dirname(path.dirname(installsDir));
  const candidates = [];
  if (major) candidates.push({ path: path.join(installsDir, major, "bin", "node"), label: `mise node@${major} symlink` });
  candidates.push({ path: path.join(installsDir, "latest", "bin", "node"), label: "mise node@latest symlink" });
  candidates.push({ path: path.join(miseRoot, "shims", "node"), label: "mise shim" });
  return candidates;
}

function detectAsdfCandidates(execPath) {
  const match = /^(.*)[/\\]installs[/\\]nodejs[/\\][^/\\]+[/\\]bin[/\\]node$/u.exec(execPath);
  if (!match) return [];
  return [{ path: path.join(match[1], "shims", "node"), label: "asdf shim" }];
}

function detectFnmCandidates(execPath) {
  const match = /^(.*)[/\\]node-versions[/\\][^/\\]+[/\\]installation[/\\]bin[/\\]node$/u.exec(execPath);
  if (!match) return [];
  return [{ path: path.join(match[1], "aliases", "default", "installation", "bin", "node"), label: "fnm default alias" }];
}

function detectVoltaCandidates(execPath) {
  const match = /^(.*)[/\\]tools[/\\]image[/\\]node[/\\][^/\\]+[/\\]bin[/\\]node$/u.exec(execPath);
  if (!match) return [];
  return [{ path: path.join(match[1], "bin", "node"), label: "volta shim" }];
}

function detectNvmCandidates(execPath, { fs }) {
  const match = /^(.*)[/\\]versions[/\\]node[/\\][^/\\]+[/\\]bin[/\\]node$/u.exec(execPath);
  if (!match) return [];
  const root = match[1];
  let alias;
  try {
    alias = fs.readFileSync(path.join(root, "alias", "default"), "utf8").trim();
  } catch {
    return [];
  }
  if (!alias || alias.startsWith("lts/")) return [];
  const versionsDir = path.join(root, "versions", "node");
  let entries;
  try {
    entries = fs.readdirSync(versionsDir);
  } catch {
    return [];
  }
  const wanted = alias.startsWith("v") ? alias : `v${alias}`;
  const matchDir = entries.find((entry) => entry === wanted || entry.startsWith(`${wanted}.`));
  return matchDir ? [{ path: path.join(versionsDir, matchDir, "bin", "node"), label: `nvm default alias (${matchDir})` }] : [];
}

// Ordered detectors, keyed by id so detectVersionManager and the resolver
// share one source of truth for "what does a pinned path from X look like".
const DETECTORS = [
  { id: "mise", pattern: /[/\\]mise[/\\]installs[/\\]node[/\\][^/\\]+[/\\]bin[/\\]node$/u, detect: detectMiseCandidates },
  { id: "asdf", pattern: /[/\\]installs[/\\]nodejs[/\\][^/\\]+[/\\]bin[/\\]node$/u, detect: detectAsdfCandidates },
  { id: "fnm", pattern: /[/\\]node-versions[/\\][^/\\]+[/\\]installation[/\\]bin[/\\]node$/u, detect: detectFnmCandidates },
  { id: "volta", pattern: /[/\\]tools[/\\]image[/\\]node[/\\][^/\\]+[/\\]bin[/\\]node$/u, detect: detectVoltaCandidates },
  { id: "nvm", pattern: /[/\\]versions[/\\]node[/\\][^/\\]+[/\\]bin[/\\]node$/u, detect: detectNvmCandidates },
];

/**
 * Identify the version manager that owns a given node path, if any, purely
 * from its shape (no filesystem access). Used both to pick stable
 * alternatives and to flag an already-installed hook as version-pinned.
 * @param {string} nodePath
 * @returns {string|null}
 */
export function detectVersionManager(nodePath) {
  const value = String(nodePath ?? "");
  return DETECTORS.find(({ pattern }) => pattern.test(value))?.id ?? null;
}

// mise keeps floating aliases (major-version, `latest`, `lts*`) beside the
// concrete versions; they follow upgrades, so a hook pointing at one is not
// pinned even though its path has the same shape as a versioned install.
const MISE_STABLE_ALIAS = /[/\\]mise[/\\]installs[/\\]node[/\\](?:\d+|latest|lts[^/\\]*)[/\\]bin[/\\]node$/u;

/**
 * The version manager that pins this node path to one concrete version, or
 * null when the path is unmanaged or a version-independent alias/shim.
 * @param {string} nodePath
 * @returns {string|null}
 */
export function detectPinnedVersionManager(nodePath) {
  const value = String(nodePath ?? "");
  if (MISE_STABLE_ALIAS.test(value)) return null;
  return detectVersionManager(value);
}

/**
 * Resolve the node path Lore should bake into installed hooks/shims: an
 * explicit override, else a stable version-manager alias/shim if one exists
 * and satisfies the minimum Node version, else the running node itself.
 * @param {object} [options]
 * @param {string} [options.execPath] - The running node binary (process.execPath).
 * @param {NodeJS.ProcessEnv} [options.env] - Reads LORE_NODE for an explicit override.
 * @param {object} [options.fs] - Injectable { accessSync, constants, readFileSync, readdirSync }.
 * @param {(path: string) => number|null} [options.getMajorVersion] - Injectable version probe.
 * @param {number} [options.minMajor]
 * @returns {{ path: string, source: string, versionManager: string|null, pinned: boolean }}
 */
export function resolveStableNodePath({
  execPath = process.execPath,
  env = process.env,
  fs = DEFAULT_FS,
  getMajorVersion = defaultGetMajorVersion,
  minMajor = MIN_NODE_MAJOR,
} = {}) {
  const override = typeof env.LORE_NODE === "string" ? env.LORE_NODE.trim() : "";
  if (override) return { path: override, source: "LORE_NODE override", versionManager: null, pinned: false };

  const manager = detectVersionManager(execPath);
  if (!manager) return { path: execPath, source: "current node binary", versionManager: null, pinned: false };

  const detector = DETECTORS.find((entry) => entry.id === manager);
  const candidates = detector ? detector.detect(execPath, { env, fs }) : [];
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate.path, fs)) continue;
    const major = getMajorVersion(candidate.path);
    if (major == null || major < minMajor) continue;
    return { path: candidate.path, source: candidate.label, versionManager: manager, pinned: false };
  }
  return { path: execPath, source: `${manager}-managed install (no stable alternative found)`, versionManager: manager, pinned: true };
}
