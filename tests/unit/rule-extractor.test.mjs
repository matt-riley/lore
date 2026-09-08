import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractSessionMemories } from "../../lib/sessions/rule-extractor.mjs";
import { MEMORY_SCOPE, classifySemanticMemory } from "../../lib/memory/memory-scope.mjs";

function extractTurn(userMessage, { repository = "owner/repo", sessionId = "test-session" } = {}) {
  return extractSessionMemories({
    sessionId,
    repository,
    sessionArtifacts: {
      session: {
        repository,
        branch: "main",
        summary: "Test session",
        updated_at: "2026-09-07T12:00:00.000Z",
      },
      checkpoints: [],
      files: [],
      refs: [],
      turns: [{
        turn_index: 1,
        user_message: userMessage,
        assistant_response: "Understood.",
      }],
    },
    workspace: { workspace: null },
  });
}

test("directives survive inline code and Markdown list formatting", () => {
  const inline = extractTurn("Always use `node:test` for tests.");
  assert.ok(inline.semanticMemories.some((memory) => memory.type === "user_preference"));
  const markdown = extractTurn("Preferences:\n- Always use node:test for tests.\n- Prefer small patches.");
  assert.equal(markdown.semanticMemories.filter((memory) => memory.type === "user_preference").length, 2);
  const fenced = extractTurn("```\nAlways use node:test for tests.\n```");
  assert.equal(fenced.semanticMemories.some((memory) => memory.type === "user_preference"), false);
});

describe("rule-extractor extraction accuracy and scoping", () => {
  test("Review git diff --cached... Do not edit files. is NOT extracted as a rejected_approach or standing directive", () => {
    const result = extractTurn("Review git diff --cached, falling back to git diff if nothing is staged. Return every actionable finding as path:line with severity, covering logic bugs, security issues, error-handling gaps, and edge cases. Do not edit files.");
    const directives = result.semanticMemories.filter((m) =>
      m.type === "rejected_approach" || m.type === "user_preference"
    );
    assert.deepEqual(directives, []);
  });

  test("Draft a conventional commit message... do not run git commit. is NOT extracted as a rejected_approach", () => {
    const result = extractTurn("Draft a conventional commit message for the staged changes, but do not run git commit.");
    const rejections = result.semanticMemories.filter((m) => m.type === "rejected_approach");
    assert.deepEqual(rejections, []);
  });

  test("Don't forget to monitor for review comments too is NOT extracted as a rejected_approach", () => {
    const result = extractTurn("Don't forget to monitor for review comments too");
    const rejections = result.semanticMemories.filter((m) => m.type === "rejected_approach");
    assert.deepEqual(rejections, []);
  });

  test("what do I prefer? is NOT extracted as a user_preference", () => {
    const result = extractTurn("what do I prefer?");
    const preferences = result.semanticMemories.filter((m) => m.type === "user_preference");
    assert.deepEqual(preferences, []);
  });

  test("Am I able to toggle it on and off? is NOT extracted as a rejected_approach", () => {
    const result = extractTurn("Am I able to toggle it on and off?");
    const rejections = result.semanticMemories.filter((m) => m.type === "rejected_approach");
    assert.deepEqual(rejections, []);
  });

  test(". Sad times or stopping? is NOT extracted as a recurring_mistake", () => {
    const result1 = extractTurn("You keep: . Sad times");
    const mistakes1 = result1.semanticMemories.filter((m) => m.type === "recurring_mistake");
    assert.deepEqual(mistakes1, []);

    const result2 = extractTurn("You keep stopping?");
    const mistakes2 = result2.semanticMemories.filter((m) => m.type === "recurring_mistake");
    assert.deepEqual(mistakes2, []);

    const result3 = extractTurn("You keep - 'menace' maybe?");
    const mistakes3 = result3.semanticMemories.filter((m) => m.type === "recurring_mistake");
    assert.deepEqual(mistakes3, []);
  });

  test("legitimate recurring mistake feedback is still extracted", () => {
    const result = extractTurn("You keep using semicolons in this Python repository.");
    const mistakes = result.semanticMemories.filter((m) => m.type === "recurring_mistake");
    assert.equal(mistakes.length, 1);
    assert.equal(mistakes[0].content, "Recurring mistake to avoid: using semicolons in this Python repository");
    assert.equal(mistakes[0].scope, MEMORY_SCOPE.REPO);
  });

  test("Repository preferences mentioning respond do NOT get promoted to global scope without explicit cross-project wording", () => {
    const repoPref = classifySemanticMemory({
      type: "user_preference",
      repository: "owner/my-repo",
      content: "Always respond with typed response models in this API.",
    });
    assert.equal(repoPref.scope, MEMORY_SCOPE.REPO);
    assert.equal(repoPref.repository, "owner/my-repo");

    const globalPref = classifySemanticMemory({
      type: "user_preference",
      repository: "owner/my-repo",
      content: "Across all projects, always respond with typed response models.",
    });
    assert.equal(globalPref.scope, MEMORY_SCOPE.GLOBAL);
    assert.equal(globalPref.repository, null);

    const phraseGlobalPref = classifySemanticMemory({
      type: "user_preference",
      repository: "owner/my-repo",
      content: "My response style should be concise and direct.",
    });
    assert.equal(phraseGlobalPref.scope, MEMORY_SCOPE.GLOBAL);
    assert.equal(phraseGlobalPref.repository, null);
  });
});
