// lore-adapter.mjs — the thin host adapter for Lore v2.
//
// Adapters own only request translation, capability negotiation and
// cancellation. Ranking, rendering, capture parsing, extraction and storage
// all live in the Rust daemon. This module never opens SQLite.

import { request, requestStatus } from "./status-client.mjs";

function abortError() {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}

/** Race one request against an AbortSignal without leaking listeners. */
function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    // The request was never awaited; keep its rejection from surfacing as an
    // unhandled rejection while returning the cancellation to the caller.
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function unwrap(outcome) {
  let body;
  try {
    body = JSON.parse(outcome.body);
  } catch {
    throw new Error(`daemon returned invalid JSON (${outcome.statusCode})`);
  }
  if (outcome.statusCode !== 200 || body.ok !== true) {
    const detail = body?.error ? `${body.error.reason}: ${body.error.message}` : outcome.body;
    const error = new Error(detail);
    error.code = body?.error?.code ?? "INTERNAL";
    error.reason = body?.error?.reason ?? "UNKNOWN";
    throw error;
  }
  return body.result;
}

/**
 * Create a thin adapter bound to one daemon socket.
 *
 * @param {{ socketPath: string, clientId?: string }} options
 */
export function createLoreClient({ socketPath, clientId = "adapter" }) {
  let cached = null;

  async function status({ signal } = {}) {
    const outcome = await withSignal(requestStatus(socketPath, { clientId, signal }), signal);
    const result = unwrap(outcome);
    cached = { storeId: result.storeId, capabilities: result.capabilities ?? [] };
    return result;
  }

  async function negotiated({ signal } = {}) {
    if (!cached) await status({ signal });
    return cached;
  }

  async function requireCapability(name, { signal } = {}) {
    const state = await negotiated({ signal });
    if (!state.capabilities.includes(name)) {
      const error = new Error(`daemon does not advertise capability ${name}`);
      error.code = "FAILED_PRECONDITION";
      error.reason = "CAPABILITY_UNAVAILABLE";
      throw error;
    }
    return state;
  }

  return {
    socketPath,
    clientId,
    status,
    negotiated,
    requireCapability,
    async recall({ query, repository, limit, includeOtherRepositories, signal } = {}) {
      const state = await negotiated({ signal });
      return unwrap(
        await withSignal(
          request(
            socketPath,
            "/v2/recall",
            { query, repository, limit, includeOtherRepositories },
            { clientId, expectedStoreId: state.storeId, signal },
          ),
          signal,
        ),
      );
    },
    async retain({ idempotencyKey, kind, content, scope, repository, confidence, tags, signal } = {}) {
      const state = await negotiated({ signal });
      return unwrap(
        await withSignal(
          request(
            socketPath,
            "/v2/retain",
            { idempotencyKey, type: kind, content, scope, repository, confidence, tags },
            { clientId, expectedStoreId: state.storeId, signal },
          ),
          signal,
        ),
      );
    },
    async forget({ idempotencyKey, memoryId, reason, signal } = {}) {
      const state = await negotiated({ signal });
      return unwrap(
        await withSignal(
          request(
            socketPath,
            "/v2/forget",
            { idempotencyKey, memoryId, reason },
            { clientId, expectedStoreId: state.storeId, signal },
          ),
          signal,
        ),
      );
    },
  };
}
