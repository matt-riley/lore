/**
 * lib/subagent-scope-tracker.mjs
 *
 * Session-local sub-agent identity tracking via the Copilot CLI event stream.
 *
 * Listens to verified subagent.* events (selected, deselected, started,
 * completed, failed) subscribed via session.on() and maintains lightweight
 * session-local state: the active sub-agent name and display name.
 *
 * Verified sub-agent events (SDK ≥ 1.0.75 session-events.d.ts):
 *   subagent.selected   — custom agent selected (has agentName, agentDisplayName, tools)
 *   subagent.deselected — custom agent deselected (empty payload)
 *   subagent.started    — sub-agent execution started (has agentName, agentDisplayName, agentDescription, toolCallId)
 *   subagent.completed  — sub-agent execution completed (has agentName, toolCallId)
 *   subagent.failed     — sub-agent execution failed (has agentName, error, toolCallId)
 *
 * Design constraints:
 *   - State is purely in-memory and never persisted.
 *   - State must not leak across sessions or active agents. reset() clears all.
 *   - Unknown event shapes or malformed payloads are safe no-ops.
 *   - Scope metadata is additive and advisory; it never alters core behavior.
 *   - Private fields (error messages etc.) are never read or retained.
 */

/**
 * Create a new sub-agent scope tracker bound to a single session lifetime.
 * Call reset() at session end to ensure state cannot leak.
 *
 * @returns {{
 *   handleSelected(event: unknown): void,
 *   handleDeselected(event: unknown): void,
 *   handleStarted(event: unknown): void,
 *   handleCompleted(event: unknown): void,
 *   handleFailed(event: unknown): void,
 *   reset(): void,
 *   getActiveScopeMetadata(): { activeSubagent: { name: string, displayName: string | null } } | null,
 *   isActive(): boolean,
 * }}
 */
export function createSubagentScopeTracker() {
  /** @type {string | null} */
  let activeAgentName = null;
  /** @type {string | null} */
  let activeAgentDisplayName = null;

  function clearState() {
    activeAgentName = null;
    activeAgentDisplayName = null;
  }

  return {
    /**
     * Handle subagent.selected event.
     * Sets the active agent identity. Safe no-op on absent/malformed event.
     *
     * @param {unknown} event
     */
    handleSelected(event) {
      try {
        const name =
          typeof event?.data?.agentName === "string"
            ? event.data.agentName.slice(0, 128)
            : null;
        if (!name) {
          return;
        }
        const displayName =
          typeof event?.data?.agentDisplayName === "string"
            ? event.data.agentDisplayName.slice(0, 256)
            : null;
        activeAgentName = name;
        activeAgentDisplayName = displayName;
      } catch {
        // safe no-op on any access error
      }
    },

    /**
     * Handle subagent.deselected event.
     * Clears the active agent identity. Always safe to call.
     *
     * @param {unknown} _event
     */
    handleDeselected(_event) {
      clearState();
    },

    /**
     * Handle subagent.started event.
     * Reinforces the active agent identity from the started payload.
     * Safe no-op on absent/malformed event.
     *
     * @param {unknown} event
     */
    handleStarted(event) {
      try {
        const name =
          typeof event?.data?.agentName === "string"
            ? event.data.agentName.slice(0, 128)
            : null;
        if (!name) {
          return;
        }
        const displayName =
          typeof event?.data?.agentDisplayName === "string"
            ? event.data.agentDisplayName.slice(0, 256)
            : null;
        // Only update if no agent is currently tracked or the name matches.
        if (!activeAgentName || activeAgentName === name) {
          activeAgentName = name;
          if (displayName !== null) {
            activeAgentDisplayName = displayName;
          }
        }
      } catch {
        // safe no-op
      }
    },

    /**
     * Handle subagent.completed event.
     * Clears the active agent identity on successful completion.
     *
     * @param {unknown} _event
     */
    handleCompleted(_event) {
      clearState();
    },

    /**
     * Handle subagent.failed event.
     * Clears the active agent identity on failure.
     * Never reads the error message from the payload.
     *
     * @param {unknown} _event
     */
    handleFailed(_event) {
      clearState();
    },

    /**
     * Reset all session-local state. Must be called at session end.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    reset() {
      clearState();
    },

    /**
     * Returns additive scope metadata when a sub-agent is active, or null
     * when no sub-agent is currently tracked.
     *
     * The metadata is advisory and never alters core recall/retain behavior.
     *
     * @returns {{ activeSubagent: { name: string, displayName: string | null } } | null}
     */
    getActiveScopeMetadata() {
      if (!activeAgentName) {
        return null;
      }
      return {
        activeSubagent: {
          name: activeAgentName,
          displayName: activeAgentDisplayName,
        },
      };
    },

    /**
     * Returns true when a sub-agent is currently active.
     *
     * @returns {boolean}
     */
    isActive() {
      return activeAgentName !== null;
    },
  };
}
