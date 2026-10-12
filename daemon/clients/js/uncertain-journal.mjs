// uncertain-journal.mjs — durable uncertain-write journal for host adapters.
//
// Before a mutation is dispatched the exact semantic payload, canonical
// operation, target store and idempotency key are persisted with an atomic
// write. After a committed acknowledgement the entry is marked resolved and
// its payload dropped. Connection failures leave the payload for an explicit
// retry with the identical key.

import { closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_CAPACITY = 100;
// Every journal update holds this lock for a few milliseconds. A waiter keeps
// waiting out a stream of updates while the journal it guards keeps moving, and
// gives up after LOCK_WAIT_MS of stillness. A lock older than STALE_LOCK_MS
// belongs to a process that died mid-update.
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 10_000;

// The Rust CLI and the host adapters share one journal file, so entries
// written by either implementation are read here. The CLI's older spelling is
// folded into the canonical shape on read and every write is canonical.
const LEGACY_ENTRY_FIELDS = [
  ["client_id", "clientId"],
  ["store_id", "storeId"],
  ["created_ms", "createdAt"],
  ["payload", "params"],
];

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const normalized = { ...entry };
  for (const [legacy, canonical] of LEGACY_ENTRY_FIELDS) {
    if (normalized[canonical] === undefined && legacy in normalized) normalized[canonical] = normalized[legacy];
    delete normalized[legacy];
  }
  if (typeof normalized.state === "string") {
    normalized.resolved = normalized.state !== "uncertain";
    if (normalized.state === "discarded" && normalized.outcome === undefined) normalized.outcome = "discarded";
    delete normalized.state;
  }
  normalized.resolved = normalized.resolved === true;
  if (normalized.params === undefined) normalized.params = null;
  return normalized;
}

