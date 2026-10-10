// repository-identity.mjs — canonical repository identity for host adapters.
//
// Port of the v1 contract in lib/utils/repository-identity.mjs and the Rust
// crate in daemon/crates/repository-identity. Host adapters ship as a self-
// contained unit, so they carry this port rather than importing from lib/.
// Every case in tests/v2/fixtures/repository-identity.json must pass here and
// in both other implementations, or prompt recall silently queries a different
// scope from the one ingestion wrote to.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

/** Normalize remote transports to `host/path`, keeping host and full path. */
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
  } catch {
    return null;
  }
}

/**
 * Canonical identity for the repository containing `cwd`, or null when there
 * is no repository. A repository without an origin gets a stable local
 * identity derived from its Git common directory, so linked worktrees agree.
 * A miss only means global scope; it is never a failure.
 */
export function resolveRepositoryIdentity(cwd, { exec = execFileSync } = {}) {
  if (!cwd) return null;
  const git = (args) =>
    String(
      exec("git", ["-C", String(cwd), ...args], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      }) ?? "",
    ).trim();
  let common;
  try {
    common = realpathSync(path.resolve(String(cwd), git(["rev-parse", "--git-common-dir"])));
  } catch {
    return null;
  }
  try {
    const remote = canonicalRemoteIdentity(git(["remote", "get-url", "origin"]));
    if (remote) return remote;
  } catch {
    // A local-only repository still has a stable local identity.
  }
  return `local:${createHash("sha256").update(common).digest("hex")}`;
}
