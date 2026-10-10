// Lore v2 Pi extension entrypoint.
//
// The Pi host loads this file, calls the default export with its extension
// API, and gets the nine canonical model tools, the /lore command and
// session-scoped cancellation. The socket path comes from the environment
// (LORE_V2_SOCKET or LORE_SOCKET) so the adapter never reads the v1 store or
// config format.

import { existsSync, readFileSync } from "node:fs";

import { registerPiV2 } from "./register.mjs";

interface PiApi {
  registerTool(tool: unknown): void;
  registerCommand?(name: string, command: unknown): void;
  on?(event: string, handler: (...args: unknown[]) => unknown): void;
}

export function resolveSocketPath(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.LORE_V2_SOCKET ?? env.LORE_SOCKET;
  if (explicit) return explicit;
  const home = env.HOME;
  if (!home) return null;
  // An installed daemon needs no environment: read the config the installer
  // wrote, and fall back to the conventional socket when it exists.
  try {
    const parsed = JSON.parse(readFileSync(`${home}/.lore/lore.json`, "utf8")) as {
      socketPath?: string;
    };
    if (parsed.socketPath) return parsed.socketPath.replace(/^~/, home);
  } catch {
    // No config: fall through to the default socket path.
  }
  const fallback = `${home}/.lore/lored.sock`;
  return existsSync(fallback) ? fallback : null;
}

export function resolveJournalPath(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.LORE_V2_JOURNAL;
}

export default function lorePiV2(pi: PiApi, options: { socketPath?: string } = {}): void {
  const socketPath = options.socketPath ?? resolveSocketPath();
  if (!socketPath) {
    // No socket configured: register nothing rather than guessing a path.
    return;
  }
  registerPiV2(pi, {
    socketPath,
    clientId: "pi",
    journalPath: resolveJournalPath(),
    notify: (message: string) => console.error(`[lore] ${message}`),
  });
}
