// pi-archive-scanner.mjs — bounded, resumable traversal of pi session archives.
//
// The scanner deliberately keeps directory handles between batches. A batch
// examines at most scanCap directory entries, then yields its state so an
// archive with a large number of stale or malformed files cannot monopolise
// the server or starve newer sessions forever.

import { opendir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_HEADER_BYTES = 64 * 1024;

const DEFAULTS = Object.freeze({
  max: 5,
  minAgeMs: 30_000,
  maxFileBytes: 10 * 1024 * 1024,
  scanCap: 5_000,
});

function readInteger(env, key, fallback, { min, max }) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/** Read and validate the Pi archive knobs at process startup. */
export function parseBackfillSettings(env = process.env) {
  return {
    max: readInteger(env, "LORE_PI_BACKFILL_MAX", DEFAULTS.max, { min: 1, max: 100 }),
    minAgeMs: readInteger(env, "LORE_PI_BACKFILL_MIN_AGE_MS", DEFAULTS.minAgeMs, {
      min: 0,
      max: 365 * 24 * 60 * 60 * 1000,
    }),
    maxFileBytes: readInteger(env, "LORE_PI_BACKFILL_MAX_FILE_BYTES", DEFAULTS.maxFileBytes, {
      min: 1,
      max: 1024 * 1024 * 1024,
    }),
    scanCap: readInteger(env, "LORE_PI_BACKFILL_SCAN_CAP", DEFAULTS.scanCap, {
      min: 1,
      max: 100_000,
    }),
  };
}

async function readFirstLine(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(0x0a, 0, bytesRead);
    return buffer.toString("utf8", 0, newline >= 0 ? newline : bytesRead);
  } finally {
    await handle.close();
  }
}

async function readHeader(filePath) {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine.trim()) {
    return null;
  }
  try {
    const header = JSON.parse(firstLine);
    if (header?.type !== "session" || typeof header.id !== "string" || !header.id) {
      return null;
    }
    return header;
  } catch {
    return null;
  }
}

function normalizeTimestamp(value, fallback) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  return fallback;
}

/**
 * Incrementally scan a pi session directory.
 *
 * @param {{ rootDir: string, scanCap?: number, minAgeMs?: number,
 *   maxFileBytes?: number, isAlreadyExtracted?: (id: string) => boolean,
 *   now?: () => number, cursorPath?: string }} options
 */
export class PiArchiveScanner {
  #rootDir;
  #scanCap;
  #minAgeMs;
  #maxFileBytes;
  #isAlreadyExtracted;
  #now;
  #cursorPath;
  #stack = [];
  #started = false;
  #cursorLoaded = false;
  #resumeCursor = null;
  #lastPath = null;

  constructor({
    rootDir,
    scanCap = DEFAULTS.scanCap,
    minAgeMs = DEFAULTS.minAgeMs,
    maxFileBytes = DEFAULTS.maxFileBytes,
    isAlreadyExtracted = () => false,
    now = () => Date.now(),
    cursorPath = null,
  }) {
    this.#rootDir = path.resolve(String(rootDir));
    this.#scanCap = Math.max(1, Number.isInteger(scanCap) ? scanCap : DEFAULTS.scanCap);
    this.#minAgeMs = Math.max(0, Number.isInteger(minAgeMs) ? minAgeMs : DEFAULTS.minAgeMs);
    this.#maxFileBytes = Math.max(1, Number.isInteger(maxFileBytes) ? maxFileBytes : DEFAULTS.maxFileBytes);
    this.#isAlreadyExtracted = isAlreadyExtracted;
    this.#now = now;
    this.#cursorPath = cursorPath ? path.resolve(String(cursorPath)) : null;
  }

  async #start() {
    if (this.#started) {
      return true;
    }
    this.#started = true;
    if (!this.#cursorLoaded) {
      this.#cursorLoaded = true;
      if (this.#cursorPath) {
        try {
          const saved = JSON.parse(await readFile(this.#cursorPath, "utf8"));
          if (saved?.rootDir === this.#rootDir && typeof saved.path === "string") {
            this.#resumeCursor = saved.path;
          }
        } catch {
          // A missing or truncated cursor starts a fresh archive cycle.
        }
      }
    }
    try {
      this.#stack.push({ path: this.#rootDir, dir: await opendir(this.#rootDir) });
      return true;
    } catch {
      this.#started = false;
      return false;
    }
  }

  async #closeFrame(frame) {
    try {
      await frame.dir.close();
    } catch {
      // The directory may already have been closed by an iterator error.
    }
  }

