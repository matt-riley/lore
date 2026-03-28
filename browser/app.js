const state = {
  tab: "overview",
  scope: {
    repository: null,
  },
  memoriesFilters: {
    type: "",
    scope: "",
    repository: "",
    canonicalKey: "",
    state: "active",
    page: 1,
    pageSize: 25,
  },
  drilldown: {
    entity: null,
    id: null,
    data: null,
  },
}

const views = {
  overview: document.getElementById("view-overview"),
  memories: document.getElementById("view-memories"),
  maintenance: document.getElementById("view-maintenance"),
  episodes: document.getElementById("view-episodes"),
  drilldown: document.getElementById("view-drilldown"),
}

const GRAPH_COLUMNS = ["left", "center", "right", "far"]
const GRAPH_COLUMN_TITLES = {
  left: "Provenance",
  center: "Focus",
  right: "Related",
  far: "Artifacts",
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

function formatTime(value) {
  if (!value) {
    return "—"
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return `${date.toLocaleString()}`
}

function truncateText(value, max = 140) {
  const text = String(value ?? "").trim()
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max - 1)}…`
}

function fetchJson(path) {
  return fetch(path).then(async (response) => {
    if (!response.ok) {
      let detail = ""
      try {
        const payload = await response.json()
        detail = payload?.message ? `: ${payload.message}` : ""
      } catch {
        detail = ""
      }
      throw new Error(`Request failed (${response.status}) for ${path}${detail}`)
    }
    return response.json()
  })
}

function setStatus(text, ok = true) {
  const pill = document.getElementById("status-pill")
  pill.textContent = text
  pill.style.color = ok ? "var(--ok)" : "var(--warn)"
}

function setScope(repository) {
  state.scope.repository = repository || null
  const pill = document.getElementById("scope-pill")
  if (!pill) {
    return
  }
  pill.textContent = repository
    ? `scope: ${repository}`
    : "scope: all repositories"
}

function renderMetricGrid(entries) {
  return `
    <div class="grid summary-grid">
      ${entries.map(([label, value]) => `
        <article class="card metric-card">
          <h3>${escapeHtml(label)}</h3>
          <div class="metric">${escapeHtml(value ?? "—")}</div>
        </article>
      `).join("")}
    </div>
  `
}

function renderDrilldownAction(entity, id, label = "Drill down") {
  return `
    <button
      type="button"
      class="action-btn"
      data-drilldown-entity="${escapeHtml(entity)}"
      data-drilldown-id="${escapeHtml(id)}"
    >${escapeHtml(label)}</button>
  `
}

function renderEmptyBlock(message) {
  return `<div class="row-muted empty-state">${escapeHtml(message)}</div>`
}

function renderOverview(data) {
  const stats = data?.stats ?? {}
  const trend = data?.latencyTrend ?? {}
  const activityRows = Array.isArray(data?.activity) ? data.activity : []
  const workstreams = Array.isArray(data?.activeWorkstreams) ? data.activeWorkstreams : []
  const dueTasks = data?.maintenance?.dueTasks ?? []

  views.overview.innerHTML = `
    ${renderMetricGrid([
      ["Semantic memories", stats.semanticCount],
      ["Episode digests", stats.episodeCount],
      ["Day summaries", stats.daySummaryCount],
      ["Active workstreams", workstreams.length],
      ["Due maintenance tasks", dueTasks.length],
      ["Trace samples", stats.retrievalTraceSampleCount],
      ["Recent latency avg", `${trend.recentAverageMs ?? 0}ms`],
      ["Latency trend", trend.trend ?? "no_samples"],
    ])}

    <h2>Last successful Coherence activity</h2>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Context injection</th>
            <th>Extraction</th>
            <th>Maintenance</th>
            <th>Trace</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          ${activityRows.map((row) => `
            <tr>
              <td>${escapeHtml(row.scopeKey)}</td>
              <td>${escapeHtml(formatTime(row.lastContextInjectionAt))}</td>
              <td>${escapeHtml(formatTime(row.lastExtractionCompletionAt))}</td>
              <td>${escapeHtml(formatTime(row.lastMaintenanceCompletionAt))}</td>
              <td>${escapeHtml(formatTime(row.lastTraceRecordedAt))}</td>
              <td>${escapeHtml(formatTime(row.updatedAt))}</td>
            </tr>
          `).join("") || '<tr><td colspan="6" class="row-muted">No activity rows</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2>Active workstreams</h2>
    <div class="list">
      ${workstreams.map((ws) => `
        <article class="list-item">
          <div class="item-header-row">
            <div>
              <strong>${escapeHtml(ws.title)}</strong> <span class="tag">${escapeHtml(ws.status)}</span>
            </div>
            ${renderDrilldownAction("workstream", ws.id, "View graph")}
          </div>
          <div class="small">repo=${escapeHtml(ws.repository ?? "global")} · scope=${escapeHtml(ws.scope ?? "repo")} · updated=${escapeHtml(formatTime(ws.updatedAt))}</div>
          ${ws.mission ? `<div class="small">mission: ${escapeHtml(ws.mission)}</div>` : ""}
          ${ws.objective ? `<div class="small">objective: ${escapeHtml(ws.objective)}</div>` : ""}
          ${Array.isArray(ws.blockers) && ws.blockers.length > 0 ? `<div class="small">blockers: ${escapeHtml(ws.blockers.join(" | "))}</div>` : ""}
          ${Array.isArray(ws.nextActions) && ws.nextActions.length > 0 ? `<div class="small">next: ${escapeHtml(ws.nextActions.join(" | "))}</div>` : ""}
        </article>
      `).join("") || renderEmptyBlock("No active workstreams.")}
    </div>
  `
}

function renderMemoriesFilters(filterData) {
  const types = filterData?.types ?? []
  const scopes = filterData?.scopes ?? []
  const repos = filterData?.repositories ?? []
  const canonicalKeys = filterData?.canonicalKeys ?? []

  return `
    <div class="controls">
      <select id="mem-filter-type">
        <option value="">type: any</option>
        ${types.map((row) => `<option value="${escapeHtml(row.type)}">${escapeHtml(row.type)} (${row.count})</option>`).join("")}
      </select>

      <select id="mem-filter-scope">
        <option value="">scope: any</option>
        ${scopes.map((row) => `<option value="${escapeHtml(row.scope)}">${escapeHtml(row.scope)} (${row.count})</option>`).join("")}
      </select>

      <select id="mem-filter-repo">
        <option value="">repo: any</option>
        ${repos.map((row) => `<option value="${escapeHtml(row.repository)}">${escapeHtml(row.repository)} (${row.count})</option>`).join("")}
      </select>

      <select id="mem-filter-canonical">
        <option value="">canonical: any</option>
        ${canonicalKeys.map((row) => `<option value="${escapeHtml(row.canonicalKey)}">${escapeHtml(row.canonicalKey)} (${row.count})</option>`).join("")}
      </select>

      <select id="mem-filter-state">
        <option value="active">active only</option>
        <option value="superseded">superseded only</option>
        <option value="all">all</option>
      </select>

      <button id="mem-apply">Apply</button>
    </div>
  `
}

function renderMemoriesTable(data) {
  const rows = data?.rows ?? []
  return `
    <div class="small">total=${data?.total ?? 0} · page=${data?.page ?? 1} · pageSize=${data?.pageSize ?? 25}</div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>updated</th>
            <th>type</th>
            <th>scope</th>
            <th>repository</th>
            <th>canonical key</th>
            <th>state</th>
            <th>content</th>
            <th>drill-down</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(formatTime(row.updatedAt))}</td>
              <td>${escapeHtml(row.type)}</td>
              <td>${escapeHtml(row.scope)}</td>
              <td>${escapeHtml(row.repository ?? "")}</td>
              <td>${escapeHtml(row.canonicalKey ?? "")}</td>
              <td>${row.supersededBy ? '<span class="tag warn">superseded</span>' : '<span class="tag ok">active</span>'}</td>
              <td>${escapeHtml(row.content)}</td>
              <td>${renderDrilldownAction(row.type === "workstream_overlay" ? "workstream" : "memory", row.id, "Open")}</td>
            </tr>
          `).join("") || '<tr><td colspan="8" class="row-muted">No memories match filters.</td></tr>'}
        </tbody>
      </table>
    </div>
  `
}

