export class SessionSource {
  findSessionsByDate(_options = {}) {
    return [];
  }

  findRelevantSessions(_options = {}) {
    return [];
  }

  close() {}
}

export class EpisodeSessionSource extends SessionSource {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.client = options.client ?? null;
  }

  findSessionsByDate({
    dateKey,
    repository,
    includeOtherRepositories = false,
    limit = 5,
  } = {}) {
    if (!this.db?.db || !dateKey) {
      return [];
    }
    const numericLimit = Math.max(1, Number(limit) || 5);
    const scoped = Boolean(repository) && includeOtherRepositories !== true;
    const sql = scoped
      ? `SELECT session_id, repository, branch, summary, created_at, updated_at
         FROM episode_digest
         WHERE date_key = ? AND (repository = ? OR repository IS NULL)
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?`
      : `SELECT session_id, repository, branch, summary, created_at, updated_at
         FROM episode_digest
         WHERE date_key = ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?`;
    const params = scoped ? [dateKey, repository, numericLimit] : [dateKey, numericLimit];
    try {
      const rows = this.db.db.prepare(sql).all(...params);
      return rows.map((row) => ({
        session_id: row.session_id,
        repository: row.repository ?? null,
        branch: row.branch ?? null,
        created_at: row.created_at ?? null,
        updated_at: row.updated_at ?? null,
        sessionStoreCreatedAt: row.created_at ?? null,
        sessionStoreUpdatedAt: row.updated_at ?? null,
        summary: row.summary ?? null,
        workspaceSummary: null,
      }));
    } catch {
      return [];
    }
  }

  findRelevantSessions({
    prompt,
    repository,
    limit = 5,
  } = {}) {
    if (!this.db?.db || !prompt) {
      return [];
    }
    const numericLimit = Math.max(1, Number(limit) || 5);
    try {
      if (typeof this.db.searchEpisodes === "function") {
        const rows = this.db.searchEpisodes({ query: prompt, repository, limit: numericLimit });
        return rows.map((row) => ({
          session_id: row.session_id ?? row.id,
          repository: row.repository ?? null,
          branch: row.branch ?? null,
          created_at: row.created_at ?? null,
          updated_at: row.updated_at ?? null,
          sessionStoreCreatedAt: row.created_at ?? null,
          sessionStoreUpdatedAt: row.updated_at ?? null,
          summary: row.summary ?? null,
          workspaceSummary: null,
          score: row.score ?? 1,
          source_type: "episode",
          excerpt: (row.summary ?? row.content ?? "").slice(0, 220),
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  close() {}
}
