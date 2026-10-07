// Node client proof for the v2 Status contract. Uses node:http with
// `socketPath`; ordinary fetch does not accept a Unix socket path.

import http from "node:http";
import { randomUUID } from "node:crypto";

export function requestStatus(socketPath, options = {}) {
  const meta = {
    clientId: options.clientId ?? "test.node",
    requestId: options.requestId ?? randomUUID(),
  };
  if (options.expectedStoreId) meta.expectedStoreId = options.expectedStoreId;
  if (options.timeoutMs) meta.timeoutMs = options.timeoutMs;
  const payload = JSON.stringify({ meta, params: options.params ?? {} });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method: "POST",
        path: "/v2/status",
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
    request.on("error", reject);
    request.setTimeout(options.timeoutMs ?? 2000, () => {
      request.destroy(new Error("status request timed out"));
    });
    request.end(payload);
  });
}
