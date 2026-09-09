import { classifyEpisodeDigest, MEMORY_SCOPE } from "../memory/memory-scope.mjs";
import { parseJsonObject } from "../utils/json-object-utils.mjs";
import { jsonText } from "../utils/json-text-utils.mjs";
import { normalizeRepository } from "../utils/repository-utils.mjs";
import { buildFtsOrRetryQuery, normalizeFtsToken, QUERY_ALIASES, sanitizeFtsQuery as sanitizeNormalizedFtsQuery } from "../utils/query-normalizer.mjs";
import { normalizeText } from "../utils/text-normalizer.mjs";
import { buildEpisodeQueryTermsets, buildTermWeights, explainEpisodeExclusionReason, isGenericWorkSummary, isPlaceholderSummary, isToolInvocationSummary, scoreAndRankEpisodeCandidates } from "./db-episode-scoring.mjs";
import { buildImprovementArtifactEpisode, IMPROVEMENT_SOURCE_KIND, IMPROVEMENT_STATUS } from "./db-improvement-artifacts.mjs";
import { buildSemanticEligibilitySql, isSemanticMemoryRowEligible } from "./db-retrieval-policy.mjs";
import { nowIso, SCOPE_SOURCE, applyScopeFilter } from "./db-shared.mjs";
import { serializeEpisodeTraceRow, buildLocalEligibility } from "./db-trace-serializers.mjs";

