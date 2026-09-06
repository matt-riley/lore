const MIN_NODE = Object.freeze({ major: 24, minor: 0, patch: 0 });

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(String(value ?? ""));
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function isSupportedNode(version) {
  if (version.major !== MIN_NODE.major) return version.major > MIN_NODE.major;
  if (version.minor !== MIN_NODE.minor) return version.minor > MIN_NODE.minor;
  return version.patch >= MIN_NODE.patch;
}

/**
 * Check the small set of runtime capabilities Lore requires before loading DB code.
 * The SQLite check intentionally uses one in-memory connection and one FTS5 probe.
 * @param {{ version?: string, loadSqlite?: () => Promise<object> }} [options]
 */
export async function checkRuntime(options = {}) {
  const rawVersion = options.version ?? process.version;
  const version = parseVersion(rawVersion);
  const diagnostics = [];
  if (!version || !isSupportedNode(version)) {
    diagnostics.push(`Node.js ${MIN_NODE.major}.${MIN_NODE.minor}.${MIN_NODE.patch} or newer is required (found ${rawVersion || "unknown"}). Update Node and rerun Lore.`);
    return { ok: false, version, sqliteAvailable: false, fts5Available: false, diagnostics };
  }

  let sqlite;
  try {
    sqlite = await (options.loadSqlite ?? (() => import("node:sqlite")))();
  } catch {
    diagnostics.push("node:sqlite is unavailable in this Node.js runtime. Install Node.js 24.0.0 or newer with the built-in SQLite module, then rerun Lore.");
    return { ok: false, version, sqliteAvailable: false, fts5Available: false, diagnostics };
  }

  let database;
  try {
    if (typeof sqlite?.DatabaseSync !== "function") throw new Error("DatabaseSync export is missing");
    database = new sqlite.DatabaseSync(":memory:");
    database.exec("CREATE VIRTUAL TABLE lore_runtime_fts5_probe USING fts5(content)");
    return { ok: true, version, sqliteAvailable: true, fts5Available: true, diagnostics };
  } catch {
    diagnostics.push("SQLite is available, but FTS5 is unavailable in this Node.js build. Install an official Node.js 24.0.0 or newer build with SQLite FTS5 enabled, then rerun Lore.");
    return { ok: false, version, sqliteAvailable: true, fts5Available: false, diagnostics };
  } finally {
    database?.close();
  }
}

export function formatRuntimeDiagnostics(result) {
  return result.diagnostics.join(" ");
}

export const MINIMUM_NODE_VERSION = `${MIN_NODE.major}.${MIN_NODE.minor}.${MIN_NODE.patch}`;