  async #finishCycle({ clearCursor = true } = {}) {
    while (this.#stack.length > 0) {
      await this.#closeFrame(this.#stack.pop());
    }
    this.#started = false;
    if (clearCursor) {
      this.#resumeCursor = null;
      this.#lastPath = null;
      if (this.#cursorPath) {
        try {
          await unlink(this.#cursorPath);
        } catch {
          // No cursor is expected after a complete cycle.
        }
      }
    }
  }

  async #persistCursor() {
    if (!this.#cursorPath || !this.#lastPath) {
      return;
    }
    const temporaryPath = `${this.#cursorPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({ rootDir: this.#rootDir, path: this.#lastPath }) + "\n",
        "utf8",
      );
      await rename(temporaryPath, this.#cursorPath);
    } catch {
      // Cursor persistence is an optimization; scanning remains correct if a
      // read-only archive prevents writing the sidecar file.
      try {
        await unlink(temporaryPath);
      } catch {
        // Best-effort cleanup of a failed atomic write.
      }
    }
  }

  /**
   * Return up to maxCandidates eligible sessions while inspecting no more
   * than scanCap filesystem entries. Traversal resumes where the prior call
   * yielded, including when every prior entry was invalid or already known.
   */
  async scan({ currentSessionId = null, maxCandidates = DEFAULTS.max } = {}) {
    const candidates = [];
    const limit = Math.max(1, Number.isInteger(maxCandidates) ? maxCandidates : DEFAULTS.max);
    let scanned = 0;
    const started = await this.#start();
    if (!started) {
      return { candidates, scanned, exhausted: true };
    }

    while (scanned < this.#scanCap && candidates.length < limit && this.#stack.length > 0) {
      const frame = this.#stack[this.#stack.length - 1];
      let entry;
      try {
        entry = await frame.dir.read();
      } catch {
        await this.#closeFrame(this.#stack.pop());
        continue;
      }
      if (!entry) {
        await this.#closeFrame(this.#stack.pop());
        continue;
      }
      scanned += 1;
      const fullPath = path.join(frame.path, entry.name);
      if (this.#resumeCursor) {
        if (fullPath !== this.#resumeCursor) {
          // Re-enter every ancestor on the way to a nested cursor. Other
          // entries were already inspected before the worker stopped.
          if (entry.isDirectory() && this.#resumeCursor.startsWith(`${fullPath}${path.sep}`)) {
            try {
              this.#stack.push({ path: fullPath, dir: await opendir(fullPath) });
            } catch {
              // A directory can disappear or become unreadable between reads.
            }
          }
          continue;
        }
        this.#lastPath = fullPath;
        if (entry.isDirectory()) {
          this.#resumeCursor = null;
          try {
            this.#stack.push({ path: fullPath, dir: await opendir(fullPath) });
          } catch {
            // A directory can disappear or become unreadable between reads.
          }
          continue;
        }
        this.#resumeCursor = null;
        continue;
      }
      this.#lastPath = fullPath;
      if (entry.isDirectory()) {
        try {
          this.#stack.push({ path: fullPath, dir: await opendir(fullPath) });
        } catch {
          // A directory can disappear or become unreadable between reads.
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        const fileStats = await stat(fullPath);
        if ((this.#minAgeMs > 0 && this.#now() - fileStats.mtimeMs < this.#minAgeMs)
          || fileStats.size > this.#maxFileBytes) {
          continue;
        }
        const header = await readHeader(fullPath);
        const sessionId = header?.id ?? null;
        if (!sessionId || sessionId === currentSessionId || this.#isAlreadyExtracted(sessionId)) {
          continue;
        }
        candidates.push({
          path: fullPath,
          sessionId,
          timestamp: normalizeTimestamp(header.timestamp, fileStats.mtime.toISOString()),
        });
      } catch {
        // A malformed, unreadable, or concurrently removed file is skipped.
      }
    }

    const exhausted = this.#stack.length === 0;
    if (exhausted) {
      await this.#finishCycle();
    } else {
      await this.#persistCursor();
    }
    candidates.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    return { candidates, scanned, exhausted };
  }

  async close() {
    // Preserve the sidecar cursor so a later worker process resumes at the
    // last inspected entry instead of replaying a large invalid prefix.
    await this.#finishCycle({ clearCursor: false });
  }
}
