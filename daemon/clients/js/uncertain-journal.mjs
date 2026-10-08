// uncertain-journal.mjs — durable uncertain-write journal for host adapters.
//
// Before a mutation is dispatched the exact semantic payload, canonical
// operation, target store and idempotency key are persisted with an atomic
// write. After a committed acknowledgement the entry is marked resolved and
// its payload dropped. Connection failures leave the payload for an explicit
// retry with the identical key.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_CAPACITY = 100;

function journalError(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
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

  function persist(state) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${randomUUID()}`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  return {
    path,
    capacity,
    record(entry) {
      const state = load();
      const unresolved = Object.values(state.entries).filter((item) => !item.resolved).length;
      if (!state.entries[entry.key] && unresolved >= capacity) {
        throw journalError("JOURNAL_FULL", "uncertain-write journal is full");
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
