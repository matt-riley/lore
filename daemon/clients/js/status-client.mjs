// Shared JS client for the v2 contract. Uses `node:http` with `socketPath`;
// ordinary fetch does not accept a Unix socket path. Runs unchanged under
// Node and Bun.

import http from "node:http";
import { randomUUID } from "node:crypto";

export function request(socketPath, path, params = {}, options = {}) {
  const meta = {
    clientId: options.clientId ?? "test.node",
    requestId: options.requestId ?? randomUUID(),
  };
  if (options.expectedStoreId) meta.expectedStoreId = options.expectedStoreId;
  if (options.timeoutMs) meta.timeoutMs = options.timeoutMs;
  const payload = JSON.stringify({ meta, params });
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      const error = new Error("request aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const request = http.request(
      {
        socketPath,
        method: "POST",
        path,
        headers: {
          host: "lore.local",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ statusCode: response.statusCode, body }));
      },
    );
    const onAbort = () => {
      const error = new Error("request aborted");
      error.name = "AbortError";
      request.destroy(error);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    request.on("error", (error) => {
      cleanup();
      reject(error);
    });
    request.on("close", cleanup);
    request.setTimeout(options.timeoutMs ?? 2000, () => {
      request.destroy(new Error("request timed out"));
    });
    request.end(payload);
  });
}

export const requestStatus = (socketPath, options) =>
  request(socketPath, "/v2/status", {}, options);

export const retain = (socketPath, params, options) =>
  request(socketPath, "/v2/retain", params, options);

export const forget = (socketPath, params, options) =>
  request(socketPath, "/v2/forget", params, options);

export const recall = (socketPath, params, options) =>
  request(socketPath, "/v2/recall", params, options);

/** Parse a response body, throwing on a non-200 with the safe error JSON. */
export function parseOk(outcome) {
  const value = JSON.parse(outcome.body);
  if (outcome.statusCode !== 200) {
    throw new Error(`request failed (${outcome.statusCode}): ${outcome.body}`);
  }
  return value;
}
