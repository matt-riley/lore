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
}) {
  const normalized = normalizeConfig(config);
  if (typeof fetchImpl !== "function") {
    throw new Error("local inference fetch implementation is unavailable");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalized.timeoutMs);
  try {
    const endpoint = buildEndpoint(normalized.baseUrl, pathname);
    const response = await fetchImpl(endpoint.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body(normalized)),
      signal: controller.signal,
    });
    if (!response?.ok) {
      const status = response?.status ?? "unknown";
      throw new Error(`local inference request failed with status ${status}`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`local inference request timed out after ${normalized.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestLocalInferenceJson({
  config,
  messages,
  fetchImpl = globalThis.fetch,
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
}) {
  const payload = await requestLocalInference({
    config,
    pathname: "embeddings",
    body: (normalized) => ({
      model: normalized.model,
      input,
    }),
    fetchImpl,
  });
  const rows = Array.isArray(payload?.data)
    ? [...payload.data].sort((left, right) => Number(left.index) - Number(right.index))
    : [];
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
