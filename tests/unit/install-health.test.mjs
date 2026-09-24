import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectInstallHealthSignals, isExecutable } from "../../lib/maintenance/install-health.mjs";
import { planSetup, applySetup } from "../../lib/clients/setup.mjs";

test("no manifest on disk yields an empty, error-free report", () => {
  const loreHome = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-empty-"));
  try {
    const report = collectInstallHealthSignals({ loreHome, env: {}, home: loreHome, cwd: loreHome });
    assert.equal(report.manifestError, null);
    assert.deepEqual(report.clients, []);
    assert.deepEqual(report.duplicates, []);
  } finally { rmSync(loreHome, { recursive: true, force: true }); }
});

test("a malformed manifest is reported, not thrown", () => {
  const loreHome = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-malformed-"));
  try {
    writeFileSync(path.join(loreHome, "install-manifest.json"), "not json");
    const report = collectInstallHealthSignals({ loreHome, env: {}, home: loreHome, cwd: loreHome });
    assert.match(report.manifestError, /could not be parsed/);
    assert.deepEqual(report.clients, []);
  } finally { rmSync(loreHome, { recursive: true, force: true }); }
});

test("a manifest that isn't a Lore manifest shape is reported, not thrown", () => {
  const loreHome = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-shape-"));
  try {
    writeFileSync(path.join(loreHome, "install-manifest.json"), JSON.stringify({ hello: "world" }));
    const report = collectInstallHealthSignals({ loreHome, env: {}, home: loreHome, cwd: loreHome });
    assert.match(report.manifestError, /does not look like a Lore install manifest/);
  } finally { rmSync(loreHome, { recursive: true, force: true }); }
});

test("a real install's hook command is discovered and parsed", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-real-"));
  try {
    const env = { HOME: home };
    applySetup(planSetup(["codex"], { home, env, node: "/usr/bin/node" }));
    const loreHome = path.join(home, ".config", "lore");
    const report = collectInstallHealthSignals({ loreHome, env, home, cwd: home });
    assert.equal(report.manifestError, null);
    assert.equal(report.clients.length, 1);
    const [codex] = report.clients;
    assert.equal(codex.client, "codex");
    assert.equal(codex.missing, false);
    assert.equal(codex.error, null);
    assert.ok(codex.commands.length > 0, "expected at least one parsed hook command");
    for (const { parsed } of codex.commands) {
      assert.equal(parsed.nodePath, "/usr/bin/node");
      assert.match(parsed.entryPath, /lore-cli\.mjs$/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("an unreadable/malformed hook file is reported per-client, not thrown", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-hookfile-"));
  try {
    const env = { HOME: home };
    applySetup(planSetup(["codex"], { home, env, node: "/usr/bin/node" }));
    writeFileSync(path.join(home, ".codex", "hooks.json"), "{ not valid json");
    const loreHome = path.join(home, ".config", "lore");
    const report = collectInstallHealthSignals({ loreHome, env, home, cwd: home });
    assert.equal(report.clients.length, 1);
    assert.ok(report.clients[0].error, "expected a parse error to be reported");
    assert.deepEqual(report.clients[0].commands, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("recorded install with the settings file since deleted is reported as missing, not thrown", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-missing-"));
  try {
    const env = { HOME: home };
    applySetup(planSetup(["claude"], { home, env, node: "/usr/bin/node" }));
    rmSync(path.join(home, ".claude", "settings.json"));
    const loreHome = path.join(home, ".config", "lore");
    const report = collectInstallHealthSignals({ loreHome, env, home, cwd: home });
    assert.equal(report.clients[0].missing, true);
    assert.equal(report.clients[0].error, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("detects a duplicate project-scope install alongside the recorded global one", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-dup-"));
  const project = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-project-"));
  try {
    const env = { HOME: home };
    applySetup(planSetup(["codex"], { home, env, node: "/usr/bin/node" }));
    mkdirSync(path.join(project, ".codex"), { recursive: true });
    writeFileSync(path.join(project, ".codex", "hooks.json"), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "'/usr/bin/node' '/some/lore-cli.mjs' hook codex SessionStart" }] }] },
    }));
    const loreHome = path.join(home, ".config", "lore");
    const report = collectInstallHealthSignals({ loreHome, env, home, cwd: project });
    assert.equal(report.duplicates.length, 1);
    assert.equal(report.duplicates[0].client, "codex");
    assert.equal(report.duplicates[0].projectTarget, path.join(project, ".codex", "hooks.json"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("no duplicate is reported when the project IS the recorded global target", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-nodup-"));
  try {
    const env = { HOME: home, CODEX_HOME: path.join(home, ".codex") };
    applySetup(planSetup(["codex"], { home, env, node: "/usr/bin/node" }));
    const loreHome = path.join(home, ".config", "lore");
    // cwd happens to be `home`, so the project-scope target (<home>/.codex/hooks.json)
    // IS the global target; that must not count as a duplicate.
    const report = collectInstallHealthSignals({ loreHome, env, home, cwd: home });
    assert.deepEqual(report.duplicates, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("isExecutable reflects real filesystem executability", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-install-health-exec-"));
  try {
    assert.equal(isExecutable(path.join(home, "does-not-exist")), false);
    assert.equal(isExecutable(process.execPath), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
