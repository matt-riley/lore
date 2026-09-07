import { createHash } from "node:crypto";

export const REPOSITORY_TABLES = ["semantic_memory", "episode_digest", "day_summary", "memory_domain", "refreshable_observation", "deferred_extraction", "improvement_backlog", "trajectory_artifact", "intent_journal", "backfill_run", "retrieval_trace_sample", "lore_activity_state", "session_evidence", "ingestion_checkpoint"];
export const MAPPING_TABLES = [...REPOSITORY_TABLES, "memory_suppression"];
export const exists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
export const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const object = (value) => { try { return JSON.parse(value ?? "{}"); } catch { return {}; } };
const placeholders = (values) => values.map(() => "?").join(",");
export function rowKey(db, table, row) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
  if (!columns.length) throw new Error(`No administration identity for ${table}`);
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}
export function candidateId(table, key) { return `aggregate:${table}:${JSON.stringify(key)}`; }
export function mutateRow(db, table, key, updates = null) {
  const where = Object.keys(key).map((column) => `${column} IS ?`).join(" AND ");
  if (updates) db.prepare(`UPDATE ${table} SET ${Object.keys(updates).map((column) => `${column}=?`).join(",")} WHERE ${where}`).run(...Object.values(updates), ...Object.values(key));
  else db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...Object.values(key));
}

