import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectSensitiveContent,
  isSensitiveMemoryContent,
  redactSensitiveContent,
} from "../../lib/memory/memory-sensitivity.mjs";

// Fixtures are assembled at runtime so secret scanners never match a literal
// token in this file. The strings must still reach the detector intact — they
// exist to prove it fires, not because any of them is a real credential.
const fixture = (...parts) => parts.join("");

const SENSITIVE = [
  ["private key block", fixture("-----BEGIN OPENSSH ", "PRIVATE KEY-----\n", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAE", "\n-----END OPENSSH ", "PRIVATE KEY-----")],
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
  ["compound aws secret", fixture("AWS_SECRET_ACCESS_KEY=", "wJalrXUtnFEMIK7MDENGbPxRfiCY")],
  ["compound private key name", fixture("private_key=", "c2VjcmV0bWF0ZXJpYWxmb3J0ZXN0")],
  ["gitlab token", fixture("Token glpat-", "abcdefghijklmnopqrst")],
  ["npm token", fixture("Token npm_", "abcdefghijklmnopqrstuvwx")],
  ["pypi token", fixture("Token pypi-", "abcdefghijklmnopqrstuvwx")],
  ["slack app token", fixture("Use xapp-", "1-A0123456789-abcdefghijkl")],
  ["bare basic auth", fixture("Basic ", "dXNlcjpwYXNzd29yZDEyMzQ1Ng==")],
  ["url credentials", fixture("https://user:", "hunter2hunter2", "@internal.example/app")],
  ["json secret assignment", fixture('{"api_key": "', "abcdefghijklmnopqrstuv", '"}')],
  ["dotted secret value", fixture("password: ab.", "cdefghijklmnopqrstuv")],
  ["stripe key", fixture("Use sk_live_", "abcdefghijklmnopqrstuvwxyz")],
  ["azure account key", fixture("AccountKey=", "abcdefghijklmnopqrstuvwxyz0123456789+/==")],
  ["basic auth header", fixture("Authorization: Basic ", "dXNlcjpwYXNzd29yZA==")],
  ["connection string", fixture("postgres://user:", "hunter2hunter2", "@db.internal:5432/app")],
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
  ["prose that names a quoted key", 'The config key "api_key" must be set in the environment, never committed.'],
  ["short json value", '{"api_key": "short"}'],
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

describe("redactSensitiveContent", () => {
  for (const [label, text] of SENSITIVE) {
    test(`redacts ${label}`, () => {
      const redacted = redactSensitiveContent(text);
      assert.match(redacted, /\[redacted\]/, label);
      // The point of redaction: what remains can no longer trip the gate.
      assert.equal(isSensitiveMemoryContent(redacted), false, label);
    });
  }

  for (const [label, text] of SAFE) {
    test(`leaves ${label} intact`, () => {
      assert.equal(redactSensitiveContent(text), text, label);
    });
  }

  test("redacts every occurrence, not just the first", () => {
    const twice = fixture("password=", "hunter2hunter2hunter2", " and backup ", "password=", "correcthorsebattery");
    const redacted = redactSensitiveContent(twice);
    assert.equal(redacted.match(/\[redacted\]/g).length, 2);
    assert.equal(isSensitiveMemoryContent(redacted), false);
  });

  test("keeps surrounding prose readable", () => {
    const key = fixture("AKIA", "IOSFODNN7EXAMPLE");
    const redacted = redactSensitiveContent(`Never commit a key like ${key} to the repo.`);
    assert.equal(redacted, "Never commit a key like [redacted] to the repo.");
  });

  test("handles empty and non-string input", () => {
    assert.equal(redactSensitiveContent(""), "");
    assert.equal(redactSensitiveContent(null), "");
    assert.equal(redactSensitiveContent(42), "42");
  });

  test("removes the whole private key body, not just the header", () => {
    const body = fixture("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAE", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo");
    const pem = fixture("-----BEGIN OPENSSH ", "PRIVATE KEY-----\n", body, "\n-----END OPENSSH ", "PRIVATE KEY-----");
    const redacted = redactSensitiveContent(pem);
    assert.equal(redacted, "[redacted]");
    assert.equal(redacted.includes(body), false, "the key material must be gone, not just the header");
  });

  test("removes the secret value, leaving the name", () => {
    const secret = "wJalrXUtnFEMIK7MDENGbPxRfiCY";
    const redacted = redactSensitiveContent(`AWS_SECRET_ACCESS_KEY=${secret} in the deploy env`);
    assert.equal(redacted.includes(secret), false);
    assert.doesNotMatch(redacted, /AWS_SECRET_ACCESS_KEY=wJalr/);
  });
});
