/**
 * Shared TypeSafe System One transport.
 *
 * One place for the provider contract — key resolution, endpoint, model
 * defaults, timeout, request shape and error messages — so the features that
 * use it (recall reranking, memory feature scoring) cannot drift apart.
 * Fail-open policy stays with each caller, not here.
 */

import { execFileSync } from "node:child_process";

export const TYPESAFE_API_KEY_ENV = "LORE_TYPESAFE_API_KEY";
const DEFAULT_TYPESAFE_MODEL = "jev-latest";
const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TYPESAFE_TIMEOUT_MS = 3000;

const MAX_TYPESAFE_TIMEOUT_MS = 60000;
const ERROR_BODY_CHARS = 200;

export const TYPESAFE_KEYCHAIN_DEFAULT_SERVICE = "lore-typesafe";
// `security` on a cold keychain (or a missing entry) is fast, but this keeps a
// misbehaving or hung keychain daemon from stalling a hook. Measured locally
// at roughly 30-50ms per lookup for a resolved-or-missing entry, well under
// this budget.
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 1000;

export function positiveInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return maximum ? Math.min(numeric, maximum) : numeric;
}

function normalizeKeychainSource(value) {
  if (value === true) {
    return { service: TYPESAFE_KEYCHAIN_DEFAULT_SERVICE, account: undefined };
  }
  if (value && typeof value === "object") {
    const service = typeof value.service === "string" && value.service.trim()
      ? value.service.trim()
      : TYPESAFE_KEYCHAIN_DEFAULT_SERVICE;
    const account = typeof value.account === "string" && value.account.trim()
      ? value.account.trim()
      : undefined;
    return { service, account };
  }
  return null;
}

