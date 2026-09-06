/**
 * lib/passive-hooks.mjs
 *
 * Privacy-preserving payload normalisation and categorical derivation for
 * the Phase 2 passive hooks: onErrorOccurred and onPostToolUse.
 *
 * Constraints enforced here:
 *   - Never reads error.message, error.stack, toolArgs content, toolResult
 *     content, file contents, or command output.
 *   - Derives only categorical fields: context category, recoverability,
 *     tool kind/category, success/failure.
 *   - Produces a non-reversible fingerprint from categorical fields only.
 *   - Safe no-op on absent or malformed payloads.
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Categorical constants
// ---------------------------------------------------------------------------

/**
 * Categorical error context types derived from structural payload fields only.
 * Never derived from raw error.message or error.stack.
 */
export const ERROR_CONTEXT_CATEGORY = Object.freeze({
  TOOL_USE: "tool_use",
  NETWORK: "network",
  PERMISSION: "permission",
  TIMEOUT: "timeout",
  PARSE: "parse",
  UNKNOWN: "unknown",
});

export const RECOVERABILITY = Object.freeze({
  RECOVERABLE: "recoverable",
  UNRECOVERABLE: "unrecoverable",
  UNKNOWN: "unknown",
});

/**
 * Tool categories derived from tool name only.
 */
export const TOOL_CATEGORY = Object.freeze({
  BASH: "bash",
  FILE: "file",
  SEARCH: "search",
  NETWORK: "network",
  MEMORY: "memory",
  OTHER: "other",
});

// ---------------------------------------------------------------------------
// Error telemetry derivation
// ---------------------------------------------------------------------------

/**
 * Derive error context category from non-message structural fields only.
 * Inspects error.name, error.code, and the categorical context descriptor.
 * Never reads error.message or error.stack.
 *
 * @param {unknown} payload
 * @returns {string} One of ERROR_CONTEXT_CATEGORY values.
 */
function deriveErrorContextCategory(payload) {
  if (!payload || typeof payload !== "object") {
    return ERROR_CONTEXT_CATEGORY.UNKNOWN;
  }

  // context is a categorical descriptor provided by the SDK (e.g. hook name),
  // not a free-text message — safe to inspect for tool/network/etc keywords.
  const contextHint = String(payload.context ?? "").toLowerCase();
  const errorName = String(payload.error?.name ?? payload.errorName ?? "").toLowerCase();
  const errorCode = String(payload.error?.code ?? payload.errorCode ?? "").toLowerCase();

  if (errorCode === "etimedout" || errorCode === "etimeout" || contextHint.includes("timeout")) {
    return ERROR_CONTEXT_CATEGORY.TIMEOUT;
  }
  if (
    errorCode === "eacces" || errorCode === "eperm"
    || errorName.includes("permission")
    || contextHint.includes("permission") || contextHint.includes("auth")
  ) {
    return ERROR_CONTEXT_CATEGORY.PERMISSION;
  }
  if (
    errorCode === "econnrefused" || errorCode === "econnreset" || errorCode === "enetunreach"
    || errorName.includes("network") || errorName.includes("fetch")
    || contextHint.includes("network") || contextHint.includes("fetch")
  ) {
    return ERROR_CONTEXT_CATEGORY.NETWORK;
  }
  if (contextHint.includes("tool") || contextHint.includes("mcp")) {
    return ERROR_CONTEXT_CATEGORY.TOOL_USE;
  }
  if (errorName.includes("syntax") || errorName.includes("parse")) {
    return ERROR_CONTEXT_CATEGORY.PARSE;
  }
  return ERROR_CONTEXT_CATEGORY.UNKNOWN;
}

/**
 * Derive recoverability from structural fields (retry hints, error codes).
 * Never reads error.message or error.stack.
 *
 * @param {unknown} payload
 * @returns {string} One of RECOVERABILITY values.
 */
function deriveRecoverability(payload) {
  if (!payload || typeof payload !== "object") {
    return RECOVERABILITY.UNKNOWN;
  }
  if (payload.retryable === true || payload.retry === true) {
    return RECOVERABILITY.RECOVERABLE;
  }
  if (payload.retryable === false || payload.retry === false) {
    return RECOVERABILITY.UNRECOVERABLE;
  }
  const errorCode = String(payload.error?.code ?? payload.errorCode ?? "").toLowerCase();
  if (errorCode === "eacces" || errorCode === "eperm") {
    return RECOVERABILITY.UNRECOVERABLE;
  }
  if (errorCode === "etimedout" || errorCode === "econnrefused") {
    return RECOVERABILITY.RECOVERABLE;
  }
  return RECOVERABILITY.UNKNOWN;
}

/**
 * Build a non-reversible type fingerprint from categorical fields only.
 * The fingerprint does NOT encode any free-text from the error.
 *
 * error.name is the JS class name (e.g. "TypeError") — a structural
 * identifier, not a message. It is included in the hash after stripping
 * to ASCII word-characters only.
 *
 * @param {string} contextCategory
 * @param {string} recoverability
 * @param {string} [errorName=""] - error.name (class identifier, not message)
 * @returns {string} 16-character hex prefix of SHA-256 hash.
 */
