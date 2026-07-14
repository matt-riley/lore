import assert from "node:assert/strict";
import { test } from "node:test";

import {
  requestLocalInferenceEmbeddings,
  requestLocalInferenceJson,
} from "../../lib/local-inference.mjs";

test("requestLocalInferenceJson calls the configured loopback chat-completions endpoint", async () => {
  const calls = [];
  const result = await requestLocalInferenceJson({
    config: {
      enabled: true,
      baseUrl: "http://127.0.0.1:12434/v1",
      model: "local-test-model",
      timeoutMs: 5000,
      maxOutputTokens: 400,
      temperature: 0,
    },
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Extract one decision." },
    ],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "{\"decisions\":[\"Use local inference asynchronously.\"]}",
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepStrictEqual(result, {
    decisions: ["Use local inference asynchronously."],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:12434/v1/chat/completions");
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
    model: "local-test-model",
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Extract one decision." },
    ],
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
  });
});

test("requestLocalInferenceEmbeddings returns vectors from the configured loopback endpoint", async () => {
  const calls = [];
  const vectors = await requestLocalInferenceEmbeddings({
    config: {
      enabled: true,
      baseUrl: "http://localhost:12434/v1",
      model: "local-embedding-model",
      timeoutMs: 5000,
    },
    input: ["reflection prompt", "supporting evidence"],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0.5, 0.5] },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepStrictEqual(vectors, [[1, 0], [0.5, 0.5]]);
  assert.equal(calls[0].url, "http://localhost:12434/v1/embeddings");
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
    model: "local-embedding-model",
    input: ["reflection prompt", "supporting evidence"],
  });
});

test("requestLocalInferenceJson keeps bare loopback base URLs on the configured host", async () => {
  let requestUrl = null;
  await requestLocalInferenceJson({
    config: {
      enabled: true,
      baseUrl: "http://127.0.0.1:12434",
      model: "local-test-model",
    },
    messages: [{ role: "user", content: "Return JSON." }],
    fetchImpl: async (url) => {
      requestUrl = url;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "{\"ok\":true}",
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(requestUrl, "http://127.0.0.1:12434/chat/completions");
});

test("local inference rejects non-loopback endpoints before making a request", async () => {
  let called = false;
  await assert.rejects(
    () => requestLocalInferenceJson({
      config: {
        enabled: true,
        baseUrl: "https://example.com/v1",
        model: "remote-model",
      },
      messages: [{ role: "user", content: "Do not send this." }],
      fetchImpl: async () => {
        called = true;
        throw new Error("unexpected request");
      },
    }),
    /must use a loopback host/,
  );
  assert.equal(called, false);
});