function applyMemoriesFilterControls() {
  const bind = (id, key) => {
    const element = document.getElementById(id)
    if (!element) {
      return
    }
    if (state.memoriesFilters[key] !== undefined) {
      element.value = state.memoriesFilters[key] || ""
    }
  }
  bind("mem-filter-type", "type")
  bind("mem-filter-scope", "scope")
  bind("mem-filter-repo", "repository")
  bind("mem-filter-canonical", "canonicalKey")
  bind("mem-filter-state", "state")

  const button = document.getElementById("mem-apply")
  if (button) {
    button.onclick = async () => {
      state.memoriesFilters.type = document.getElementById("mem-filter-type")?.value || ""
      state.memoriesFilters.scope = document.getElementById("mem-filter-scope")?.value || ""
      state.memoriesFilters.repository = document.getElementById("mem-filter-repo")?.value || ""
      state.memoriesFilters.canonicalKey = document.getElementById("mem-filter-canonical")?.value || ""
      state.memoriesFilters.state = document.getElementById("mem-filter-state")?.value || "active"
      state.memoriesFilters.page = 1
      await loadMemories()
    }
  }
}

async function loadMemories() {
  const [filtersResponse, memoriesResponse] = await Promise.all([
    fetchJson("/api/memories/filters"),
    fetchJson(`/api/memories?${new URLSearchParams(state.memoriesFilters).toString()}`),
  ])
  views.memories.innerHTML = `${renderMemoriesFilters(filtersResponse.data)}${renderMemoriesTable(memoriesResponse.data)}`
  applyMemoriesFilterControls()
}