export function dedupeSemanticRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.type}::${normalizeText(row.content).toLowerCase()}::${row.scope ?? MEMORY_SCOPE.REPO}::${row.repository ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

export function normalizeDaySummaryRepository(repository) {
  return normalizeRepository(repository) ?? "";
}

export function dedupeEpisodesWithTrace(episodes, currentRepository = null) {
  const seenSummaries = new Set();
  const seenSessions = new Set();
  const deduped = [];
  const filtered = [];

  for (const episode of episodes) {
    if (seenSessions.has(episode.session_id)) {
      filtered.push({
        stage: "dedupe",
        reason: "duplicate_session",
        row: serializeEpisodeTraceRow(episode, currentRepository),
      });
      continue;
    }
    const summaryKey = normalizeText(episode.summary).toLowerCase();
    if (summaryKey && seenSummaries.has(summaryKey)) {
      filtered.push({
        stage: "dedupe",
        reason: "duplicate_summary",
        row: serializeEpisodeTraceRow(episode, currentRepository),
      });
      continue;
    }
    seenSessions.add(episode.session_id);
    if (summaryKey) {
      seenSummaries.add(summaryKey);
    }
    deduped.push(episode);
  }

  return {
    rows: deduped,
    filtered,
  };
}

export function filterEpisodePoolWithTrace(pool, stageName, repository) {
  const included = [];
  const filtered = [];
  for (const episode of pool) {
    const reason = explainEpisodeExclusionReason(episode);
    if (!reason) {
      included.push(episode);
    } else {
      filtered.push({ stage: stageName, reason, row: serializeEpisodeTraceRow(episode, repository) });
    }
  }
  return { included, filtered };
}

export function separateGenericEpisodes(ordered, repository) {
  const hasNonGeneric = ordered.some((episode) => !isGenericWorkSummary(episode.summary));
  const genericFiltered = hasNonGeneric
    ? ordered
      .filter((episode) => isGenericWorkSummary(episode.summary))
      .map((episode) => ({
        stage: "preference",
        reason: "generic_work_summary",
        row: serializeEpisodeTraceRow(episode, repository),
      }))
    : [];
  const preferred = hasNonGeneric
    ? ordered.filter((episode) => !isGenericWorkSummary(episode.summary))
    : ordered;
  return { preferred, genericFiltered };
}

export function hasEpisodeDigest(owner, sessionId) {
  owner.ensureOpen();
  const row = owner.db.prepare(`
    SELECT id FROM episode_digest WHERE session_id = ?
  `).get(sessionId);
  return !!row;
}

export function upsertEpisodeDigest(owner, digest) {
  owner.ensureOpen();
  const timestamp = nowIso();
  const classification = classifyEpisodeDigest(digest);
  owner.db.prepare(`
    INSERT INTO episode_digest (
      id, session_id, scope, scope_source, repository, branch, summary, actions_json, decisions_json,
      learnings_json, files_changed_json, refs_json, significance, themes_json,
      open_items_json, source, date_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      scope = CASE
        WHEN episode_digest.scope_source = 'manual' THEN episode_digest.scope
        ELSE excluded.scope
      END,
      repository = CASE
        WHEN episode_digest.scope_source = 'manual' THEN episode_digest.repository
        ELSE excluded.repository
      END,
      branch = excluded.branch,
      summary = excluded.summary,
      actions_json = excluded.actions_json,
      decisions_json = excluded.decisions_json,
      learnings_json = excluded.learnings_json,
      files_changed_json = excluded.files_changed_json,
      refs_json = excluded.refs_json,
      significance = excluded.significance,
      themes_json = excluded.themes_json,
      open_items_json = excluded.open_items_json,
      source = excluded.source,
      date_key = excluded.date_key,
      updated_at = excluded.updated_at
  `).run(
    digest.id ?? digest.sessionId,
    digest.sessionId,
    classification.scope,
    SCOPE_SOURCE.AUTO,
    classification.repository,
    digest.branch ?? null,
    digest.summary,
    jsonText(digest.actions),
    jsonText(digest.decisions),
    jsonText(digest.learnings),
    jsonText(digest.filesChanged),
    jsonText(digest.refs),
    digest.significance ?? 5,
    jsonText(digest.themes),
    jsonText(digest.openItems),
    digest.source ?? "rule",
    digest.dateKey,
    digest.createdAt ?? timestamp,
    timestamp,
  );
}

export function refreshDaySummary(owner, { date, repository }) {
  owner.ensureOpen();
  const repo = normalizeDaySummaryRepository(repository);
  const rows = owner.db.prepare(`
    SELECT session_id, summary
    FROM episode_digest
    WHERE date_key = ? AND (
      (? = '' AND (repository IS NULL OR repository = '')) OR repository = ?
    )
    ORDER BY updated_at DESC
    LIMIT 8
  `).all(date, repo, repo);

  const summaries = rows
    .map((row) => ({
      session_id: row.session_id,
      summary: normalizeText(row.summary),
    }))
    .filter((row) => row.summary.length > 0);

  const preferred = summaries.some((row) => !isGenericWorkSummary(row.summary) && !isPlaceholderSummary(row.summary) && !isToolInvocationSummary(row.summary))
    ? summaries.filter((row) => !isGenericWorkSummary(row.summary) && !isPlaceholderSummary(row.summary) && !isToolInvocationSummary(row.summary))
    : summaries;

  const summary = preferred.length === 0
    ? "No remembered activity."
    : preferred.map((row) => `- ${row.summary}`).join("\n");

  owner.db.prepare(`
    INSERT INTO day_summary (date_key, repository, summary, episode_ids_json, computed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date_key, repository) DO UPDATE SET
      summary = excluded.summary,
      episode_ids_json = excluded.episode_ids_json,
      computed_at = excluded.computed_at
  `).run(
    date,
    repo,
    summary,
    JSON.stringify(preferred.map((row) => row.session_id)),
    nowIso(),
  );
}

export function mapRetrievalRepositories(owner, rows, repository) {
  if (!repository || rows.length === 0) return rows;
  const aliases = new Set(owner.db.prepare("SELECT legacy FROM repository_identity_mapping WHERE canonical = ?")
    .all(repository).map((row) => row.legacy));
  return rows.map((row) => aliases.has(row.repository)
    ? { ...row, sourceRepository: row.repository, repository }
    : row);
}

export function searchSemantic(owner, {
  query,
  repository,
  includeOtherRepositories = false,
  types = [],
  scopes = [],
  limit = 8,
  includeTypedFallback = false,
  expandAliases = true,
  standingExtractorPolicy = false,
  now = new Date(),
}) {
  owner.ensureOpen();
  const sanitized = sanitizeNormalizedFtsQuery(query, {
    aliases: expandAliases ? QUERY_ALIASES : {},
    normalize: normalizeFtsToken,
  });
  const repo = normalizeRepository(repository);
  const runSearch = (ftsQuery, effectiveLimit = limit, excludedIds = []) => {
    const pageSize = Math.max(64, Math.min(256, Math.max(effectiveLimit, 8) * 8));
    const collected = [];
    for (let offset = 0; ; offset += pageSize) {
      const params = [];
      let sql = `
      SELECT
        sm.id,
        sm.type,
        sm.content,
        sm.scope,
        sm.scope_source,
        sm.confidence,
        sm.repository,
        sm.domain_key,
        sm.updated_at,
        sm.source_session_id,
        sm.canonical_key,
        sm.superseded_by,
        sm.reinforcement_count,
        sm.last_seen_at,
        sm.expires_at,
        sm.tags,
        sm.metadata_json
      FROM semantic_memory sm
      `;

      if (ftsQuery) {
        sql += ` JOIN semantic_fts ON semantic_fts.rowid = sm.rowid `;
      }

      const eligibility = buildSemanticEligibilitySql({
      alias: "sm",
      repository: repo,
      includeOtherRepositories,
      now,
      });
      sql += ` WHERE ${eligibility.sql} `;
      params.push(...eligibility.params);

      if (types.length > 0) {
      sql += ` AND sm.type IN (${types.map(() => "?").join(", ")}) `;
      params.push(...types);
      }

      if (scopes.length > 0) {
      sql += ` AND sm.scope IN (${scopes.map(() => "?").join(", ")}) `;
      params.push(...scopes);
      }

      if (standingExtractorPolicy) {
      sql += ` AND COALESCE(json_extract(sm.metadata_json, '$.source'), '') = 'rule_extractor'
        AND (
          COALESCE(json_extract(sm.metadata_json, '$.confidenceBasis'), '') IN ('explicit_preference_sentence', 'standing_policy_sentence')
          OR instr(' ' || lower(COALESCE(sm.tags, '')) || ' ', ' preference ') > 0
          OR instr(' ' || lower(COALESCE(sm.tags, '')) || ' ', ' policy ') > 0
        ) `;
      }

      if (excludedIds.length > 0) {
      sql += ` AND sm.id NOT IN (${excludedIds.map(() => "?").join(", ")}) `;
      params.push(...excludedIds);
      }

      if (ftsQuery) {
      sql += ` AND semantic_fts MATCH ? `;
      params.push(ftsQuery);
      sql += ` ORDER BY bm25(semantic_fts), sm.updated_at DESC, sm.reinforcement_count DESC `;
      } else {
      sql += ` ORDER BY sm.updated_at DESC, sm.reinforcement_count DESC `;
      }

      params.push(pageSize, offset);
      const page = owner.mapRetrievalRepositories(owner.db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params), repo);
      collected.push(...page.filter((row) => isSemanticMemoryRowEligible(row, {
        repository: repo,
        includeOtherRepositories,
        now,
      }).eligible));
      if (collected.length >= effectiveLimit || page.length < pageSize) break;
    }
    return collected.slice(0, effectiveLimit);
  };

  let lexicalRows = runSearch(sanitized);
  if (sanitized && lexicalRows.length === 0) {
    const orQuery = buildFtsOrRetryQuery(query);
    if (orQuery && orQuery !== sanitized) {
      lexicalRows = runSearch(orQuery);
    }
  }
  const shouldRunTypedFallback = includeTypedFallback
    && types.length > 0
    && sanitized
    && lexicalRows.length < limit;
  const lexicalIds = lexicalRows.map((row) => row.id).filter(Boolean);
  const fallbackRows = shouldRunTypedFallback
    ? runSearch("", Math.max(1, limit - lexicalRows.length), lexicalIds)
    : [];
  const rows = fallbackRows.length > 0
    ? dedupeSemanticRows([...lexicalRows, ...fallbackRows])
    : lexicalRows;

  const eligibleRows = rows.filter((row) => isSemanticMemoryRowEligible(row, {
    repository: repo,
    includeOtherRepositories,
    now,
  }).eligible);
  return dedupeSemanticRows(eligibleRows).slice(0, limit)
    .map((row) => ({
      ...row,
      domainKey: row.domain_key ?? null,
      metadata: parseJsonObject(row.metadata_json),
    }));
}

