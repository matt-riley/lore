// uncertain-journal.mjs — durable uncertain-write journal for host adapters.
//
// Before a mutation is dispatched the exact semantic payload, canonical
// operation, target store and idempotency key are persisted with an atomic
// write. After a committed acknowledgement the entry is marked resolved and
// its payload dropped. Connection failures leave the payload for an explicit
// retry with the identical key.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_CAPACITY = 100;

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

export function createUncertainJournal(path, { capacity = DEFAULT_CAPACITY } = {}) {
  function load() {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, entries: {} };
      throw journalError("JOURNAL_UNREADABLE", `journal is unreadable: ${error.message}`);
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
        throw new Error("shape");
      }
      return parsed;
    } catch {
      throw journalError("JOURNAL_CORRUPT", "journal is corrupt; no guesses are replayed");
    }
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
    record(entry) {
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
    },
    complete(key) {
      const state = load();
      const entry = state.entries[key];
      if (!entry) return false;
      entry.resolved = true;
      entry.params = null;
      entry.resolvedAt = Date.now();
      persist(state);
      return true;
    },
    /**
     * Resolve an entry without a commit: the daemon rejected the write
     * outright, or an operator decided not to retry it. Returns false when
     * there is no unresolved entry under this key.
     */
    discard(key) {
      const state = load();
      const entry = state.entries[key];
      if (!entry || entry.resolved) return false;
      entry.resolved = true;
      entry.params = null;
      entry.resolvedAt = Date.now();
      entry.outcome = "discarded";
      persist(state);
      return true;
    },
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
