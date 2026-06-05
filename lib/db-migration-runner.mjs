import {
  buildSemanticCanonicalKey,
  classifyEpisodeDigest,
  classifySemanticMemory,
} from "./memory-scope.mjs";
import { parseJsonArray } from "./json-array-utils.mjs";
import { parseJsonObject } from "./json-object-utils.mjs";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema.mjs";

const PRIMARY_SCHEMA_VERSION_TABLE = "lore_schema_version";
const LEGACY_SCHEMA_VERSION_TABLES = Object.freeze(["coherence_schema_version"]);
const PRIMARY_ACTIVITY_STATE_TABLE = "lore_activity_state";
const LEGACY_ACTIVITY_STATE_TABLE = "coherence_activity_state";

/** @typedef {import("node:sqlite").DatabaseSync} DatabaseSync */
/** @typedef {import("./db.mjs").LoreDb} LoreDb */
/** @typedef {MigrationRunner | LoreDb} MigrationApi */
/** @typedef {{ tableName: string | null, version: number }} SchemaVersionInfo */
/** @typedef {{ label: string, shouldRun: (currentVersion: number) => boolean, run: () => void }} MigrationStep */

function nowIso() {
  return new Date().toISOString();
}

function mergeMigrationTagText(existingTags, incomingTags) {
  const tags = new Set(
    `${existingTags || ""} ${incomingTags || ""}`
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  return [...tags].join(" ");
}

/**
 * Runs schema and follow-on migrations against the shared Lore database handle.
 */
export class MigrationRunner {
  /**
   * @param {DatabaseSync | null} db
   * @param {object} config
   */
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  /**
   * @returns {{ optimizeRows: object[], checkpoint: object, completedAt: string }}
   */
  runIndexUpkeep() {
    const optimizeRows = this.db.prepare(`PRAGMA optimize`).all();
    const checkpoint = this.db.prepare(`PRAGMA wal_checkpoint(PASSIVE)`).get();
    return {
      optimizeRows,
      checkpoint,
      completedAt: nowIso(),
    };
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {number}
   */
  getCurrentVersion(api = this) {
    return api.getCurrentVersionInfo().version;
  }

  /**
   * @returns {SchemaVersionInfo}
   */
  getCurrentVersionInfo() {
    for (const tableName of [PRIMARY_SCHEMA_VERSION_TABLE, ...LEGACY_SCHEMA_VERSION_TABLES]) {
      const hasVersionTable = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(tableName);
      if (!hasVersionTable) {
        continue;
      }
      const row = this.db.prepare(`SELECT MAX(version) AS version FROM ${tableName}`).get();
      const version = typeof row?.version === "number" ? row.version : 0;
      return { tableName, version };
    }
    return { tableName: null, version: 0 };
  }

  /**
   * @param {number} version
   * @returns {void}
   */
  adoptSchemaVersion(version) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${PRIMARY_SCHEMA_VERSION_TABLE} (
        version INTEGER NOT NULL
      );
    `);
    this.db.exec(`DELETE FROM ${PRIMARY_SCHEMA_VERSION_TABLE};`);
    this.db.prepare(`INSERT INTO ${PRIMARY_SCHEMA_VERSION_TABLE} (version) VALUES (?)`).run(version);
  }

  /**
   * @param {string} tableName
   * @returns {boolean}
   */
  tableExists(tableName) {
    return Boolean(
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(tableName),
    );
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  adoptLegacyActivityStateTable(api = this) {
    if (api.tableExists(PRIMARY_ACTIVITY_STATE_TABLE) || !api.tableExists(LEGACY_ACTIVITY_STATE_TABLE)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${LEGACY_ACTIVITY_STATE_TABLE} RENAME TO ${PRIMARY_ACTIVITY_STATE_TABLE}`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_lore_activity_state_scope_type_repository
        ON ${PRIMARY_ACTIVITY_STATE_TABLE}(scope_type, repository);
    `);
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {MigrationStep[]}
   */
  getPreSchemaMigrationSteps(api = this) {
    return [
      {
        label: "legacy-scope-columns",
        shouldRun: (currentVersion) => currentVersion > 0 && currentVersion < 3,
        run: () => {
          api.ensureColumn("semantic_memory", "scope", `TEXT NOT NULL DEFAULT 'repo'`);
          api.ensureColumn("episode_digest", "scope", `TEXT NOT NULL DEFAULT 'repo'`);
        },
      },
      {
        label: "legacy-scope-governance-columns",
        shouldRun: (currentVersion) => currentVersion > 0 && currentVersion < 5,
        run: () => {
          api.ensureColumn("semantic_memory", "scope_source", `TEXT NOT NULL DEFAULT 'auto'`);
          api.ensureColumn("semantic_memory", "scope_override_actor", `TEXT`);
          api.ensureColumn("semantic_memory", "scope_override_reason", `TEXT`);
          api.ensureColumn("semantic_memory", "scope_override_source", `TEXT`);
          api.ensureColumn("semantic_memory", "scope_override_at", `TEXT`);
          api.ensureColumn("episode_digest", "scope_source", `TEXT NOT NULL DEFAULT 'auto'`);
          api.ensureColumn("episode_digest", "scope_override_actor", `TEXT`);
          api.ensureColumn("episode_digest", "scope_override_reason", `TEXT`);
          api.ensureColumn("episode_digest", "scope_override_source", `TEXT`);
          api.ensureColumn("episode_digest", "scope_override_at", `TEXT`);
        },
      },
      {
        label: "legacy-growth-columns",
        shouldRun: (currentVersion) => currentVersion > 0 && currentVersion < 7,
        run: () => {
          api.ensureColumn("semantic_memory", "canonical_key", "TEXT");
          api.ensureColumn("semantic_memory", "reinforcement_count", "INTEGER NOT NULL DEFAULT 1");
          api.ensureColumn("semantic_memory", "last_seen_at", "TEXT");
        },
      },
      {
        label: "phase5-improvement-loop",
        shouldRun: (currentVersion) => currentVersion > 0 && currentVersion < 10,
        run: () => api.applyPhase5ImprovementLoopMigration(),
      },
      {
        label: "trajectory-artifacts",
        shouldRun: (currentVersion) => currentVersion > 0 && currentVersion < 11,
        run: () => api.applyTrajectoryArtifactsMigration(),
      },
      {
        label: "intent-journal",
        shouldRun: (currentVersion) => currentVersion > 0 && currentVersion < 12,
        run: () => api.applyIntentJournalMigration(),
      },
    ];
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {MigrationStep[]}
   */
  getPostSchemaMigrationSteps(api = this) {
    return [
      {
        label: "scope-migration",
        shouldRun: (currentVersion) => currentVersion < 4,
        run: () => api.applyScopeMigration(),
      },
      {
        label: "scope-governance",
        shouldRun: (currentVersion) => currentVersion < 5,
        run: () => api.applyScopeGovernanceMigration(),
      },
      {
        label: "growth-memory",
        shouldRun: (currentVersion) => currentVersion < 7,
        run: () => api.applyGrowthMemoryMigration(),
      },
      {
        label: "improvement-backlog",
        shouldRun: (currentVersion) => currentVersion < 8,
        run: () => api.applyImprovementBacklogMigration(),
      },
      {
        label: "lore-visibility-substrate",
        shouldRun: (currentVersion) => currentVersion < 13,
        run: () => api.applyLoreVisibilitySubstrateMigration(),
      },
      {
        label: "memory-domain-observation",
        shouldRun: (currentVersion) => currentVersion < 14,
        run: () => api.applyMemoryDomainObservationMigration(),
      },
    ];
  }

  /**
   * @returns {void}
   */
  applySchemaStatementsMigration() {
    for (const statement of SCHEMA_STATEMENTS) {
      this.db.exec(statement);
    }
  }

  /**
   * @param {number} currentVersion
   * @param {MigrationApi} [api=this]
   * @returns {MigrationStep[]}
   */
  buildMigrationPlan(currentVersion, api = this) {
    return [
      ...api.getPreSchemaMigrationSteps(),
      {
        label: "schema-statements",
        shouldRun: () => true,
        run: () => api.applySchemaStatementsMigration(),
      },
      ...api.getPostSchemaMigrationSteps(),
    ].filter((step) => step.shouldRun(currentVersion));
  }

  /**
   * @param {number} currentVersion
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  runMigrations(currentVersion, api = this) {
    if (currentVersion >= SCHEMA_VERSION) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      for (const step of api.buildMigrationPlan(currentVersion)) {
        step.run();
      }
      api.adoptSchemaVersion(SCHEMA_VERSION);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * @param {string} tableName
   * @param {string} columnName
   * @returns {boolean}
   */
  tableHasColumn(tableName, columnName) {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    return rows.some((row) => row.name === columnName);
  }

  /**
   * @param {string} tableName
   * @param {string} columnName
   * @param {string} definitionSql
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  ensureColumn(tableName, columnName, definitionSql, api = this) {
    if (api.tableHasColumn(tableName, columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  applyScopeMigration(api = this) {
    api.ensureColumn("semantic_memory", "scope", `TEXT NOT NULL DEFAULT 'repo'`);
    api.ensureColumn("episode_digest", "scope", `TEXT NOT NULL DEFAULT 'repo'`);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_scope
        ON semantic_memory(scope);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_episode_digest_scope
        ON episode_digest(scope);
    `);

    const updateSemantic = this.db.prepare(`
      UPDATE semantic_memory
      SET scope = ?, repository = ?, metadata_json = ?
      WHERE id = ?
    `);
    const semanticRows = this.db.prepare(`
      SELECT id, type, content, scope, repository, tags, metadata_json
      FROM semantic_memory
    `).all();
    for (const row of semanticRows) {
      const classification = classifySemanticMemory({
        type: row.type,
        content: row.content,
        scope: null,
        repository: row.repository,
        tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
        metadata: parseJsonObject(row.metadata_json),
      });
      updateSemantic.run(
        classification.scope,
        classification.repository,
        JSON.stringify(classification.metadata),
        row.id,
      );
    }

    const updateEpisode = this.db.prepare(`
      UPDATE episode_digest
      SET scope = ?, repository = ?
      WHERE id = ?
    `);
    const episodeRows = this.db.prepare(`
      SELECT
        id,
        scope,
        repository,
        summary,
        actions_json,
        decisions_json,
        learnings_json,
        refs_json,
        themes_json,
        open_items_json
      FROM episode_digest
    `).all();
    for (const row of episodeRows) {
      const classification = classifyEpisodeDigest({
        scope: null,
        repository: row.repository,
        summary: row.summary,
        actions: parseJsonArray(row.actions_json),
        decisions: parseJsonArray(row.decisions_json),
        learnings: parseJsonArray(row.learnings_json),
        refs: parseJsonArray(row.refs_json),
        themes: parseJsonArray(row.themes_json),
        openItems: parseJsonArray(row.open_items_json),
      });
      updateEpisode.run(
        classification.scope,
        classification.repository,
        row.id,
      );
    }
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  applyScopeGovernanceMigration(api = this) {
    api.ensureColumn("semantic_memory", "scope_source", `TEXT NOT NULL DEFAULT 'auto'`);
    api.ensureColumn("semantic_memory", "scope_override_actor", `TEXT`);
    api.ensureColumn("semantic_memory", "scope_override_reason", `TEXT`);
    api.ensureColumn("semantic_memory", "scope_override_source", `TEXT`);
    api.ensureColumn("semantic_memory", "scope_override_at", `TEXT`);
    api.ensureColumn("episode_digest", "scope_source", `TEXT NOT NULL DEFAULT 'auto'`);
    api.ensureColumn("episode_digest", "scope_override_actor", `TEXT`);
    api.ensureColumn("episode_digest", "scope_override_reason", `TEXT`);
    api.ensureColumn("episode_digest", "scope_override_source", `TEXT`);
    api.ensureColumn("episode_digest", "scope_override_at", `TEXT`);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_scope_source
        ON semantic_memory(scope_source);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_episode_digest_scope_source
        ON episode_digest(scope_source);
    `);
    this.db.exec(`
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
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scope_override_audit_target
        ON scope_override_audit(target_type, target_id, created_at DESC);
    `);

    this.db.prepare(`
      UPDATE semantic_memory
      SET scope_source = COALESCE(scope_source, 'auto')
    `).run();
    this.db.prepare(`
      UPDATE episode_digest
      SET scope_source = COALESCE(scope_source, 'auto')
    `).run();
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  applyGrowthMemoryMigration(api = this) {
    api.prepareGrowthMemoryMigration();
    api.backfillGrowthMemoryCanonicalKeys();
    api.mergeGrowthMemoryDuplicateUserIdentityRows();
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  prepareGrowthMemoryMigration(api = this) {
    api.ensureColumn("semantic_memory", "canonical_key", "TEXT");
    api.ensureColumn("semantic_memory", "reinforcement_count", "INTEGER NOT NULL DEFAULT 1");
    api.ensureColumn("semantic_memory", "last_seen_at", "TEXT");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_canonical_key
        ON semantic_memory(canonical_key);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_user_identity_canonical
        ON semantic_memory(type, canonical_key, superseded_by, updated_at DESC);
    `);
    try {
      this.db.exec(`INSERT INTO semantic_fts(semantic_fts) VALUES('rebuild');`);
    } catch {
      // best-effort rebuild for legacy DBs before bulk updates
    }

    this.db.prepare(`
      UPDATE semantic_memory
      SET reinforcement_count = CASE
        WHEN reinforcement_count IS NULL OR reinforcement_count < 1 THEN 1
        ELSE reinforcement_count
      END
    `).run();
    this.db.prepare(`
      UPDATE semantic_memory
      SET last_seen_at = COALESCE(last_seen_at, updated_at, created_at)
      WHERE last_seen_at IS NULL
    `).run();
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  backfillGrowthMemoryCanonicalKeys(api = this) {
    const semanticRows = api.listGrowthMemoryRowsForCanonicalBackfill();
    const updateCanonical = this.db.prepare(`
      UPDATE semantic_memory
      SET canonical_key = ?
      WHERE id = ?
    `);
    for (const row of semanticRows) {
      const canonicalKey = buildSemanticCanonicalKey({
        type: row.type,
        content: row.content,
        metadata: parseJsonObject(row.metadata_json),
      });
      if (!canonicalKey) {
        continue;
      }
      updateCanonical.run(canonicalKey, row.id);
    }
  }

  /**
   * @returns {Array<{ id: string, type: string, content: string, metadata_json: string }>} 
   */
  listGrowthMemoryRowsForCanonicalBackfill() {
    return this.db.prepare(`
      SELECT id, type, content, metadata_json
      FROM semantic_memory
      WHERE superseded_by IS NULL
        AND type IN ('user_identity', 'assistant_goal', 'recurring_mistake', 'workstream_overlay')
    `).all();
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  mergeGrowthMemoryDuplicateUserIdentityRows(api = this) {
    const duplicateKeys = this.db.prepare(`
      SELECT canonical_key
      FROM semantic_memory
      WHERE superseded_by IS NULL
        AND type = 'user_identity'
        AND canonical_key IS NOT NULL
      GROUP BY canonical_key
      HAVING COUNT(*) > 1
    `).all();

    for (const { canonical_key: canonicalKey } of duplicateKeys) {
      const candidates = api.listGrowthMigrationCandidates(canonicalKey);
      if (candidates.length <= 1) {
        continue;
      }

      const [winner, ...losers] = candidates;
      const mergedState = api.mergeGrowthMigrationCandidates(candidates, winner);
      api.updateGrowthMigrationWinner(winner.id, mergedState);
      api.supersedeGrowthMigrationLosers(winner.id, losers);
    }
  }

  /**
   * @param {string} canonicalKey
   * @returns {Array<{ id: string, confidence: number | null, reinforcement_count: number | null, last_seen_at: string | null, updated_at: string | null, tags: string | null, metadata_json: string | null, scope_source: string | null }>}
   */
  listGrowthMigrationCandidates(canonicalKey) {
    return this.db.prepare(`
      SELECT
        id,
        confidence,
        reinforcement_count,
        last_seen_at,
        updated_at,
        tags,
        metadata_json,
        scope_source
      FROM semantic_memory
      WHERE superseded_by IS NULL
        AND type = 'user_identity'
        AND canonical_key = ?
      ORDER BY
        CASE WHEN COALESCE(scope_source, 'auto') = 'manual' THEN 0 ELSE 1 END,
        confidence DESC,
        reinforcement_count DESC,
        updated_at DESC
    `).all(canonicalKey);
  }

  /**
   * @param {{ last_seen_at?: string | null, updated_at?: string | null } | null | undefined} candidate
   * @returns {string | null}
   */
  getGrowthMigrationLastSeen(candidate) {
    const timestamps = [candidate?.last_seen_at, candidate?.updated_at]
      .filter((value) => typeof value === "string" && value.length > 0)
      .sort();
    return timestamps.at(-1) ?? null;
  }

  /**
   * @param {Array<{ confidence: number | null, reinforcement_count: number | null, last_seen_at: string | null, updated_at: string | null, tags: string | null, metadata_json: string | null }>} candidates
   * @param {{ confidence: number | null, last_seen_at: string | null, updated_at: string | null, tags: string | null, metadata_json: string | null }} winner
   * @param {MigrationApi} [api=this]
   * @returns {{ reinforcementTotal: number, latestSeen: string, mergedTags: string, mergedMetadata: object, maxConfidence: number }}
   */
  mergeGrowthMigrationCandidates(candidates, winner, api = this) {
    const initialLastSeen = api.getGrowthMigrationLastSeen(winner) || nowIso();
    const initialConfidence = Number.isFinite(winner?.confidence) ? winner.confidence : 1.0;
    return candidates.reduce((state, candidate) => {
      const nextLastSeen = api.getGrowthMigrationLastSeen(candidate);
      return {
        reinforcementTotal: state.reinforcementTotal + (
          Number.isInteger(candidate?.reinforcement_count)
            ? candidate.reinforcement_count
            : 1
        ),
        latestSeen: nextLastSeen && nextLastSeen > state.latestSeen
          ? nextLastSeen
          : state.latestSeen,
        mergedTags: mergeMigrationTagText(state.mergedTags, candidate?.tags),
        mergedMetadata: {
          ...parseJsonObject(candidate?.metadata_json),
          ...state.mergedMetadata,
        },
        maxConfidence: Math.max(
          state.maxConfidence,
          Number.isFinite(candidate?.confidence) ? candidate.confidence : 1.0,
        ),
      };
    }, {
      reinforcementTotal: 0,
      latestSeen: initialLastSeen,
      mergedTags: winner?.tags || "",
      mergedMetadata: parseJsonObject(winner?.metadata_json),
      maxConfidence: initialConfidence,
    });
  }

  /**
   * @param {string} winnerId
   * @param {{ maxConfidence: number, reinforcementTotal: number, latestSeen: string, mergedTags: string, mergedMetadata: object }} mergedState
   * @returns {void}
   */
  updateGrowthMigrationWinner(winnerId, mergedState) {
    this.db.prepare(`
      UPDATE semantic_memory
      SET confidence = ?,
          reinforcement_count = ?,
          last_seen_at = ?,
          tags = ?,
          metadata_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      mergedState.maxConfidence,
      Math.max(mergedState.reinforcementTotal, 1),
      mergedState.latestSeen,
      mergedState.mergedTags,
      JSON.stringify(mergedState.mergedMetadata),
      nowIso(),
      winnerId,
    );
  }

  /**
   * @param {string} winnerId
   * @param {Array<{ id: string }>} losers
   * @returns {void}
   */
  supersedeGrowthMigrationLosers(winnerId, losers) {
    const supersededAt = nowIso();
    const supersedeStatement = this.db.prepare(`
      UPDATE semantic_memory
      SET superseded_by = ?, updated_at = ?
      WHERE id = ?
    `);
    for (const loser of losers) {
      supersedeStatement.run(winnerId, supersededAt, loser.id);
    }
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  applyImprovementBacklogMigration(api = this) {
    api.ensureColumn("improvement_backlog", "linked_memory_id", "TEXT");
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  applyPhase5ImprovementLoopMigration(api = this) {
    api.ensureColumn("improvement_backlog", "proposal_type", "TEXT");
    api.ensureColumn("improvement_backlog", "proposal_path", "TEXT");
    api.ensureColumn("improvement_backlog", "proposal_hash", "TEXT");
    api.ensureColumn("improvement_backlog", "review_state", `TEXT NOT NULL DEFAULT 'none'`);
    api.ensureColumn("improvement_backlog", "review_requested_at", "TEXT");
    api.ensureColumn("improvement_backlog", "review_requested_by", "TEXT");
    api.ensureColumn("improvement_backlog", "reviewer_decision", "TEXT");
    api.ensureColumn("improvement_backlog", "reviewer_notes_json", `TEXT NOT NULL DEFAULT '{}'`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_improvement_backlog_review_state_updated
        ON improvement_backlog(review_state, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_improvement_backlog_proposal_path
        ON improvement_backlog(proposal_path);
    `);
  }

  /**
   * @returns {void}
   */
  applyTrajectoryArtifactsMigration() {
    this.db.exec(`
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
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_kind_created
        ON trajectory_artifact(kind, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_source_created
        ON trajectory_artifact(source_kind, source_case_id, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trajectory_artifact_repository_kind_created
        ON trajectory_artifact(repository, kind, created_at DESC);
    `);
  }

  /**
   * @returns {void}
   */
  applyIntentJournalMigration() {
    this.db.exec(`
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
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_journal_repository_created
        ON intent_journal(repository, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_journal_kind_created
        ON intent_journal(intent_kind, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_intent_journal_session_created
        ON intent_journal(session_id, created_at DESC);
    `);
  }

  /**
   * @returns {void}
   */
  applyLoreVisibilitySubstrateMigration() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lore_activity_state (
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
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_lore_activity_state_scope_type_repository
        ON lore_activity_state(scope_type, repository);
    `);
    this.db.exec(`
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
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_retrieval_trace_sample_repository_recorded
        ON retrieval_trace_sample(repository, recorded_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_retrieval_trace_sample_scope_recorded
        ON retrieval_trace_sample(scope_type, recorded_at DESC);
    `);
  }

  /**
   * @param {MigrationApi} [api=this]
   * @returns {void}
   */
  applyMemoryDomainObservationMigration(api = this) {
    if (api.tableExists("semantic_memory")) {
      api.ensureColumn("semantic_memory", "domain_key", "TEXT");
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_semantic_memory_domain_key
          ON semantic_memory(domain_key);
      `);
    }
  }
}
