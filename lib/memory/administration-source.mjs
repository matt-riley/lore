import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripInjectedContext } from "./retention-sanitizer.mjs";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const revision = (value) => digest(JSON.stringify(value));

// Open first, then validate and read that same descriptor. O_NONBLOCK prevents
// a replaced FIFO from waiting for a writer; O_NOFOLLOW rejects symlink swaps.
export function readAdministrationSource(sourcePath) {
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) throw new Error("SOURCE_UNAVAILABLE");
  const fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("SOURCE_UNAVAILABLE");
    if (before.size > MAX_SOURCE_BYTES) throw new Error("SOURCE_BOUND_REACHED");
    const chunks = [];
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < before.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - offset));
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (!count) throw new Error("SOURCE_CHANGED");
      const bytes = chunk.subarray(0, count);
      chunks.push(bytes);
      hash.update(bytes);
      offset += count;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("SOURCE_CHANGED");
    return { bytes: Buffer.concat(chunks), fingerprint: { sourceIdentity: `${before.dev}:${before.ino}`, size: before.size, mtimeMs: before.mtimeMs, contentHash: hash.digest("hex") } };
  } finally { closeSync(fd); }
}

function textOf(content) {
  return stripInjectedContext(typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((block) => ["text", "input_text", "output_text"].includes(block?.type)).map((block) => typeof block.text === "string" ? block.text : "").join("\n") : "").trim();
}

// A complete repair scan deliberately has no rolling turn window. Byte offsets
// and role revisions match native capture, including multiple assistant records.
export function parseAdministrationTranscript(bytes, { client, sessionId, repository, cwd, timestamp }) {
  if (!["codex", "claude", "antigravity", "pi"].includes(client)) throw new Error("SOURCE_CLIENT_UNSUPPORTED");
  const records = [];
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) throw new Error("SOURCE_INCOMPLETE");
    if (newline - offset > MAX_RECORD_BYTES) throw new Error("SOURCE_RECORD_BOUND_REACHED");
    const line = bytes.subarray(offset, newline).toString("utf8");
    if (line.trim()) records.push({ value: JSON.parse(line), offset: String(offset) });
    offset = newline + 1;
  }
  const nativeId = sessionId.startsWith(`${client}:`) ? sessionId.slice(client.length + 1) : sessionId;
  if (client !== "antigravity") {
    const identities = records.flatMap(({ value }) => {
      const identity = client === "codex" && value.type === "session_meta" ? value.payload?.id
        : client === "claude" ? value.sessionId
        : client === "pi" && value.type === "session" ? value.id : undefined;
      return typeof identity === "string" && identity.trim() ? [identity] : [];
    });
    if (!identities.length) throw new Error("SOURCE_SESSION_ID_MISSING");
    if (identities.some((identity) => identity !== nativeId)) throw new Error("SOURCE_SESSION_MISMATCH");
  }
  let active = records;
  if (client === "claude") {
    const nodes = new Map(records.filter(({ value }) => value.uuid && !value.isMeta && ["user", "assistant"].includes(value.type)).map((record) => [record.value.uuid, record]));
    const last = records.findLast(({ value }) => value.uuid && !value.isMeta && ["user", "assistant"].includes(value.type));
    let leaf = nodes.get(last?.value.uuid);
    const ids = new Set(), branch = [];
    while (leaf) {
      if (ids.has(leaf.value.uuid)) throw new Error("SOURCE_BRANCH_UNRESOLVED");
      ids.add(leaf.value.uuid);
      branch.push(leaf);
      if (leaf.value.parentUuid && !nodes.has(leaf.value.parentUuid)) throw new Error("SOURCE_BRANCH_UNRESOLVED");
      leaf = nodes.get(leaf.value.parentUuid);
    }
    active = branch.reverse();
  }
  if (client === "antigravity") {
    const steps = new Map();
    for (const record of records) if (Number.isSafeInteger(record.value.step_index) && record.value.status === "DONE") steps.set(record.value.step_index, record);
    active = [...steps.values()].sort((a, b) => a.value.step_index - b.value.step_index);
  }
  const turns = [];
  let current;
  for (const { value, offset: id } of active) {
    let role, content;
    if (client === "codex" && value.type === "response_item" && value.payload?.type === "message" && value.payload.channel !== "analysis") ({ role, content } = value.payload);
    if (client === "claude" && !value.isMeta && ["user", "assistant"].includes(value.type)) ({ role, content } = value.message ?? {});
    if (client === "pi" && value.type === "message") ({ role, content } = value.message ?? {});
    if (client === "antigravity" && value.status === "DONE") {
      if (value.type === "USER_INPUT" && value.source === "USER_EXPLICIT") role = "user";
      if (value.type === "PLANNER_RESPONSE" && value.source === "MODEL") role = "assistant";
      content = value.content;
    }
    let text = textOf(content);
    if (client === "antigravity") text = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u)?.[1]?.trim() ?? text;
    if (!text || !["user", "assistant"].includes(role)) continue;
    if (role === "user" || !current) {
      current = { turn_index: turns.length + 1, user_message: role === "user" ? text : "", assistant_response: "", assistant_source_records: [], timestamp: value.timestamp ?? timestamp,
        source_record_id: role === "user" ? id : null, source_revision: role === "user" ? revision({ user: text, role: "user" }) : null };
      turns.push(current);
      if (turns.length > 10000) throw new Error("SOURCE_BOUND_REACHED");
    }
    if (role === "assistant") {
      current.assistant_source_records.push({ source_record_id: id, source_revision: revision({ role: "assistant", text }), text });
      current.assistant_response = current.assistant_source_records.map((record) => record.text).join("\n");
    }
  }
  return { session: { id: sessionId, repository, cwd, created_at: timestamp, updated_at: timestamp }, turns, checkpoints: [], files: [], refs: [] };
}

export function inspectAdministrationSource(sourcePath) {
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) throw new Error("SOURCE_UNAVAILABLE");
  const fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("SOURCE_UNAVAILABLE");
    return { sourceIdentity: `${stat.dev}:${stat.ino}`, size: stat.size, mtimeMs: stat.mtimeMs };
  } finally { closeSync(fd); }
}

export function readCopilotRepairSource(config, sessionId) {
  const checked = inspectAdministrationSource(config.paths.rawStorePath);
  const worker = fileURLToPath(new URL("./administration-copilot-source.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [worker, config.paths.rawStorePath, sessionId, checked.sourceIdentity], {
    encoding: "utf8", timeout: 2500, maxBuffer: MAX_SOURCE_BYTES + 1024, windowsHide: true,
  });
  if (result.status !== 0 || result.error) throw new Error(/^SOURCE_[A-Z_]+$/.test(result.stderr ?? "") ? result.stderr : "SOURCE_UNAVAILABLE");
  const artifacts = JSON.parse(result.stdout);
  return { artifacts, fingerprint: { ...checked, contentHash: digest(JSON.stringify(artifacts)) } };
}
