import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const dbModule = new URL("../../lib/db.mjs", import.meta.url).href;
for (const kind of ["default", "explicit", "custom-parent", "legacy", "symlink"]) {
  test(`opening a database tightens only its dedicated Lore home (${kind})`, { skip: !FTS5_AVAILABLE }, () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "lore-home-permissions-"));
    try {
      const preferred = path.join(home, ".config", "lore");
      const directory = kind === "default" || kind === "symlink" ? preferred
        : kind === "legacy" ? path.join(home, ".copilot") : path.join(home, "storage");
      const physical = kind === "symlink" ? path.join(home, "shared") : directory;
      mkdirSync(physical, { recursive: true });
      chmodSync(physical, 0o755);
      if (kind === "symlink") {
        mkdirSync(path.dirname(preferred), { recursive: true });
        symlinkSync(physical, preferred);
      }
      if (kind === "legacy") writeFileSync(path.join(directory, "lore.json"), "{}");
      const script = `import { LoreDb } from ${JSON.stringify(dbModule)};
const db = new LoreDb({ paths: { derivedStorePath: process.argv[1], backupDir: process.argv[2] } });
try { db.initialize(); } finally { db.close(); }`;
      execFileSync(process.execPath, ["--input-type=module", "-e", script, path.join(directory, "lore.db"), path.join(directory, "backups")], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), LORE_HOME: kind === "explicit" ? directory : "", LORE_COPILOT_HOME: path.join(home, ".copilot"), LORE_CONFIG: "" },
        stdio: "pipe",
      });
      assert.equal(statSync(physical).mode & 0o777, ["default", "explicit"].includes(kind) ? 0o700 : 0o755);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
