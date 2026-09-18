import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectSensitiveContent,
  isSensitiveMemoryContent,
} from "../../lib/memory/memory-sensitivity.mjs";

const SENSITIVE = [
  ["private key block", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----"],
  ["aws access key", "The deploy key was AKIAIOSFODNN7EXAMPLE for staging."],
  ["openai key", "Use sk-proj-abcdefghijklmnopqrstuvwxyz123456 for the API."],
  ["anthropic key", "Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
  ["github token", "Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 worked."],
  ["github pat", "Use github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0000000000000000000000"],
  ["slack token", "Slack bot uses xoxb-1234567890-abcdefghijklm"],
  ["google api key", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
  ["typesafe key", "The provider key is apikey_2abcdefghijklmnopqrstuvwxyz"],
  ["jwt", "Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ["bearer token", "Send Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
  ["secret assignment", "Set DATABASE_PASSWORD=hunter2hunter2hunter2 before starting."],
];

const SAFE = [
  ["ordinary preference", "Name tests after their modules."],
  ["prose mentioning a key", "The API key is read from the environment, never stored in config."],
  ["prose mentioning a password", "Never store passwords in the repository."],
  ["git sha", "Fixed in commit 4f2a9c1b8e3d5a6f7b8c9d0e1f2a3b4c5d6e7f80."],
  ["short token word", "The token: short value here."],
  ["email", "Contact matt@example.com for access requests."],
  ["selection guidance", "Keep primary keys stable and avoid composite keys where a surrogate works."],
  ["phrase with equals", "Use key=value pairs for the config file."],
];

describe("detectSensitiveContent", () => {
  for (const [label, text] of SENSITIVE) {
    test(`flags ${label}`, () => {
      const result = detectSensitiveContent(text);
      assert.equal(result.sensitive, true, label);
      assert.ok(result.reason, `${label} should name a reason`);
    });
  }

  for (const [label, text] of SAFE) {
    test(`leaves ${label} alone`, () => {
      assert.equal(detectSensitiveContent(text).sensitive, false, label);
    });
  }

  test("handles empty and non-string input", () => {
    assert.deepEqual(detectSensitiveContent(""), { sensitive: false, reason: null });
    assert.deepEqual(detectSensitiveContent(null), { sensitive: false, reason: null });
    assert.equal(isSensitiveMemoryContent(undefined), false);
  });
});
