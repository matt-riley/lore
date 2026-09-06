// pi-session-reader.mjs — parse pi session JSONL into lore's sessionArtifacts
// shape (the format lore's extractSessionMemories pipeline consumes).
//
// Pi sessions live in ~/.pi/agent/sessions/<cwd-slug>/*.jsonl (see pi's
// session-format.md). Copilot stores sessions in SQLite with checkpoints and
// per-turn rows; pi stores typed JSONL entries. This module maps:
//
//   Copilot `turns`        <- consecutive user -> assistant text pairs
//   Copilot `checkpoints`  <- pi compaction entries (summaries)
//   Copilot `files`        <- write/edit/read tool calls
//   Copilot `refs`         <- [] (pi does not track git refs per session)
//
// Only reads files; never writes.

import { readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const FILE_TOOL_NAMES = new Set(["write", "edit", "read"]);

/** Best-effort repository slug ("owner/name") from the git remote, else the toplevel dir name. */
function deriveRepository(cwd) {
  if (!cwd) {
    return null;
  }
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/[:/]([^/:]+)\/([^/.]+?)(?:\.git)?$/);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  } catch {
    // not a git remote
  }
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) {
      return path.basename(top);
    }
  } catch {
    // not a git repo
  }
  return null;
}

/** Extract joined text from a pi content block (string or block array). */
function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Read a pi session JSONL file and synthesize lore sessionArtifacts.
 *
 * @param {string} filePath
 * @param {{ repository?: string | null }} [opts]
 * @returns {{ sessionId: string|null, cwd: string|null, repository: string|null,
 *            sessionArtifacts: { session: object, checkpoints: object[],
 *            files: object[], refs: [], turns: object[] } }}
 */
export function readPiSessionFile(filePath, { repository = null } = {}) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  let header = null;
  let lastTimestamp = null;
  const turns = [];
  const files = new Map();
  const checkpoints = [];
  let currentTurn = null;
  let turnIndex = 0;
  let checkpointNumber = 0;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.timestamp) {
      lastTimestamp = entry.timestamp;
    }

    if (entry.type === "session" && !header) {
      header = entry;
      continue;
    }

    if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
      checkpoints.push({
        checkpoint_number: ++checkpointNumber,
        title: "",
        overview: entry.summary,
        history: "",
        work_done: "",
        technical_details: "",
        important_files: "",
        next_steps: "",
        created_at: entry.timestamp ?? new Date().toISOString(),
      });
      continue;
    }

    if (entry.type !== "message") {
      continue;
    }

    const msg = entry.message ?? {};
    const role = msg.role;

    if (role === "user") {
      const text = textOf(msg.content).trim();
      if (text) {
        currentTurn = {
          turn_index: ++turnIndex,
          user_message: text,
          assistant_response: "",
          timestamp: entry.timestamp ?? new Date().toISOString(),
        };
        turns.push(currentTurn);
      }
      continue;
    }

    if (role === "assistant") {
      const text = textOf(msg.content).trim();
      if (currentTurn && text) {
        currentTurn.assistant_response += currentTurn.assistant_response ? `\n${text}` : text;
      }
      const toolCalls = Array.isArray(msg.content)
        ? msg.content.filter((block) => block?.type === "toolCall")
        : [];
      for (const tc of toolCalls) {
        const name = String(tc.name ?? "");
        if (!FILE_TOOL_NAMES.has(name)) {
          continue;
        }
        const args = tc.arguments ?? {};
        const filePathArg = args.path ?? args.filePath;
        if (typeof filePathArg !== "string" || !filePathArg.trim()) {
          continue;
        }
        // Pi tool calls commonly use paths relative to the session's working
        // directory. Resolve after reading the header so archive extraction is
        // independent of the server process cwd.
        const resolved = path.resolve(header?.cwd ?? process.cwd(), filePathArg.trim());
        if (!files.has(resolved)) {
          files.set(resolved, {
            file_path: resolved,
            tool_name: name,
            turn_index: currentTurn?.turn_index ?? 0,
            first_seen_at: entry.timestamp ?? new Date().toISOString(),
          });
        }
      }
      continue;
    }

    // toolResult, bashExecution, custom, compactionSummary, branchSummary: ignored.
  }

  const cwd = header?.cwd ?? null;
  const sessionId = header?.id ?? null;
  const effectiveRepository = repository ?? deriveRepository(cwd);
  const createdAt = header?.timestamp ?? lastTimestamp ?? statSync(filePath).mtime.toISOString();
  const updatedAt = lastTimestamp ?? createdAt;

  return {
    sessionId,
    cwd,
    repository: effectiveRepository,
    sessionArtifacts: {
      session: {
        id: sessionId,
        cwd,
        repository: effectiveRepository,
        branch: null,
        summary: "",
        created_at: createdAt,
        updated_at: updatedAt,
      },
      checkpoints,
      files: [...files.values()],
      refs: [],
      turns,
    },
  };
}
