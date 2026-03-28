import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildMaintenancePlan } from "../lib/maintenance-scheduler.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STATIC_ROOT = __dirname

const MEMORY_ROW_SELECT = `
  SELECT
    id, type, content, confidence, source_session_id, source_turn_index,
    scope, scope_source, repository, tags, created_at, updated_at,
    superseded_by, canonical_key, reinforcement_count, last_seen_at,
    expires_at, metadata_json
  FROM semantic_memory
`

const EPISODE_ROW_SELECT = `
  SELECT
    id, session_id, scope, scope_source, repository, branch, summary,
    actions_json, decisions_json, learnings_json, files_changed_json,
    refs_json, significance, themes_json, open_items_json,
    source, date_key, created_at, updated_at
  FROM episode_digest
`

const DAY_ROW_SELECT = `
  SELECT date_key, repository, summary, episode_ids_json, computed_at
  FROM day_summary
`

const IMPROVEMENT_ROW_SELECT = `
  SELECT
    id, source_case_id, source_kind, title, summary, evidence_json,
    trace_json, status, linked_memory_id, superseded_by, proposal_type,
    proposal_path, proposal_hash, review_state, reviewer_decision,
    reviewer_notes_json, created_at, updated_at, resolved_at
  FROM improvement_backlog
`

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.name = "HttpError"
    this.statusCode = statusCode
    this.code = code
  }
}

function clampInteger(value, fallback, { min = 1, max = 500 } = {}) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function parseJsonObject(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {}
  }
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {}
  } catch {
    return {}
  }
}

