import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

/** Normalize remote transports without dropping their host or nested path. */
export function canonicalRemoteIdentity(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  let host;
  let remotePath;
  try {
    if (text.includes("://")) {
      const url = new URL(text);
      if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol)) return null;
      host = url.host.toLowerCase();
      remotePath = url.pathname;
    } else {
      const match = text.match(/^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/u);
      if (!match || match[1].length === 1) return null;
      host = match[1].toLowerCase();
      remotePath = match[2];
    }
    remotePath = remotePath.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
    if (!host || !remotePath || /[\s?#]/u.test(remotePath)
      || remotePath.split("/").some((part) => !part || part === "." || part === "..")) return null;
    return `${host}/${remotePath}`;
  } catch { return null; }
}

function mappedIdentity(legacy, mappings) {
  if (!legacy) return null;
  const entries = Array.isArray(mappings) ? mappings : [];
  const matches = new Set(entries.filter((row) => row.legacy === legacy)
    .map((row) => row.canonical).filter((value) => typeof value === "string" && value.trim()));
  return matches.size === 1 ? [...matches][0] : null;
}

/** Resolve live Git identity, or an explicitly approved legacy association. */
export function resolveRepositoryIdentity({ cwd, explicit, legacy, mappings = [] } = {}) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (typeof cwd === "string" && cwd.trim()) {
    const git = (args) => execFileSync("git", args, {
      cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Resolve the Git common directory first: a missing origin must not be
    // confused with a non-repository, and linked worktrees need one identity.
    try {
      const common = realpathSync(path.resolve(cwd, git(["rev-parse", "--git-common-dir"])));
      try {
        const remote = canonicalRemoteIdentity(git(["remote", "get-url", "origin"]));
        if (remote) return remote;
      } catch { /* A local-only repository still has a stable local identity. */ }
      return `local:${createHash("sha256").update(common).digest("hex")}`;
    } catch { /* Only explicitly mapped host-provided legacy IDs are trusted. */ }
  }
  return mappedIdentity(typeof legacy === "string" ? legacy.trim() : null, mappings);
}
