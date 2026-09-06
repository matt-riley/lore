import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access, rm, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";

import { migrateLoreHome } from "../../scripts/migrate-home.mjs";

const execFileAsync = promisify(execFile);
const tempDirs = [];

async function fixture({ config = {}, withDatabase = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lore-migrate-test-"));
  tempDirs.push(root);
  const sourceDir = path.join(root, "legacy");
  const targetDir = path.join(root, "new", "lore");
  await mkdir(path.join(sourceDir, "backups", "lore"), { recursive: true });
  await writeFile(path.join(sourceDir, "lore.json"), JSON.stringify(config, null, 2));
  await writeFile(path.join(sourceDir, "backups", "lore", "snapshot.txt"), "backup");
  await writeFile(path.join(sourceDir, "lore.db.pi-archive-cursor.json"), "{\"offset\":7}\n");
  if (withDatabase) {
    const db = new DatabaseSync(path.join(sourceDir, "lore.db"));
    db.exec("CREATE TABLE memories (content TEXT); INSERT INTO memories VALUES ('preserve me');");
    db.close();
  }
  return { root, sourceDir, targetDir };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("migrateLoreHome", () => {
  test("moves default config and creates a safe readable database snapshot", async () => {
    const { sourceDir, targetDir } = await fixture({
      config: {
        enabled: true,
        paths: {
          rawStorePath: "/Users/example/.copilot/session-store.db",
          instructionsPath: "/Users/example/.copilot/copilot-instructions.md",
        },
      },
    });

    await migrateLoreHome({ sourceDir, targetDir });

    const migrated = JSON.parse(await readFile(path.join(targetDir, "lore.json"), "utf8"));
    assert.equal(migrated.enabled, true);
    assert.equal(migrated.paths.derivedStorePath, path.join(targetDir, "lore.db"));
    assert.equal(migrated.paths.backupDir, path.join(targetDir, "backups"));
    assert.equal(migrated.paths.copilotHome, sourceDir);
    assert.equal(migrated.paths.scopedInstructionsDir, path.join(sourceDir, "instructions"));
    assert.equal(migrated.paths.rawStorePath, "/Users/example/.copilot/session-store.db");
    assert.equal(migrated.paths.instructionsPath, "/Users/example/.copilot/copilot-instructions.md");
    const migratedDb = new DatabaseSync(path.join(targetDir, "lore.db"));
    assert.equal(migratedDb.prepare("SELECT content FROM memories").get().content, "preserve me");
    migratedDb.close();
    assert.equal(await readFile(path.join(targetDir, "backups", "snapshot.txt"), "utf8"), "backup");
    assert.equal(await readFile(path.join(targetDir, "lore.db.pi-archive-cursor.json"), "utf8"), "{\"offset\":7}\n");
  });

  test("retains explicit database and backup overrides without copying unused defaults", async () => {
    const { root, sourceDir, targetDir } = await fixture();
    await writeFile(path.join(sourceDir, "lore.json"), JSON.stringify({
      paths: {
        derivedStorePath: path.join(root, "elsewhere.db"),
        backupDir: path.join(root, "elsewhere-backups"),
        rawStorePath: path.join(sourceDir, "session-store.db"),
        instructionsPath: path.join(sourceDir, "copilot-instructions.md"),
      },
    }));

    await migrateLoreHome({ sourceDir, targetDir });

    const migrated = JSON.parse(await readFile(path.join(targetDir, "lore.json"), "utf8"));
    assert.equal(migrated.paths.derivedStorePath, path.join(root, "elsewhere.db"));
    assert.equal(migrated.paths.backupDir, path.join(root, "elsewhere-backups"));
    await assert.rejects(access(path.join(targetDir, "lore.db")));
    await assert.rejects(access(path.join(targetDir, "backups")));
  });

  test("does not overwrite an existing target or alter the source", async () => {
    const { sourceDir, targetDir } = await fixture();
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, "sentinel"), "keep");
    const sourceConfig = await readFile(path.join(sourceDir, "lore.json"), "utf8");

    await assert.rejects(migrateLoreHome({ sourceDir, targetDir }), /target already exists/i);
    assert.equal(await readFile(path.join(targetDir, "sentinel"), "utf8"), "keep");
    assert.equal(await readFile(path.join(sourceDir, "lore.json"), "utf8"), sourceConfig);
  });

  test("rejects a missing source before creating a target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lore-migrate-test-"));
    tempDirs.push(root);
    const sourceDir = path.join(root, "missing");
    const targetDir = path.join(root, "target");
    await assert.rejects(migrateLoreHome({ sourceDir, targetDir }), /source does not exist/i);
    await assert.rejects(access(targetDir));
  });

  test("supports config-only and database-only legacy homes", async () => {
    const configOnly = await fixture({ withDatabase: false });
    const configResult = await migrateLoreHome(configOnly);
    assert.equal(configResult.copiedDatabase, false);
    await assert.rejects(access(path.join(configOnly.targetDir, "lore.db")));

    const databaseOnly = await fixture();
    await rm(path.join(databaseOnly.sourceDir, "lore.json"));
    const databaseResult = await migrateLoreHome(databaseOnly);
    assert.equal(databaseResult.copiedDatabase, true);
    const databaseOnlyDb = new DatabaseSync(path.join(databaseOnly.targetDir, "lore.db"));
    assert.equal(databaseOnlyDb.prepare("SELECT count(*) AS count FROM memories").get().count, 1);
    databaseOnlyDb.close();
  });

  test("cleans the staged target when config or database copying fails", async () => {
    const { sourceDir, targetDir } = await fixture();
    await writeFile(path.join(sourceDir, "lore.db"), "not sqlite");
    await assert.rejects(migrateLoreHome({ sourceDir, targetDir }), /sqlite|database/i);
    await assert.rejects(access(targetDir));
    const siblings = await readdir(path.dirname(targetDir));
    assert.equal(siblings.some((name) => name.startsWith(`.${path.basename(targetDir)}.migration-`)), false);
  });

  test("accepts a source without backups or a cursor", async () => {
    const { sourceDir, targetDir } = await fixture();
    await rm(path.join(sourceDir, "backups"), { recursive: true });
    await rm(path.join(sourceDir, "lore.db.pi-archive-cursor.json"));
    const result = await migrateLoreHome({ sourceDir, targetDir });
    assert.equal(result.copiedBackups, false);
    await assert.rejects(access(path.join(targetDir, "backups")));
  });

  test("rejects malformed config without creating a target", async () => {
    const { sourceDir, targetDir } = await fixture({ withDatabase: false });
    await writeFile(path.join(sourceDir, "lore.json"), "[]");
    await assert.rejects(migrateLoreHome({ sourceDir, targetDir }), /JSON object/i);
    await assert.rejects(access(targetDir));
  });

  test("rejects symlinks in backups without touching the linked file", async () => {
    const { root, sourceDir, targetDir } = await fixture();
    const linked = path.join(root, "outside.txt");
    await writeFile(linked, "outside");
    await symlink(linked, path.join(sourceDir, "backups", "lore", "linked.txt"));
    await assert.rejects(migrateLoreHome({ sourceDir, targetDir }), /symlink/i);
    assert.equal(await readFile(linked, "utf8"), "outside");
    await assert.rejects(access(targetDir));
  });

  test("snapshots a database while another handle is open", async () => {
    const { sourceDir, targetDir } = await fixture();
    const openHandle = new DatabaseSync(path.join(sourceDir, "lore.db"));
    const result = await migrateLoreHome({ sourceDir, targetDir });
    openHandle.close();
    assert.equal(result.copiedDatabase, true);
    const migratedDb = new DatabaseSync(path.join(targetDir, "lore.db"));
    assert.equal(migratedDb.prepare("SELECT content FROM memories").get().content, "preserve me");
    migratedDb.close();
  });

  test("CLI uses environment defaults and reports the migrated destination", async () => {
    const { sourceDir, targetDir } = await fixture({ withDatabase: false });
    const result = await execFileAsync(process.execPath, ["scripts/migrate-home.mjs"], {
      cwd: path.resolve("."),
      env: { ...process.env, LORE_COPILOT_HOME: sourceDir, LORE_HOME: targetDir },
    });
    assert.ok(result.stdout.includes(`Migrated Lore home to ${targetDir}`));
    assert.match(result.stdout, /Original files were retained/);
    await access(path.join(sourceDir, "lore.json"));
    await access(path.join(targetDir, "lore.json"));
  });

  test("supports CLI help", async () => {
    await fixture();
    const result = await execFileAsync(process.execPath, ["scripts/migrate-home.mjs", "--help"], { cwd: path.resolve(".") });
    assert.match(result.stdout, /Usage:.*migrate-home/i);
    assert.match(result.stdout, /--from/);
    assert.match(result.stdout, /--to/);
  });
});
