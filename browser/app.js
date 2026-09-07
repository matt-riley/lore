const state = {
  tab: "overview",
  loreCliPath: null,
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

function renderActivityTable(activityRows) {
  return `
    <h2>Last successful Lore activity</h2>
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
  `
}

function renderWorkstreamItem(ws) {
  return `
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
  `
}

function renderWorkstreamsList(workstreams) {
  return `
    <h2>Active workstreams</h2>
    <div class="list">
      ${workstreams.map(renderWorkstreamItem).join("") || renderEmptyBlock("No active workstreams.")}
    </div>
  `
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeOverviewData(data) {
  return {
    stats: data?.stats ?? {},
    trend: data?.latencyTrend ?? {},
    activityRows: asArray(data?.activity),
    workstreams: asArray(data?.activeWorkstreams),
    dueTasks: data?.maintenance?.dueTasks ?? [],
    captureHealth: asArray(data?.captureHealth),
    indexing: data?.indexing ?? {},
  }
}

function renderCaptureHealth(health) {
  const statusForCapture = (row) => {
    if (row.status) return row.status
    if (row.failureCode) return "failed"
    if (Number(row.pendingBytes) > 0 || row.pendingWork?.branch || row.pendingWork?.cleanup) return "pending"
    return "healthy"
  }
  return `
    <section class="card section-card health-section">
      <div class="section-head">
        <div>
          <h2>Capture health</h2>
          <div class="small">Last successful capture, pending bytes, and resumable native sessions.</div>
        </div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>client / session</th><th>last success</th><th>pending</th><th>status</th><th>resume</th></tr></thead>
          <tbody>
            ${health.map((row) => `
              <tr>
                <td><strong>${escapeHtml(row.client ?? "unknown")}</strong><div class="small">${escapeHtml(row.sessionId ?? "unknown session")}</div><div class="small">origin=${escapeHtml(row.originLabel ?? row.repository ?? "unknown origin")}</div></td>
                <td>${escapeHtml(formatTime(row.lastSuccessAt))}</td>
                <td>${escapeHtml(row.pendingBytes ?? 0)} bytes</td>
                <td>${(() => { const status = statusForCapture(row); return `<span class="tag ${status === "healthy" ? "ok" : "warn"}">${escapeHtml(status)}</span>${row.failureCode ? `<div class="small">failure=${escapeHtml(row.failureCode)}</div>` : ""}<div class="small">offset=${escapeHtml(row.offset ?? 0)}</div>${row.pendingWork?.branch ? '<div class="small">branch reconciliation pending</div>' : ""}${row.pendingWork?.cleanup ? '<div class="small">cleanup pending</div>' : ""}` })()}</td>
                <td>${row.resumeCommand ? `<button type="button" class="action-btn copy-command" data-copy-kind="resume" data-copy-command="${escapeHtml(row.resumeCommand)}" aria-label="Copy resume command">Copy resume command</button><div class="small copy-feedback" aria-live="polite"></div>` : '<span class="small">No resumable source</span>'}</td>
              </tr>
            `).join("") || '<tr><td colspan="5" class="row-muted">No capture checkpoints recorded.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `
}

function renderIndexingCoverage(indexing) {
  const diagnostics = asArray(indexing.fallbackDiagnostics)
  const status = indexing.enabled === false ? "disabled" : `${indexing.coveragePercent ?? 0}% sampled`
  return `
    <section class="card section-card health-section">
      <div class="section-head">
        <div>
          <h2>Embedding coverage</h2>
          <div class="small">Cached vectors augment lexical retrieval. Coverage is a bounded sample of eligible active memories.</div>
        </div>
        <span class="tag ${indexing.enabled === false ? "warn" : "ok"}">${escapeHtml(status)}</span>
      </div>
      ${renderMetricGrid([
        ["Active memories", indexing.totalActive ?? 0],
        ["Indexed", indexing.indexed ?? 0],
        ["Pending", indexing.pending == null ? "not estimated" : indexing.pending],
      ])}
      <div class="small coverage-note">${indexing.enabled === false ? "Embeddings are disabled in configuration; lexical retrieval remains available." : `Indexed ${indexing.indexedSample ?? indexing.indexed ?? 0} of ${indexing.sampleSize ?? indexing.totalActive ?? 0} sampled eligible rows (${escapeHtml(indexing.coverageBasis ?? "bounded eligible sample")}; ${escapeHtml(indexing.dimensionsBasis ?? "cache identity validated")}). Pending is shown only when the eligible set was fully sampled.`}</div>
      ${diagnostics.length > 0 ? `<div class="list compact-list coverage-diagnostics"><strong>Recent fallback diagnostics</strong>${diagnostics.map((row) => `<div class="list-item"><span>${escapeHtml(row.reason)}</span><span class="small">count=${escapeHtml(row.count)}</span></div>`).join("")}</div>` : '<div class="small">No fallback diagnostics in the recent trace sample.</div>'}
    </section>
  `
}

function renderOverview(data) {
  const {
    stats,
    trend,
    activityRows,
    workstreams,
    dueTasks,
    captureHealth,
    indexing,
  } = normalizeOverviewData(data)

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

    ${renderActivityTable(activityRows)}
    <div class="health-grid">
      ${renderCaptureHealth(captureHealth)}
      ${renderIndexingCoverage(indexing)}
    </div>
    ${renderWorkstreamsList(workstreams)}
  `
}

function renderMemoriesFilters(filterData) {
  const types = filterData?.types ?? []
  const scopes = filterData?.scopes ?? []
  const repos = filterData?.repositories ?? []
  const canonicalKeys = filterData?.canonicalKeys ?? []

  return `
    <div class="controls">
      <select id="mem-filter-type" aria-label="Memory type">
        <option value="">type: any</option>
        ${types.map((row) => `<option value="${escapeHtml(row.type)}">${escapeHtml(row.type)} (${row.count})</option>`).join("")}
      </select>

      <select id="mem-filter-scope" aria-label="Memory scope">
        <option value="">scope: any</option>
        ${scopes.map((row) => `<option value="${escapeHtml(row.scope)}">${escapeHtml(row.scope)} (${row.count})</option>`).join("")}
      </select>

      <select id="mem-filter-repo" aria-label="Repository">
        <option value="">repo: any</option>
        ${repos.map((row) => `<option value="${escapeHtml(row.repository)}">${escapeHtml(row.repository)} (${row.count})</option>`).join("")}
      </select>

      <select id="mem-filter-canonical" aria-label="Canonical key">
        <option value="">canonical: any</option>
        ${canonicalKeys.map((row) => `<option value="${escapeHtml(row.canonicalKey)}">${escapeHtml(row.canonicalKey)} (${row.count})</option>`).join("")}
      </select>

      <select id="mem-filter-state" aria-label="Memory state">
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
    <div class="table-wrap" role="region" aria-label="Memory results" tabindex="0">
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
          ${renderMemoryTableRows(rows)}
        </tbody>
      </table>
    </div>
  `
}

function renderMemoryStateTag(row) {
  return row.supersededBy
    ? '<span class="tag warn">superseded</span>'
    : '<span class="tag ok">active</span>'
}

function resolveMemoryDrilldownEntity(row) {
  return row.type === "workstream_overlay" ? "workstream" : "memory"
}

function renderMemoryTableRows(rows) {
  if (rows.length === 0) {
    return '<tr><td colspan="8" class="row-muted">No memories match filters.</td></tr>'
  }
  return rows.map((row) => `
    <tr>
      <td>${escapeHtml(formatTime(row.updatedAt))}</td>
      <td>${escapeHtml(row.type)}</td>
      <td>${escapeHtml(row.scope)}</td>
      <td>${escapeHtml(row.repository ?? "")}</td>
      <td>${escapeHtml(row.canonicalKey ?? "")}</td>
      <td>${renderMemoryStateTag(row)}</td>
      <td><div class="memory-preview">${escapeHtml(row.content)}</div></td>
      <td>${renderDrilldownAction(resolveMemoryDrilldownEntity(row), row.id, "Open")}</td>
    </tr>
  `).join("")
}

function readMemoriesFilterValue(id, fallback = "") {
  return document.getElementById(id)?.value || fallback
}

async function applyMemoriesFiltersFromDom() {
  state.memoriesFilters.type = readMemoriesFilterValue("mem-filter-type")
  state.memoriesFilters.scope = readMemoriesFilterValue("mem-filter-scope")
  state.memoriesFilters.repository = readMemoriesFilterValue("mem-filter-repo")
  state.memoriesFilters.canonicalKey = readMemoriesFilterValue("mem-filter-canonical")
  state.memoriesFilters.state = readMemoriesFilterValue("mem-filter-state", "active")
  state.memoriesFilters.page = 1
  await loadMemories()
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
    button.onclick = async () => applyMemoriesFiltersFromDom()
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

function renderMaintenanceDueTasks(dueTasks) {
  return dueTasks.map((task) => `
    <article class="list-item">
      <div><strong>${escapeHtml(task.label)}</strong> <span class="tag">${escapeHtml(task.dueReason)}</span></div>
      <div class="small">lastRunMinutesAgo=${escapeHtml(task.lastRunMinutesAgo ?? "n/a")} cadenceMinutes=${escapeHtml(task.cadenceMinutes)}</div>
    </article>
  `).join("") || renderEmptyBlock("No due tasks right now.")
}

function renderMaintenanceTaskRows(taskStates) {
  return taskStates.map((row) => `
    <tr>
      <td>${escapeHtml(row.task_name)}</td>
      <td>${escapeHtml(row.last_status)}</td>
      <td>${escapeHtml(row.total_runs)}</td>
      <td>${escapeHtml(row.total_failures)}</td>
      <td>${escapeHtml(row.total_needs_attention)}</td>
      <td>${escapeHtml(formatTime(row.last_completed_at))}</td>
    </tr>
  `).join("") || '<tr><td colspan="6" class="row-muted">No task states.</td></tr>'
}

function renderMaintenanceRunRows(runs) {
  return runs.map((run) => `
    <tr>
      <td>${escapeHtml(formatTime(run.started_at))}</td>
      <td>${escapeHtml(run.status)}</td>
      <td>${escapeHtml(run.trigger)}</td>
      <td>${escapeHtml(run.repository ?? "")}</td>
      <td>${escapeHtml(run.completed_count ?? 0)}</td>
      <td>${escapeHtml(run.failed_count ?? 0)}</td>
      <td>${escapeHtml(run.needs_attention_count ?? 0)}</td>
    </tr>
  `).join("") || '<tr><td colspan="7" class="row-muted">No maintenance runs.</td></tr>'
}

function renderDeferredExtractionRows(deferred) {
  return deferred.map((row) => `
    <tr>
      <td>${escapeHtml(row.sessionId)}</td>
      <td>${escapeHtml(row.repository ?? "")}</td>
      <td>${escapeHtml(row.status)}</td>
      <td>${escapeHtml(row.priority)}</td>
      <td>${escapeHtml(formatTime(row.availableAt))}</td>
      <td>${escapeHtml(row.attempts)}</td>
      <td>${escapeHtml(row.lastError ?? "")}</td>
    </tr>
  `).join("") || '<tr><td colspan="7" class="row-muted">No deferred items.</td></tr>'
}

function renderDoctorReports(doctorReports) {
  return doctorReports.map((row) => `
    <article class="list-item">
      <div><strong>${escapeHtml(row.summary)}</strong></div>
      <div class="small">severity=${escapeHtml(row.severity)} · outcome=${escapeHtml(row.outcome)} · created=${escapeHtml(formatTime(row.created_at))}</div>
    </article>
  `).join("") || renderEmptyBlock("No doctor reports found.")
}

function normalizeMaintenanceData(data) {
  const maintenancePlan = data?.maintenancePlan ?? {}
  return {
    runs: asArray(data?.runs),
    taskStates: asArray(data?.taskStates),
    deferred: asArray(data?.deferred),
    doctorReports: asArray(data?.doctorReports),
    dueTasks: asArray(maintenancePlan.dueTasks),
  }
}

function renderMaintenance(data) {
  const {
    runs,
    taskStates,
    deferred,
    doctorReports,
    dueTasks,
  } = normalizeMaintenanceData(data)

  views.maintenance.innerHTML = `
    <h2>Due maintenance tasks</h2>
    <div class="list">
      ${renderMaintenanceDueTasks(dueTasks)}
    </div>

    <h2>Maintenance task state</h2>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>task</th><th>status</th><th>runs</th><th>failures</th><th>needs attention</th><th>completed</th></tr>
        </thead>
        <tbody>
          ${renderMaintenanceTaskRows(taskStates)}
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
          ${renderMaintenanceRunRows(runs)}
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
          ${renderDeferredExtractionRows(deferred)}
        </tbody>
      </table>
    </div>

    <h2>Doctor reports</h2>
    <div class="list">
      ${renderDoctorReports(doctorReports)}
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

  const renderNodeDetails = (node) => [
    `<span class="graph-node-title">${escapeHtml(node.title)}</span>`,
    node.subtitle ? `<span class="graph-node-subtitle">${escapeHtml(node.subtitle)}</span>` : "",
    node.meta ? `<span class="graph-node-meta">${escapeHtml(node.meta)}</span>` : "",
    node.badge ? `<span class="tag node-badge">${escapeHtml(node.badge)}</span>` : "",
  ].filter(Boolean).join("")

  const renderNode = (node) => {
    const classes = ["graph-node", `node-${escapeHtml(node.kind || "memory")}`]
    const commonAttrs = `class="${classes.join(" ")}" data-node-id="${escapeHtml(node.id)}"`
    const nodeDetails = renderNodeDetails(node)

    if (node.navigable && node.entityType && node.entityId) {
      return `
        <button
          type="button"
          ${commonAttrs}
          data-drilldown-entity="${escapeHtml(node.entityType)}"
          data-drilldown-id="${escapeHtml(node.entityId)}"
        >
          ${nodeDetails}
        </button>
      `
    }

    return `
      <div ${commonAttrs}>
        ${nodeDetails}
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

function countItems(items) {
  return Array.isArray(items) ? items.length : 0
}

function renderDaySummaryRelation(day, extraMeta = []) {
  if (!day) {
    return ""
  }

  return `
    <article class="list-item relation-item">
      <div><strong>${escapeHtml(day.dateKey)}</strong></div>
      <div>${escapeHtml(truncateText(day.summary, 220))}</div>
      <div class="small">${escapeHtml([
        `repo=${day.repository || "global"}`,
        `episodes=${countItems(day.episodeIds)}`,
        ...extraMeta.filter(Boolean),
      ].join(" · "))}</div>
    </article>
  `
}

function renderDrilldownShell({
  title,
  subtitle,
  summary,
  meta,
  summaryCards,
  graphDescription,
  graph,
  detailSections,
}) {
  return `
    <div class="drilldown-shell">
      <section class="card drilldown-header">
        <div class="item-header-row">
          <div>
            <h2>${escapeHtml(title)}</h2>
            <div class="small">${escapeHtml(subtitle)}</div>
          </div>
          <button type="button" class="action-btn secondary-btn" data-clear-drilldown="true">Clear selection</button>
        </div>
        <p>${escapeHtml(summary)}</p>
        <div class="small">${escapeHtml(meta)}</div>
      </section>

      ${summaryCards}

      <section class="card section-card">
        <div class="section-head">
          <div>
            <h2>Focused relationship graph</h2>
            <div class="small">${escapeHtml(graphDescription)}</div>
          </div>
        </div>
        ${renderGraph(graph)}
      </section>

      <div class="detail-grid">
        ${detailSections}
      </div>
    </div>
  `
}

function joinRenderedParts(parts) {
  return parts.filter(Boolean).join("")
}

function buildMemorySummaryCards(focus) {
  return renderMetricGrid([
    ["Type", focus.type],
    ["Repository", focus.repository ?? "global"],
    ["Scope", focus.scope ?? "repo"],
    ["State", focus.status],
    ["Reinforcements", focus.reinforcementCount ?? 1],
    ["Canonical key", focus.canonicalKey ?? "—"],
  ])
}

function buildMemoryHeaderSubtitle(focus) {
  return [
    focus.entityType,
    focus.repository ?? "global",
    focus.scope ? `scope=${focus.scope}` : null,
    focus.sourceTurnIndex !== null && focus.sourceTurnIndex !== undefined ? `turn=${focus.sourceTurnIndex}` : null,
  ].filter(Boolean).join(" · ")
}

function buildMemoryMeta(focus) {
  return [
    `updated=${formatTime(focus.updatedAt)}`,
    `created=${formatTime(focus.createdAt)}`,
    `lastSeen=${formatTime(focus.lastSeenAt)}`,
  ].join(" · ")
}

function buildMemoryProvenanceItems(provenance) {
  return joinRenderedParts([
    provenance.sourceSession ? renderSessionRelationItem(provenance.sourceSession, "Source session") : "",
    renderDaySummaryRelation(provenance.day),
    ...(Array.isArray(provenance.siblingSessions) ? provenance.siblingSessions.map((session) => renderSessionRelationItem(session, "Same day")) : []),
  ])
}

function buildMemoryLineageItems(lineage) {
  return joinRenderedParts([
    lineage.supersededBy ? renderMemoryRelationItem(lineage.supersededBy, "Superseded by") : "",
    ...(Array.isArray(lineage.supersedes) ? lineage.supersedes.map((memory) => renderMemoryRelationItem(memory, "Supersedes")) : []),
  ])
}

function renderMemoryClusterHeader(cluster) {
  if (!cluster) {
    return ""
  }

  return `
    <article class="list-item relation-item">
      <div><strong>${escapeHtml(cluster.key)}</strong></div>
      <div class="small">members=${escapeHtml(cluster.totalMembers)} · active=${escapeHtml(cluster.activeMembers)} · total reinforcement=${escapeHtml(cluster.totalReinforcement)}</div>
    </article>
  `
}

function buildMemoryClusterItems(cluster, focusId) {
  if (!cluster) {
    return ""
  }

  const members = Array.isArray(cluster.members) ? cluster.members : []
  return joinRenderedParts([
    renderMemoryClusterHeader(cluster),
    ...members.map((memory) => renderMemoryRelationItem(memory, memory.id === focusId ? "Focused memory" : "Cluster member")),
  ])
}

function renderMemoryMetadataSection(metadata) {
  return `
    <section class="card section-card">
      <div class="section-head"><h2>Metadata</h2></div>
      ${renderMetadataList(metadata)}
    </section>
  `
}

function renderMemoryLifecycleSection(lifecycle = {}) {
  const state = lifecycle.state ?? {}
  const evidence = ensureArray(lifecycle.evidence)
  const suppressions = ensureArray(lifecycle.suppressions)
  const timeline = ensureArray(lifecycle.timeline)
  const stateText = [
    `memory=${state.memory ?? "unknown"}`,
    `suppression=${state.suppression ?? "none"}`,
    `expiry=${state.expiry ?? "none"}`,
    `correction=${state.correction ?? "none"}`,
  ].join(" · ")
  const evidenceHtml = evidence.map((item) => `
    <article class="list-item provenance-item">
      <div class="item-header-row"><strong>${escapeHtml(item.sourceKind ?? "evidence")}</strong><span class="tag ${item.retiredAt || item.linkRetiredAt ? "warn" : "ok"}">${item.retiredAt || item.linkRetiredAt ? "retired" : "active"}</span></div>
      <div class="small">role=${escapeHtml(item.sourceRole ?? "unattributed")} · confidence basis=${escapeHtml(item.confidenceBasis ?? "not recorded")}</div>
      <div class="small">source ref=${escapeHtml(item.sourceRecordId ?? "not recorded")} · session=${escapeHtml(item.sessionId ?? "not recorded")}</div>
      <div class="small">evidence key=${escapeHtml(item.key ?? "not recorded")}</div>
      <div class="small">captured=${escapeHtml(formatTime(item.capturedAt))} · revision=${escapeHtml(item.revision ?? "not recorded")}</div>
    </article>
  `).join("")
  const suppressionHtml = suppressions.map((item) => `
    <article class="list-item provenance-item">
      <div class="item-header-row"><strong>Suppression</strong><span class="tag ${item.supersededAt ? "ok" : "warn"}">${item.supersededAt ? "superseded" : "active"}</span></div>
      <div class="small">actor=${escapeHtml(item.actor ?? "unknown")} · reason=${escapeHtml(item.reason ?? "not recorded")}</div>
      <div class="small">recorded=${escapeHtml(formatTime(item.createdAt))}</div>
    </article>
  `).join("")
  const timelineHtml = timeline.map((item) => `
    <li><strong>${escapeHtml(item.label ?? item.kind ?? "event")}</strong><span class="small">${escapeHtml(formatTime(item.at))}</span>${item.sourceRole || item.sourceRecordId ? `<div class="small">${escapeHtml([item.sourceRole ? `role=${item.sourceRole}` : null, item.sourceRecordId ? `source ref=${item.sourceRecordId}` : null].filter(Boolean).join(" · "))}</div>` : ""}</li>
  `).join("")
  return `
    <section class="card section-card lifecycle-section">
      <div class="section-head"><div><h2>Evidence & lifecycle</h2><div class="small">Attributed source records and state history. Confidence basis is descriptive, not a probability.</div></div><span class="tag">${escapeHtml(stateText)}</span></div>
      <div class="lifecycle-grid">
        <div><h3>Source evidence</h3><div class="list compact-list">${evidenceHtml || renderEmptyBlock("No evidence links recorded.")}</div></div>
        <div><h3>Suppression state</h3><div class="list compact-list">${suppressionHtml || renderEmptyBlock("No suppression recorded.")}</div></div>
      </div>
      <h3>Timeline</h3>
      <ol class="timeline">${timelineHtml || '<li class="row-muted">No lifecycle events recorded.</li>'}</ol>
    </section>
  `
}

function quoteShell(value) {
  return `'${String(value ?? "").replaceAll("'", "'\"'\"'")}'`
}

function buildPreviewCommand(tool, payload) {
  if (!state.loreCliPath) {
    return null
  }
  return `printf '%s\\n' ${quoteShell(JSON.stringify({ action: "preview", ...payload }))} | node ${quoteShell(state.loreCliPath)} tool ${tool}`
}

function renderAdministrationPreviewSection(focus) {
  const commands = [
    ["Correct", "memory_correct", { memoryId: focus.id, repository: focus.repository ?? undefined, content: "<replacement>", reason: "<reason>" }],
    ["Repair", "memory_repair", { memoryIds: [focus.id], repository: focus.repository ?? undefined }],
    ["Purge", "memory_purge", { memoryIds: [focus.id] }],
  ].map(([label, tool, payload]) => {
    const command = buildPreviewCommand(tool, payload)
    if (!command) {
      return `<article class="list-item admin-command-item"><strong>${escapeHtml(label)} preview</strong><div class="small">CLI path unavailable from the dashboard health response.</div></article>`
    }
    return `
      <article class="list-item admin-command-item">
        <div class="item-header-row"><strong>${escapeHtml(label)} preview</strong><button type="button" class="action-btn copy-command" data-copy-kind="preview" data-copy-command="${escapeHtml(command)}" aria-label="Copy ${escapeHtml(label.toLowerCase())} preview command">Copy preview command</button></div>
        <code class="command-preview">${escapeHtml(command)}</code>
        <div class="small copy-feedback" aria-live="polite"></div>
      </article>
    `
  }).join("")
  return `
    <section class="card section-card administration-section">
      <div class="section-head"><div><h2>Administration previews</h2><div class="small">Copy-only shell commands. Review the report fingerprint before any explicit apply.</div></div><span class="tag warn">preview only</span></div>
      <div class="list compact-list">${commands}</div>
      <div class="small">Purge removes selected derived records while retaining raw sources and recovery snapshots; it is not secure erasure.</div>
    </section>
  `
}

function buildMemoryDetailSections({ focus, provenance, lineage, cluster, improvements, lifecycle }) {
  return joinRenderedParts([
    renderSectionList("Provenance & day grouping", buildMemoryProvenanceItems(provenance), "No provenance rows for this memory.", "Session provenance and neighboring episodes on the same day."),
    renderSectionList("Lineage", buildMemoryLineageItems(lineage), "No supersession links for this memory.", "Navigate reinforced and superseded memories from here."),
    renderSectionList("Canonical cluster", buildMemoryClusterItems(cluster, focus.id), "This memory is not part of a canonical cluster.", "Cluster members share the same canonical key."),
    renderSectionList("Linked improvements", improvements.map(renderImprovementRelationItem).join(""), "No improvement artifacts linked to this memory.", "Read-only improvement backlog linkage."),
    renderMemoryLifecycleSection(lifecycle),
    renderAdministrationPreviewSection(focus),
    renderMemoryMetadataSection(focus.metadata),
  ])
}

function buildSessionSummaryCards(focus) {
  return renderMetricGrid([
    ["Repository", focus.repository ?? "global"],
    ["Scope", focus.scope ?? "repo"],
    ["Actions", focus.actionCount ?? 0],
    ["Decisions", focus.decisionCount ?? 0],
    ["Learnings", focus.learningCount ?? 0],
    ["Open items", focus.openItemCount ?? 0],
  ])
}

function renderHighlightItem(label, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return ""
  }

  return `<article class="list-item relation-item"><strong>${escapeHtml(label)}</strong><div class="small">${escapeHtml(values.join(" | "))}</div></article>`
}