function parseJsonArray(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeRepository(value) {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function splitTags(value) {
  if (typeof value !== "string") {
    return []
  }
  return value.split(/\s+/).filter(Boolean)
}

function truncateText(value, max = 140) {
  const text = String(value ?? "").trim()
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max - 1)}…`
}

function summarizeList(values, max = 4) {
  if (!Array.isArray(values) || values.length === 0) {
    return []
  }
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .slice(0, max)
}

function computeLatencyTrend(rows) {
  const latencies = rows
    .map((row) => Number(row.latencyMs))
    .filter((value) => Number.isFinite(value))
  if (latencies.length === 0) {
    return {
      sampleCount: 0,
      recentAverageMs: 0,
      previousAverageMs: 0,
      deltaMs: 0,
      trend: "no_samples",
    }
  }

  const windowSize = Math.max(1, Math.min(10, Math.floor(latencies.length / 2) || 1))
  const recent = latencies.slice(-windowSize)
  const previous = latencies.slice(-(windowSize * 2), -windowSize)
  const average = (values) => Math.round(values.reduce((sum, item) => sum + item, 0) / values.length)
  const recentAverageMs = average(recent)
  const previousAverageMs = previous.length > 0 ? average(previous) : 0
  const deltaMs = previous.length > 0 ? recentAverageMs - previousAverageMs : 0
  const trend = previous.length === 0
    ? "insufficient_history"
    : Math.abs(deltaMs) <= 5
      ? "flat"
      : deltaMs > 0
        ? "rising"
        : "falling"

  return {
    sampleCount: latencies.length,
    recentAverageMs,
    previousAverageMs,
    deltaMs,
    trend,
  }
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  })
  res.end(body)
}

function notFound(res) {
  jsonResponse(res, 404, {
    ok: false,
    error: "not_found",
  })
}

function methodNotAllowed(res) {
  jsonResponse(res, 405, {
    ok: false,
    error: "method_not_allowed",
  })
}

function getStaticContentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8"
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8"
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8"
  }
  return "text/plain; charset=utf-8"
}

async function serveStatic(req, res, pathname) {
  const candidate = pathname === "/" ? "/index.html" : pathname
  const resolved = path.resolve(STATIC_ROOT, `.${candidate}`)
  if (!resolved.startsWith(STATIC_ROOT)) {
    notFound(res)
    return
  }

  try {
    const content = await readFile(resolved)
    res.writeHead(200, {
      "Content-Type": getStaticContentType(resolved),
      "Cache-Control": "no-store",
      "Content-Length": content.length,
    })
    res.end(content)
  } catch {
    if (candidate !== "/index.html") {
      return serveStatic(req, res, "/index.html")
    }
    notFound(res)
  }
}

function mapMemoryRow(row) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    confidence: row.confidence,
    sourceSessionId: row.source_session_id,
    sourceTurnIndex: row.source_turn_index,
    scope: row.scope,
    scopeSource: row.scope_source,
    repository: row.repository,
    tags: splitTags(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supersededBy: row.superseded_by,
    canonicalKey: row.canonical_key,
    reinforcementCount: row.reinforcement_count,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    metadata: parseJsonObject(row.metadata_json),
  }
}

function mapEpisodeRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    scope: row.scope,
    scopeSource: row.scope_source,
    repository: row.repository,
    branch: row.branch,
    summary: row.summary,
    actions: parseJsonArray(row.actions_json),
    decisions: parseJsonArray(row.decisions_json),
    learnings: parseJsonArray(row.learnings_json),
    filesChanged: parseJsonArray(row.files_changed_json),
    refs: parseJsonArray(row.refs_json),
    significance: row.significance,
    themes: parseJsonArray(row.themes_json),
    openItems: parseJsonArray(row.open_items_json),
    source: row.source,
    dateKey: row.date_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapDaySummaryRow(row) {
  return {
    dateKey: row.date_key,
    repository: row.repository,
    summary: row.summary,
    episodeIds: parseJsonArray(row.episode_ids_json),
    computedAt: row.computed_at,
  }
}

function mapImprovementRow(row) {
  return {
    id: row.id,
    sourceCaseId: row.source_case_id,
    sourceKind: row.source_kind,
    title: row.title,
    summary: row.summary,
    evidence: parseJsonObject(row.evidence_json),
    trace: parseJsonObject(row.trace_json),
    status: row.status,
    linkedMemoryId: row.linked_memory_id,
    supersededBy: row.superseded_by,
    proposalType: row.proposal_type,
    proposalPath: row.proposal_path,
    proposalHash: row.proposal_hash,
    reviewState: row.review_state,
    reviewerDecision: row.reviewer_decision,
    reviewerNotes: parseJsonObject(row.reviewer_notes_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    linkedMemory: row.memory_id
      ? {
        id: row.memory_id,
        type: row.memory_type,
        content: row.memory_content,
      }
      : null,
  }
}

function getMemoryById(db, id) {
  const row = db.db.prepare(`${MEMORY_ROW_SELECT} WHERE id = ?`).get(id)
  return row ? mapMemoryRow(row) : null
}

function getEpisodeBySessionId(db, sessionId) {
  const row = db.db.prepare(`${EPISODE_ROW_SELECT} WHERE session_id = ?`).get(sessionId)
  return row ? mapEpisodeRow(row) : null
}

function getDaySummary(db, { dateKey, repository }) {
  if (!dateKey) {
    return null
  }

  const exactRepository = repository ?? ""
  const row = db.db.prepare(`
    ${DAY_ROW_SELECT}
    WHERE date_key = ?
      AND repository IN (?, '')
    ORDER BY CASE WHEN repository = ? THEN 0 ELSE 1 END, computed_at DESC
    LIMIT 1
  `).get(dateKey, exactRepository, exactRepository)

  return row ? mapDaySummaryRow(row) : null
}

function listDayEpisodes(db, { dateKey, repository, excludeSessionId = null, limit = 12 }) {
  if (!dateKey) {
    return []
  }

  const rows = db.db.prepare(`
    ${EPISODE_ROW_SELECT}
    WHERE date_key = ?
      AND (
        (? IS NOT NULL AND repository = ?)
        OR (? IS NULL)
      )
      AND (? IS NULL OR session_id != ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(dateKey, repository, repository, repository, excludeSessionId, excludeSessionId, limit)

  return rows.map(mapEpisodeRow)
}

function listMemoriesByCanonicalKey(db, canonicalKey, { limit = 12 } = {}) {
  if (!canonicalKey) {
    return []
  }
  const rows = db.db.prepare(`
    ${MEMORY_ROW_SELECT}
    WHERE canonical_key = ?
    ORDER BY CASE WHEN superseded_by IS NULL THEN 0 ELSE 1 END, updated_at DESC
    LIMIT ?
  `).all(canonicalKey, limit)

  return rows.map(mapMemoryRow)
}

function getCanonicalClusterSummary(db, canonicalKey) {
  if (!canonicalKey) {
    return null
  }

  const counts = db.db.prepare(`
    SELECT
      COUNT(*) AS total_members,
      SUM(CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END) AS active_members,
      SUM(COALESCE(reinforcement_count, 0)) AS total_reinforcement
    FROM semantic_memory
    WHERE canonical_key = ?
  `).get(canonicalKey)

  return {
    key: canonicalKey,
    totalMembers: counts?.total_members ?? 0,
    activeMembers: counts?.active_members ?? 0,
    totalReinforcement: counts?.total_reinforcement ?? 0,
  }
}

function listMemoriesSupersededBy(db, id, { limit = 12 } = {}) {
  const rows = db.db.prepare(`
    ${MEMORY_ROW_SELECT}
    WHERE superseded_by = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(id, limit)

  return rows.map(mapMemoryRow)
}

function listMemoriesBySourceSession(db, sessionId, { limit = 24 } = {}) {
  const rows = db.db.prepare(`
    ${MEMORY_ROW_SELECT}
    WHERE source_session_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(sessionId, limit)

  return rows.map(mapMemoryRow)
}

function listImprovementsForMemory(db, memoryId, { limit = 12 } = {}) {
  const rows = db.db.prepare(`
    ${IMPROVEMENT_ROW_SELECT}
    WHERE linked_memory_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(memoryId, limit)

  return rows.map(mapImprovementRow)
}

function listImprovementsForSession(db, sessionId, { limit = 16 } = {}) {
  const rows = db.db.prepare(`
    SELECT
      ib.id, ib.source_case_id, ib.source_kind, ib.title, ib.summary,
      ib.evidence_json, ib.trace_json, ib.status, ib.linked_memory_id,
      ib.superseded_by, ib.proposal_type, ib.proposal_path, ib.proposal_hash,
      ib.review_state, ib.reviewer_decision, ib.reviewer_notes_json,
      ib.created_at, ib.updated_at, ib.resolved_at,
      sm.id AS memory_id, sm.type AS memory_type, sm.content AS memory_content
    FROM improvement_backlog ib
    JOIN semantic_memory sm ON sm.id = ib.linked_memory_id
    WHERE sm.source_session_id = ?
    ORDER BY ib.updated_at DESC
    LIMIT ?
  `).all(sessionId, limit)

  return rows.map(mapImprovementRow)
}

function summarizeWorkstreamTitle(memory) {
  const title = typeof memory.metadata?.title === "string" ? memory.metadata.title.trim() : ""
  if (title.length > 0) {
    return title
  }
  return truncateText(memory.content, 120)
}

function getMemoryEntityType(memory) {
  return memory.type === "workstream_overlay" ? "workstream" : "memory"
}

function buildNodeId(kind, id) {
  return `${kind}:${id}`
}

function buildMemoryNode(memory, { column = "right", entityType = null, focus = false } = {}) {
  const resolvedEntityType = entityType ?? getMemoryEntityType(memory)
  const title = resolvedEntityType === "workstream"
    ? summarizeWorkstreamTitle(memory)
    : truncateText(memory.content, focus ? 160 : 88)

  return {
    id: buildNodeId(resolvedEntityType, memory.id),
    kind: resolvedEntityType,
    entityType: resolvedEntityType,
    entityId: memory.id,
    navigable: true,
    column,
    title,
    subtitle: [memory.type, memory.repository ?? memory.scope].filter(Boolean).join(" · "),
    badge: memory.supersededBy ? "superseded" : "active",
    meta: [
      memory.canonicalKey ? `canonical ${memory.canonicalKey}` : null,
      memory.reinforcementCount > 1 ? `reinforced ${memory.reinforcementCount}×` : null,
    ].filter(Boolean).join(" · "),
  }
}

function buildSessionNode(episode, { column = "left", focus = false } = {}) {
  return {
    id: buildNodeId("session", episode.sessionId),
    kind: "session",
    entityType: "session",
    entityId: episode.sessionId,
    navigable: true,
    column,
    title: focus ? truncateText(episode.summary, 180) : `session ${truncateText(episode.sessionId, 12)}`,
    subtitle: [episode.repository ?? "global", episode.branch, episode.dateKey].filter(Boolean).join(" · "),
    badge: "session",
    meta: `significance ${episode.significance}`,
  }
}

function buildSessionPlaceholderNode(sessionId, repository, { column = "left" } = {}) {
  return {
    id: buildNodeId("session", sessionId),
    kind: "session",
    entityType: null,
    entityId: null,
    navigable: false,
    column,
    title: `session ${truncateText(sessionId, 12)}`,
    subtitle: repository ?? "pending digest",
    badge: "provenance",
    meta: "episode digest not available yet",
  }
}

function buildDayNode(day, { column = "left" } = {}) {
  return {
    id: buildNodeId("day", `${day.repository || "global"}:${day.dateKey}`),
    kind: "day",
    entityType: null,
    entityId: null,
    navigable: false,
    column,
    title: day.dateKey,
    subtitle: day.repository || "global",
    badge: "day",
    meta: `${day.episodeIds.length} episodes`,
  }
}

function buildClusterNode(cluster, { column = "left" } = {}) {
  return {
    id: buildNodeId("cluster", cluster.key),
    kind: "cluster",
    entityType: null,
    entityId: null,
    navigable: false,
    column,
    title: truncateText(cluster.key, 48),
    subtitle: `${cluster.totalMembers} memories`,
    badge: "canonical",
    meta: `${cluster.totalReinforcement} reinforcements`,
  }
}

function buildImprovementNode(improvement, { column = "far" } = {}) {
  return {
    id: buildNodeId("improvement", improvement.id),
    kind: "improvement",
    entityType: null,
    entityId: null,
    navigable: false,
    column,
    title: truncateText(improvement.title, 88),
    subtitle: [improvement.status, improvement.reviewState].filter(Boolean).join(" · "),
    badge: "improvement",
    meta: truncateText(improvement.summary, 96),
  }
}

function createGraph(centerNode) {
  const nodes = new Map()
  const edges = []

  const addNode = (node) => {
    if (!node?.id) {
      return
    }
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node)
      return
    }
    nodes.set(node.id, {
      ...nodes.get(node.id),
      ...node,
    })
  }

  const addEdge = (from, to, type, label) => {
    if (!from || !to || from === to) {
      return
    }
    edges.push({
      id: `${type}:${from}:${to}:${edges.length}`,
      from,
      to,
      type,
      label,
    })
  }

  addNode(centerNode)

  return {
    addNode,
    addEdge,
    toJSON() {
      return {
        centerNodeId: centerNode.id,
        nodes: Array.from(nodes.values()),
        edges,
      }
    },
  }
}

function buildMemoryFocus(memory, entityType) {
  return {
    entityType,
    id: memory.id,
    title: entityType === "workstream" ? summarizeWorkstreamTitle(memory) : truncateText(memory.content, 220),
    content: memory.content,
    type: memory.type,
    repository: memory.repository,
    scope: memory.scope,
    scopeSource: memory.scopeSource,
    status: memory.supersededBy ? "superseded" : "active",
    canonicalKey: memory.canonicalKey,
    reinforcementCount: memory.reinforcementCount,
    sourceSessionId: memory.sourceSessionId,
    sourceTurnIndex: memory.sourceTurnIndex,
    tags: memory.tags,
    metadata: memory.metadata,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastSeenAt: memory.lastSeenAt,
    expiresAt: memory.expiresAt,
  }
}

function buildSessionFocus(episode) {
  return {
    entityType: "session",
    id: episode.sessionId,
    title: truncateText(episode.summary, 220),
    summary: episode.summary,
    repository: episode.repository,
    scope: episode.scope,
    scopeSource: episode.scopeSource,
    branch: episode.branch,
    significance: episode.significance,
    dateKey: episode.dateKey,
    source: episode.source,
    actionCount: episode.actions.length,
    decisionCount: episode.decisions.length,
    learningCount: episode.learnings.length,
    openItemCount: episode.openItems.length,
    actions: summarizeList(episode.actions),
    decisions: summarizeList(episode.decisions),
    learnings: summarizeList(episode.learnings),
    openItems: summarizeList(episode.openItems),
    themes: summarizeList(episode.themes),
    filesChanged: summarizeList(episode.filesChanged),
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
  }
}

function buildMemoryDrilldown({ db, id, entityType }) {
  const memory = getMemoryById(db, id)
  if (!memory) {
    throw new HttpError(404, "memory_not_found", `No memory found for ${id}`)
  }
  if (entityType === "workstream" && memory.type !== "workstream_overlay") {
    throw new HttpError(404, "workstream_not_found", `No workstream found for ${id}`)
  }

  const focus = buildMemoryFocus(memory, entityType)
  const sourceEpisode = memory.sourceSessionId ? getEpisodeBySessionId(db, memory.sourceSessionId) : null
  const sourceDay = sourceEpisode
    ? getDaySummary(db, { dateKey: sourceEpisode.dateKey, repository: sourceEpisode.repository })
    : null
  const dayEpisodes = sourceEpisode
    ? listDayEpisodes(db, {
      dateKey: sourceEpisode.dateKey,
      repository: sourceEpisode.repository,
      excludeSessionId: sourceEpisode.sessionId,
      limit: 8,
    })
    : []
  const supersededBy = memory.supersededBy ? getMemoryById(db, memory.supersededBy) : null
  const supersedes = listMemoriesSupersededBy(db, memory.id, { limit: 8 })
  const linkedImprovements = listImprovementsForMemory(db, memory.id, { limit: 8 })
  const canonicalCluster = memory.canonicalKey
    ? {
      ...getCanonicalClusterSummary(db, memory.canonicalKey),
      members: listMemoriesByCanonicalKey(db, memory.canonicalKey, { limit: 10 }),
    }
    : null

  const centerNode = buildMemoryNode(memory, {
    column: "center",
    entityType,
    focus: true,
  })
  const graph = createGraph(centerNode)

  if (sourceEpisode) {
    const sessionNode = buildSessionNode(sourceEpisode, { column: "left" })
    graph.addNode(sessionNode)
    graph.addEdge(sessionNode.id, centerNode.id, "source_session", "source session")
  } else if (memory.sourceSessionId) {
    const sessionNode = buildSessionPlaceholderNode(memory.sourceSessionId, memory.repository, { column: "left" })
    graph.addNode(sessionNode)
    graph.addEdge(sessionNode.id, centerNode.id, "source_session", "source session")
  }

  if (sourceDay) {
    const dayNode = buildDayNode(sourceDay, { column: "left" })
    graph.addNode(dayNode)
    if (sourceEpisode) {
      graph.addEdge(dayNode.id, buildNodeId("session", sourceEpisode.sessionId), "day_group", "day grouping")
    } else {
      graph.addEdge(dayNode.id, centerNode.id, "day_group", "day grouping")
    }
  }

  if (canonicalCluster) {
    const clusterNode = buildClusterNode(canonicalCluster, { column: "left" })
    graph.addNode(clusterNode)
    graph.addEdge(clusterNode.id, centerNode.id, "canonical_cluster", "canonical cluster")
    canonicalCluster.members
      .filter((candidate) => candidate.id !== memory.id)
      .slice(0, 5)
      .forEach((candidate) => {
        const memberNode = buildMemoryNode(candidate, {
          column: "right",
          entityType: getMemoryEntityType(candidate),
        })
        graph.addNode(memberNode)
        graph.addEdge(clusterNode.id, memberNode.id, "cluster_member", "cluster member")
      })
  }

  supersedes.slice(0, 4).forEach((candidate) => {
    const node = buildMemoryNode(candidate, {
      column: "left",
      entityType: getMemoryEntityType(candidate),
    })
    graph.addNode(node)
    graph.addEdge(node.id, centerNode.id, "superseded_by", "superseded by")
  })

  if (supersededBy) {
    const node = buildMemoryNode(supersededBy, {
      column: "right",
      entityType: getMemoryEntityType(supersededBy),
    })
    graph.addNode(node)
    graph.addEdge(centerNode.id, node.id, "superseded_by", "superseded by")
  }

  linkedImprovements.slice(0, 4).forEach((improvement) => {
    const node = buildImprovementNode(improvement, { column: "far" })
    graph.addNode(node)
    graph.addEdge(node.id, centerNode.id, "linked_memory", "linked improvement")
  })

  return {
    entityType,
    focus,
    provenance: {
      sourceSession: sourceEpisode ?? (memory.sourceSessionId
        ? {
          sessionId: memory.sourceSessionId,
          summary: "Source session digest not available yet",
          repository: memory.repository,
          dateKey: null,
          branch: null,
          significance: null,
        }
        : null),
      sourceTurnIndex: memory.sourceTurnIndex,
      day: sourceDay,
      siblingSessions: dayEpisodes,
    },
    lineage: {
      supersededBy,
      supersedes,
    },
    canonicalCluster,
    linkedImprovements,
    graph: graph.toJSON(),
  }
}

function buildSessionDrilldown({ db, id }) {
  const episode = getEpisodeBySessionId(db, id)
  if (!episode) {
    throw new HttpError(404, "session_not_found", `No session digest found for ${id}`)
  }

  const focus = buildSessionFocus(episode)
  const day = getDaySummary(db, {
    dateKey: episode.dateKey,
    repository: episode.repository,
  })
  const siblingSessions = listDayEpisodes(db, {
    dateKey: episode.dateKey,
    repository: episode.repository,
    excludeSessionId: episode.sessionId,
    limit: 8,
  })
  const sessionMemories = listMemoriesBySourceSession(db, episode.sessionId, { limit: 16 })
  const linkedImprovements = listImprovementsForSession(db, episode.sessionId, { limit: 10 })

  const centerNode = buildSessionNode(episode, {
    column: "center",
    focus: true,
  })
  const graph = createGraph(centerNode)

  if (day) {
    const dayNode = buildDayNode(day, { column: "left" })
    graph.addNode(dayNode)
    graph.addEdge(dayNode.id, centerNode.id, "day_group", "day grouping")
  }

  sessionMemories.slice(0, 8).forEach((memory) => {
    const node = buildMemoryNode(memory, {
      column: "right",
      entityType: getMemoryEntityType(memory),
    })
    graph.addNode(node)
    graph.addEdge(centerNode.id, node.id, "source_session", "source session")
  })

  linkedImprovements.slice(0, 6).forEach((improvement) => {
    const node = buildImprovementNode(improvement, { column: "far" })
    graph.addNode(node)
    if (improvement.linkedMemoryId && improvement.linkedMemory) {
      const linkedMemoryNode = {
        ...buildMemoryNode(
          {
            ...improvement.linkedMemory,
            repository: episode.repository,
            scope: episode.scope,
            canonicalKey: null,
            reinforcementCount: 1,
            supersededBy: null,
            metadata: {},
            updatedAt: episode.updatedAt,
          },
          {
            column: "right",
            entityType: improvement.linkedMemory.type === "workstream_overlay" ? "workstream" : "memory",
          },
        ),
        title: truncateText(improvement.linkedMemory.content, 88),
      }
      graph.addNode(linkedMemoryNode)
      graph.addEdge(node.id, linkedMemoryNode.id, "linked_memory", "linked improvement")
      return
    }

    graph.addEdge(node.id, centerNode.id, "linked_memory", "linked improvement")
  })

  return {
    entityType: "session",
    focus,
    dayGroup: {
      day,
      siblingSessions,
    },
    sessionMemories,
    linkedImprovements,
    graph: graph.toJSON(),
  }
}

function queryOverview({ db, repository, traceLimit = 40, maintenanceLimit = 10 }) {
  const stats = db.getStats()
  const traces = db.listRetrievalTraceSamples({
    repository,
    includeGlobal: true,
    limit: clampInteger(traceLimit, 40, { min: 5, max: 200 }),
  })
  const activity = db.getActivityState({ repository, includeGlobal: true })

  const workstreamRows = db.db.prepare(`
    SELECT id, repository, scope, content, metadata_json, updated_at
    FROM semantic_memory
    WHERE type = 'workstream_overlay'
      AND superseded_by IS NULL
    ORDER BY updated_at DESC
    LIMIT 20
  `).all()
  const workstreams = workstreamRows
    .map((row) => {
      const metadata = parseJsonObject(row.metadata_json)
      return {
        id: row.id,
        repository: row.repository,
        scope: row.scope,
        status: typeof metadata.status === "string" ? metadata.status : "active",
        title: typeof metadata.title === "string" && metadata.title.trim().length > 0
          ? metadata.title.trim()
          : row.content,
        mission: typeof metadata.mission === "string" ? metadata.mission : "",
        objective: typeof metadata.objective === "string" ? metadata.objective : "",
        blockers: Array.isArray(metadata.blockers) ? metadata.blockers : [],
        nextActions: Array.isArray(metadata.nextActions) ? metadata.nextActions : [],
        updatedAt: row.updated_at,
      }
    })
    .filter((row) => row.status !== "done")

  const maintenancePlan = buildMaintenancePlan({
    runtime: {
      config: db.config,
      db,
      traceRecorder: {
        isEnabled: () => Boolean(db.config?.rollout?.traceRecorder),
      },
    },
    repository,
    trigger: "status",
    force: false,
    requestedTasks: [],
  })

  const recentRuns = db.listMaintenanceRuns({
    limit: clampInteger(maintenanceLimit, 10, { min: 1, max: 50 }),
  })

  return {
    stats,
    activeWorkstreams: workstreams,
    activity,
    maintenance: {
      dueTasks: maintenancePlan.dueTasks,
      selectedTasks: maintenancePlan.selectedTasks,
      recentRuns,
      skippedDueToCap: maintenancePlan.skippedDueToCap,
    },
    latencyTrend: computeLatencyTrend(traces),
    recentTraceSamples: traces.slice(0, 10),
  }
}

function queryMemoryFilters({ db }) {
  const types = db.db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM semantic_memory
    GROUP BY type
    ORDER BY count DESC, type ASC
  `).all()
  const scopes = db.db.prepare(`
    SELECT scope, COUNT(*) AS count
    FROM semantic_memory
    GROUP BY scope
    ORDER BY count DESC, scope ASC
  `).all()
  const repositories = db.db.prepare(`
    SELECT repository, COUNT(*) AS count
    FROM semantic_memory
    WHERE repository IS NOT NULL AND repository != ''
    GROUP BY repository
    ORDER BY count DESC, repository ASC
    LIMIT 200
  `).all()
  const canonicalKeys = db.db.prepare(`
    SELECT canonical_key AS canonicalKey, COUNT(*) AS count
    FROM semantic_memory
    WHERE canonical_key IS NOT NULL AND canonical_key != ''
    GROUP BY canonical_key
    ORDER BY count DESC, canonical_key ASC
    LIMIT 200
  `).all()

  return {
    types,
    scopes,
    repositories,
    canonicalKeys,
  }
}

function queryMemories({ db, url }) {
  const type = url.searchParams.get("type")?.trim() || null
  const scope = url.searchParams.get("scope")?.trim() || null
  const repository = normalizeRepository(url.searchParams.get("repository"))
  const canonicalKey = url.searchParams.get("canonicalKey")?.trim() || null
  const state = (url.searchParams.get("state") || "active").trim().toLowerCase()
  const page = clampInteger(url.searchParams.get("page"), 1, { min: 1, max: 2000 })
  const pageSize = clampInteger(url.searchParams.get("pageSize"), 25, { min: 1, max: 100 })
  const offset = (page - 1) * pageSize

  const clauses = []
  const params = []

  if (type) {
    clauses.push("type = ?")
    params.push(type)
  }
  if (scope) {
    clauses.push("scope = ?")
    params.push(scope)
  }
  if (repository) {
    clauses.push("repository = ?")
    params.push(repository)
  }
  if (canonicalKey) {
    clauses.push("canonical_key = ?")
    params.push(canonicalKey)
  }
  if (state === "active") {
    clauses.push("superseded_by IS NULL")
  } else if (state === "superseded") {
    clauses.push("superseded_by IS NOT NULL")
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
  const countRow = db.db.prepare(`
    SELECT COUNT(*) AS count
    FROM semantic_memory
    ${where}
  `).get(...params)

  const rows = db.db.prepare(`
    ${MEMORY_ROW_SELECT}
    ${where}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset)

  return {
    page,
    pageSize,
    total: countRow?.count ?? 0,
    rows: rows.map(mapMemoryRow),
  }
}

function queryMaintenance({ db, repository }) {
  const runs = db.listMaintenanceRuns({ limit: 20 })
  const taskStates = db.listMaintenanceTaskStates()
  const traces = db.listRetrievalTraceSamples({ repository, includeGlobal: true, limit: 30 })
  const doctorReports = db.listTrajectoryArtifacts({ kind: "doctor_report", repository, limit: 20 })
  const trajectory = db.listTrajectoryArtifacts({ repository, limit: 30 })

  const deferred = db.db.prepare(`
    SELECT
      session_id, repository, status, priority, reason, queued_at,
      available_at, started_at, completed_at, attempts, last_error, metadata_json
    FROM deferred_extraction
    ORDER BY
      CASE status
        WHEN 'running' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'failed' THEN 2
        ELSE 3
      END,
      available_at ASC
    LIMIT 100
  `).all().map((row) => ({
    sessionId: row.session_id,
    repository: row.repository,
    status: row.status,
    priority: row.priority,
    reason: row.reason,
    queuedAt: row.queued_at,
    availableAt: row.available_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    attempts: row.attempts,
    lastError: row.last_error,
    metadata: parseJsonObject(row.metadata_json),
  }))

  const maintenancePlan = buildMaintenancePlan({
    runtime: {
      config: db.config,
      db,
      traceRecorder: {
        isEnabled: () => Boolean(db.config?.rollout?.traceRecorder),
      },
    },
    repository,
    trigger: "status",
    force: false,
    requestedTasks: [],
  })

  return {
    runs,
    taskStates,
    deferred,
    doctorReports,
    trajectory,
    maintenancePlan,
    recentTraceSamples: traces,
  }
}

function queryEpisodes({ db, repository }) {
  const episodes = db.db.prepare(`
    ${EPISODE_ROW_SELECT}
    WHERE (? IS NULL OR repository = ? OR scope = 'global')
    ORDER BY updated_at DESC
    LIMIT 100
  `).all(repository, repository).map(mapEpisodeRow)

  const daySummaries = db.db.prepare(`
    ${DAY_ROW_SELECT}
    WHERE (? IS NULL OR repository = ? OR repository = '')
    ORDER BY date_key DESC, computed_at DESC
    LIMIT 60
  `).all(repository, repository).map(mapDaySummaryRow)

  return {
    episodes,
    daySummaries,
  }
}

function queryDrilldown({ db, url }) {
  const entityType = (url.searchParams.get("entity") || "").trim().toLowerCase()
  const id = (url.searchParams.get("id") || "").trim()

  if (!entityType || !id) {
    throw new HttpError(400, "invalid_drilldown_query", "entity and id are required")
  }

  if (entityType === "memory" || entityType === "workstream") {
    return buildMemoryDrilldown({ db, id, entityType })
  }

  if (entityType === "session") {
    return buildSessionDrilldown({ db, id })
  }

  throw new HttpError(400, "unsupported_drilldown_entity", `Unsupported drilldown entity: ${entityType}`)
}

export function startCoherenceBrowserServer({
  db,
  host = "127.0.0.1",
  port = 43111,
  repository = null,
} = {}) {
  if (!db) {
    throw new Error("db is required")
  }

  const normalizedRepository = normalizeRepository(repository)

  const server = createServer(async (req, res) => {
    if (req.method !== "GET") {
      methodNotAllowed(res)
      return
    }

    const url = new URL(req.url || "/", `http://${host}:${port}`)

    try {
      if (url.pathname === "/api/health") {
        jsonResponse(res, 200, {
          ok: true,
          mode: "read_only",
          host,
          repository: normalizedRepository,
          dbPath: db.config?.paths?.derivedStorePath ?? null,
        })
        return
      }

      if (url.pathname === "/api/overview") {
        jsonResponse(res, 200, {
          ok: true,
          mode: "read_only",
          data: queryOverview({ db, repository: normalizedRepository }),
        })
        return
      }

      if (url.pathname === "/api/memories") {
        jsonResponse(res, 200, {
          ok: true,
          mode: "read_only",
          data: queryMemories({ db, url }),
        })
        return
      }

      if (url.pathname === "/api/memories/filters") {
        jsonResponse(res, 200, {
          ok: true,
          mode: "read_only",
          data: queryMemoryFilters({ db }),
        })
        return
      }

      if (url.pathname === "/api/maintenance") {
        jsonResponse(res, 200, {
          ok: true,
          mode: "read_only",
          data: queryMaintenance({ db, repository: normalizedRepository }),
        })
        return
      }

      if (url.pathname === "/api/episodes") {
        jsonResponse(res, 200, {
          ok: true,
          mode: "read_only",
          data: queryEpisodes({ db, repository: normalizedRepository }),
        })
        return
      }

      if (url.pathname === "/api/drilldown") {
        jsonResponse(res, 200, {
          ok: true,
          mode: "read_only",
          data: queryDrilldown({ db, url }),
        })
        return
      }

      await serveStatic(req, res, url.pathname)
    } catch (error) {
      if (error instanceof HttpError) {
        jsonResponse(res, error.statusCode, {
          ok: false,
          mode: "read_only",
          error: error.code,
          message: error.message,
        })
        return
      }

      jsonResponse(res, 500, {
        ok: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  server.listen(port, host)

  return {
    server,
    host,
    port,
  }
}
