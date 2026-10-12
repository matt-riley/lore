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
 * @param {string} [client] host whose installer document names the socket
 * @returns {string | null}
 */
export function resolveSocketPath(env = process.env, client = null) {
  const explicit = env.LORE_V2_SOCKET ?? env.LORE_SOCKET;
  if (explicit) return explicit;
  const home = env.HOME;
  if (!home) return null;
  // `lore setup` records the socket it installed for each client. That is the
  // endpoint the daemon actually serves when setup used a custom config.
  if (client) {
    try {
      const document = JSON.parse(readFileSync(`${home}/.lore/integrations/${client}.json`, "utf8"));
      if (typeof document?.socketPath === "string" && document.socketPath) {
        return document.socketPath.replace(/^~/, home);
      }
    } catch {
      // No installer document for this host: fall through to the shared config.
    }
  }
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
 * The data directory the daemon and CLI own: LORE_V2_DATA_DIR, then the
 * `dataDir` the config names, then the config's own directory. Null when
 * neither a home directory nor an override exists, and then no socket
 * resolves either.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function resolveDataDir(env) {
  const home = env.HOME;
  const configPath = home ? `${home}/.lore/lore.json` : null;
  let config = null;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // No config: only an override or the conventional home directory remains.
  }
  const base = configPath && config ? dirname(configPath) : process.cwd();
  const expand = (value) => {
    const expanded = value.replace(/^~/, home ?? "");
    return isAbsolute(expanded) ? expanded : resolve(base, expanded);
  };
  if (env.LORE_V2_DATA_DIR) return expand(env.LORE_V2_DATA_DIR);
  if (typeof config?.dataDir === "string" && config.dataDir) return expand(config.dataDir);
  if (configPath && config) return dirname(configPath);
  return home ? `${home}/.lore` : null;
}

/**
 * Per-user journal for uncertain writes, in the data directory the daemon and
 * CLI own, so one journal serves every client. LORE_V2_JOURNAL overrides the
 * location outright.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function resolveJournalPath(env = process.env) {
  if (env.LORE_V2_JOURNAL) return env.LORE_V2_JOURNAL;
  const dataDir = resolveDataDir(env);
  return dataDir ? `${dataDir}/uncertain-writes.json` : null;
}

/**
 * The journal host adapters wrote before they shared the CLI's data directory.
 * Its unresolved entries are read until the shared journal knows their keys;
 * the file itself is never modified or deleted. An explicit override means an
 * isolated store, so the legacy file is left out of it.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function resolveLegacyJournalPaths(env = process.env) {
  if (env.LORE_V2_JOURNAL || env.LORE_V2_DATA_DIR) return [];
  const home = env.HOME;
  if (!home) return [];
  return [`${home}/.lore/uncertain-writes-v2.json`];
}
