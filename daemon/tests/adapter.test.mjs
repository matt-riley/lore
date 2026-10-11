// Thin adapter behaviour against a real hermetic daemon.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createLoreClient } from "../clients/js/lore-adapter.mjs";
import { startDaemon, waitForLiveStatus } from "./harness.mjs";

test("adapter negotiates capabilities and performs durable verbs", async () => {
  const daemon = startDaemon();
  try {
    const status = await waitForLiveStatus(daemon.socket);
    const client = createLoreClient({ socketPath: daemon.socket, clientId: "adapter.test" });
    const negotiated = await client.negotiated();
    assert.equal(negotiated.storeId, status.storeId);
    assert.ok(negotiated.capabilities.includes("recall.lexical"), negotiated.capabilities.join(","));
    assert.ok(negotiated.capabilities.includes("memory.retain.manual"));

    const retained = await client.retain({
      idempotencyKey: "adapter-retain-1",
      kind: "note",
      content: "Adapter writes durable memory through the socket.",
      scope: "global",
    });
    assert.ok(retained.memoryId.startsWith("mem_") || retained.memoryId.length > 0);

    const recalled = await client.recall({ query: "durable memory socket", limit: 6 });
    assert.ok(
      recalled.records.some((record) => record.content.includes("Adapter writes")),
      JSON.stringify(recalled.records),
    );

    const forgotten = await client.forget({
      idempotencyKey: "adapter-forget-1",
      memoryId: retained.memoryId,
    });
    assert.equal(forgotten.writeResult, "forgotten");
  } finally {
    await daemon.stop();
  }
});

test("adapter cancellation rejects without touching the daemon", async () => {
  const daemon = startDaemon();
  try {
    await waitForLiveStatus(daemon.socket);
    const client = createLoreClient({ socketPath: daemon.socket, clientId: "adapter.abort" });
    await client.status();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => client.recall({ query: "anything", signal: controller.signal }),
      (error) => error.name === "AbortError",
    );
  } finally {
    await daemon.stop();
  }
});

test("adapter refuses capabilities the daemon does not advertise", async () => {
  const daemon = startDaemon();
  try {
    await waitForLiveStatus(daemon.socket);
    const client = createLoreClient({ socketPath: daemon.socket, clientId: "adapter.caps" });
    await assert.rejects(
      () => client.requireCapability("analysis.chat"),
      (error) => error.reason === "CAPABILITY_UNAVAILABLE",
    );
  } finally {
    await daemon.stop();
  }
});

test("a pinned call never renegotiates onto another store", async () => {
  const daemon = startDaemon();
  try {
    const status = await waitForLiveStatus(daemon.socket);
    const client = createLoreClient({ socketPath: daemon.socket, clientId: "adapter.pinned" });
    const params = {
      idempotencyKey: "adapter-pinned-1",
      type: "note",
      content: "A pinned adapter write.",
      scope: "global",
    };
    await assert.rejects(
      () => client.call("/v2/retain", params, { pinStoreId: "store_not_this_one" }),
      (error) => error.reason === "STORE_MISMATCH",
    );
    // The unpinned default still renegotiates and writes to the served store.
    const retained = await client.call("/v2/retain", params, {});
    assert.ok(retained.memoryId, JSON.stringify(retained));
    assert.ok(status.storeId.length > 0);
  } finally {
    await daemon.stop();
  }
});
