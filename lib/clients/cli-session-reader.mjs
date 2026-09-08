import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { stripInjectedContext } from "../memory/retention-sanitizer.mjs";

function textOf(content) {
  if (typeof content === "string") return stripInjectedContext(content);
  if (!Array.isArray(content)) return "";
  return stripInjectedContext(content.filter((block) => ["text", "input_text", "output_text"].includes(block?.type))
    .map((block) => typeof block.text === "string" ? block.text : "").join("\n"));
}

function activeClaudeBranch(entries) {
  const byId = new Map(entries.filter((entry) => entry.uuid).map((entry) => [entry.uuid, entry]));
  const leaf = entries.findLast((entry) => entry.uuid && ["user", "assistant"].includes(entry.type));
  if (!leaf) return entries;
  const branch = new Set();
  let node = leaf;
  while (node && !branch.has(node.uuid)) {
    branch.add(node.uuid);
    node = byId.get(node.parentUuid);
  }
  return entries.filter((entry) => branch.has(entry.uuid));
}

function parseCliTranscriptEntries(entries, {
  client,
  sessionId,
  cwd,
  repository,
  timestamp = new Date().toISOString(),
} = {}) {
  entries = Array.isArray(entries) ? entries : [];
  if (entries.some((entry) => entry?.type === "normalized_turn")) {
    const turns = entries.map((entry, index) => ({
      turn_index: Number.isInteger(entry.turn_index) ? entry.turn_index : index + 1,
      user_message: String(entry.user_message ?? ""),
      assistant_response: String(entry.assistant_response ?? ""),
      timestamp: entry.timestamp ?? timestamp,
      source_record_id: entry.source_record_id ?? null,
    })).filter((turn) => turn.user_message.trim() || turn.assistant_response.trim());
    return {
      session: { id: sessionId, cwd, repository, branch: null, summary: "", created_at: turns[0]?.timestamp ?? timestamp, updated_at: turns.at(-1)?.timestamp ?? timestamp },
      turns,
      checkpoints: [], files: [], refs: [],
    };
  }
  if (client === "claude") entries = activeClaudeBranch(entries);
  if (client === "antigravity") {
    const steps = new Map();
    for (const entry of entries) {
      if (Number.isInteger(entry.step_index)) steps.set(entry.step_index, entry);
    }
    entries = [...steps.values()].sort((a, b) => a.step_index - b.step_index);
  }
  const turns = [];
  let current;
  let updatedAt = timestamp;
  for (const entry of entries) {
    let role;
    let content;
    if (client === "codex" && entry.type === "response_item" && entry.payload?.type === "message" && entry.payload.channel !== "analysis") {
      ({ role, content } = entry.payload);
    } else if (client === "claude" && !entry.isMeta && ["user", "assistant"].includes(entry.type)) {
      ({ role, content } = entry.message ?? {});
    } else if (client === "antigravity" && entry.status === "DONE") {
      if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") role = "user";
      if (entry.type === "PLANNER_RESPONSE" && entry.source === "MODEL") role = "assistant";
      content = entry.content;
      if (role === "user" && typeof content === "string") {
        // Full Antigravity transcripts wrap the actual prompt in USER_REQUEST
        // and append command expansions/settings as metadata, not user evidence.
        const request = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u);
        if (request) content = request[1];
      }
    } else if (client === "pi" && entry.type === "message") {
      ({ role, content } = entry.message ?? {});
    }
    if (!["user", "assistant"].includes(role)) continue;
    const text = textOf(content);
    if (!text.trim()) continue;
    const time = entry.timestamp ?? entry.created_at ?? timestamp;
    updatedAt = Number.isNaN(Date.parse(time)) ? timestamp : new Date(time).toISOString();
    if (role === "user") {
      current = { turn_index: turns.length + 1, user_message: text, assistant_response: "", timestamp: updatedAt,
        source_record_id: entry.sourceRecordId ?? null };
      turns.push(current);
    } else if (current) {
      current.assistant_response += `${current.assistant_response ? "\n" : ""}${text}`;
    }
  }
  return {
    session: { id: sessionId, cwd, repository, branch: null, summary: "", created_at: turns[0]?.timestamp ?? updatedAt, updated_at: updatedAt },
    turns, checkpoints: [], files: [], refs: [],
  };
}

export function parseCliTranscript(raw, options = {}) {
  let entries = [];
  const lines = String(raw ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try { entries.push(JSON.parse(lines[index])); } catch {
      // A live writer may not have finished its last record yet.
      if (index !== lines.length - 1) throw new Error("Malformed transcript record");
    }
  }
  return parseCliTranscriptEntries(entries, options);
}

/** Bounded tail fallback for Antigravity's current prompt; never loads history. */
export async function readLatestCliPrompt(filePath, { client, maxBytes = 4 * 1024 * 1024, budgetMs = 250 } = {}) {
  if (client !== "antigravity") return "";
  const expanded = typeof filePath === "string" && filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
  if (typeof expanded !== "string" || !path.isAbsolute(expanded)) throw new Error("Transcript path must be absolute");
  const handle = await open(expanded, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const source = await handle.stat();
    if (!source.isFile()) throw new Error("Transcript source must be a regular file");
    const length = Math.min(maxBytes, source.size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, source.size - length);
    const started = performance.now();
    const first = source.size > length ? buffer.indexOf(10) + 1 : 0;
    let end = bytesRead > 0 ? buffer.lastIndexOf(10, bytesRead - 1) : -1;
    let latest = null;
    let count = 0;
    while (end >= first && performance.now() - started < budgetMs) {
      const previous = end > 0 ? buffer.lastIndexOf(10, end - 1) : -1;
      const start = Math.max(first, previous + 1);
      if (end - start <= 1024 * 1024) {
        try {
          const entry = JSON.parse(buffer.toString("utf8", start, end));
          if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT" && entry.status === "DONE"
            && Number.isSafeInteger(entry.step_index) && (!latest || entry.step_index > latest.step_index)) latest = entry;
        } catch { /* A malformed or partial tail record is not a prompt. */ }
      }
      end = previous;
      if (++count % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const text = textOf(latest?.content);
    return text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u)?.[1] ?? text;
  } finally { await handle.close(); }
}
