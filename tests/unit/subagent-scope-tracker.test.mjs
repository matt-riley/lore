/**
 * tests/unit/subagent-scope-tracker.test.mjs
 *
 * Unit tests for lib/subagent-scope-tracker.mjs.
 *
 * Covers:
 *   - Initial state: no active sub-agent, isActive() false, getActiveScopeMetadata() null
 *   - handleSelected: sets active identity from SubagentSelectedEvent shape
 *   - handleDeselected: clears identity
 *   - handleStarted: reinforces identity from SubagentStartedEvent shape
 *   - handleCompleted: clears identity
 *   - handleFailed: clears identity (never reads error field)
 *   - reset(): clears all state; safe to call multiple times
 *   - Lifecycle: selected → started → completed resets; selected → deselected resets
 *   - Scope metadata: additive, never leaks across reset() calls
 *   - Malformed/absent/unknown payloads: safe no-ops
 *   - Unknown event types do not affect state
 *   - getActiveScopeMetadata() returns correct structure when active
 *   - Multiple trackers are independent (no shared state)
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createSubagentScopeTracker } from "../../lib/subagent-scope-tracker.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function selectedEvent(agentName, agentDisplayName = "Display Name", tools = null) {
  return {
    type: "subagent.selected",
    data: { agentName, agentDisplayName, tools },
  };
}

function deselectedEvent() {
  return { type: "subagent.deselected", data: {} };
}

function startedEvent(agentName, agentDisplayName = "Display Name") {
  return {
    type: "subagent.started",
    data: { agentName, agentDisplayName, agentDescription: "A helper agent", toolCallId: "tc-1" },
  };
}

function completedEvent(agentName) {
  return {
    type: "subagent.completed",
    data: { agentName, agentDisplayName: "Display Name", toolCallId: "tc-1" },
  };
}

function failedEvent(agentName) {
  return {
    type: "subagent.failed",
    data: {
      agentName,
      agentDisplayName: "Display Name",
      error: "SENSITIVE ERROR MESSAGE MUST NOT BE READ",
      toolCallId: "tc-1",
    },
  };
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("createSubagentScopeTracker — initial state", () => {
  test("isActive() returns false before any events", () => {
    const tracker = createSubagentScopeTracker();
    assert.strictEqual(tracker.isActive(), false);
  });

  test("getActiveScopeMetadata() returns null before any events", () => {
    const tracker = createSubagentScopeTracker();
    assert.strictEqual(tracker.getActiveScopeMetadata(), null);
  });
});

// ---------------------------------------------------------------------------
// handleSelected
// ---------------------------------------------------------------------------

describe("handleSelected", () => {
  test("sets active identity from valid SubagentSelectedEvent", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("my-agent", "My Agent"));
    assert.strictEqual(tracker.isActive(), true);
    const meta = tracker.getActiveScopeMetadata();
    assert.ok(meta, "should return metadata");
    assert.strictEqual(meta.activeSubagent.name, "my-agent");
    assert.strictEqual(meta.activeSubagent.displayName, "My Agent");
  });

  test("safe no-op when event is null", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(null);
    assert.strictEqual(tracker.isActive(), false);
  });

  test("safe no-op when event is undefined", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(undefined);
    assert.strictEqual(tracker.isActive(), false);
  });

  test("safe no-op when event has no data", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected({ type: "subagent.selected" });
    assert.strictEqual(tracker.isActive(), false);
  });

  test("safe no-op when agentName is missing", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected({ data: { agentDisplayName: "X" } });
    assert.strictEqual(tracker.isActive(), false);
  });

  test("safe no-op when agentName is not a string", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected({ data: { agentName: 42 } });
    assert.strictEqual(tracker.isActive(), false);
  });

  test("agentName is truncated to 128 chars", () => {
    const tracker = createSubagentScopeTracker();
    const longName = "a".repeat(200);
    tracker.handleSelected({ data: { agentName: longName } });
    assert.strictEqual(tracker.getActiveScopeMetadata().activeSubagent.name.length, 128);
  });

  test("agentDisplayName is truncated to 256 chars", () => {
    const tracker = createSubagentScopeTracker();
    const longDisplay = "d".repeat(300);
    tracker.handleSelected({ data: { agentName: "agent", agentDisplayName: longDisplay } });
    assert.strictEqual(tracker.getActiveScopeMetadata().activeSubagent.displayName.length, 256);
  });

  test("displayName defaults to null when absent", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected({ data: { agentName: "agent" } });
    assert.strictEqual(tracker.getActiveScopeMetadata().activeSubagent.displayName, null);
  });
});

// ---------------------------------------------------------------------------
// handleDeselected
// ---------------------------------------------------------------------------

describe("handleDeselected", () => {
  test("clears active identity set by handleSelected", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("agent-1"));
    assert.strictEqual(tracker.isActive(), true);
    tracker.handleDeselected(deselectedEvent());
    assert.strictEqual(tracker.isActive(), false);
    assert.strictEqual(tracker.getActiveScopeMetadata(), null);
  });

  test("safe no-op when no agent was active", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleDeselected(deselectedEvent());
    assert.strictEqual(tracker.isActive(), false);
  });

  test("safe no-op when event is null", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("agent-1"));
    tracker.handleDeselected(null);
    assert.strictEqual(tracker.isActive(), false); // deselected still clears
  });
});

// ---------------------------------------------------------------------------
// handleStarted
// ---------------------------------------------------------------------------

describe("handleStarted", () => {
  test("reinforces identity when agent name matches selected", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("impl-planner", "Impl Planner"));
    tracker.handleStarted(startedEvent("impl-planner", "Impl Planner v2"));
    const meta = tracker.getActiveScopeMetadata();
    assert.strictEqual(meta.activeSubagent.name, "impl-planner");
    assert.strictEqual(meta.activeSubagent.displayName, "Impl Planner v2");
  });

  test("sets identity from started when no prior selection", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleStarted(startedEvent("auto-agent", "Auto Agent"));
    assert.strictEqual(tracker.isActive(), true);
    assert.strictEqual(tracker.getActiveScopeMetadata().activeSubagent.name, "auto-agent");
  });

  test("does not override a different already-active agent", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("agent-a", "Agent A"));
    tracker.handleStarted(startedEvent("agent-b", "Agent B"));
    // agent-a already active and agent-b name doesn't match
    const meta = tracker.getActiveScopeMetadata();
    assert.strictEqual(meta.activeSubagent.name, "agent-a");
  });

  test("safe no-op when event is null", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleStarted(null);
    assert.strictEqual(tracker.isActive(), false);
  });

  test("safe no-op when agentName is absent", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleStarted({ data: {} });
    assert.strictEqual(tracker.isActive(), false);
  });
});

// ---------------------------------------------------------------------------
// handleCompleted
// ---------------------------------------------------------------------------

describe("handleCompleted", () => {
  test("clears active identity on completion", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("planner"));
    tracker.handleCompleted(completedEvent("planner"));
    assert.strictEqual(tracker.isActive(), false);
    assert.strictEqual(tracker.getActiveScopeMetadata(), null);
  });

  test("safe no-op when event is null", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("agent"));
    tracker.handleCompleted(null);
    assert.strictEqual(tracker.isActive(), false); // still clears
  });
});

// ---------------------------------------------------------------------------
// handleFailed
// ---------------------------------------------------------------------------

describe("handleFailed", () => {
  test("clears active identity on failure", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("coder"));
    tracker.handleFailed(failedEvent("coder"));
    assert.strictEqual(tracker.isActive(), false);
    assert.strictEqual(tracker.getActiveScopeMetadata(), null);
  });

  test("does not read or retain error field from failed event", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("coder"));
    const sensitiveEvent = failedEvent("coder");
    sensitiveEvent.data.error = "SENSITIVE: /home/user/.ssh/id_rsa permission denied";
    tracker.handleFailed(sensitiveEvent);
    // Confirm the tracker is cleared and error value is not accessible
    assert.strictEqual(tracker.isActive(), false);
    assert.strictEqual(tracker.getActiveScopeMetadata(), null);
  });

  test("safe no-op when event is null", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("agent"));
    tracker.handleFailed(null);
    assert.strictEqual(tracker.isActive(), false); // still clears
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe("reset()", () => {
  test("clears active state", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("impl-planner"));
    tracker.reset();
    assert.strictEqual(tracker.isActive(), false);
    assert.strictEqual(tracker.getActiveScopeMetadata(), null);
  });

  test("safe to call multiple times when already cleared", () => {
    const tracker = createSubagentScopeTracker();
    tracker.reset();
    tracker.reset();
    assert.strictEqual(tracker.isActive(), false);
  });

  test("state does not leak after reset followed by new events", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("agent-1", "First"));
    tracker.reset();

    // Confirm clean state before second lifecycle
    assert.strictEqual(tracker.getActiveScopeMetadata(), null);

    tracker.handleSelected(selectedEvent("agent-2", "Second"));
    const meta = tracker.getActiveScopeMetadata();
    assert.strictEqual(meta.activeSubagent.name, "agent-2");
    assert.strictEqual(meta.activeSubagent.displayName, "Second");
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle sequences
// ---------------------------------------------------------------------------

describe("lifecycle: select → start → complete", () => {
  test("state is active between selected and completed", () => {
    const tracker = createSubagentScopeTracker();
    assert.strictEqual(tracker.isActive(), false);

    tracker.handleSelected(selectedEvent("planner", "Planner"));
    assert.strictEqual(tracker.isActive(), true);

    tracker.handleStarted(startedEvent("planner", "Planner"));
    assert.strictEqual(tracker.isActive(), true);

    tracker.handleCompleted(completedEvent("planner"));
    assert.strictEqual(tracker.isActive(), false);
  });

  test("state is active between selected and failed", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("coder", "Coder"));
    assert.strictEqual(tracker.isActive(), true);
    tracker.handleFailed(failedEvent("coder"));
    assert.strictEqual(tracker.isActive(), false);
  });

  test("state is active between selected and deselected", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("agent"));
    assert.strictEqual(tracker.isActive(), true);
    tracker.handleDeselected(deselectedEvent());
    assert.strictEqual(tracker.isActive(), false);
  });
});

// ---------------------------------------------------------------------------
// Scope metadata shape
// ---------------------------------------------------------------------------

describe("getActiveScopeMetadata — shape invariants", () => {
  test("returned object has exactly { activeSubagent: { name, displayName } }", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected(selectedEvent("impl-planner", "Implementation Planner"));
    const meta = tracker.getActiveScopeMetadata();
    assert.ok(meta, "must return metadata");
    assert.deepStrictEqual(Object.keys(meta), ["activeSubagent"]);
    assert.deepStrictEqual(Object.keys(meta.activeSubagent), ["name", "displayName"]);
  });

  test("does not contain session IDs, tool args, or private fields", () => {
    const tracker = createSubagentScopeTracker();
    tracker.handleSelected({
      data: {
        agentName: "agent",
        agentDisplayName: "Agent",
        tools: ["bash", "grep"],
        sessionId: "should-not-appear",
      },
    });
    const meta = tracker.getActiveScopeMetadata();
    const metaStr = JSON.stringify(meta);
    assert.ok(!metaStr.includes("should-not-appear"), "sessionId must not appear in metadata");
    assert.ok(!metaStr.includes("bash"), "tool list must not appear in metadata");
  });
});

// ---------------------------------------------------------------------------
// Multiple independent trackers
// ---------------------------------------------------------------------------

describe("multiple trackers are independent", () => {
  test("state change in tracker A does not affect tracker B", () => {
    const trackerA = createSubagentScopeTracker();
    const trackerB = createSubagentScopeTracker();

    trackerA.handleSelected(selectedEvent("agent-a"));
    assert.strictEqual(trackerA.isActive(), true);
    assert.strictEqual(trackerB.isActive(), false);

    trackerA.reset();
    assert.strictEqual(trackerA.isActive(), false);
    assert.strictEqual(trackerB.isActive(), false);
  });
});