/** Default keychain command runner: `security find-generic-password`, no shell. */
function runSecurityFindGenericPassword(service, account) {
  const args = ["find-generic-password", "-s", service];
  if (account) {
    args.push("-a", account);
  }
  args.push("-w");
  return execFileSync("security", args, {
    timeout: KEYCHAIN_LOOKUP_TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// Cache the resolved (or absent) keychain key for the lifetime of this
// process, keyed by service/account: recall assembly can run once per prompt
// and must not shell out to `security` every time. Only the default runner's
// results are cached — an injected test runner is already in-memory and
// caching it would leak state between tests using the same service name.
let cachedKeychainResult = null;

/**
 * Resolve the TypeSafe API key from the macOS keychain, if configured via
 * `config.typesafe.apiKeyKeychain`. Fails open (returns "") when unconfigured,
 * on a non-darwin platform, when `security` has no matching entry, or on any
 * other lookup error (missing binary, timeout, ...) — exactly like a missing
 * key today. `onTrace` receives a short reason string for status/trace output.
 */
export function resolveTypesafeKeychainKey(config, {
  platform = process.platform,
  runCommand = runSecurityFindGenericPassword,
  onTrace,
} = {}) {
  const source = normalizeKeychainSource(config?.typesafe?.apiKeyKeychain);
  if (!source) {
    return "";
  }
  if (platform !== "darwin") {
    onTrace?.("keychain_unsupported_platform");
    return "";
  }
  const usingDefaultRunner = runCommand === runSecurityFindGenericPassword;
  if (usingDefaultRunner && cachedKeychainResult
    && cachedKeychainResult.service === source.service
    && cachedKeychainResult.account === source.account) {
    onTrace?.(cachedKeychainResult.key ? "keychain_cached" : "keychain_not_found_cached");
    return cachedKeychainResult.key;
  }
  let key = "";
  try {
    key = String(runCommand(source.service, source.account) ?? "").trim();
    onTrace?.(key ? "keychain_found" : "keychain_empty");
  } catch (error) {
    onTrace?.(`keychain_lookup_failed: ${error instanceof Error ? error.message : String(error)}`);
    key = "";
  }
  if (usingDefaultRunner) {
    cachedKeychainResult = { service: source.service, account: source.account, key };
  }
  return key;
}

/**
 * Resolve the API key. Precedence: the `LORE_TYPESAFE_API_KEY` env var, then
 * the macOS keychain (`config.typesafe.apiKeyKeychain`), then the plaintext
 * `config.typesafe.apiKey`. Keeping the key out of plaintext config is the
 * point of the keychain source, so it is checked before the plaintext
 * fallback rather than after.
 */
export function resolveTypesafeApiKey(config, env = process.env, keychainOptions = {}) {
  const envKey = env?.[TYPESAFE_API_KEY_ENV];
  if (typeof envKey === "string" && envKey.trim()) {
    return envKey.trim();
  }
  const keychainKey = resolveTypesafeKeychainKey(config, keychainOptions);
  if (keychainKey) {
    return keychainKey;
  }
  const configKey = config?.typesafe?.apiKey;
  if (typeof configKey === "string" && configKey.trim()) {
    return configKey.trim();
  }
  return "";
}

export function typesafeModel(config, override) {
  const candidates = [override, config?.typesafe?.model];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return DEFAULT_TYPESAFE_MODEL;
}

export function typesafeTimeoutMs(config) {
  return positiveInteger(config?.typesafe?.timeoutMs, DEFAULT_TYPESAFE_TIMEOUT_MS, MAX_TYPESAFE_TIMEOUT_MS);
}

async function readErrorDetail(response, apiKey) {
  if (typeof response?.text !== "function") {
    return "";
  }
  try {
    // The provider can echo the submitted credential in a 4xx body, and this
    // detail lands in trace output, so redact before it travels any further.
    const body = redactSecrets(String(await response.text()).trim(), apiKey);
    return body ? `: ${body.slice(0, ERROR_BODY_CHARS)}` : "";
  } catch {
    return "";
  }
}

function redactSecrets(text, apiKey) {
  let output = String(text ?? "");
  const key = String(apiKey ?? "").trim();
  if (key) {
    // Literal first (split/join is literal, so regex metacharacters in the key
    // are safe), then the JSON-escaped form a serializer would emit, then a
    // case-insensitive pass for an echo with no recognizable prefix.
    output = output.split(key).join("[redacted]");
    const escapedForJson = key.replace(/\//g, "\\/");
    if (escapedForJson !== key) {
      output = output.split(escapedForJson).join("[redacted]");
    }
    const pattern = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(pattern, "gi"), "[redacted]");
  }
  return output
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|apikey_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,}|pypi-[A-Za-z0-9_-]{8,}|(?:xox[baprs]|xoxc|xoxd|xapp)-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{10,}|AKIA[0-9A-Z]{8,}|sk_live_[A-Za-z0-9]{8,})/g, "[redacted]");
}

/**
 * One request to the System One endpoint.
 *
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   state: unknown,
 *   questions: object,
 *   timeoutMs: number,
 *   fetchImpl?: typeof globalThis.fetch,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<object>} the parsed response body
 */
export async function requestSystemOne({
  apiKey,
  model,
  state,
  questions,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  signal,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("typesafe fetch implementation is unavailable");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  try {
    if (signal?.aborted) {
      throw new Error("typesafe request aborted");
    }
    if (signal) {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const response = await fetchImpl(TYPESAFE_SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, state, questions }),
      // Fixed remote host: refusing redirects keeps state and the bearer
      // token from following an unexpected Location.
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) {
      const detail = await readErrorDetail(response, apiKey);
      throw new Error(`typesafe request failed with status ${response?.status ?? "unknown"}${detail}`);
    }
    return await response.json();
  } catch (error) {
    if (timedOut) {
      throw new Error(`typesafe request timed out after ${timeoutMs}ms`);
    }
    if (signal?.aborted) {
      throw new Error("typesafe request aborted");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener("abort", forwardAbort);
    }
  }
}
