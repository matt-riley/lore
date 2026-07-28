import { normalizeBoolean } from "./config.mjs";

export function readRolloutBoolean(config, key, fallback) {
  return normalizeBoolean(config?.rollout?.[key], fallback);
}

export function createRolloutBooleanReader(key, fallback, parentReader = null) {
  return (config) => (parentReader?.(config) ?? true)
    && readRolloutBoolean(config, key, fallback);
}
