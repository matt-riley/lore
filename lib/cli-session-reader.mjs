import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { stripInjectedContext } from "./retention-sanitizer.mjs";

export function deriveCliRepository(cwd) {
  if (!cwd) return null;
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const remote = git(["remote", "get-url", "origin"]);
    const match = remote.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/u);
    if (match) return `${match[1]}/${match[2]}`;
  } catch { /* Local repository fallback. */ }
  try { return path.basename(git(["rev-parse", "--show-toplevel"])); } catch { return path.resolve(cwd); }
}

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

export function parseCliTranscript(raw, { client, sessionId, cwd, repository, timestamp = new Date().toISOString() }) {
  let entries = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try { entries.push(JSON.parse(lines[index])); } catch {
      // A live writer may not have finished its last record yet.
      if (index !== lines.length - 1) throw new Error("Malformed transcript record");
    }
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
    }
    if (!["user", "assistant"].includes(role)) continue;
    const text = textOf(content);
    if (!text.trim()) continue;
    const time = entry.timestamp ?? entry.created_at ?? timestamp;
    updatedAt = Number.isNaN(Date.parse(time)) ? timestamp : new Date(time).toISOString();
    if (role === "user") {
      current = { turn_index: turns.length + 1, user_message: text, assistant_response: "", timestamp: updatedAt };
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

export async function readCliTranscript(filePath, options) {
  if (typeof filePath !== "string" || !filePath) throw new Error("Hook did not supply a transcript path");
  const expanded = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
  if (!path.isAbsolute(expanded)) throw new Error("Transcript path must be absolute");
  const file = await open(expanded, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const limit = 32 * 1024 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error("Transcript must be a regular file of at most 32 MiB");
    // Read the bounded snapshot, even if the host appends while this hook runs.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return parseCliTranscript(buffer.subarray(0, offset).toString("utf8"), { ...options, timestamp: stat.mtime.toISOString() });
  } finally { await file.close(); }
}