function renderMaintenance(data) {
  const runs = data?.runs ?? []
  const taskStates = data?.taskStates ?? []
  const deferred = data?.deferred ?? []
  const doctorReports = data?.doctorReports ?? []
  const dueTasks = data?.maintenancePlan?.dueTasks ?? []

  views.maintenance.innerHTML = `
    <h2>Due maintenance tasks</h2>
    <div class="list">
      ${dueTasks.map((task) => `
        <article class="list-item">
          <div><strong>${escapeHtml(task.label)}</strong> <span class="tag">${escapeHtml(task.dueReason)}</span></div>
          <div class="small">lastRunMinutesAgo=${escapeHtml(task.lastRunMinutesAgo ?? "n/a")} cadenceMinutes=${escapeHtml(task.cadenceMinutes)}</div>
        </article>
      `).join("") || renderEmptyBlock("No due tasks right now.")}
    </div>

    <h2>Maintenance task state</h2>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>task</th><th>status</th><th>runs</th><th>failures</th><th>needs attention</th><th>completed</th></tr>
        </thead>
        <tbody>
          ${taskStates.map((row) => `
            <tr>
              <td>${escapeHtml(row.task_name)}</td>
              <td>${escapeHtml(row.last_status)}</td>
              <td>${escapeHtml(row.total_runs)}</td>
              <td>${escapeHtml(row.total_failures)}</td>
              <td>${escapeHtml(row.total_needs_attention)}</td>
              <td>${escapeHtml(formatTime(row.last_completed_at))}</td>
            </tr>
          `).join("") || '<tr><td colspan="6" class="row-muted">No task states.</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2>Recent maintenance runs</h2>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>started</th><th>status</th><th>trigger</th><th>repository</th><th>completed</th><th>failed</th><th>needs attention</th></tr>
        </thead>
        <tbody>
          ${runs.map((run) => `
            <tr>
              <td>${escapeHtml(formatTime(run.started_at))}</td>
              <td>${escapeHtml(run.status)}</td>
              <td>${escapeHtml(run.trigger)}</td>
              <td>${escapeHtml(run.repository ?? "")}</td>
              <td>${escapeHtml(run.completed_count ?? 0)}</td>
              <td>${escapeHtml(run.failed_count ?? 0)}</td>
              <td>${escapeHtml(run.needs_attention_count ?? 0)}</td>
            </tr>
          `).join("") || '<tr><td colspan="7" class="row-muted">No maintenance runs.</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2>Deferred extraction queue</h2>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>session</th><th>repo</th><th>status</th><th>priority</th><th>available</th><th>attempts</th><th>error</th></tr>
        </thead>
        <tbody>
          ${deferred.map((row) => `
            <tr>
              <td>${escapeHtml(row.sessionId)}</td>
              <td>${escapeHtml(row.repository ?? "")}</td>
              <td>${escapeHtml(row.status)}</td>
              <td>${escapeHtml(row.priority)}</td>
              <td>${escapeHtml(formatTime(row.availableAt))}</td>
              <td>${escapeHtml(row.attempts)}</td>
              <td>${escapeHtml(row.lastError ?? "")}</td>
            </tr>
          `).join("") || '<tr><td colspan="7" class="row-muted">No deferred items.</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2>Doctor reports</h2>
    <div class="list">
      ${doctorReports.map((row) => `
        <article class="list-item">
          <div><strong>${escapeHtml(row.summary)}</strong></div>
          <div class="small">severity=${escapeHtml(row.severity)} · outcome=${escapeHtml(row.outcome)} · created=${escapeHtml(formatTime(row.created_at))}</div>
        </article>
      `).join("") || renderEmptyBlock("No doctor reports found.")}
    </div>
  `
}

