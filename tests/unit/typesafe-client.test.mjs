import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  TYPESAFE_API_KEY_ENV,
  TYPESAFE_KEYCHAIN_DEFAULT_SERVICE,
  resolveTypesafeApiKey,
  resolveTypesafeKeychainKey,
} from "../../lib/inference/typesafe-client.mjs";

const ENV_KEY = "env-key-should-never-appear-in-traces";
const KEYCHAIN_KEY = "keychain-key-should-never-appear-in-traces";
const CONFIG_KEY = "config-key-should-never-appear-in-traces";

function keychainConfig(apiKeyKeychain, overrides = {}) {
  return { typesafe: { enabled: true, apiKeyKeychain, ...overrides } };
}

/** An injected command runner that never touches the real `security` binary. */
function fakeRunner({ result, error, calls = [] } = {}) {
  return (service, account) => {
    calls.push({ service, account });
    if (error) {
      throw error;
    }
    return result;
  };
}

describe("resolveTypesafeKeychainKey", () => {
  test("returns empty when apiKeyKeychain is not configured", () => {
    const calls = [];
    const key = resolveTypesafeKeychainKey({ typesafe: {} }, {
      platform: "darwin",
      runCommand: fakeRunner({ result: KEYCHAIN_KEY, calls }),
    });
    assert.equal(key, "");
    assert.deepEqual(calls, []);
  });

  test("is ignored on non-darwin platforms even when configured", () => {
    const calls = [];
    const key = resolveTypesafeKeychainKey(keychainConfig(true), {
      platform: "linux",
      runCommand: fakeRunner({ result: KEYCHAIN_KEY, calls }),
    });
    assert.equal(key, "");
    assert.deepEqual(calls, []);
  });

  test("apiKeyKeychain: true uses the default service and no account", () => {
    const calls = [];
    const key = resolveTypesafeKeychainKey(keychainConfig(true), {
      platform: "darwin",
      runCommand: fakeRunner({ result: KEYCHAIN_KEY, calls }),
    });
    assert.equal(key, KEYCHAIN_KEY);
    assert.deepEqual(calls, [{ service: TYPESAFE_KEYCHAIN_DEFAULT_SERVICE, account: undefined }]);
  });

  test("apiKeyKeychain object overrides service and account", () => {
    const calls = [];
    const key = resolveTypesafeKeychainKey(
      keychainConfig({ service: "custom-service", account: "matt" }),
      { platform: "darwin", runCommand: fakeRunner({ result: KEYCHAIN_KEY, calls }) },
    );
    assert.equal(key, KEYCHAIN_KEY);
    assert.deepEqual(calls, [{ service: "custom-service", account: "matt" }]);
  });

  test("fails open when the command throws (missing entry, no `security`, timeout, ...)", () => {
    const traces = [];
    const key = resolveTypesafeKeychainKey(keychainConfig(true), {
      platform: "darwin",
      runCommand: fakeRunner({ error: new Error("security: item not found") }),
      onTrace: (reason) => traces.push(reason),
    });
    assert.equal(key, "");
    assert.equal(traces.length, 1);
    assert.match(traces[0], /^keychain_lookup_failed: security: item not found$/);
  });

  test("treats a blank result the same as not found", () => {
    const key = resolveTypesafeKeychainKey(keychainConfig(true), {
      platform: "darwin",
      runCommand: () => "  \n",
    });
    assert.equal(key, "");
  });

  test("trims the resolved key", () => {
    const key = resolveTypesafeKeychainKey(keychainConfig(true), {
      platform: "darwin",
      runCommand: () => `  ${KEYCHAIN_KEY}\n`,
    });
    assert.equal(key, KEYCHAIN_KEY);
  });

  test("an injected runner is called every time, not cached (only the default runner caches)", () => {
    const calls = [];
    const options = { platform: "darwin", runCommand: fakeRunner({ result: KEYCHAIN_KEY, calls }) };
    resolveTypesafeKeychainKey(keychainConfig(true), options);
    resolveTypesafeKeychainKey(keychainConfig(true), options);
    assert.equal(calls.length, 2);
  });
});

describe("resolveTypesafeApiKey precedence", () => {
  test("env wins over keychain and plaintext config", () => {
    const config = { typesafe: { apiKeyKeychain: true, apiKey: CONFIG_KEY } };
    const key = resolveTypesafeApiKey(config, { [TYPESAFE_API_KEY_ENV]: ENV_KEY }, {
      platform: "darwin",
      runCommand: () => KEYCHAIN_KEY,
    });
    assert.equal(key, ENV_KEY);
  });

  test("keychain wins over plaintext config when there is no env key", () => {
    const config = { typesafe: { apiKeyKeychain: true, apiKey: CONFIG_KEY } };
    const key = resolveTypesafeApiKey(config, {}, {
      platform: "darwin",
      runCommand: () => KEYCHAIN_KEY,
    });
    assert.equal(key, KEYCHAIN_KEY);
  });

  test("falls through to plaintext config when the keychain has no entry", () => {
    const config = { typesafe: { apiKeyKeychain: true, apiKey: CONFIG_KEY } };
    const key = resolveTypesafeApiKey(config, {}, {
      platform: "darwin",
      runCommand: () => { throw new Error("security: item not found"); },
    });
    assert.equal(key, CONFIG_KEY);
  });

  test("plaintext config still works with no keychain configured at all", () => {
    const config = { typesafe: { apiKey: CONFIG_KEY } };
    assert.equal(resolveTypesafeApiKey(config, {}), CONFIG_KEY);
  });

  test("resolves to empty when nothing is configured", () => {
    assert.equal(resolveTypesafeApiKey({ typesafe: {} }, {}), "");
  });
});
