/**
 * lib/pre-tool-use-guardrail.mjs
 *
 * Narrow, default-off pre-tool-use guardrail for the onPreToolUse hook.
 *
 * Design constraints (Phase 3):
 *   - Default-off: only active when rollout.preToolUseGuardrail is true.
 *   - Explicit allowlist: only processes tools in PRE_TOOL_USE_ALLOWLIST.
 *   - Never reads, logs, or persists raw toolArgs content.
 *   - Enforces a 50 ms internal timeout; fails open on timeout, error,
 *     SDK mismatch, or malformed payload.
 *   - Returns void (no-op) by default; never returns a "deny" decision.
 *   - Observe-only in Phase 3: may return { additionalContext } with advisory
 *     sub-agent scope metadata when scope tracking is active.
 *
 * Verified SDK capability (types.d.ts, SDK ≥ 1.0.75):
 *   PreToolUseHookInput  — { toolName, toolArgs, sessionId, timestamp, workingDirectory }
 *   PreToolUseHookOutput — { permissionDecision?, permissionDecisionReason?,
 *                            modifiedArgs?, additionalContext?, suppressOutput? }
 *
 * Privacy guarantees:
 *   - toolArgs are structurally present in the input but never accessed here.
 *   - No raw argument content appears in any returned output, trace, or log.
 */

import { createRolloutBooleanReader } from "./rollout-flag-utils.mjs";

/**
 * Lore-relevant tools that benefit from a pre-use scope context check.
 * Only tools in this set are observed by the guardrail; all others are no-ops.
 *
 * @type {ReadonlySet<string>}
 */
export const PRE_TOOL_USE_ALLOWLIST = Object.freeze(
  new Set(["lore_retain", "lore_reflect", "memory_save"]),
);

/** Maximum time (ms) the guardrail check may run before failing open. */
export const GUARDRAIL_TIMEOUT_MS = 50;

const readPreToolUseGuardrailEnabledInternal = createRolloutBooleanReader(
  "preToolUseGuardrail",
  false,
);

/**
 * Returns true if the tool name is in the explicit allowlist.
 *
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isToolInAllowlist(toolName) {
  if (typeof toolName !== "string" || !toolName) {
    return false;
  }
  return PRE_TOOL_USE_ALLOWLIST.has(toolName.trim().slice(0, 64));
}

/**
 * Run the pre-tool-use guardrail.
 *
 * Returns undefined in all base cases. When the tool is in the allowlist and
 * sub-agent scope tracking is active, returns { additionalContext } with
 * advisory scope text. Fails open (returns undefined) on any error, timeout,
 * or ambiguous input.
 *
 * Must complete within GUARDRAIL_TIMEOUT_MS or it fails open automatically.
 *
 * @param {unknown} input - PreToolUseHookInput from the SDK
 * @param {{
 *   config: unknown,
 *   scopeTracker?: { getActiveScopeMetadata(): object | null },
 * }} opts
 * @returns {Promise<{ additionalContext: string } | undefined>}
 */
export async function runPreToolUseGuardrail(input, { config, scopeTracker } = {}) {
  try {
    if (!readPreToolUseGuardrailEnabledInternal(config)) {
      return undefined;
    }

    // Malformed or absent payload → no-op
    if (!input || typeof input !== "object") {
      return undefined;
    }

    const toolName = typeof input.toolName === "string" ? input.toolName : "";

    // toolArgs are intentionally never read or inspected here

    if (!isToolInAllowlist(toolName)) {
      return undefined;
    }

    // Cheap precomputed check wrapped in a hard timeout.
    const checkPromise = Promise.resolve().then(() => {
      const scopeMeta = scopeTracker?.getActiveScopeMetadata?.() ?? null;
      if (!scopeMeta) {
        return undefined;
      }
      const agentName = String(scopeMeta.activeSubagent?.name ?? "").slice(0, 64);
      if (!agentName) {
        return undefined;
      }
      return {
        additionalContext: `[lore scope] active sub-agent: ${agentName}`,
      };
    });

    // Hoist the handle so it can be cleared once the race settles,
    // regardless of which side wins or whether the check throws.
    let timerId;
    const timeoutPromise = new Promise((resolve) => {
      timerId = setTimeout(() => resolve(undefined), GUARDRAIL_TIMEOUT_MS);
    });

    try {
      return await Promise.race([checkPromise, timeoutPromise]);
    } finally {
      clearTimeout(timerId);
    }
  } catch {
    // Fail open on any error, SDK mismatch, or unexpected condition
    return undefined;
  }
}