function buildSessionHighlightsItems(focus) {
  return joinRenderedParts([
    renderHighlightItem("Actions", focus.actions),
    renderHighlightItem("Decisions", focus.decisions),
    renderHighlightItem("Learnings", focus.learnings),
    renderHighlightItem("Open items", focus.openItems),
    renderHighlightItem("Files changed", focus.filesChanged),
  ])
}

function buildSessionDayGroupingItems(dayGroup) {
  return joinRenderedParts([
    renderDaySummaryRelation(
      dayGroup.day,
      dayGroup.day?.computedAt ? [`computed=${formatTime(dayGroup.day.computedAt)}`] : [],
    ),
    ...(Array.isArray(dayGroup.siblingSessions) ? dayGroup.siblingSessions.map((session) => renderSessionRelationItem(session, "Same day")) : []),
  ])
}

function buildSessionSubtitle(focus) {
  return `session · ${[focus.repository ?? "global", focus.branch, focus.dateKey].filter(Boolean).join(" · ")}`
}

function buildSessionMeta(focus) {
  return [
    `updated=${formatTime(focus.updatedAt)}`,
    `created=${formatTime(focus.createdAt)}`,
    `significance=${focus.significance ?? "—"}`,
  ].join(" · ")
}

function buildSessionDetailSections({ focus, dayGroup, sessionMemories, improvements }) {
  return joinRenderedParts([
    renderSectionList(
      "Session highlights",
      buildSessionHighlightsItems(focus),
      "No highlight arrays recorded on this session digest.",
      "Pulled from the existing episode digest fields.",
    ),
    renderSectionList(
      "Day grouping",
      buildSessionDayGroupingItems(dayGroup),
      "No day grouping rows for this session.",
      "Shows the day summary and neighboring sessions from the same day.",
    ),
    renderSectionList(
      "Memories from this session",
      sessionMemories.map((memory) => renderMemoryRelationItem(memory, "Session memory")).join(""),
      "No semantic memories reference this session yet.",
      "Read-only memory provenance by source session.",
    ),
    renderSectionList(
      "Linked improvements",
      improvements.map(renderImprovementRelationItem).join(""),
      "No improvement artifacts linked to this session's memories.",
      "Improvement backlog records joined through linked_memory_id.",
    ),
  ])
}