export function buildErrorFingerprint(contextCategory, recoverability, errorName = "") {
  const safeErrorName = String(errorName)
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase()
    .slice(0, 32);
  return crypto
    .createHash("sha256")
    .update(`${contextCategory}:${recoverability}:${safeErrorName}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Build a privacy-minimised error telemetry record from an onErrorOccurred payload.
 * Returns null when the payload is absent or structurally malformed.
 *
 * Fields persisted: session_id (session ID), context_category, recoverability,
 * fingerprint (non-reversible hash), created_at (added by the DB layer).
 *
 * Fields never persisted: error.message, error.stack, tool arguments, tool
 * results, file contents, command output, raw payload blobs.
 *
 * @param {unknown} payload - Raw onErrorOccurred input payload.
 * @param {string | null} [sessionId] - Current session ID.
 * @returns {{ sessionId: string | null, contextCategory: string, recoverability: string, fingerprint: string } | null}
 */
export function buildErrorTelemetryRecord(payload, sessionId = null) {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload !== "object") {
    return null;
  }

  const contextCategory = deriveErrorContextCategory(payload);
  const recoverability = deriveRecoverability(payload);
  const errorName = String(payload.error?.name ?? payload.errorName ?? "");
  const fingerprint = buildErrorFingerprint(contextCategory, recoverability, errorName);

  return {
    sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
    contextCategory,
    recoverability,
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Post-tool-use observation derivation
// ---------------------------------------------------------------------------

const BASH_TOOLS = new Set([
  "bash", "run_command", "shell", "execute_command", "run_shell_command",
]);
const FILE_TOOLS = new Set([
  "read_file", "write_file", "view", "create", "edit", "delete_file",
  "list_dir", "list_files", "view_file", "create_file", "edit_file",
]);
const SEARCH_TOOLS = new Set([
  "grep", "glob", "search", "rg", "search_files", "find_files", "ripgrep",
]);
const NETWORK_TOOLS = new Set([
  "web_fetch", "fetch", "http_get", "http_post", "web_search",
  "browser_navigate", "browser_navigate_back",
]);
const MEMORY_TOOL_PREFIXES = ["lore_", "memory_"];

/**
 * Derive a categorical tool kind from the tool name only.
 * Never inspects tool arguments or results.
 *
 * @param {unknown} toolName
 * @returns {string} One of TOOL_CATEGORY values.
 */
export function deriveToolCategory(toolName) {
  const name = String(toolName ?? "").toLowerCase().replace(/[-\s]/g, "_");
  if (BASH_TOOLS.has(name)) {
    return TOOL_CATEGORY.BASH;
  }
  if (FILE_TOOLS.has(name)) {
    return TOOL_CATEGORY.FILE;
  }
  if (SEARCH_TOOLS.has(name)) {
    return TOOL_CATEGORY.SEARCH;
  }
  if (NETWORK_TOOLS.has(name)) {
    return TOOL_CATEGORY.NETWORK;
  }
  if (MEMORY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return TOOL_CATEGORY.MEMORY;
  }
  return TOOL_CATEGORY.OTHER;
}

/**
 * Safely inspect the structural shape of toolArgs if they arrive as a JSON
 * string. Returns only structural metadata (is it parseable? is it an object?
 * is it empty?). Never returns the raw args value itself for persistence.
 *
 * @param {unknown} toolArgs
 * @returns {{ parsed: boolean, isObject: boolean, isEmpty: boolean }}
 */
export function normalizeToolArgsShape(toolArgs) {
  if (toolArgs === null || toolArgs === undefined) {
    return { parsed: true, isObject: false, isEmpty: true };
  }
  if (typeof toolArgs === "object") {
    return {
      parsed: true,
      isObject: true,
      isEmpty: Object.keys(toolArgs).length === 0,
    };
  }
  if (typeof toolArgs === "string") {
    try {
      const parsed = JSON.parse(toolArgs);
      const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      return {
        parsed: true,
        isObject,
        isEmpty: isObject ? Object.keys(parsed).length === 0 : false,
      };
    } catch {
      return { parsed: false, isObject: false, isEmpty: false };
    }
  }
  return { parsed: true, isObject: false, isEmpty: false };
}

/**
 * Build a privacy-preserving post-tool-use observation from an onPostToolUse payload.
 * Returns null when the payload is absent, malformed, or has no tool name.
 *
 * Derives only categorical tool kind/category and success/failure.
 * Never persists raw args, results, file contents, or command output.
 *
 * @param {unknown} payload - Raw onPostToolUse input payload.
 * @returns {{ toolName: string, toolCategory: string, success: boolean, argsShape: object } | null}
 */
export function buildPostToolUseObservation(payload) {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload !== "object") {
    return null;
  }

  const toolName = String(payload.toolName ?? payload.name ?? "").slice(0, 64);
  if (!toolName) {
    return null;
  }

  const toolCategory = deriveToolCategory(toolName);
  const success = payload.success === true
    || payload.outcome === "success"
    || payload.status === "success";
  const argsShape = normalizeToolArgsShape(payload.toolArgs ?? payload.args);

  return {
    toolName,
    toolCategory,
    success,
    argsShape,
  };
}