function renderEpisodes(data) {
  const episodes = data?.episodes ?? []
  const summaries = data?.daySummaries ?? []

  views.episodes.innerHTML = `
    <h2>Recent episodes</h2>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>updated</th><th>date</th><th>repo</th><th>scope</th><th>summary</th><th>significance</th><th>drill-down</th></tr>
        </thead>
        <tbody>
          ${episodes.map((row) => `
            <tr>
              <td>${escapeHtml(formatTime(row.updatedAt))}</td>
              <td>${escapeHtml(row.dateKey)}</td>
              <td>${escapeHtml(row.repository ?? "")}</td>
              <td>${escapeHtml(row.scope)}</td>
              <td>${escapeHtml(row.summary)}</td>
              <td>${escapeHtml(row.significance)}</td>
              <td>${renderDrilldownAction("session", row.sessionId, "Open")}</td>
            </tr>
          `).join("") || '<tr><td colspan="7" class="row-muted">No episodes found.</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2>Day summaries</h2>
    <div class="list">
      ${summaries.map((row) => `
        <article class="list-item">
          <div><strong>${escapeHtml(row.dateKey)}</strong> <span class="small">repo=${escapeHtml(row.repository || "global")}</span></div>
          <div>${escapeHtml(row.summary)}</div>
          <div class="small">computed=${escapeHtml(formatTime(row.computedAt))} · episodes=${escapeHtml(row.episodeIds.length)}</div>
        </article>
      `).join("") || renderEmptyBlock("No day summaries found.")}
    </div>
  `
}

function renderSectionList(title, itemsHtml, emptyMessage, description = "") {
  return `
    <section class="card section-card">
      <div class="section-head">
        <div>
          <h2>${escapeHtml(title)}</h2>
          ${description ? `<div class="small">${escapeHtml(description)}</div>` : ""}
        </div>
      </div>
      <div class="list compact-list">
        ${itemsHtml || renderEmptyBlock(emptyMessage)}
      </div>
    </section>
  `
}

function renderMetadataList(metadata) {
  const entries = Object.entries(metadata ?? {})
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .slice(0, 10)

  if (entries.length === 0) {
    return renderEmptyBlock("No metadata fields on this record.")
  }

  return `
    <div class="kv-list">
      ${entries.map(([key, value]) => `
        <div class="kv-row">
          <span class="small">${escapeHtml(key)}</span>
          <span>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}</span>
        </div>
      `).join("")}
    </div>
  `
}

function renderMemoryRelationItem(memory, label = "Memory") {
  const entity = memory.type === "workstream_overlay" ? "workstream" : "memory"
  const subtitle = [
    label,
    memory.type,
    memory.repository ?? memory.scope,
    memory.canonicalKey ? `canonical=${memory.canonicalKey}` : null,
  ].filter(Boolean).join(" · ")
  const meta = [
    `updated=${formatTime(memory.updatedAt)}`,
    memory.reinforcementCount > 1 ? `reinforced=${memory.reinforcementCount}` : null,
    memory.supersededBy ? "state=superseded" : "state=active",
  ].filter(Boolean).join(" · ")

  return `
    <article class="list-item relation-item">
      <div class="item-header-row">
        <div>
          <strong>${escapeHtml(truncateText(memory.content, 160))}</strong>
          <div class="small">${escapeHtml(subtitle)}</div>
        </div>
        ${renderDrilldownAction(entity, memory.id, "Open")}
      </div>
      <div class="small">${escapeHtml(meta)}</div>
    </article>
  `
}

function renderSessionRelationItem(session, label = "Session") {
  const title = session.summary || `session ${session.sessionId}`
  const subtitle = [label, session.repository ?? "global", session.branch, session.dateKey].filter(Boolean).join(" · ")
  const meta = [
    session.significance ? `significance=${session.significance}` : null,
    session.scope ? `scope=${session.scope}` : null,
    session.updatedAt ? `updated=${formatTime(session.updatedAt)}` : null,
  ].filter(Boolean).join(" · ")

  return `
    <article class="list-item relation-item">
      <div class="item-header-row">
        <div>
          <strong>${escapeHtml(truncateText(title, 180))}</strong>
          <div class="small">${escapeHtml(subtitle)}</div>
        </div>
        ${renderDrilldownAction("session", session.sessionId, "Open")}
      </div>
      ${meta ? `<div class="small">${escapeHtml(meta)}</div>` : ""}
    </article>
  `
}