export function searchEpisodes(owner, { query, repository, includeOtherRepositories = false, scopes = [], limit = 5 }) {
  owner.ensureOpen();
  const sanitized = sanitizeNormalizedFtsQuery(query, {
    aliases: QUERY_ALIASES,
    normalize: normalizeFtsToken,
  });
  const repo = normalizeRepository(repository);
  const params = [];
  let sql = `
    SELECT
      ed.id,
      ed.session_id,
      ed.scope,
      ed.scope_source,
      ed.repository,
      ed.summary,
      ed.actions_json,
      ed.decisions_json,
      ed.files_changed_json,
      ed.themes_json,
      ed.open_items_json,
      ed.significance,
      ed.date_key,
      ed.updated_at
    FROM episode_digest ed
  `;

  if (sanitized) {
    sql += ` JOIN episode_fts ON episode_fts.rowid = ed.rowid `;
  }

  sql += ` WHERE 1 = 1 `;

  sql = applyScopeFilter(sql, params, repo, includeOtherRepositories, "ed");

  if (scopes.length > 0) {
    sql += ` AND ed.scope IN (${scopes.map(() => "?").join(", ")}) `;
    params.push(...scopes);
  }

  if (sanitized) {
    sql += ` AND episode_fts MATCH ? `;
    params.push(sanitized);
    sql += ` ORDER BY bm25(episode_fts), ed.significance DESC, ed.updated_at DESC `;
  } else {
    sql += ` ORDER BY ed.updated_at DESC, ed.significance DESC `;
  }

  sql += ` LIMIT ? `;
  params.push(limit);
  return owner.mapRetrievalRepositories(owner.db.prepare(sql).all(...params), repo);
}

