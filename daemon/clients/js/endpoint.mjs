// endpoint.mjs — resolve the daemon socket for any host adapter.
//
// Adapters are loaded by hosts that know nothing about Lore, so the socket
// cannot be an argument the host passes: it comes from the environment when a
// shell provides one, then from the config the installer wrote, then from the
// conventional path. Nothing is guessed beyond that — an unresolved endpoint
// means the adapter registers no tools and injects nothing.

import { existsSync, readFileSync } from "node:fs";

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
    const parsed = JSON.parse(readFileSync(`${home}/.lore/lore.json`, "utf8"));
    if (typeof parsed?.socketPath === "string" && parsed.socketPath) {
      return parsed.socketPath.replace(/^~/, home);
    }
  } catch {
    // No config: fall through to the conventional socket.
  }
  const fallback = `${home}/.lore/lored.sock`;
  return existsSync(fallback) ? fallback : null;
}