function renderImprovementRelationItem(improvement) {
  const evidenceKeys = Object.keys(improvement.evidence ?? {}).slice(0, 4)
  const traceKeys = Object.keys(improvement.trace ?? {}).slice(0, 4)
  const meta = [
    `status=${improvement.status}`,
    `review=${improvement.reviewState}`,
    improvement.sourceKind ? `source=${improvement.sourceKind}` : null,
    improvement.supersededBy ? `supersededBy=${improvement.supersededBy}` : null,
  ].filter(Boolean).join(" · ")

  return `
    <article class="list-item relation-item">
      <div><strong>${escapeHtml(improvement.title)}</strong></div>
      <div>${escapeHtml(truncateText(improvement.summary, 220))}</div>
      <div class="small">${escapeHtml(meta)}</div>
      ${evidenceKeys.length > 0 ? `<div class="small">evidence keys: ${escapeHtml(evidenceKeys.join(", "))}</div>` : ""}
      ${traceKeys.length > 0 ? `<div class="small">trace keys: ${escapeHtml(traceKeys.join(", "))}</div>` : ""}
      ${improvement.linkedMemory ? `<div class="small">linked memory: ${escapeHtml(truncateText(improvement.linkedMemory.content, 120))}</div>` : ""}
    </article>
  `
}

function renderGraph(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const nodesByColumn = Object.fromEntries(GRAPH_COLUMNS.map((column) => [column, []]))

  for (const node of nodes) {
    const column = GRAPH_COLUMNS.includes(node.column) ? node.column : "right"
    nodesByColumn[column].push(node)
  }

  const renderNode = (node) => {
    const classes = ["graph-node", `node-${escapeHtml(node.kind || "memory")}`]
    const commonAttrs = `class="${classes.join(" ")}" data-node-id="${escapeHtml(node.id)}"`

    if (node.navigable && node.entityType && node.entityId) {
      return `
        <button
          type="button"
          ${commonAttrs}
          data-drilldown-entity="${escapeHtml(node.entityType)}"
          data-drilldown-id="${escapeHtml(node.entityId)}"
        >
          <span class="graph-node-title">${escapeHtml(node.title)}</span>
          ${node.subtitle ? `<span class="graph-node-subtitle">${escapeHtml(node.subtitle)}</span>` : ""}
          ${node.meta ? `<span class="graph-node-meta">${escapeHtml(node.meta)}</span>` : ""}
          ${node.badge ? `<span class="tag node-badge">${escapeHtml(node.badge)}</span>` : ""}
        </button>
      `
    }

    return `
      <div ${commonAttrs}>
        <span class="graph-node-title">${escapeHtml(node.title)}</span>
        ${node.subtitle ? `<span class="graph-node-subtitle">${escapeHtml(node.subtitle)}</span>` : ""}
        ${node.meta ? `<span class="graph-node-meta">${escapeHtml(node.meta)}</span>` : ""}
        ${node.badge ? `<span class="tag node-badge">${escapeHtml(node.badge)}</span>` : ""}
      </div>
    `
  }

  const nodeIndex = new Map(nodes.map((node) => [node.id, node]))

  return `
    <div class="graph-shell" id="drilldown-graph-shell">
      <svg class="graph-lines" aria-hidden="true"></svg>
      <div class="graph-columns">
        ${GRAPH_COLUMNS.map((column) => `
          <div class="graph-column column-${column}">
            <div class="small graph-column-title">${escapeHtml(GRAPH_COLUMN_TITLES[column])}</div>
            <div class="graph-node-stack">
              ${nodesByColumn[column].map(renderNode).join("") || renderEmptyBlock(`No ${GRAPH_COLUMN_TITLES[column].toLowerCase()} nodes`) }
            </div>
          </div>
        `).join("")}
      </div>
    </div>
    <div class="edge-list small">
      ${edges.map((edge) => {
        const from = nodeIndex.get(edge.from)
        const to = nodeIndex.get(edge.to)
        return `
          <span class="edge-chip">${escapeHtml(from?.title ?? edge.from)} → ${escapeHtml(edge.label)} → ${escapeHtml(to?.title ?? edge.to)}</span>
        `
      }).join("") || renderEmptyBlock("No relationship edges to display.")}
    </div>
  `
}

function drawGraphLines() {
  const shell = document.getElementById("drilldown-graph-shell")
  if (!shell) {
    return
  }

  const svg = shell.querySelector(".graph-lines")
  const nodeElements = new Map(
    Array.from(shell.querySelectorAll("[data-node-id]")).map((element) => [element.dataset.nodeId, element]),
  )
  const graph = state.drilldown.data?.graph
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const rect = shell.getBoundingClientRect()
  const width = Math.max(1, shell.clientWidth)
  const height = Math.max(1, shell.clientHeight)

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  svg.setAttribute("width", width)
  svg.setAttribute("height", height)

  const paths = edges.map((edge) => {
    const fromElement = nodeElements.get(edge.from)
    const toElement = nodeElements.get(edge.to)
    if (!fromElement || !toElement) {
      return ""
    }

    const fromRect = fromElement.getBoundingClientRect()
    const toRect = toElement.getBoundingClientRect()
    const x1 = fromRect.left - rect.left + fromRect.width / 2
    const y1 = fromRect.top - rect.top + fromRect.height / 2
    const x2 = toRect.left - rect.left + toRect.width / 2
    const y2 = toRect.top - rect.top + toRect.height / 2
    const curve = Math.max(36, Math.abs(x2 - x1) / 2)

    return `<path d="M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}" class="graph-edge edge-${escapeHtml(edge.type || "link")}" />`
  }).join("")

  svg.innerHTML = paths
}

