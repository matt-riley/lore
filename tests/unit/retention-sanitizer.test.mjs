import assert from "node:assert/strict";
import { test } from "node:test";

import { stripInjectedContext } from "../../lib/memory/retention-sanitizer.mjs";

test("strips all Lore-generated context sections before retention", () => {
  const text = [
    "Please fix the parser.",
    "",
    "## Standing Directives",
    "",
    "- An old task rule.",
    "",
    "## Response Style And Addressing",
    "",
    "- An injected style preference.",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "Please fix the parser.");
});

test("leaves ordinary user text untouched", () => {
  const text = "Please fix the parser without changing the public API.";
  assert.equal(stripInjectedContext(text), text);
});

test("strips Claude Code slash-command echoes", () => {
  const text = [
    "Fix the logging.",
    "<command-name>/model</command-name>",
    "<command-message>model</command-message>",
    "<command-args></command-args>",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "Fix the logging.");
});

test("strips local command output blocks", () => {
  const text = [
    "Please check the test results:",
    "<local-command-stdout>All tests passed</local-command-stdout>",
    "<local-command-stderr>Warning: deprecated API</local-command-stderr>",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "Please check the test results:");
});

test("strips local command caveat blocks", () => {
  const text = [
    "Here is the fix:",
    "<local-command-caveat>This change may affect performance</local-command-caveat>",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "Here is the fix:");
});

test("strips system-reminder blocks inside user content", () => {
  const text = [
    "Remember to update the documentation.",
    "<system-reminder>",
    "These are instructions for the harness",
    "</system-reminder>",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "Remember to update the documentation.");
});

test("strips Codex AGENTS.md instructions heading and content blocks", () => {
  const text = [
    "Please implement the feature.",
    "# AGENTS.md instructions for lib/utils",
    "<INSTRUCTIONS>Use the utility functions correctly</INSTRUCTIONS>",
    "<environment_context>Node 24.0.0</environment_context>",
    "That is all.",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "Please implement the feature.\n\nThat is all.");
});

test("strips user_instructions blocks from Codex rollouts", () => {
  const text = [
    "Follow the guidelines:",
    "<user_instructions>Read the config carefully</user_instructions>",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "Follow the guidelines:");
});

test("removes messages that consist only of injected content", () => {
  const commandOnly = [
    "<command-name>/help</command-name>",
    "<command-message>help</command-message>",
  ].join("\n");

  assert.equal(stripInjectedContext(commandOnly), "");
});

test("removes AGENTS.md instruction-only messages", () => {
  const agentsOnly = [
    "# AGENTS.md instructions for test",
    "<INSTRUCTIONS>test instructions</INSTRUCTIONS>",
  ].join("\n");

  assert.equal(stripInjectedContext(agentsOnly), "");
});

test("preserves real user text while removing multiple injected blocks", () => {
  const text = [
    "Please help with the parser",
    "<command-name>/debug</command-name>",
    "I need to understand the issue",
    "<local-command-stdout>Error in line 42</local-command-stdout>",
    "Can you fix it?",
    "<system-reminder>Internal note</system-reminder>",
  ].join("\n");

  const result = stripInjectedContext(text);
  assert(result.includes("Please help with the parser"));
  assert(result.includes("I need to understand the issue"));
  assert(result.includes("Can you fix it?"));
  assert(!result.includes("command-name"));
  assert(!result.includes("Error in line 42"));
  assert(!result.includes("Internal note"));
});

test("handles nested and consecutive injected blocks", () => {
  const text = [
    "The implementation is ready",
    "<command-message>message</command-message>",
    "<system-reminder>do not store</system-reminder>",
    "<INSTRUCTIONS>ignore</INSTRUCTIONS>",
  ].join("\n");

  assert.equal(stripInjectedContext(text), "The implementation is ready");
});
