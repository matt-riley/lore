import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLorePaths } from "../../lib/lore-paths.mjs";

function resolve(env = {}, files = []) {
  return resolveLorePaths({ env, home: "/users/test", exists: (p) => files.includes(p) });
}

test("fresh defaults separate Lore storage from Copilot inputs", () => {
  const paths = resolve();
  assert.equal(paths.loreHome, "/users/test/.config/lore");
  assert.equal(paths.configPath, "/users/test/.config/lore/lore.json");
  assert.equal(paths.derivedStorePath, "/users/test/.config/lore/lore.db");
  assert.equal(paths.backupDir, "/users/test/.config/lore/backups");
  assert.equal(paths.copilotHome, "/users/test/.copilot");
  assert.equal(paths.legacy, false);
});

test("absolute XDG_CONFIG_HOME and explicit LORE_HOME take precedence", () => {
  assert.equal(resolve({ XDG_CONFIG_HOME: "/config" }).loreHome, "/config/lore");
  assert.equal(resolve({ XDG_CONFIG_HOME: "relative" }).loreHome, "/users/test/.config/lore");
  const paths = resolve({ XDG_CONFIG_HOME: "/config", LORE_HOME: "/lore", LORE_CONFIG: "/custom/settings.json", LORE_COPILOT_HOME: "/copilot" });
  assert.equal(paths.loreHome, "/lore");
  assert.equal(paths.configPath, "/custom/settings.json");
  assert.equal(paths.derivedStorePath, "/lore/lore.db");
  assert.equal(paths.copilotHome, "/copilot");
});

test("legacy config or database retains the entire old storage layout", () => {
  for (const file of ["lore.json", "lore.db"]) {
    const paths = resolve({}, [`/users/test/.copilot/${file}`]);
    assert.equal(paths.loreHome, "/users/test/.copilot");
    assert.equal(paths.backupDir, "/users/test/.copilot/backups/lore");
    assert.equal(paths.legacy, true);
  }
  assert.equal(resolve({ LORE_COPILOT_HOME: "/old" }, ["/old/lore.db"]).configPath, "/old/lore.json");
});

test("new home or explicit Lore override prevents legacy fallback", () => {
  assert.equal(resolve({}, ["/users/test/.config/lore", "/users/test/.copilot/lore.db"]).legacy, false);
  assert.equal(resolve({ LORE_HOME: "/new" }, ["/users/test/.copilot/lore.db"]).loreHome, "/new");
});

test("Copilot override alone does not relocate a fresh Lore store", () => {
  assert.equal(resolve({ LORE_COPILOT_HOME: "/copilot" }).derivedStorePath, "/users/test/.config/lore/lore.db");
});