function queueGraphDraw() {
  window.requestAnimationFrame(() => drawGraphLines())
}

function renderMemoryDrilldown(data) {
  const focus = data?.focus ?? {}
  const provenance = data?.provenance ?? {}
  const lineage = data?.lineage ?? {}
  const cluster = data?.canonicalCluster
  const improvements = Array.isArray(data?.linkedImprovements) ? data.linkedImprovements : []

  const summaryCards = renderMetricGrid([
    ["Type", focus.type],
    ["Repository", focus.repository ?? "global"],
    ["Scope", focus.scope ?? "repo"],
    ["State", focus.status],
    ["Reinforcements", focus.reinforcementCount ?? 1],
    ["Canonical key", focus.canonicalKey ?? "—"],
  ])

  const provenanceItems = [
    provenance.sourceSession ? renderSessionRelationItem(provenance.sourceSession, "Source session") : "",
    provenance.day ? `
      <article class="list-item relation-item">
        <div><strong>${escapeHtml(provenance.day.dateKey)}</strong></div>
        <div>${escapeHtml(truncateText(provenance.day.summary, 220))}</div>
        <div class="small">repo=${escapeHtml(provenance.day.repository || "global")} · episodes=${escapeHtml(provenance.day.episodeIds.length)}</div>
      </article>
    ` : "",
    ...(Array.isArray(provenance.siblingSessions) ? provenance.siblingSessions.map((session) => renderSessionRelationItem(session, "Same day")) : []),
  ].filter(Boolean).join("")

  const lineageItems = [
    lineage.supersededBy ? renderMemoryRelationItem(lineage.supersededBy, "Superseded by") : "",
    ...(Array.isArray(lineage.supersedes) ? lineage.supersedes.map((memory) => renderMemoryRelationItem(memory, "Supersedes")) : []),
  ].filter(Boolean).join("")

  const clusterItems = cluster
    ? [
      `
        <article class="list-item relation-item">
          <div><strong>${escapeHtml(cluster.key)}</strong></div>
          <div class="small">members=${escapeHtml(cluster.totalMembers)} · active=${escapeHtml(cluster.activeMembers)} · total reinforcement=${escapeHtml(cluster.totalReinforcement)}</div>
        </article>
      `,
      ...(Array.isArray(cluster.members) ? cluster.members.map((memory) => renderMemoryRelationItem(memory, memory.id === focus.id ? "Focused memory" : "Cluster member")) : []),
    ].join("")
    : ""

  const headerSubtitle = [
    focus.entityType,
    focus.repository ?? "global",
    focus.scope ? `scope=${focus.scope}` : null,
    focus.sourceTurnIndex !== null && focus.sourceTurnIndex !== undefined ? `turn=${focus.sourceTurnIndex}` : null,
  ].filter(Boolean).join(" · ")

  views.drilldown.innerHTML = `
    <div class="drilldown-shell">
      <section class="card drilldown-header">
        <div class="item-header-row">
          <div>
            <h2>${escapeHtml(focus.title)}</h2>
            <div class="small">${escapeHtml(headerSubtitle)}</div>
          </div>
          <button type="button" class="action-btn secondary-btn" data-clear-drilldown="true">Clear selection</button>
        </div>
        <p>${escapeHtml(focus.content || focus.title || "")}</p>
        <div class="small">updated=${escapeHtml(formatTime(focus.updatedAt))} · created=${escapeHtml(formatTime(focus.createdAt))} · lastSeen=${escapeHtml(formatTime(focus.lastSeenAt))}</div>
      </section>

      ${summaryCards}

      <section class="card section-card">
        <div class="section-head">
          <div>
            <h2>Focused relationship graph</h2>
            <div class="small">Read-only graph centered on the selected ${escapeHtml(focus.entityType)}.</div>
          </div>
        </div>
        ${renderGraph(data.graph)}
      </section>

      <div class="detail-grid">
        ${renderSectionList("Provenance & day grouping", provenanceItems, "No provenance rows for this memory.", "Session provenance and neighboring episodes on the same day.")}
        ${renderSectionList("Lineage", lineageItems, "No supersession links for this memory.", "Navigate reinforced and superseded memories from here.")}
        ${renderSectionList("Canonical cluster", clusterItems, "This memory is not part of a canonical cluster.", "Cluster members share the same canonical key.")}
        ${renderSectionList("Linked improvements", improvements.map(renderImprovementRelationItem).join(""), "No improvement artifacts linked to this memory.", "Read-only improvement backlog linkage.")}
        <section class="card section-card">
          <div class="section-head"><h2>Metadata</h2></div>
          ${renderMetadataList(focus.metadata)}
        </section>
      </div>
    </div>
  `

  queueGraphDraw()
}