export function buildRowPlan(db, request) {
  const tables = {}, unresolved = [];
  const collect = (table, where, args = []) => {
    if (!exists(db, table)) return [];
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid LIMIT ?`).all(...args, request.limit + 1);
    if (rows.length > request.limit) unresolved.push({ code: "BOUND_REACHED", table, limit: request.limit });
    const prior = tables[table] ?? [];
    const unique = new Map([...prior, ...rows].map((row) => [JSON.stringify(rowKey(db, table, row)), row]));
    tables[table] = [...unique.values()];
    if (tables[table].length > request.limit && !unresolved.some((item) => item.table === table)) unresolved.push({ code: "BOUND_REACHED", table, limit: request.limit });
    return rows;
  };
  if (request.memoryIds.length) collect("semantic_memory", `id IN (${placeholders(request.memoryIds)})`, request.memoryIds);
  else if (request.repository && !request.repositoryMappings.length) collect("semantic_memory", "repository = ?", [request.repository]);
  else if (request.scope === "global" && request.operation === "purge") collect("semantic_memory", "scope = 'global'");
  else if (request.sessionIds.length) collect("semantic_memory", `source_session_id IN (${placeholders(request.sessionIds)}) OR id IN (SELECT me.memory_id FROM memory_evidence me JOIN session_evidence se ON se.evidence_key=me.evidence_key WHERE se.session_id IN (${placeholders(request.sessionIds)}))`, [...request.sessionIds, ...request.sessionIds]);
  const memories = tables.semantic_memory ?? [];
  const ids = memories.map((row) => row.id);
  if (request.memoryIds.some((id) => !ids.includes(id))) unresolved.push({ code: "MEMORY_NOT_FOUND", selector: request.memoryIds.filter((id) => !ids.includes(id)) });
  if (request.operation !== "correct" && request.repository && memories.some((row) => row.repository !== request.repository)) unresolved.push({ code: "FOREIGN_TARGET" });
  if (ids.length) {
    collect("memory_evidence", `memory_id IN (${placeholders(ids)})`, ids);
    collect("memory_embedding", `memory_id IN (${placeholders(ids)})`, ids);
    collect("improvement_backlog", `linked_memory_id IN (${placeholders(ids)})`, ids);
    collect("scope_override_audit", `target_type='semantic' AND target_id IN (${placeholders(ids)})`, ids);
  }
  const evidenceKeys = (tables.memory_evidence ?? []).map((row) => row.evidence_key);
  if (evidenceKeys.length) collect("session_evidence", `evidence_key IN (${placeholders(evidenceKeys)})`, evidenceKeys);
  if (request.operation === "repair" && request.repository) {
    collect("episode_digest", "repository=?", [request.repository]);
    collect("ingestion_checkpoint", "repository=?", [request.repository]);
  }
  const sessions = [...new Set([...request.sessionIds, ...(tables.episode_digest ?? []).map((row) => row.session_id), ...(tables.ingestion_checkpoint ?? []).map((row) => row.session_id), ...memories.map((row) => row.source_session_id), ...(tables.session_evidence ?? []).map((row) => row.session_id)].filter(Boolean))];
  for (const table of ["episode_digest", "ingestion_checkpoint", "deferred_extraction", "intent_journal", "backfill_run_item"]) if (sessions.length) collect(table, `session_id IN (${placeholders(sessions)})`, sessions);
  for (const episode of tables.episode_digest ?? []) collect("day_summary", "date_key=? AND repository IS ?", [episode.date_key, episode.repository ?? ""]);
  for (const memory of memories) if (memory.domain_key) {
    for (const table of ["memory_domain", "refreshable_observation"]) collect(table, "domain_key=? AND repository IS ? AND scope=?", [memory.domain_key, memory.repository, memory.scope]);
  }
  // JSON provenance is matched as complete scalar IDs, never SQL wildcard text.
  const refs = [...new Set([...ids, ...sessions])];
  if (refs.length) for (const [table, columns] of [["trajectory_artifact", ["context_json", "trace_json"]], ["retrieval_trace_sample", ["lookups_json", "trace_json", "output_json"]]]) {
    const clauses = columns.map((column) => `EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END) j WHERE j.type='text' AND j.value IN (${placeholders(refs)}) AND (j.key IN ('memoryId','memory_id','sessionId','session_id','source_case_id') OR instr(j.fullkey, '.memoryIds[')>0 OR instr(j.fullkey, '.sessionIds[')>0))`);
    const args = columns.flatMap(() => refs);
    if (table === "trajectory_artifact") { clauses.push(`source_case_id IN (${placeholders(refs)})`); args.push(...refs); }
    collect(table, clauses.join(" OR "), args);
  }
  if (refs.length) collect("improvement_backlog", `source_case_id IN (${placeholders(refs)})`, refs);
  const runIds = [...new Set((tables.backfill_run_item ?? []).map((row) => row.run_id))];
  if (runIds.length) collect("backfill_run", `id IN (${placeholders(runIds)})`, runIds);
  if (request.operation === "purge") {
    // Provenance-free literal copies are uncertain whole aggregates, requiring
    // explicit selection. Exact content matching never treats short IDs as text.
    for (const table of REPOSITORY_TABLES.filter((name) => !["semantic_memory", "session_evidence", "ingestion_checkpoint"].includes(name))) {
      if (!exists(db, table)) continue;
      const fields = db.prepare(`PRAGMA table_info(${table})`).all().filter((column) => /TEXT/i.test(column.type) && !column.pk && !["repository", "scope", "source_session_id", "session_id"].includes(column.name)).map((column) => column.name);
      for (const memory of memories) {
        if (!fields.length || !memory.content) continue;
        const values = [memory.content, JSON.stringify(memory.content).slice(1, -1)];
        collect(table, `repository IS ? AND (${fields.map((field) => `(instr(${field},?)>0 OR instr(${field},?)>0)`).join(" OR ")})`, [memory.repository, ...fields.flatMap(() => values)]);
      }
    }
  }
  if (request.repository && request.operation === "purge") {
    for (const table of REPOSITORY_TABLES) collect(table, "repository=?", [request.repository]);
  }
  const mappings = [];
  for (const mapping of request.repositoryMappings) {
    const changes = [], destination = {};
    const existingMapping = db.prepare("SELECT canonical FROM repository_identity_mapping WHERE legacy=?").get(mapping.legacy);
    if (existingMapping && existingMapping.canonical !== mapping.canonical) unresolved.push({ code: "MAPPING_COLLISION", selector: mapping });
    for (const table of MAPPING_TABLES) {
      const rows = collect(table, "repository=?", [mapping.legacy]);
      for (const row of rows) changes.push({ table, key: rowKey(db, table, row), row, updates: { repository: mapping.canonical } });
      if (exists(db, table)) {
        destination[table] = db.prepare(`SELECT * FROM ${table} WHERE repository=? ORDER BY rowid LIMIT ?`).all(mapping.canonical, request.limit + 1);
        if (destination[table].length > request.limit) unresolved.push({ code: "BOUND_REACHED", table, selector: mapping.canonical });
      }
    }
    for (const row of collect("scope_override_audit", "previous_repository=? OR next_repository=?", [mapping.legacy, mapping.legacy])) changes.push({ table: "scope_override_audit", key: rowKey(db, "scope_override_audit", row), row, updates: { previous_repository: row.previous_repository === mapping.legacy ? mapping.canonical : row.previous_repository, next_repository: row.next_repository === mapping.legacy ? mapping.canonical : row.next_repository } });
    if (!changes.length) unresolved.push({ code: "LEGACY_IDENTITY_NOT_FOUND", selector: mapping.legacy });
    if (changes.some((change) => change.table === "day_summary" && destination.day_summary.some((row) => row.date_key === change.row.date_key)
      || change.table === "semantic_memory" && destination.semantic_memory.some((row) => !row.superseded_by && !change.row.superseded_by && row.type === change.row.type && row.scope === change.row.scope && (row.canonical_key && row.canonical_key === change.row.canonical_key || row.content === change.row.content)))) unresolved.push({ code: "MAPPING_COLLISION", selector: mapping });
    for (const prior of mappings.filter((item) => item.canonical === mapping.canonical)) {
      const collision = changes.some((change) => prior.changes.some((other) => change.table === other.table && (
        change.table === "day_summary" && change.row.date_key === other.row.date_key
        || change.table === "semantic_memory" && !change.row.superseded_by && !other.row.superseded_by && change.row.type === other.row.type && change.row.scope === other.row.scope && (change.row.canonical_key && change.row.canonical_key === other.row.canonical_key || change.row.content === other.row.content))));
      if (collision) unresolved.push({ code: "MAPPING_COLLISION", selector: mapping });
    }
    mappings.push({ ...mapping, candidateId: `mapping:${mapping.legacy}->${mapping.canonical}`, changes, destination });
  }
  const aggregates = [];
  if (request.operation === "purge") {
    const direct = new Set(["semantic_memory", "memory_evidence", "memory_embedding", "scope_override_audit"]);
    for (const [table, rows] of Object.entries(tables)) {
      if (direct.has(table)) continue;
      for (const row of rows) {
        if (table === "session_evidence") {
          const shared = db.prepare(`SELECT memory_id FROM memory_evidence WHERE evidence_key=? AND memory_id NOT IN (${placeholders(ids) || "NULL"})`).all(row.evidence_key, ...ids);
          if (!shared.length) continue;
          unresolved.push({ code: "SHARED_EVIDENCE", table, key: rowKey(db, table, row), memoryIds: shared.map((item) => item.memory_id) });
          continue;
        }
        const key = rowKey(db, table, row);
        aggregates.push({ candidateId: candidateId(table, key), table, key });
      }
    }
    if (aggregates.length && !request.includeDependentAggregates) unresolved.push({ code: "DEPENDENT_AGGREGATES_REQUIRE_SELECTION", selector: aggregates.map((row) => row.candidateId), detail: "These derived copies may retain selected plaintext. Preview with includeDependentAggregates, then explicitly select these candidate IDs." });
  }
  return { tables, memories, sessions, mappings, aggregates, unresolved };
}
