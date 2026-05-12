import { normalizeBoolean } from "./config.mjs";

export function readRolloutBoolean(config, key, fallback) {
  return normalizeBoolean(config?.rollout?.[key], fallback);
}
