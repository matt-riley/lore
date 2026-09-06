const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function ensurePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("local inference baseUrl must use http or https");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("local inference baseUrl must use a loopback host");
  }
  if (url.username || url.password) {
    throw new Error("local inference baseUrl must not contain credentials");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function normalizeConfig(config) {
  if (config?.enabled !== true) {
    throw new Error("local inference is disabled");
  }
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (!model) {
    throw new Error("local inference model is required");
  }
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    model,
    timeoutMs: ensurePositiveInteger(config.timeoutMs, 30000),
    maxOutputTokens: ensurePositiveInteger(config.maxOutputTokens, 1200),
    temperature: Number.isFinite(Number(config.temperature))
      ? Number(config.temperature)
      : 0,
  };
}

function buildEndpoint(baseUrl, pathname) {
  const endpoint = new URL(baseUrl);
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  const suffix = String(pathname || "").replace(/^\/+/, "");
  endpoint.pathname = `${basePath}/${suffix}`;
  return endpoint;
}

function parseJsonContent(content) {
  const trimmed = String(content || "").trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`local inference returned invalid JSON: ${message}`);
  }
}

export function localInferenceEnabled(config) {
  return config?.enabled === true;
}

async function requestLocalInference({
  config,
  pathname,
  body,
  fetchImpl = globalThis.fetch,
  signal,
}) {
  const normalized = normalizeConfig(config);
  if (typeof fetchImpl !== "function") {
    throw new Error("local inference fetch implementation is unavailable");
  }
  const controller = new AbortController();
  let timedOut = false;
  let externalAbortHandler = null;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new Error(`local inference request timed out after ${normalized.timeoutMs}ms`));
  }, normalized.timeoutMs);
  try {
    if (signal?.aborted) {
      throw new Error("local inference request aborted");
    }
    const endpoint = buildEndpoint(normalized.baseUrl, pathname);
    const request = fetchImpl(endpoint.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body(normalized)),
      signal: controller.signal,
    });
    const abortPromise = signal
      ? new Promise((_, reject) => {
        externalAbortHandler = () => {
          controller.abort(signal.reason);
          reject(new Error("local inference request aborted"));
        };
        if (signal.aborted) {
          externalAbortHandler();
        } else {
          signal.addEventListener("abort", externalAbortHandler, { once: true });
        }
      })
      : null;
    const response = await Promise.race(
      [request, timeoutPromise, abortPromise].filter(Boolean),
    );
    if (!response?.ok) {
      const status = response?.status ?? "unknown";
      throw new Error(`local inference request failed with status ${status}`);
    }
    return await Promise.race(
      [response.json(), timeoutPromise, abortPromise].filter(Boolean),
    );
  } catch (error) {
    if (timedOut) {
      throw new Error(`local inference request timed out after ${normalized.timeoutMs}ms`);
    }
    if (signal?.aborted) {
      throw new Error("local inference request aborted");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalAbortHandler && signal) {
      signal.removeEventListener("abort", externalAbortHandler);
    }
  }
}

export async function requestLocalInferenceJson({
  config,
  messages,
  fetchImpl = globalThis.fetch,
  signal,
}) {
  const payload = await requestLocalInference({
    config,
    pathname: "chat/completions",
    body: (normalized) => ({
      model: normalized.model,
      messages,
      temperature: normalized.temperature,
      max_tokens: normalized.maxOutputTokens,
      response_format: { type: "json_object" },
    }),
    fetchImpl,
    signal,
  });
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("local inference response did not contain message content");
  }
  return parseJsonContent(content);
}

export async function requestLocalInferenceEmbeddings({
  config,
  input,
  fetchImpl = globalThis.fetch,
  signal,
  preserveInvalid = false,
}) {
  const payload = await requestLocalInference({
    config,
    pathname: "embeddings",
    body: (normalized) => ({
      model: normalized.model,
      input,
    }),
    fetchImpl,
    signal,
  });
  const rows = Array.isArray(payload?.data)
    ? [...payload.data].sort((left, right) => {
      const leftIndex = Number.isInteger(Number(left?.index)) ? Number(left.index) : Number.POSITIVE_INFINITY;
      const rightIndex = Number.isInteger(Number(right?.index)) ? Number(right.index) : Number.POSITIVE_INFINITY;
      return leftIndex - rightIndex;
    })
    : [];
  if (preserveInvalid) {
    // Keep response positions tied to request positions. Semantic indexing can
    // record malformed slots as non-hits and advance to later memories without
    // weakening strict validation for the other callers of this helper.
    const vectors = Array.from({ length: Array.isArray(input) ? input.length : rows.length }, () => null);
    for (const row of rows) {
      const index = Number(row?.index);
      if (Number.isInteger(index) && index >= 0 && index < vectors.length) {
        vectors[index] = row?.embedding ?? null;
      }
    }
    return vectors;
  }
  const vectors = rows.map((row) => row?.embedding);
  if (vectors.length === 0 || vectors.some((vector) => (
    !Array.isArray(vector)
    || vector.length === 0
    || vector.some((value) => !Number.isFinite(value))
  ))) {
    throw new Error("local inference response did not contain valid embeddings");
  }
  return vectors;
}
