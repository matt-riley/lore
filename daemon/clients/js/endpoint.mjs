// endpoint.mjs — resolve the daemon socket for any host adapter.
//
// Adapters are loaded by hosts that know nothing about Lore, so the socket
// cannot be an argument the host passes: it comes from the environment when a
// shell provides one, then from the config the installer wrote, then from the
// conventional path. Nothing is guessed beyond that — an unresolved endpoint
// means the adapter registers no tools and injects nothing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function resolveSocketPath(env = process.env) {
  const explicit = env.LORE_V2_SOCKET ?? env.LORE_SOCKET;
  if (explicit) return explicit;
  const home = env.HOME;
  if (!home) return null;
  try {
    const configPath = `${home}/.lore/lore.json`;
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed?.socketPath === "string" && parsed.socketPath) {
      // A relative socket is relative to the config file, never to the host's
      // working directory, which differs for every host process.
      const socketPath = parsed.socketPath.replace(/^~/, home);
      return isAbsolute(socketPath) ? socketPath : resolve(dirname(configPath), socketPath);
    }
  } catch {
    // No config: fall through to the conventional socket.
  }
  const fallback = `${home}/.lore/lored.sock`;
  return existsSync(fallback) ? fallback : null;
}

/**
 * Per-user journal for uncertain writes. Host adapters always get durable
 * recovery by default; LORE_V2_JOURNAL overrides the location. Returns null
 * only when no home directory exists, and then no socket resolves either.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function resolveJournalPath(env = process.env) {
  if (env.LORE_V2_JOURNAL) return env.LORE_V2_JOURNAL;
  const home = env.HOME;
  if (!home) return null;
  return `${home}/.lore/uncertain-writes-v2.json`;
}
