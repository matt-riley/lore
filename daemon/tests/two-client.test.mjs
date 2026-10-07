// Two independent clients share one store through the API, and one client's
// disconnect does not take the daemon down with it.

import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import { parseOk, request, requestStatus } from "../clients/js/status-client.mjs";
import { startDaemon, waitForLiveStatus } from "./harness.mjs";

test("two clients share a store and a disconnect spares the daemon", { skip: !process.env.LORED_BIN }, async () => {
  const daemon = startDaemon();
  try {
    const status = await waitForLiveStatus(daemon.socket);
    const clientFor = (clientId) => (path, params, options = {}) =>
      request(daemon.socket, path, params, {
        clientId,
        expectedStoreId: status.storeId,
        ...options,
      });
    const clientA = clientFor("client-a");
    const clientB = clientFor("client-b");

    const retained = parseOk(
      await clientA("/v2/retain", {
        idempotencyKey: "a-1",
        type: "note",
        content: "shared build fact",
        scope: "global",
      }),
    );
    const memoryId = retained.result.memoryId;

    const seenByB = parseOk(await clientB("/v2/recall", { query: "shared build" }));
    assert.equal(seenByB.result.records.length, 1, "B reads A's acknowledged write");
    assert.equal(seenByB.result.records[0].id, memoryId);

    const forgotten = parseOk(
      await clientB("/v2/forget", { idempotencyKey: "b-1", memoryId }),
    );
    assert.equal(forgotten.result.writeResult, "forgotten");

    const seenByA = parseOk(await clientA("/v2/recall", { query: "shared build" }));
    assert.equal(seenByA.result.records.length, 0, "A observes B's forget");

    // A client that disconnects mid-request must not kill the daemon.
    await new Promise((resolve) => {
      const raw = net.connect(daemon.socket);
      raw.on("connect", () => {
        raw.write("POST /v2/status HTTP/1.1\r\nHost: lore.local\r\n");
        raw.destroy();
        resolve();
      });
      raw.on("error", resolve);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await requestStatus(daemon.socket)).statusCode, 200);
  } finally {
    await daemon.stop();
    daemon.cleanup();
  }
});
