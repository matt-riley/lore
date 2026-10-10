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
    // Only the daemon sets this; transport failures leave it undefined.
    error.retryable = body?.error?.retryable;
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

  /**
   * Run one store-bound request. A STORE_MISMATCH means the daemon now serves
   * a different store (after a migration or restore), so the cached identity
   * is dropped, renegotiated and the request retried once. The daemon rejects
   * mismatches before any work runs, so the retry cannot repeat a write.
   */
  async function bound(run, { signal } = {}) {
    const state = await negotiated({ signal });
    try {
      return await run(state);
    } catch (error) {
      if (error?.reason !== "STORE_MISMATCH") throw error;
      cached = null;
      return run(await negotiated({ signal }));
    }
  }

  return {
    socketPath,
    clientId,
    status,
    negotiated,
    requireCapability,
    recall({ query, repository, limit, includeOtherRepositories, signal } = {}) {
      return bound(
        (state) =>
          withSignal(
            request(
              socketPath,
              "/v2/recall",
              { query, repository, limit, includeOtherRepositories },
              { clientId, expectedStoreId: state.storeId, signal },
            ),
            signal,
          ).then(unwrap),
        { signal },
      );
    },
    retain({ idempotencyKey, kind, content, scope, repository, confidence, tags, signal } = {}) {
      return bound(
        (state) =>
          withSignal(
            request(
              socketPath,
              "/v2/retain",
              { idempotencyKey, type: kind, content, scope, repository, confidence, tags },
              { clientId, expectedStoreId: state.storeId, signal },
            ),
            signal,
          ).then(unwrap),
        { signal },
      );
    },
    call(route, params = {}, { signal } = {}) {
      return bound(
        (state) =>
          withSignal(
            request(socketPath, route, params, {
              clientId,
              expectedStoreId: state.storeId,
              signal,
            }),
            signal,
          ).then(unwrap),
        { signal },
      );
    },
    forget({ idempotencyKey, memoryId, reason, signal } = {}) {
      return bound(
        (state) =>
          withSignal(
            request(
              socketPath,
              "/v2/forget",
              { idempotencyKey, memoryId, reason },
              { clientId, expectedStoreId: state.storeId, signal },
            ),
            signal,
          ).then(unwrap),
        { signal },
      );
    },
  };
}
