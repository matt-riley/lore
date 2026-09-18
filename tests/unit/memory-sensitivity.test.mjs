import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectSensitiveContent,
  isSensitiveMemoryContent,
} from "../../lib/memory/memory-sensitivity.mjs";

// Fixtures are assembled at runtime so secret scanners never match a literal
// token in this file. The strings must still reach the detector intact — they
// exist to prove it fires, not because any of them is a real credential.
const fixture = (...parts) => parts.join("");

const SENSITIVE = [
  ["private key block", fixture("-----BEGIN OPENSSH ", "PRIVATE KEY-----\nabc123\n-----END OPENSSH ", "PRIVATE KEY-----")],
  ["aws access key", fixture("The deploy key was AKIA", "IOSFODNN7EXAMPLE for staging.")],
  ["openai key", fixture("Use sk-", "proj-abcdefghijklmnopqrstuvwxyz123456 for the API.")],
  ["anthropic key", fixture("Key: sk-ant-", "api03-abcdefghijklmnopqrstuvwxyz")],
  ["github token", fixture("Token ghp_", "abcdefghijklmnopqrstuvwxyz0123456789 worked.")],
  ["github pat", fixture("Use github_pat_", "11ABCDEFG0abcdefghijklmnopqrstuvwxyz0000000000000000000000")],
  ["slack token", fixture("Slack bot uses xoxb-", "1234567890-abcdefghijklm")],
  ["google api key", fixture("AIza", "SyA1234567890abcdefghijklmnopqrstuv")],
  ["typesafe key", fixture("The provider key is apikey_", "2abcdefghijklmnopqrstuvwxyz")],
  ["jwt", fixture(
    "Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  )],
  ["bearer token", fixture("Send Authorization: Bearer ", "abcdefghijklmnopqrstuvwxyz123456")],
  ["secret assignment", fixture("Set DATABASE_PASSWORD=", "hunter2hunter2hunter2 before starting.")],
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