export function findRelevantEpisodesDetailed(owner, { prompt, repository, includeOtherRepositories = false, scopes = [], limit = 5 }) {
  const { entityTerms, hybridEnabled, effectivePrimaryTerms, effectiveTerms, lexicalQuery } =
    buildEpisodeQueryTermsets(prompt, owner.config);
  const improvementRows = owner.listImprovementArtifacts({
    sourceKind: IMPROVEMENT_SOURCE_KIND.REPLAY,
    status: IMPROVEMENT_STATUS.ACTIVE,
    limit: Math.max(limit * 3, 12),
  });
  const improvementEpisodes = improvementRows
    .filter((artifact) => {
      const evidence = parseJsonObject(artifact.evidence_json);
      return evidence.caseType === "ranking_target";
    })
    .map((artifact) => buildImprovementArtifactEpisode(artifact, repository))
    .filter(Boolean);
  const rawExactMatches = owner.searchEpisodes({
    query: lexicalQuery, repository, includeOtherRepositories, scopes, limit: Math.max(limit * 2, 8),
  });
  const { included: exactMatches, filtered: exactFiltered } =
    filterEpisodePoolWithTrace([...rawExactMatches, ...improvementEpisodes], "exact_matches", repository);

  const seen = new Set(exactMatches.map((episode) => episode.session_id));
  const rawFallbackPool = owner.searchEpisodes({
    query: "", repository, includeOtherRepositories, scopes, limit: Math.max(limit * 8, 24),
  });
  const { included: fallbackPool, filtered: fallbackFiltered } =
    filterEpisodePoolWithTrace([...rawFallbackPool, ...improvementEpisodes], "fallback_pool", repository);

  const deduped = dedupeEpisodesWithTrace([...exactMatches, ...fallbackPool], repository);
  const candidatePool = deduped.rows;
  const exactMatchIds = new Set(exactMatches.map((episode) => episode.session_id));
  const termWeights = buildTermWeights(candidatePool, effectiveTerms);

  // Build rank maps for RRF fusion: preserve the FTS (BM25) order and the recency order
  // so the final scoring blends both signals rather than discarding FTS rank.
  const ftsRankMap = hybridEnabled
    ? new Map(rawExactMatches.map((ep, i) => [ep.session_id, i]))
    : new Map();
  const recencyRankMap = hybridEnabled
    ? new Map(rawFallbackPool.map((ep, i) => [ep.session_id, i]))
    : new Map();
  const ranked = scoreAndRankEpisodeCandidates({
    candidatePool, seen, exactMatchIds, effectiveTerms, effectivePrimaryTerms, termWeights,
    hybridEnabled, ftsRankMap, recencyRankMap,
    ftsMissRank: rawExactMatches.length, recencyMissRank: rawFallbackPool.length,
  });

  const ordered = ranked.map((entry) => entry.episode);
  const { preferred, genericFiltered } = separateGenericEpisodes(ordered, repository);
  const includedRows = preferred.slice(0, limit);
  return {
    episodes: includedRows,
    trace: {
      prompt,
      repository,
      includeOtherRepositories,
      eligibleScopes: scopes.length > 0 ? [...scopes] : buildLocalEligibility(repository),
      primaryTerms: effectivePrimaryTerms,
      entityTerms: hybridEnabled ? entityTerms : [],
      hybridEnabled,
      terms: effectiveTerms,
      lexicalQuery,
      rankedRows: ranked
        .slice(0, Math.max(limit * 3, 12))
        .map((entry) => ({
          ...serializeEpisodeTraceRow(entry.episode, repository),
          score: Number(entry.score.toFixed(2)),
        })),
      includedRows: includedRows.map((episode) => serializeEpisodeTraceRow(episode, repository)),
      filtered: [
        ...exactFiltered,
        ...fallbackFiltered,
        ...deduped.filtered,
        ...genericFiltered,
      ],
    },
  };
}