function journalError(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

function syncDirectory(directory) {
  const handle = openSync(directory, "r");
  try {
    fsyncSync(handle);
  } catch (error) {
    // Some filesystems refuse directory fsync; the file itself is already durable.
    if (error.code !== "EINVAL") throw error;
  } finally {
    closeSync(handle);
  }
}

function sleepBriefly(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a lock left by a dead process. The stale file is first moved aside under
 * a unique name, then checked by inode: if it is still the file that was judged
 * stale it is deleted; if a live holder's lock was moved by mistake it is put back.
 */
function takeOverStaleLock(lockPath, observedIno) {
  const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return;
  }
  try {
    if (statSync(aside).ino !== observedIno) {
      // A live lock was moved aside. Restore it if nothing has taken the path.
      try {
        linkSync(aside, lockPath);
      } catch {
        // Something already holds the path; the moved lock is no longer needed.
      }
    }
  } catch {
    // The file vanished; nothing to restore.
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Run one journal update while holding a cross-process lock. The default
 * journal is shared by every host adapter for a user, and each update is a
 * read-modify-write, so unlocked updates could lose another process's entry.
 * The wait is renewed by journal progress, so a sibling working through its
 * own updates never looks like a stuck holder.
 */
function withLock(lockPath, journalPath, waitMs, fn) {
  let progress = null;
  try {
    progress = statSync(journalPath).mtimeMs;
  } catch {
    // The journal does not exist yet; its first write renews the wait.
  }
  let deadline = Date.now() + waitMs;
  let fd;
  let ino;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      ino = fstatSync(fd).ino;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const observed = statSync(lockPath);
        if (Date.now() - observed.mtimeMs > STALE_LOCK_MS) takeOverStaleLock(lockPath, observed.ino);
      } catch {
        // The holder released it between the check and the stat; retry.
      }
      // A held lock is not a stuck lock: every completed update moves the
      // journal, and each move renews the wait. Only a holder that leaves the
      // journal still for the whole wait is reported busy.
      try {
        const updated = statSync(journalPath).mtimeMs;
        if (updated !== progress) {
          progress = updated;
          deadline = Date.now() + waitMs;
        }
      } catch {
        // No journal to watch; the wait stands.
      }
      if (Date.now() > deadline) {
        throw journalError("JOURNAL_BUSY", "uncertain-write journal is locked by another process; retry");
      }
      sleepBriefly(5);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    // Remove only the lock this call created; a taken-over path belongs to someone else.
    try {
      if (statSync(lockPath).ino === ino) unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

export function createUncertainJournal(
  path,
  { capacity = DEFAULT_CAPACITY, lockWaitMs = LOCK_WAIT_MS, legacyPaths = [] } = {},
) {
  const lockPath = `${path}.lock`;
  // The journal host adapters wrote before they shared the CLI's data
  // directory. Nothing is written to these paths.
  const legacy = legacyPaths.filter((candidate) => candidate && candidate !== path);
  const locked = (fn) => (...args) => {
    mkdirSync(dirname(path), { recursive: true });
    return withLock(lockPath, path, lockWaitMs, () => fn(...args));
  };

  // Read one journal file in the shared format. A missing file is nothing to
  // read; an unreadable or corrupt one is reported and never guessed at.
  function readJournal(filePath, label) {
    let raw;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw journalError("JOURNAL_UNREADABLE", `${label} is unreadable: ${error.message}`);
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
        throw new Error("shape");
      }
      return {
        version: parsed.version ?? 1,
        entries: Object.fromEntries(Object.entries(parsed.entries).map(([key, entry]) => [key, normalizeEntry(entry)])),
      };
    } catch {
      throw journalError("JOURNAL_CORRUPT", `${label} is corrupt; no guesses are replayed`);
    }
  }

  function load() {
    const state = readJournal(path, "journal") ?? { version: 1, entries: {} };
    // A legacy entry is offered until the shared journal knows its key, and the
    // next write copies it forward. The legacy file stays as it was.
    for (const legacyPath of legacy) {
      const previous = readJournal(legacyPath, `legacy journal ${legacyPath}`);
      if (!previous) continue;
      for (const [key, entry] of Object.entries(previous.entries)) {
        if (state.entries[key] === undefined) state.entries[key] = entry;
      }
    }
    return state;
  }

  // The entry must be on disk before the mutation is dispatched, so the
  // payload is fsynced, renamed into place and the rename itself is fsynced.
  function persist(state) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const temp = `${path}.tmp-${randomUUID()}`;
    const handle = openSync(temp, "w", 0o600);
    try {
      writeSync(handle, `${JSON.stringify(state)}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, path);
    syncDirectory(directory);
  }

  return {
    path,
    capacity,
    record: locked((entry) => {
      const state = load();
      const existing = state.entries[entry.key];
      // Overwriting an unresolved payload would lose the only record of a write
      // that may have committed, so the new write is refused instead.
      if (existing && !existing.resolved) {
        throw journalError("JOURNAL_KEY_PENDING", "an unresolved uncertain write already uses this idempotency key");
      }
      const unresolved = Object.values(state.entries).filter((item) => !item.resolved).length;
      if (!existing && unresolved >= capacity) {
        throw journalError(
          "JOURNAL_FULL",
          "uncertain-write journal is full; review /lore retries and discard writes you will not retry",
        );
      }
      state.entries[entry.key] = {
        key: entry.key,
        clientId: entry.clientId,
        operation: entry.operation,
        route: entry.route,
        params: entry.params,
        storeId: entry.storeId,
        createdAt: entry.createdAt,
        resolved: false,
      };
      persist(state);
    }),
    complete: locked((key) => {
      const state = load();
      const entry = state.entries[key];
      if (!entry) return false;
      entry.resolved = true;
      entry.params = null;
      entry.resolvedAt = Date.now();
      persist(state);
      return true;
    }),
    /**
     * Resolve an entry without a commit: the daemon rejected the write
     * outright, or an operator decided not to retry it. Returns false when
     * there is no unresolved entry under this key.
     */
    discard: locked((key) => {
      const state = load();
      const entry = state.entries[key];
      if (!entry || entry.resolved) return false;
      entry.resolved = true;
      entry.params = null;
      entry.resolvedAt = Date.now();
      entry.outcome = "discarded";
      persist(state);
      return true;
    }),
    list() {
      const state = load();
      return Object.values(state.entries)
        .filter((entry) => !entry.resolved)
        .map((entry) => ({
          key: entry.key,
          operation: entry.operation,
          storeId: entry.storeId,
          createdAt: entry.createdAt,
          hasPayload: entry.params !== null,
        }))
        .sort((left, right) => left.createdAt - right.createdAt);
    },
    entry(key) {
      const state = load();
      return state.entries[key] ?? null;
    },
  };
}
