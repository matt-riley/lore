export const SCHEMA_VERSION = 13;

export const SCHEMA_STATEMENTS = [
  `
    CREATE TABLE IF NOT EXISTS semantic_memory (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_session_id TEXT,
      source_turn_index INTEGER,
      scope TEXT NOT NULL DEFAULT 'repo',
      scope_source TEXT NOT NULL DEFAULT 'auto',
      scope_override_actor TEXT,
      scope_override_reason TEXT,
      scope_override_source TEXT,
      scope_override_at TEXT,
      repository TEXT,
      tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded_by TEXT,
      canonical_key TEXT,
      reinforcement_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT,
      expires_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_repository
      ON semantic_memory(repository);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_scope
      ON semantic_memory(scope);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_scope_source
      ON semantic_memory(scope_source);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_type
      ON semantic_memory(type);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_superseded
      ON semantic_memory(superseded_by);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_canonical_key
      ON semantic_memory(canonical_key);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_user_identity_canonical
      ON semantic_memory(type, canonical_key, superseded_by, updated_at DESC);
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
      content,
      tags,
      type,
      content='semantic_memory',
      content_rowid='rowid'
    );
  `,
  `
    CREATE TRIGGER IF NOT EXISTS semantic_memory_ai AFTER INSERT ON semantic_memory BEGIN
      INSERT INTO semantic_fts(rowid, content, tags, type)
      VALUES (new.rowid, new.content, new.tags, new.type);
    END;
  `,
  `
    CREATE TRIGGER IF NOT EXISTS semantic_memory_ad AFTER DELETE ON semantic_memory BEGIN
      INSERT INTO semantic_fts(semantic_fts, rowid, content, tags, type)
      VALUES('delete', old.rowid, old.content, old.tags, old.type);
    END;
  `,
  `
    CREATE TRIGGER IF NOT EXISTS semantic_memory_au AFTER UPDATE ON semantic_memory BEGIN
      INSERT INTO semantic_fts(semantic_fts, rowid, content, tags, type)
      VALUES('delete', old.rowid, old.content, old.tags, old.type);
      INSERT INTO semantic_fts(rowid, content, tags, type)
      VALUES (new.rowid, new.content, new.tags, new.type);
    END;
  `,
  `
    CREATE TABLE IF NOT EXISTS episode_digest (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL DEFAULT 'repo',
      scope_source TEXT NOT NULL DEFAULT 'auto',
      scope_override_actor TEXT,
      scope_override_reason TEXT,
      scope_override_source TEXT,
      scope_override_at TEXT,
      repository TEXT,
      branch TEXT,
      summary TEXT NOT NULL,
      actions_json TEXT NOT NULL DEFAULT '[]',
      decisions_json TEXT NOT NULL DEFAULT '[]',
      learnings_json TEXT NOT NULL DEFAULT '[]',
      files_changed_json TEXT NOT NULL DEFAULT '[]',
      refs_json TEXT NOT NULL DEFAULT '[]',
      significance INTEGER NOT NULL DEFAULT 5,
      themes_json TEXT NOT NULL DEFAULT '[]',
      open_items_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'rule',
      date_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_episode_digest_repository
      ON episode_digest(repository);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_episode_digest_scope
      ON episode_digest(scope);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_episode_digest_scope_source
      ON episode_digest(scope_source);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_episode_digest_date_key
      ON episode_digest(date_key);
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
      summary,
      actions_json,
      decisions_json,
      learnings_json,
      themes_json,
      content='episode_digest',
      content_rowid='rowid'
    );
  `,
  `
    CREATE TRIGGER IF NOT EXISTS episode_digest_ai AFTER INSERT ON episode_digest BEGIN
      INSERT INTO episode_fts(rowid, summary, actions_json, decisions_json, learnings_json, themes_json)
      VALUES (new.rowid, new.summary, new.actions_json, new.decisions_json, new.learnings_json, new.themes_json);
    END;
  `,
  `
    CREATE TRIGGER IF NOT EXISTS episode_digest_ad AFTER DELETE ON episode_digest BEGIN
      INSERT INTO episode_fts(episode_fts, rowid, summary, actions_json, decisions_json, learnings_json, themes_json)
      VALUES('delete', old.rowid, old.summary, old.actions_json, old.decisions_json, old.learnings_json, old.themes_json);
    END;
  `,
  `
    CREATE TRIGGER IF NOT EXISTS episode_digest_au AFTER UPDATE ON episode_digest BEGIN
      INSERT INTO episode_fts(episode_fts, rowid, summary, actions_json, decisions_json, learnings_json, themes_json)
      VALUES('delete', old.rowid, old.summary, old.actions_json, old.decisions_json, old.learnings_json, old.themes_json);
      INSERT INTO episode_fts(rowid, summary, actions_json, decisions_json, learnings_json, themes_json)
      VALUES (new.rowid, new.summary, new.actions_json, new.decisions_json, new.learnings_json, new.themes_json);
    END;
  `,
  `
    CREATE TABLE IF NOT EXISTS day_summary (
      date_key TEXT NOT NULL,
      repository TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      episode_ids_json TEXT NOT NULL DEFAULT '[]',
      computed_at TEXT NOT NULL,
      PRIMARY KEY (date_key, repository)
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS deferred_extraction (
      session_id TEXT PRIMARY KEY,
      repository TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT 'manual',
      queued_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_deferred_extraction_status_available
      ON deferred_extraction(status, available_at);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_deferred_extraction_repository_status
      ON deferred_extraction(repository, status);
  `,
  `
    CREATE TABLE IF NOT EXISTS scope_override_audit (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      previous_scope TEXT,
      next_scope TEXT,
      previous_repository TEXT,
      next_repository TEXT,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_scope_override_audit_target
      ON scope_override_audit(target_type, target_id, created_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS improvement_backlog (
      id TEXT PRIMARY KEY,
      source_case_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      linked_memory_id TEXT,
      superseded_by TEXT,
      proposal_type TEXT,
      proposal_path TEXT,
      proposal_hash TEXT,
      review_state TEXT NOT NULL DEFAULT 'none',
      review_requested_at TEXT,
      review_requested_by TEXT,
      reviewer_decision TEXT,
      reviewer_notes_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_improvement_backlog_status_updated
      ON improvement_backlog(status, updated_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_improvement_backlog_source
      ON improvement_backlog(source_kind, source_case_id, status, updated_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_improvement_backlog_review_state_updated
      ON improvement_backlog(review_state, updated_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_improvement_backlog_proposal_path
      ON improvement_backlog(proposal_path);
  `,
  `
    CREATE TABLE IF NOT EXISTS trajectory_artifact (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      repository TEXT,
      source_case_id TEXT,
      source_kind TEXT,
      improvement_artifact_id TEXT,
      event_key TEXT,
      summary TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      outcome TEXT NOT NULL DEFAULT 'captured',
      latency_ms INTEGER,
      target_ms INTEGER,
      context_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_kind_created
      ON trajectory_artifact(kind, created_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_source_created
      ON trajectory_artifact(source_kind, source_case_id, created_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_repository_kind_created
      ON trajectory_artifact(repository, kind, created_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS coherence_activity_state (
      scope_key TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      repository TEXT,
      last_context_injection_at TEXT,
      last_context_injection_hook TEXT,
      last_context_injection_sections_json TEXT NOT NULL DEFAULT '[]',
      last_context_injection_trace_id TEXT,
      last_context_injection_duration_ms INTEGER,
      last_extraction_completion_at TEXT,
      last_extraction_repository TEXT,
      last_maintenance_completion_at TEXT,
      last_maintenance_status TEXT,
      last_maintenance_run_id TEXT,
      last_trace_recorded_at TEXT,
      last_trace_hook TEXT,
      last_trace_id TEXT,
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_coherence_activity_state_scope_type_repository
      ON coherence_activity_state(scope_type, repository);
  `,
  `
    CREATE TABLE IF NOT EXISTS retrieval_trace_sample (
      id TEXT PRIMARY KEY,
      repository TEXT,
      scope_type TEXT NOT NULL DEFAULT 'repo',
      hook TEXT NOT NULL,
      route TEXT,
      route_reason TEXT,
      context_injected INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      prompt_preview TEXT,
      section_titles_json TEXT NOT NULL DEFAULT '[]',
      prompt_need_json TEXT NOT NULL DEFAULT '{}',
      eligibility_json TEXT NOT NULL DEFAULT '{}',
      lookups_json TEXT NOT NULL DEFAULT '{}',
      omissions_json TEXT NOT NULL DEFAULT '[]',
      output_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '{}',
      recorded_at TEXT NOT NULL
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_retrieval_trace_sample_repository_recorded
      ON retrieval_trace_sample(repository, recorded_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_retrieval_trace_sample_scope_recorded
      ON retrieval_trace_sample(scope_type, recorded_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS intent_journal (
      id TEXT PRIMARY KEY,
      repository TEXT,
      session_id TEXT,
      turn_hint TEXT,
      intent_kind TEXT NOT NULL DEFAULT 'journal',
      summary TEXT NOT NULL,
      rationale TEXT,
      context_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_intent_journal_repository_created
      ON intent_journal(repository, created_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_intent_journal_kind_created
      ON intent_journal(intent_kind, created_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_intent_journal_session_created
      ON intent_journal(session_id, created_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS backfill_run (
      id TEXT PRIMARY KEY,
      strategy TEXT NOT NULL DEFAULT 'session_refresh',
      status TEXT NOT NULL DEFAULT 'pending',
      dry_run INTEGER NOT NULL DEFAULT 0,
      repository TEXT,
      include_other_repositories INTEGER NOT NULL DEFAULT 0,
      refresh_existing INTEGER NOT NULL DEFAULT 1,
      batch_size INTEGER NOT NULL DEFAULT 10,
      total_candidates INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      created_episode_count INTEGER NOT NULL DEFAULT 0,
      refreshed_episode_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      snapshot_path TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_backfill_run_status_updated
      ON backfill_run(status, updated_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS backfill_run_item (
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      repository TEXT,
      ordinal INTEGER NOT NULL,
      planned_action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      semantic_before_count INTEGER,
      semantic_after_count INTEGER,
      semantic_delta INTEGER,
      episode_before_scope TEXT,
      episode_after_scope TEXT,
      processed_at TEXT,
      error TEXT,
      PRIMARY KEY (run_id, session_id),
      FOREIGN KEY (run_id) REFERENCES backfill_run(id) ON DELETE CASCADE
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_backfill_run_item_status_ordinal
      ON backfill_run_item(run_id, status, ordinal);
  `,
  `
    CREATE TABLE IF NOT EXISTS maintenance_run (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      repository TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'planned',
      planned_tasks_json TEXT NOT NULL DEFAULT '[]',
      summary_json TEXT NOT NULL DEFAULT '{}',
      completed_count INTEGER NOT NULL DEFAULT 0,
      needs_attention_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_maintenance_run_status_updated
      ON maintenance_run(status, updated_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS maintenance_task_state (
      task_name TEXT PRIMARY KEY,
      last_status TEXT NOT NULL DEFAULT 'idle',
      last_trigger TEXT,
      last_repository TEXT,
      last_started_at TEXT,
      last_completed_at TEXT,
      last_duration_ms INTEGER NOT NULL DEFAULT 0,
      cursor INTEGER NOT NULL DEFAULT 0,
      total_runs INTEGER NOT NULL DEFAULT 0,
      total_failures INTEGER NOT NULL DEFAULT 0,
      total_needs_attention INTEGER NOT NULL DEFAULT 0,
      last_summary_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS coherence_schema_version (
      version INTEGER NOT NULL
    );
  `,
];
