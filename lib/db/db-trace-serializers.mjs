import { MEMORY_SCOPE } from "../memory/memory-scope.mjs";
import { parseJsonArray } from "../utils/json-array-utils.mjs";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { isCrossRepoRow } from "./db-temporal.mjs";

export function serializeEpisodeTraceRow(episode, currentRepository = null) {
  return {
    id: episode.id ?? null,
    sessionId: episode.session_id ?? null,
    scope: episode.scope ?? null,
    scopeSource: episode.scope_source ?? null,
    repository: episode.repository ?? null,
    updatedAt: episode.updated_at ?? null,
    dateKey: episode.date_key ?? null,
    significance: episode.significance ?? 0,
    crossRepo: isCrossRepoRow(episode, currentRepository),
    summary: normalizeText(episode.summary),
    decisions: parseJsonArray(episode.decisions_json).map(normalizeText).filter(Boolean).slice(0, 6),
    actions: parseJsonArray(episode.actions_json).map(normalizeText).filter(Boolean).slice(0, 6),
    openItems: parseJsonArray(episode.open_items_json).map(normalizeText).filter(Boolean).slice(0, 6),
    themes: parseJsonArray(episode.themes_json).map(normalizeText).filter(Boolean).slice(0, 6),
  };
}

export function buildLocalEligibility(repository) {
  if (repository) {
    return [MEMORY_SCOPE.GLOBAL, `${MEMORY_SCOPE.REPO}:${repository}`];
  }
  return [MEMORY_SCOPE.GLOBAL];
}
