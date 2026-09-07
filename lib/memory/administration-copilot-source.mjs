import { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, fstatSync } from "node:fs";
import { inspectAdministrationSource } from "./administration-source.mjs";

// SQLite owns its file opens (Node exposes no descriptor constructor). Keep
// these opens in a time-limited child and verify the source identity around
// the read transaction. WAL-visible rows, rather than only main-file bytes,
// are returned to the fingerprinting caller.
const [sourcePath, sessionId, expectedIdentity] = process.argv.slice(2);
let descriptor, raw;
try {
  descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== expectedIdentity) throw new Error("SOURCE_CHANGED");
  raw = new DatabaseSync(sourcePath, { readOnly: true, timeout: 500 });
  raw.exec("BEGIN");
  const session = raw.prepare("SELECT id,cwd,repository,created_at,updated_at FROM sessions WHERE id=?").get(sessionId);
  if (!session) throw new Error("SOURCE_UNAVAILABLE");
  const size = raw.prepare("SELECT COUNT(*) records, SUM(COALESCE(length(CAST(user_message AS BLOB)),0)+COALESCE(length(CAST(assistant_response AS BLOB)),0)+COALESCE(length(CAST(timestamp AS BLOB)),0)) bytes FROM turns WHERE session_id=?").get(sessionId);
  if (size.records > 10000 || size.bytes > 32 * 1024 * 1024) throw new Error("SOURCE_BOUND_REACHED");
  const turns = raw.prepare("SELECT turn_index,user_message,assistant_response,timestamp FROM turns WHERE session_id=? ORDER BY turn_index LIMIT 10001").all(sessionId);
  if (turns.length > 10000) throw new Error("SOURCE_BOUND_REACHED");
  const result = { session, turns, checkpoints: [], files: [], refs: [] };
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 32 * 1024 * 1024) throw new Error("SOURCE_BOUND_REACHED");
  const after = inspectAdministrationSource(sourcePath);
  if (after.sourceIdentity !== expectedIdentity) throw new Error("SOURCE_CHANGED");
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(/^SOURCE_[A-Z_]+$/.test(error.message) ? error.message : "SOURCE_UNAVAILABLE");
  process.exitCode = 1;
} finally {
  raw?.close();
  if (descriptor !== undefined) closeSync(descriptor);
}
