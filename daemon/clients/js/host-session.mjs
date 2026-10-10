// host-session.mjs — shared host adapter session behavior.
//
// Hosts own event translation and presentation. This module owns capability
// negotiation, per-session cancellation, the durable uncertain-write journal
// and one bounded automatic retry for mutations.

import { randomUUID } from "node:crypto";

import { createLoreClient } from "./lore-adapter.mjs";
import { toolByName } from "./model-tools.mjs";
import { createUncertainJournal } from "./uncertain-journal.mjs";

const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENOTFOUND",
  "ENOENT",
  "EAI_AGAIN",
]);

/** One automatic retry per interaction, only for transport failures. */
export function isRetryableTransportError(error) {
  if (!error || error.name === "AbortError") return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  const message = String(error.message ?? "");
  return /timed out|socket hang up|connection refused|no such file or directory/i.test(message);
}

export function createHostSession({
  socketPath,
  clientId = "host-adapter",
  journalPath = null,
  journalCapacity = 100,
  createClient = createLoreClient,
  notify = () => {},
  now = () => Date.now(),
} = {}) {
  const client = createClient({ socketPath, clientId });
  const journal = journalPath
    ? createUncertainJournal(journalPath, { capacity: journalCapacity })
    : null;
  const sessions = new Map();
  const warned = new Set();

  function warnOnce(category, message) {
    if (warned.has(category)) return;
    warned.add(category);
    try {
      notify(message);
    } catch {
      // Host notifications must never fail a tool call.
    }
  }

  function controllerFor(sessionId) {
    if (!sessionId) return null;
    let controller = sessions.get(sessionId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      sessions.set(sessionId, controller);
    }
    return controller;
  }

  function signalFor(sessionId, hostSignal) {
    const controller = controllerFor(sessionId);
    const signals = [controller?.signal, hostSignal].filter(Boolean);
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  }

  async function invokeTool(name, args = {}, { sessionId, signal: hostSignal } = {}) {
    const tool = toolByName(name);
    if (!tool) {
      const error = new Error(`unknown lore tool: ${name}`);
      error.reason = "UNKNOWN_TOOL";
      throw error;
    }
    const signal = signalFor(sessionId, hostSignal);
    if (tool.capability) {
      try {
        await client.requireCapability(tool.capability, { signal });
      } catch (error) {
        warnOnce(`capability:${tool.capability}`, `lore: ${error.message}`);
        throw error;
      }
    }
    const params = tool.buildParams(args);
    if (tool.kind !== "write") {
      return client.call(tool.route, params, { signal });
    }

    const key = args.idempotencyKey ?? randomUUID();
    const payload = { ...params, idempotencyKey: key };
    if (journal) {
      const state = await client.negotiated({ signal });
      // Capacity failure rejects before dispatch; the write never leaves.
      journal.record({
        key,
        clientId,
        operation: tool.name,
        route: tool.route,
        params: payload,
        storeId: state.storeId,
        createdAt: now(),
      });
    }
    let result;
    try {
      try {
        result = await client.call(tool.route, payload, { signal });
      } catch (error) {
        if (!isRetryableTransportError(error)) throw error;
        result = await client.call(tool.route, payload, { signal });
      }
    } catch (error) {
      // A definitive daemon rejection means nothing committed, so the entry is
      // no longer needed. Anything else may have committed and stays for retry.
      if (error?.retryable === false) journal?.discard(key);
      throw error;
    }
    journal?.complete(key);
    return result;
  }

  async function shutdownSession(sessionId) {
    const controller = sessions.get(sessionId);
    if (!controller) return;
    controller.abort();
    sessions.delete(sessionId);
    await Promise.resolve();
  }

  async function shutdownAll() {
    for (const controller of sessions.values()) controller.abort();
    sessions.clear();
  }

  return {
    client,
    journal,
    sessions,
    startSession(sessionId) {
      return controllerFor(sessionId);
    },
    signalFor,
    invokeTool,
    shutdownSession,
    shutdownAll,
    retries() {
      return journal ? journal.list() : [];
    },
    discardRetry(key) {
      return journal ? journal.discard(key) : false;
    },
  };
}

/**
 * Render a tool result for a host transcript, never throwing into the host.
 */
export async function renderToolCall(session, toolName, args, options = {}) {
  const tool = toolByName(toolName);
  try {
    const result = await session.invokeTool(toolName, args, options);
    return tool ? tool.present(result) : JSON.stringify(result);
  } catch (error) {
    if (error?.name === "AbortError") return "lore: request cancelled";
    return `lore unavailable: ${error.message}`;
  }
}
