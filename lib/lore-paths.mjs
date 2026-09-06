import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

// Keep harness inputs independent from Lore-owned state. Existing installs
// remain on their legacy store until the user explicitly migrates it.
export function resolveLorePaths({ env = process.env, home = os.homedir(), exists = existsSync } = {}) {
  const copilotHome = env.LORE_COPILOT_HOME?.trim() || path.join(home, ".copilot");
  const xdgHome = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdgHome && path.isAbsolute(xdgHome) ? xdgHome : path.join(home, ".config");
  const explicitHome = env.LORE_HOME?.trim();
  const preferredHome = explicitHome || path.join(configHome, "lore");
  const legacy = !explicitHome && !exists(preferredHome)
    && ["lore.json", "lore.db"].some((name) => exists(path.join(copilotHome, name)));
  const loreHome = legacy ? copilotHome : preferredHome;
  return {
    loreHome,
    copilotHome,
    configPath: env.LORE_CONFIG?.trim() || path.join(loreHome, "lore.json"),
    derivedStorePath: path.join(loreHome, "lore.db"),
    backupDir: legacy ? path.join(loreHome, "backups", "lore") : path.join(loreHome, "backups"),
    legacy,
  };
}
