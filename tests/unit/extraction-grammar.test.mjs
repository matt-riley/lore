import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isNonDirectiveSentence,
  isOneOffDirectiveRequest,
  standingDirectiveType,
} from "../../lib/sessions/extraction-grammar.mjs";

describe("extraction grammar accuracy", () => {
  test("identifies question forms as non-directive sentences", () => {
    assert.equal(isNonDirectiveSentence("what do I prefer?"), true);
    assert.equal(isNonDirectiveSentence("what do I prefer"), true);
    assert.equal(isNonDirectiveSentence("Am I able to toggle it on and off?"), true);
    assert.equal(isNonDirectiveSentence("can I use tabs instead of spaces?"), true);
    assert.equal(isNonDirectiveSentence("how do I configure local storage?"), true);
    assert.equal(isNonDirectiveSentence("is there a cached build available?"), true);
    assert.equal(isNonDirectiveSentence("would there be a better language to use rather than Go"), true);
    assert.equal(isNonDirectiveSentence("were the chinese language ones useful though?"), true);
  });

  test("does not classify questions as standing directives", () => {
    assert.equal(standingDirectiveType("what do I prefer?"), null);
    assert.equal(standingDirectiveType("Am I able to toggle it on and off?"), null);
    assert.equal(standingDirectiveType("is there a way to override this?"), null);
  });

  test("keeps quoted tool names inside genuine preferences and directives", () => {
    assert.equal(isNonDirectiveSentence('I prefer "pnpm" for package management.'), false);
    assert.equal(isNonDirectiveSentence('Always use "node test" for tests.'), false);
    assert.equal(isNonDirectiveSentence('Always use “node:test” for tests.'), false);
    assert.equal(isNonDirectiveSentence("I prefer 'release candidate' tags."), false);
  });

  test("still filters quoted instructions and reported examples", () => {
    assert.equal(isNonDirectiveSentence('"Always use SQLite for local development."'), true);
    assert.equal(isNonDirectiveSentence('The old guide says "always use SQLite".'), true);
    assert.equal(isNonDirectiveSentence('The guide says "always use `node:test`".'), true);
    assert.equal(isNonDirectiveSentence('The guide says “always use SQLite”.'), true);
    assert.equal(isNonDirectiveSentence('The guide says "always use SQLite.'), true);
  });

  test("treats don't forget as a positive reminder and never a prohibition", () => {
    assert.notEqual(standingDirectiveType("Don't forget to monitor for review comments too"), "rejected_approach");
    assert.notEqual(standingDirectiveType("Do not forget to run migrations"), "rejected_approach");
  });

  test("does not treat bare imperative task language as standing policy", () => {
    assert.equal(standingDirectiveType("Run the tests."), null);
    assert.equal(standingDirectiveType("Use bun for this task."), null);
    assert.equal(standingDirectiveType("Write a summary of the diff."), null);
    assert.equal(standingDirectiveType("Check if the endpoint is healthy."), null);
  });

  test("emits directive for must/should/mandatory standing policy", () => {
    assert.equal(standingDirectiveType("Secrets must be redacted at rest."), "directive");
    assert.equal(standingDirectiveType("Failure reports should include the request id."), "directive");
    assert.equal(standingDirectiveType("Idempotency keys are mandatory."), "directive");
  });

  test("detects task requests and negative task constraints as one-off directives", () => {
    assert.equal(isOneOffDirectiveRequest("Review git diff --cached... Do not edit files."), true);
    assert.equal(isOneOffDirectiveRequest("Do not edit files."), true);
    assert.equal(isOneOffDirectiveRequest("Draft a conventional commit message... do not run git commit."), true);
    assert.equal(isOneOffDirectiveRequest("do not run git commit."), true);
    assert.equal(isOneOffDirectiveRequest("do not make any code changes"), true);
    assert.equal(isOneOffDirectiveRequest("Audit the authentication flow and report back."), true);
    assert.equal(isOneOffDirectiveRequest("Inspect the error logs from the latest run."), true);
    assert.equal(isOneOffDirectiveRequest("Check if all endpoints are responding."), true);
    assert.equal(isOneOffDirectiveRequest("Find all usages of deprecated methods."), true);
    assert.equal(isOneOffDirectiveRequest("Search for broken links across documentation."), true);
    assert.equal(isOneOffDirectiveRequest("Analyze the performance bottleneck in database queries."), true);
    assert.equal(isOneOffDirectiveRequest("Examine the commit history for regressions."), true);
    assert.equal(isOneOffDirectiveRequest("Look at the PR review feedback."), true);
    assert.equal(isOneOffDirectiveRequest("Generate a summary table of test results."), true);
    assert.equal(isOneOffDirectiveRequest("Write a unit test covering this edge case."), true);
    assert.equal(isOneOffDirectiveRequest("Explain how the memory subsystem works."), true);
    assert.equal(isOneOffDirectiveRequest("Tell me if any tests failed."), true);
    assert.equal(isOneOffDirectiveRequest("Summarize the main changes on this branch."), true);
  });

  test("preserves standing policies despite task verb presence", () => {
    assert.equal(isOneOffDirectiveRequest("As a policy, always check test coverage before PRs."), false);
    assert.equal(isOneOffDirectiveRequest("In future, always review all pull requests."), false);
    assert.equal(isOneOffDirectiveRequest("Going forward, never commit secrets to the repository."), false);
  });
});