export function findRelevantEpisodes(owner, { prompt, repository, includeOtherRepositories = false, scopes = [], limit = 5 }) {
  return owner.findRelevantEpisodesDetailed({
    prompt,
    repository,
    includeOtherRepositories,
    scopes,
    limit,
  }).episodes;
}

export function getDaySummary(owner, { date, repository }) {
  owner.ensureOpen();
  return owner.getDaySummaries({ date, repository, limit: 1 })[0];
}

export function getDaySummaries(owner, { date, repository, includeOtherRepositories = false, limit = 4 }) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const params = [date];
  let sql = `
    SELECT date_key, repository, summary, episode_ids_json, computed_at
    FROM day_summary
    WHERE date_key = ?
  `;

  if (!includeOtherRepositories) {
    const scopedRepo = normalizeDaySummaryRepository(repository);
    sql += ` AND ((? = '' AND repository = '') OR repository = ? OR repository IN (SELECT legacy FROM repository_identity_mapping WHERE canonical = ?)) `;
    params.push(scopedRepo, scopedRepo, scopedRepo);
  }

  sql += `
    ORDER BY
      CASE
        WHEN ? IS NOT NULL AND repository = ? THEN 0
        WHEN repository IS NULL OR repository = '' THEN 1
        ELSE 2
      END,
      computed_at DESC,
      repository ASC
    LIMIT ?
  `;
  params.push(repo, repo, limit);
  return owner.mapRetrievalRepositories(owner.db.prepare(sql).all(...params), repo);
}

export function findRelevantEpisodesByDateDetailed(owner, { date, repository, includeOtherRepositories = false, limit = 5 }) {
  owner.ensureOpen();
  const repo = normalizeRepository(repository);
  const params = [date];
  let sql = `
    SELECT
      ed.id,
      ed.session_id,
      ed.scope,
      ed.scope_source,
      ed.repository,
      ed.summary,
      ed.actions_json,
      ed.decisions_json,
      ed.files_changed_json,
      ed.themes_json,
      ed.open_items_json,
      ed.significance,
      ed.date_key,
      ed.updated_at
    FROM episode_digest ed
    WHERE ed.date_key = ?
  `;

  sql = applyScopeFilter(sql, params, repo, includeOtherRepositories, "ed");

  sql += `
    ORDER BY
      CASE
        WHEN ? IS NOT NULL AND ed.repository = ? THEN 0
        WHEN ed.scope = ? THEN 1
        ELSE 2
      END,
      ed.significance DESC,
      ed.updated_at DESC
    LIMIT ?
  `;
  params.push(repo, repo, MEMORY_SCOPE.GLOBAL, Math.max(limit * 3, 12));

  const rawRows = owner.mapRetrievalRepositories(owner.db.prepare(sql).all(...params), repo);
  const filtered = [];
  const eligibleRows = rawRows.filter((episode) => {
    const reason = explainEpisodeExclusionReason(episode);
    if (!reason) {
      return true;
    }
    filtered.push({
      stage: "date_matches",
      reason,
      row: serializeEpisodeTraceRow(episode, repository),
    });
    return false;
  });

  const deduped = dedupeEpisodesWithTrace(eligibleRows, repository);
  const ordered = deduped.rows;
  const genericFiltered = ordered.some((episode) => !isGenericWorkSummary(episode.summary))
    ? ordered
        .filter((episode) => isGenericWorkSummary(episode.summary))
        .map((episode) => ({
          stage: "preference",
          reason: "generic_work_summary",
          row: serializeEpisodeTraceRow(episode, repository),
        }))
    : [];
  const preferred = ordered.some((episode) => !isGenericWorkSummary(episode.summary))
    ? ordered.filter((episode) => !isGenericWorkSummary(episode.summary))
    : ordered;
  const includedRows = preferred.slice(0, limit);

  return {
    episodes: includedRows,
    trace: {
      prompt: `date:${date}`,
      repository,
      includeOtherRepositories,
      eligibleScopes: includeOtherRepositories ? [] : buildLocalEligibility(repository),
      primaryTerms: [],
      terms: [],
      lexicalQuery: "",
      rankedRows: preferred
        .slice(0, Math.max(limit * 3, 12))
        .map((episode) => serializeEpisodeTraceRow(episode, repository)),
      includedRows: includedRows.map((episode) => serializeEpisodeTraceRow(episode, repository)),
      filtered: [
        ...filtered,
        ...deduped.filtered,
        ...genericFiltered,
      ],
    },
  };
}
