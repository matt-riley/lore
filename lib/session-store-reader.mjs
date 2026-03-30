import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const GENERIC_QUERY_TERMS = new Set([
  "again",
  "apply",
  "consistent",
  "conversation",
  "conversations",
  "continue",
  "decision",
  "decisions",
  "history",
  "keep",
  "prior",
  "problem",
  "session",
  "sessions",
  "task",
  "tasks",
  "thing",
  "things",
  "work",
  "worked",
  "working",
]);

const QUERY_ALIASES = {
  chat: ["conversation", "session"],
  lore: ["memory", "history", "session"],
  conversation: ["chat", "session", "history"],
  conversations: ["chat", "session", "history"],
  memory: ["remember", "history", "lore"],
  past: ["history", "prior"],
  previous: ["history", "prior"],
  recall: ["memory", "history", "remember"],
  remember: ["memory", "history", "lore"],
  remembering: ["memory", "history", "lore"],
  retrieval: ["memory", "history", "lore"],
  session: ["conversation", "history"],
};

function normalizeMatchTerm(term) {
  let value = String(term || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (value.endsWith("ies") && value.length > 4) {
    value = `${value.slice(0, -3)}y`;
  } else if (value.endsWith("ing") && value.length > 5) {
    value = value.slice(0, -3);
  } else if (value.endsWith("ed") && value.length > 4) {
    value = value.slice(0, -2);
  } else if (value.endsWith("s") && value.length > 4) {
    value = value.slice(0, -1);
  }
  return value;
}

function sanitizeFtsQuery(query) {
  const directTerms = String(query || "")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/[^a-z0-9\s]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .map(normalizeMatchTerm)
    .filter((term) => term.length > 2)
    .filter((term) => !GENERIC_QUERY_TERMS.has(term));

  const terms = [...new Set(
    directTerms.flatMap((term) => [
      term,
      ...(QUERY_ALIASES[term] ?? []).map((alias) => normalizeMatchTerm(alias)),
    ]).filter((term) => term.length > 2 && !GENERIC_QUERY_TERMS.has(term)),
  )];
  if (terms.length === 0) {
    return "";
  }
  return terms.join(" ");
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenizeText(value) {
  return new Set(
    normalizeText(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(normalizeMatchTerm)
      .filter((term) => term.length > 2),
  );
}

function parseSimpleYaml(text) {
  const result = {};
  for (const line of String(text || "").split("\n")) {
    if (!line.includes(":")) {
      continue;
    }
    const [key, ...rest] = line.split(":");
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }
    result[normalizedKey] = rest.join(":").trim();
  }
  return result;
}

export class SessionStoreReader {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.workspaceCache = new Map();
  }

  initialize() {
    if (this.db) {
      return;
    }
    const configuredPath = this.config?.paths?.rawStorePath;
    if (!configuredPath) {
      throw new Error("session-store.db path is not configured");
    }
    const rawStorePath = path.resolve(String(configuredPath));
    if (!existsSync(rawStorePath)) {
      throw new Error(
        `session-store.db not found at ${rawStorePath}. Lore requires the Copilot CLI session store.`,
      );
    }
    this.db = new DatabaseSync(rawStorePath, { readonly: true });
  }

  ensureOpen() {
    if (!this.db) {
      throw new Error("session-store reader is not initialized");
    }
  }

  getWorkspaceMetadata(sessionId) {
    if (this.workspaceCache.has(sessionId)) {
      return this.workspaceCache.get(sessionId);
    }

    const workspacePath = path.join(
      this.config.paths.copilotHome ?? path.join(os.homedir(), ".copilot"),
      "session-state",
      sessionId,
      "workspace.yaml",
    );

    if (!existsSync(workspacePath)) {
      this.workspaceCache.set(sessionId, null);
      return null;
    }

    const metadata = parseSimpleYaml(readFileSync(workspacePath, "utf8"));
    this.workspaceCache.set(sessionId, metadata);
    return metadata;
  }

  hydrateSessionRow(row) {
    if (!row) {
      return null;
    }
    const baseRow = {
      ...row,
      sessionStoreCreatedAt: row.created_at ?? null,
      sessionStoreUpdatedAt: row.updated_at ?? null,
    };

    const workspace = this.getWorkspaceMetadata(row.id);
    if (!workspace) {
      return baseRow;
    }

    return {
      ...baseRow,
      repository: workspace.repository || row.repository || null,
      branch: workspace.branch || row.branch || null,
      updated_at: workspace.updated_at || row.updated_at,
      workspaceSummary: workspace.summary || null,
    };
  }

  getRecentSessionsWindow({ limit = 50, offset = 0, cursor = null } = {}) {
    this.ensureOpen();
    const boundedLimit = Math.max(1, Math.floor(limit));
    const rows = cursor?.id
      ? this.db.prepare(`
        SELECT id, repository, branch, summary, created_at, updated_at
        FROM sessions
        WHERE COALESCE(updated_at, '') < ?
          OR (COALESCE(updated_at, '') = ? AND id < ?)
        ORDER BY COALESCE(updated_at, '') DESC, id DESC
        LIMIT ?
      `).all(
        cursor.updatedAt ?? "",
        cursor.updatedAt ?? "",
        cursor.id,
        boundedLimit,
      )
      : this.db.prepare(`
        SELECT id, repository, branch, summary, created_at, updated_at
        FROM sessions
        ORDER BY COALESCE(updated_at, '') DESC, id DESC
        LIMIT ?
        OFFSET ?
      `).all(boundedLimit, Math.max(0, Math.floor(offset)));
    return rows.map((row) => this.hydrateSessionRow(row));
  }

  getRecentSessions({ repository, limit = 3 }) {
    const fetchLimit = repository ? Math.max(limit * 20, 50) : limit;
    const hydrated = this.getRecentSessionsWindow({
      limit: fetchLimit,
      offset: 0,
    });
    if (!repository) {
      return hydrated.slice(0, limit);
    }

    return hydrated
      .filter((row) => row.repository === repository)
      .slice(0, limit);
  }

  findSessionsByDate({
    dateKey,
    repository,
    includeOtherRepositories = false,
    limit = 5,
  } = {}) {
    this.ensureOpen();
    const boundedLimit = Math.max(1, Math.floor(limit));
    const scopedToRepository = Boolean(repository) && includeOtherRepositories !== true;
    const fetchLimit = scopedToRepository
      ? Math.max(boundedLimit * 20, 50)
      : boundedLimit;
    const rows = this.db.prepare(`
      SELECT id, repository, branch, summary, created_at, updated_at
      FROM sessions
      WHERE substr(COALESCE(updated_at, created_at), 1, 10) = ?
      ORDER BY COALESCE(updated_at, created_at, '') DESC, id DESC
      LIMIT ?
    `).all(dateKey, fetchLimit);

    const hydrated = rows.map((row) => this.hydrateSessionRow(row));
    const filtered = scopedToRepository
      ? hydrated.filter((row) => row?.repository === repository)
      : hydrated;

    return filtered.slice(0, boundedLimit).map((row) => ({
      session_id: row.id,
      repository: row.repository ?? null,
      branch: row.branch ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      sessionStoreCreatedAt: row.sessionStoreCreatedAt ?? row.created_at ?? null,
      sessionStoreUpdatedAt: row.sessionStoreUpdatedAt ?? row.updated_at ?? null,
      summary: row.summary ?? null,
      workspaceSummary: row.workspaceSummary ?? null,
    }));
  }

  getSessionArtifacts(sessionId) {
    this.ensureOpen();
    const sessionRow = this.db.prepare(`
      SELECT id, cwd, repository, branch, summary, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `).get(sessionId);
    if (!sessionRow) {
      return null;
    }
    const session = this.hydrateSessionRow(sessionRow);

    const checkpoints = this.db.prepare(`
      SELECT checkpoint_number, title, overview, history, work_done, technical_details, important_files, next_steps, created_at
      FROM checkpoints
      WHERE session_id = ?
      ORDER BY checkpoint_number DESC
    `).all(sessionId);

    const files = this.db.prepare(`
      SELECT file_path, tool_name, turn_index, first_seen_at
      FROM session_files
      WHERE session_id = ?
      ORDER BY first_seen_at ASC
    `).all(sessionId);

    const refs = this.db.prepare(`
      SELECT ref_type, ref_value, turn_index, created_at
      FROM session_refs
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId);

    const turns = this.db.prepare(`
      SELECT turn_index, user_message, assistant_response, timestamp
      FROM turns
      WHERE session_id = ?
      ORDER BY turn_index ASC
    `).all(sessionId);

    return {
      session,
      checkpoints,
      files,
      refs,
      turns,
    };
  }

  searchIndex({ query, repository, limit = 5 }) {
    this.ensureOpen();
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT si.session_id, si.content, si.source_type, si.source_id, s.repository, s.branch
      FROM search_index si
      JOIN sessions s ON s.id = si.session_id
      WHERE search_index MATCH ?
      LIMIT ?
    `).all(sanitized, repository ? Math.max(limit * 10, 20) : limit);

    const hydrated = rows.map((row) => {
      const session = this.hydrateSessionRow({
        id: row.session_id,
        repository: row.repository,
        branch: row.branch,
        summary: null,
        created_at: null,
        updated_at: null,
      });
      return {
        ...row,
        repository: session?.repository ?? row.repository,
        branch: session?.branch ?? row.branch,
      };
    });

    if (!repository) {
      return hydrated.slice(0, limit);
    }

    return hydrated
      .filter((row) => row.repository === repository)
      .slice(0, limit);
  }

  findRelevantSessions({ prompt, repository, limit = 5 }) {
    this.ensureOpen();
    const sanitized = sanitizeFtsQuery(prompt);
    if (!sanitized) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT si.session_id, si.content, si.source_type, si.source_id, s.repository, s.branch, s.updated_at
      FROM search_index si
      JOIN sessions s ON s.id = si.session_id
      WHERE search_index MATCH ?
      LIMIT ?
    `).all(sanitized, repository ? Math.max(limit * 20, 40) : Math.max(limit * 10, 20));

    const promptTerms = sanitizeFtsQuery(prompt).split(/\s+/).filter(Boolean);
    const bySession = new Map();

    for (const row of rows) {
      const hydrated = this.hydrateSessionRow({
        id: row.session_id,
        repository: row.repository,
        branch: row.branch,
        summary: null,
        created_at: null,
        updated_at: row.updated_at,
      });
      if (repository && hydrated?.repository !== repository) {
        continue;
      }

      const tokens = tokenizeText(row.content);
      let score = 0;
      for (const term of promptTerms) {
        if (tokens.has(term)) {
          score += 1;
        }
      }
      if (score === 0) {
        continue;
      }

      if (row.source_type.startsWith("checkpoint_")) {
        score += 1.5;
      } else if (row.source_type === "turn") {
        score += 0.5;
      }

      const current = bySession.get(row.session_id);
      const excerpt = normalizeText(row.content).slice(0, 220);
      if (!current || score > current.score) {
        bySession.set(row.session_id, {
          session_id: row.session_id,
          repository: hydrated?.repository ?? row.repository,
          branch: hydrated?.branch ?? row.branch,
          updated_at: hydrated?.updated_at ?? row.updated_at,
          score,
          source_type: row.source_type,
          excerpt,
        });
      }
    }

    return [...bySession.values()]
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return String(right.updated_at).localeCompare(String(left.updated_at));
      })
      .slice(0, limit);
  }
}