function renderSessionDrilldown(data) {
  const focus = data?.focus ?? {}
  const dayGroup = data?.dayGroup ?? {}
  const sessionMemories = Array.isArray(data?.sessionMemories) ? data.sessionMemories : []
  const improvements = Array.isArray(data?.linkedImprovements) ? data.linkedImprovements : []

  views.drilldown.innerHTML = `
    <div class="drilldown-shell">
      <section class="card drilldown-header">
        <div class="item-header-row">
          <div>
            <h2>${escapeHtml(focus.title)}</h2>
            <div class="small">session · ${escapeHtml([focus.repository ?? "global", focus.branch, focus.dateKey].filter(Boolean).join(" · "))}</div>
          </div>
          <button type="button" class="action-btn secondary-btn" data-clear-drilldown="true">Clear selection</button>
        </div>
        <p>${escapeHtml(focus.summary || "")}</p>
        <div class="small">updated=${escapeHtml(formatTime(focus.updatedAt))} · created=${escapeHtml(formatTime(focus.createdAt))} · significance=${escapeHtml(focus.significance ?? "—")}</div>
      </section>

      ${renderMetricGrid([
        ["Repository", focus.repository ?? "global"],
        ["Scope", focus.scope ?? "repo"],
        ["Actions", focus.actionCount ?? 0],
        ["Decisions", focus.decisionCount ?? 0],
        ["Learnings", focus.learningCount ?? 0],
        ["Open items", focus.openItemCount ?? 0],
      ])}

      <section class="card section-card">
        <div class="section-head">
          <div>
            <h2>Focused relationship graph</h2>
            <div class="small">Session provenance, linked memories, and improvement artifacts.</div>
          </div>
        </div>
        ${renderGraph(data.graph)}
      </section>

      <div class="detail-grid">
        ${renderSectionList(
          "Session highlights",
          [
            focus.actions?.length ? `<article class="list-item relation-item"><strong>Actions</strong><div class="small">${escapeHtml(focus.actions.join(" | "))}</div></article>` : "",
            focus.decisions?.length ? `<article class="list-item relation-item"><strong>Decisions</strong><div class="small">${escapeHtml(focus.decisions.join(" | "))}</div></article>` : "",
            focus.learnings?.length ? `<article class="list-item relation-item"><strong>Learnings</strong><div class="small">${escapeHtml(focus.learnings.join(" | "))}</div></article>` : "",
            focus.openItems?.length ? `<article class="list-item relation-item"><strong>Open items</strong><div class="small">${escapeHtml(focus.openItems.join(" | "))}</div></article>` : "",
            focus.filesChanged?.length ? `<article class="list-item relation-item"><strong>Files changed</strong><div class="small">${escapeHtml(focus.filesChanged.join(" | "))}</div></article>` : "",
          ].filter(Boolean).join(""),
          "No highlight arrays recorded on this session digest.",
          "Pulled from the existing episode digest fields.",
        )}
        ${renderSectionList(
          "Day grouping",
          [
            dayGroup.day ? `
              <article class="list-item relation-item">
                <div><strong>${escapeHtml(dayGroup.day.dateKey)}</strong></div>
                <div>${escapeHtml(truncateText(dayGroup.day.summary, 220))}</div>
                <div class="small">repo=${escapeHtml(dayGroup.day.repository || "global")} · episodes=${escapeHtml(dayGroup.day.episodeIds.length)} · computed=${escapeHtml(formatTime(dayGroup.day.computedAt))}</div>
              </article>
            ` : "",
            ...(Array.isArray(dayGroup.siblingSessions) ? dayGroup.siblingSessions.map((session) => renderSessionRelationItem(session, "Same day")) : []),
          ].filter(Boolean).join(""),
          "No day grouping rows for this session.",
          "Shows the day summary and neighboring sessions from the same day.",
        )}
        ${renderSectionList(
          "Memories from this session",
          sessionMemories.map((memory) => renderMemoryRelationItem(memory, "Session memory")).join(""),
          "No semantic memories reference this session yet.",
          "Read-only memory provenance by source session.",
        )}
        ${renderSectionList(
          "Linked improvements",
          improvements.map(renderImprovementRelationItem).join(""),
          "No improvement artifacts linked to this session's memories.",
          "Improvement backlog records joined through linked_memory_id.",
        )}
      </div>
    </div>
  `

  queueGraphDraw()
}