function ensureDefaultValue(value, defaultValue = {}) {
  return value ?? defaultValue
}

function ensureArray(value) {
  return Array.isArray(value) ? value : []
}

function renderMemoryDrilldown(data) {
  const focus = ensureDefaultValue(data?.focus)
  const provenance = ensureDefaultValue(data?.provenance)
  const lineage = ensureDefaultValue(data?.lineage)
  const cluster = data?.canonicalCluster
  const improvements = ensureArray(data?.linkedImprovements)
  const lifecycle = ensureDefaultValue(data?.lifecycle)

  views.drilldown.innerHTML = renderDrilldownShell({
    title: focus.title,
    subtitle: buildMemoryHeaderSubtitle(focus),
    summary: focus.content || focus.title || "",
    meta: buildMemoryMeta(focus),
    summaryCards: buildMemorySummaryCards(focus),
    graphDescription: `Read-only graph centered on the selected ${focus.entityType}.`,
    graph: data.graph,
    detailSections: buildMemoryDetailSections({ focus, provenance, lineage, cluster, improvements, lifecycle }),
  })

  queueGraphDraw()
}

function renderSessionDrilldown(data) {
  const focus = ensureDefaultValue(data?.focus)
  const dayGroup = ensureDefaultValue(data?.dayGroup)
  const sessionMemories = ensureArray(data?.sessionMemories)
  const improvements = ensureArray(data?.linkedImprovements)

  views.drilldown.innerHTML = renderDrilldownShell({
    title: focus.title,
    subtitle: buildSessionSubtitle(focus),
    summary: focus.summary || "",
    meta: buildSessionMeta(focus),
    summaryCards: buildSessionSummaryCards(focus),
    graphDescription: "Session provenance, linked memories, and improvement artifacts.",
    graph: data.graph,
    detailSections: buildSessionDetailSections({ focus, dayGroup, sessionMemories, improvements }),
  })

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
  try {
    await loadDrilldown(route.entity, route.id, { activate: activateIfPresent })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    renderDrilldownEmpty(`This ${route.entity} is no longer available. The rest of the dashboard remains available; refresh the source view to choose another record.`)
    setStatus("record unavailable", false)
    if (activateIfPresent) activateTab("drilldown")
    console.warn(message)
  }
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
    state.loreCliPath = typeof healthResponse.loreCliPath === "string" ? healthResponse.loreCliPath : null
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
  const copyButton = event.target.closest("[data-copy-command]")
  if (copyButton) {
    const command = copyButton.dataset.copyCommand
    const copyKind = copyButton.dataset.copyKind === "resume" ? "resume" : "preview"
    const idleLabel = copyKind === "resume" ? "Copy resume command" : "Copy preview command"
    const copiedLabel = copyKind === "resume" ? "Copied resume command" : "Copied preview command"
    const feedback = copyButton.parentElement?.querySelector?.(".copy-feedback")
      ?? copyButton.closest?.(".admin-command-item")?.querySelector?.(".copy-feedback")
    if (!command) {
      return
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      if (feedback) feedback.textContent = "Clipboard unavailable; select the command from the page source."
      return
    }
    void navigator.clipboard.writeText(command).then(() => {
      if (feedback) feedback.textContent = copiedLabel
      copyButton.textContent = "Copied"
      window.setTimeout(() => {
        copyButton.textContent = idleLabel
        if (feedback) feedback.textContent = ""
      }, 1600)
    }).catch(() => {
      if (feedback) feedback.textContent = "Copy failed; command remains available in the page."
    })
    return
  }

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