function renderDrilldownEmpty(message = "Select a memory, session, or workstream from the overview, memories, or episodes tabs to open a focused relationship graph.") {
  state.drilldown.data = null
  views.drilldown.innerHTML = `
    <section class="card drilldown-header empty-drilldown">
      <h2>Focused drill-down</h2>
      <p>${escapeHtml(message)}</p>
      <div class="small">The landing flow stays overview/table-first; this secondary tab is only for scoped exploration.</div>
    </section>
  `
}

function parseDrilldownHash() {
  const hash = window.location.hash.slice(1)
  if (!hash.startsWith("drilldown")) {
    return null
  }
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : ""
  const params = new URLSearchParams(query)
  const entity = params.get("entity")?.trim().toLowerCase()
  const id = params.get("id")?.trim()
  if (!entity || !id) {
    return null
  }
  return { entity, id }
}

function activateTab(tabName) {
  state.tab = tabName
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName)
  })
  Object.entries(views).forEach(([name, element]) => {
    element.classList.toggle("active", name === tabName)
  })
}

async function loadDrilldown(entity, id, { activate = true } = {}) {
  const response = await fetchJson(`/api/drilldown?${new URLSearchParams({ entity, id }).toString()}`)
  state.drilldown = {
    entity,
    id,
    data: response.data,
  }
  if (activate) {
    activateTab("drilldown")
  }

  if (response.data?.entityType === "session") {
    renderSessionDrilldown(response.data)
  } else {
    renderMemoryDrilldown(response.data)
  }
  setStatus("read-only local mode", true)
}

async function syncDrilldownFromHash({ activateIfPresent = false } = {}) {
  const route = parseDrilldownHash()
  if (!route) {
    renderDrilldownEmpty()
    return
  }
  await loadDrilldown(route.entity, route.id, { activate: activateIfPresent })
}

async function navigateToDrilldown(entity, id) {
  const nextHash = `#drilldown?${new URLSearchParams({ entity, id }).toString()}`
  if (window.location.hash === nextHash) {
    await loadDrilldown(entity, id, { activate: true })
    return
  }
  window.location.hash = nextHash
}

function clearDrilldownSelection() {
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
  renderDrilldownEmpty()
  activateTab("overview")
}

async function refreshAll() {
  setStatus("loading…", true)
  try {
    const [healthResponse, overviewResponse, maintenanceResponse, episodesResponse] = await Promise.all([
      fetchJson("/api/health"),
      fetchJson("/api/overview"),
      fetchJson("/api/maintenance"),
      fetchJson("/api/episodes"),
    ])
    setScope(healthResponse.repository ?? null)
    renderOverview(overviewResponse.data)
    renderMaintenance(maintenanceResponse.data)
    renderEpisodes(episodesResponse.data)
    await loadMemories()
    setStatus("read-only local mode", true)
  } catch (error) {
    setStatus(`error: ${error.message}`, false)
    const message = `<p class="row-muted">${escapeHtml(error.message)}</p>`
    Object.values(views).forEach((view) => {
      view.innerHTML = message
    })
  }
}

document.getElementById("tabs").addEventListener("click", (event) => {
  const button = event.target.closest(".tab")
  if (!button) {
    return
  }
  activateTab(button.dataset.tab)
})

document.body.addEventListener("click", (event) => {
  const clearButton = event.target.closest("[data-clear-drilldown]")
  if (clearButton) {
    clearDrilldownSelection()
    return
  }

  const trigger = event.target.closest("[data-drilldown-entity][data-drilldown-id]")
  if (!trigger) {
    return
  }

  event.preventDefault()
  const entity = trigger.dataset.drilldownEntity
  const id = trigger.dataset.drilldownId
  if (!entity || !id) {
    return
  }
  void navigateToDrilldown(entity, id)
})

window.addEventListener("hashchange", () => {
  void syncDrilldownFromHash({ activateIfPresent: true })
})

window.addEventListener("resize", () => {
  if (state.drilldown.data?.graph) {
    queueGraphDraw()
  }
})

await refreshAll()
await syncDrilldownFromHash({ activateIfPresent: true })
setInterval(() => {
  if (state.tab === "overview" || state.tab === "maintenance") {
    void refreshAll()
  }
}, 15000)
