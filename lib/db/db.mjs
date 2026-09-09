import crypto from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./schema.mjs";
import {
  forgetMemory as forgetLifecycleMemory,
  getIngestionCheckpoint as getLifecycleCheckpoint,
  getRepositoryMappings as getLifecycleRepositoryMappings,
  listCaptureHealth as listLifecycleCaptureHealth,
  listSemanticEvidence as listLifecycleSemanticEvidence,
  reconcileGeneratedMemories as reconcileLifecycleMemories,
  saveIngestionCheckpoint as saveLifecycleCheckpoint,
  setRepositoryMapping as setLifecycleRepositoryMapping,
  upsertSessionEvidence as upsertLifecycleEvidence,
} from "./db-memory-lifecycle.mjs";
import { resolveLorePaths } from "../core/lore-paths.mjs";
import { MigrationRunner } from "./db-migration-runner.mjs";
import { readCurrentSuppressions, prepareSnapshotStage } from "./db-snapshot-lifecycle.mjs";
import { registerRetrievalPolicyFunctions } from "./db-retrieval-policy.mjs";
import { nowIso } from "./db-shared.mjs";
import { getStats } from "./db-stats.mjs";
import {
  insertIntentJournalEntry,
  listIntentJournalEntries,
  insertTrajectoryArtifact,
  listTrajectoryArtifacts,
} from "./db-intent-trajectory.mjs";
import {
  upsertActivitySuccess,
  collectDirectActivityRows,
  collectFallbackActivityRows,
  getActivityState,
  deriveActivityStateFallback,
  buildActivityFallbackScope,
  readActivityFallbackRows,
  serializeActivityStateFallback,
  serializeActivityFallbackContext,
  serializeActivityFallbackExtraction,
  serializeActivityFallbackMaintenance,
  serializeActivityFallbackTrace,
  resolveActivityFallbackUpdatedAt,
  readLatestContextFallbackRow,
  readLatestTraceFallbackRow,
  readLatestMaintenanceFallbackRow,
  readLatestExtractionFallbackRow,
  collectActivityFallbackTimestamps,
  buildActivityStateFallbackRow,
} from "./db-activity-state.mjs";
import {
  normalizeRetrievalTraceHook,
  normalizeRetrievalTraceScopeType,
  normalizeRetrievalTraceSectionTitles,
  buildRetrievalTraceSampleRecord,
  writeRetrievalTraceSample,
  insertRetrievalTraceSample,
  pruneRetrievalTraceSamples,
  listRetrievalTraceSamples,
} from "./db-trace-samples.mjs";
import { insertErrorTelemetry, pruneErrorTelemetry } from "./db-error-telemetry.mjs";
import {
  getSemanticMemoryByIds,
  getEpisodeDigestsByIds,
  previewScopeChanges,
  insertScopeOverrideAudit,
  applyScopeChanges,
  listScopeOverrideAudit,
} from "./db-scope-management.mjs";
import {
  upsertImprovementArtifact,
  updateImprovementArtifactStatus,
  getImprovementArtifact,
  setImprovementArtifactProposal,
  listImprovementArtifacts,
} from "./db-improvement-artifacts.mjs";
import {
  countGeneratedSemanticMemoriesBySession,
  getEpisodeDigestBySession,
  createBackfillRun,
  insertBackfillRunItems,
  getBackfillRun,
  listBackfillRunItems,
  updateBackfillRunItem,
  getBackfillRunCounts,
  deriveBackfillRunStatus,
  deriveBackfillRunLastError,
  buildBackfillRunSummaryUpdate,
  writeBackfillRunSummary,
  refreshBackfillRunSummary,
  listBackfillRuns,
} from "./db-backfill-runs.mjs";
import {
  createMaintenanceRun,
  reclaimStaleMaintenanceRuns,
  completeMaintenanceRun,
  listMaintenanceRuns,
  listMaintenanceTaskStates,
  recordMaintenanceTaskStart,
  recordMaintenanceTaskResult,
} from "./db-maintenance-runs.mjs";
import {
  buildSemanticMemoryWriteContext,
  findActiveSuppression,
  isMemorySuppressed,
  listActiveMemorySuppressions,
  findManualSemanticMemoryMatch,
  findScopedSemanticMemoryMatch,
  buildSemanticMemoryMetadata,
  updateManualSemanticMemoryMatch,
  updateProtectedSemanticMemoryMatch,
  updateScopedSemanticMemoryMatch,
  insertNewSemanticMemory,
  upsertManualSemanticMemory,
  upsertScopedSemanticMemory,
  insertSemanticMemory,
  withSemanticMemoryTransaction,
  verifySemanticMemoryDurability,
} from "./db-semantic-memory-write.mjs";
import {
  upsertMemoryDomain,
  getMemoryDomain,
  listMemoryDomains,
  upsertObservation,
  getObservation,
  listObservations,
  deleteGeneratedSemanticMemories,
} from "./db-memory-domain-observation.mjs";
import {
  enqueueDeferredExtraction,
  listDeferredExtractions,
  markDeferredExtractionRunning,
  claimDeferredExtraction,
  heartbeatDeferredExtraction,
  reclaimStaleDeferredExtractions,
  completeDeferredExtraction,
  failDeferredExtraction,
} from "./db-deferred-extraction.mjs";
import {
  listActiveStabilisationMemories,
  listMemoryHygieneEpisodes,
  restoreMemoriesBySupersessionMarker,
} from "./db-memory-hygiene.mjs";
import {
  hasEpisodeDigest,
  upsertEpisodeDigest,
  refreshDaySummary,
  mapRetrievalRepositories,
  searchSemantic,
  searchEpisodes,
  findRelevantEpisodesDetailed,
  findRelevantEpisodes,
  getDaySummary,
  getDaySummaries,
  findRelevantEpisodesByDateDetailed,
} from "./db-episode-search.mjs";
import {
  ensureMemoryEmbeddingTable,
  listSemanticMemoriesForEmbedding,
  countSemanticMemoriesForEmbedding,
  getMemoryEmbedding,
  setMemoryEmbedding,
} from "./db-embedding.mjs";
import {
  searchPromptSemanticRows,
  searchPromptSemanticFallback,
  buildPromptSemanticContext,
  buildEffectivePromptStyleSection,
  filterPromptDaySummaries,
  buildIdentityOnlyEpisodeDetails,
  buildPromptEpisodeContext,
  buildPromptTemporalContext,
  buildPromptCrossRepoContext,
  determinePromptDaySummaryReason,
  buildPromptTemporalVerifier,
  buildPromptContextFlags,
  buildLexicalPrompt,
  resolvePromptRenderTerms,
  buildExplainComputedState,
  collectPromptContext,
  explainPromptContext,
  buildPromptContext,
} from "./db-prompt-context.mjs";

const PRIMARY_SCHEMA_VERSION_TABLE = "lore_schema_version";

function escapeSqlString(value) {
  return String(value || "").replace(/'/g, "''");
}

export class LoreDb {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.lastBackupPath = null;
    this.migrations = new MigrationRunner(this.db, this.config);
  }

  openReadOnly() {
    if (this.db) throw new Error("Database connection is already open");
    const dbPath = this.config.paths.derivedStorePath;
    if (!existsSync(dbPath)) {
      const error = new Error("Lore database is unavailable; preview cannot create a store");
      error.code = "DATABASE_UNAVAILABLE";
      throw error;
    }
    this.preflightSchemaVersion(dbPath);
    this.db = new DatabaseSync(dbPath, { readOnly: true });
    this.readOnly = true;
    this.migrations = new MigrationRunner(this.db, this.config);
    try {
      this.db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
      if (this.getCurrentVersion() !== SCHEMA_VERSION) {
        const error = new Error("Lore schema upgrade required before this preview");
        error.code = "SCHEMA_UPGRADE_REQUIRED";
        throw error;
      }
    } catch (error) {
      this.close();
      throw error;
    }
    return { readOnly: true, schemaVersion: SCHEMA_VERSION };
  }

  openDatabase() {
    this.readOnly = false;
    const dbPath = this.config.paths.derivedStorePath;
    const creatingDatabase = !existsSync(dbPath);
    const directory = path.dirname(dbPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const paths = resolveLorePaths();
    // Setup or manual creation may have left the dedicated home world-readable.
    // Do not change a custom DB parent, the shared legacy home, or a symlink target.
    if (!paths.legacy && path.resolve(directory) === path.resolve(paths.loreHome)) {
      try {
        if (!lstatSync(directory).isSymbolicLink()) chmodSync(directory, 0o700);
      } catch {
        // Best effort: opening an otherwise usable existing store must still work.
      }
    }
    this.db = new DatabaseSync(dbPath);
    if (creatingDatabase) {
      chmodSync(dbPath, 0o600);
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrations = new MigrationRunner(this.db, this.config);
  }

  close() {
    if (!this.db) {
      return;
    }
    try {
      // PASSIVE never blocks or disrupts other connections mid-write; TRUNCATE
      // requires a stronger lock and can race a concurrent writer's in-flight
      // commit when multiple Copilot CLI processes hold lore.db open at once.
      if (!this.readOnly) this.db.exec(`PRAGMA wal_checkpoint(PASSIVE);`);
    } catch {
      // best-effort checkpoint before close
    }
    this.db.close();
    this.db = null;
    this.migrations = new MigrationRunner(this.db, this.config);
  }

  initialize() {
    if (this.db) {
      return { backupPath: this.lastBackupPath };
    }

    const dbPath = this.config.paths.derivedStorePath;
    const hadExistingDatabase = existsSync(dbPath);
    this.preflightSchemaVersion(dbPath);
    this.openDatabase();
    try {
      // Acquire the writer lock before taking the migration decision. The
      // metadata is read again under the lock so two fresh processes cannot
      // both migrate the same stale version.
      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      const lockedVersionInfo = this.getCurrentVersionInfo();
      this.db.exec("ROLLBACK");

      const needsBackup = hadExistingDatabase && (
        lockedVersionInfo.version < SCHEMA_VERSION
        || (lockedVersionInfo.version > 0
          && lockedVersionInfo.tableName
          && lockedVersionInfo.tableName !== PRIMARY_SCHEMA_VERSION_TABLE)
        || (!this.tableExists("lore_activity_state") && this.tableExists("coherence_activity_state"))
      );
      if (needsBackup) {
        this.lastBackupPath = this.backupDatabase();
      }

      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
      const currentVersionInfo = this.getCurrentVersionInfo();
      const currentVersion = currentVersionInfo.version;
      const adoptsSchemaVersion = currentVersion > 0
        && currentVersionInfo.tableName
        && currentVersionInfo.tableName !== PRIMARY_SCHEMA_VERSION_TABLE;
      const adoptsActivityState = !this.tableExists("lore_activity_state")
        && this.tableExists("coherence_activity_state");
      const needsTransaction = adoptsSchemaVersion || adoptsActivityState || currentVersion < SCHEMA_VERSION;
      if (!needsTransaction) {
        this.db.exec("COMMIT");
        return { backupPath: this.lastBackupPath };
      }
      if (adoptsSchemaVersion) {
        this.adoptSchemaVersion(currentVersion);
      }
      this.adoptLegacyActivityStateTable();
      this.migrations.runMigrations(currentVersion, this, { transaction: false });
      this.db.exec("COMMIT");
      return { backupPath: this.lastBackupPath };
    } catch (error) {
      try {
        if (this.db) this.db.exec("ROLLBACK");
      } catch {
        // The transaction may not have been established (for example, when
        // another process holds the writer lock).
      }
      this.close();
      throw error;
    }
  }

  preflightSchemaVersion(dbPath) {
    if (!existsSync(dbPath)) {
      return;
    }
    const readOnlyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = [PRIMARY_SCHEMA_VERSION_TABLE, "coherence_schema_version"];
      for (const tableName of tables) {
        const exists = readOnlyDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(tableName);
        if (!exists) continue;
        const rows = readOnlyDb.prepare(`SELECT version FROM ${tableName}`).all();
        if (rows.some((row) => typeof row.version !== "number" || !Number.isInteger(row.version) || row.version < 0)) {
          throw new Error(`malformed Lore schema version in ${tableName} at ${path.resolve(dbPath)}`);
        }
        const version = rows.length > 0 ? Math.max(...rows.map((row) => row.version)) : 0;
        if (version > SCHEMA_VERSION) {
          throw new Error(
            `unsupported future Lore schema version ${version} (supported through ${SCHEMA_VERSION}) at ${path.resolve(dbPath)}`,
          );
        }
      }
    } finally {
      readOnlyDb.close();
    }
  }

  backupDatabase() {
    const backupDir = this.config.paths.backupDir;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });

    const timestamp = nowIso().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `lore-${timestamp}.db`);
    rmSync(backupPath, { force: true });
    this.ensureOpen();
    this.db.exec(`VACUUM INTO '${escapeSqlString(backupPath)}'`);
    chmodSync(backupPath, 0o600);
    return backupPath;
  }

  restoreFromBackup(backupPath) {
    const normalizedPath = path.resolve(String(backupPath || ""));
    if (!existsSync(normalizedPath)) {
      throw new Error(`backup path does not exist: ${normalizedPath}`);
    }
    const dbPath = this.config.paths.derivedStorePath;
    const currentSuppressions = readCurrentSuppressions(dbPath);
    const stage = `${dbPath}.restore-${crypto.randomUUID()}.tmp`;
    const rescue = `${dbPath}.rescue-${crypto.randomUUID()}`;
    try {
      prepareSnapshotStage({ snapshotPath: normalizedPath, stagePath: stage, suppressions: currentSuppressions,
        upgrade: (stagePath) => {
          const staged = new LoreDb({ ...this.config, paths: { ...this.config.paths, derivedStorePath: stagePath, backupDir: `${stagePath}.backups` } });
          try { staged.initialize(); } finally { staged.close(); rmSync(`${stagePath}.backups`, { recursive: true, force: true }); }
        },
      });

      this.close();
      let movedTarget = false;
      let installedTarget = false;
      const movedSidecars = [];
      try {
        if (existsSync(dbPath)) {
          renameSync(dbPath, rescue);
          movedTarget = true;
        }
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(`${dbPath}${suffix}`)) {
            renameSync(`${dbPath}${suffix}`, `${rescue}${suffix}`);
            movedSidecars.push(suffix);
          }
        }
        renameSync(stage, dbPath);
        installedTarget = true;
        this.openDatabase();
        return { restoredFrom: normalizedPath, rescuePath: movedTarget || movedSidecars.length > 0 ? rescue : null, schemaVersion: this.getCurrentVersion() };
      } catch (error) {
        try { this.close(); } catch { /* best effort before rescue restore */ }
        if (installedTarget) {
          for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
        }
        if (movedTarget && existsSync(rescue)) renameSync(rescue, dbPath);
        for (const suffix of movedSidecars) {
          if (existsSync(`${rescue}${suffix}`)) renameSync(`${rescue}${suffix}`, `${dbPath}${suffix}`);
        }
        if (!this.db && existsSync(dbPath)) this.openDatabase();
        throw error;
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${stage}${suffix}`, { force: true });
    }
  }

  runIndexUpkeep() {
    this.ensureOpen();
    return this.migrations.runIndexUpkeep();
  }

  getCurrentVersion() {
    return this.migrations.getCurrentVersion(this);
  }

  getCurrentVersionInfo() {
    return this.migrations.getCurrentVersionInfo();
  }

  adoptSchemaVersion(version) {
    return this.migrations.adoptSchemaVersion(version);
  }

  tableExists(tableName) {
    return this.migrations.tableExists(tableName);
  }

  adoptLegacyActivityStateTable() {
    return this.migrations.adoptLegacyActivityStateTable(this);
  }

  getPreSchemaMigrationSteps() {
    return this.migrations.getPreSchemaMigrationSteps(this);
  }

  getPostSchemaMigrationSteps() {
    return this.migrations.getPostSchemaMigrationSteps(this);
  }

  applySchemaStatementsMigration() {
    return this.migrations.applySchemaStatementsMigration();
  }

  buildMigrationPlan(currentVersion) {
    return this.migrations.buildMigrationPlan(currentVersion, this);
  }

  runMigrations(currentVersion) {
    return this.migrations.runMigrations(currentVersion, this);
  }

  tableHasColumn(tableName, columnName) {
    return this.migrations.tableHasColumn(tableName, columnName);
  }

  ensureColumn(tableName, columnName, definitionSql) {
    return this.migrations.ensureColumn(tableName, columnName, definitionSql, this);
  }

  applyScopeMigration() {
    return this.migrations.applyScopeMigration(this);
  }

  applyScopeGovernanceMigration() {
    return this.migrations.applyScopeGovernanceMigration(this);
  }

  applyGrowthMemoryMigration() {
    return this.migrations.applyGrowthMemoryMigration(this);
  }

  prepareGrowthMemoryMigration() {
    return this.migrations.prepareGrowthMemoryMigration(this);
  }

  backfillGrowthMemoryCanonicalKeys() {
    return this.migrations.backfillGrowthMemoryCanonicalKeys(this);
  }

  listGrowthMemoryRowsForCanonicalBackfill() {
    return this.migrations.listGrowthMemoryRowsForCanonicalBackfill();
  }

  mergeGrowthMemoryDuplicateUserIdentityRows() {
    return this.migrations.mergeGrowthMemoryDuplicateUserIdentityRows(this);
  }

  listGrowthMigrationCandidates(canonicalKey) {
    return this.migrations.listGrowthMigrationCandidates(canonicalKey);
  }

  getGrowthMigrationLastSeen(candidate) {
    return this.migrations.getGrowthMigrationLastSeen(candidate);
  }

  mergeGrowthMigrationCandidates(candidates, winner) {
    return this.migrations.mergeGrowthMigrationCandidates(candidates, winner, this);
  }

  updateGrowthMigrationWinner(winnerId, mergedState) {
    return this.migrations.updateGrowthMigrationWinner(winnerId, mergedState);
  }

  supersedeGrowthMigrationLosers(winnerId, losers) {
    return this.migrations.supersedeGrowthMigrationLosers(winnerId, losers);
  }

  applyImprovementBacklogMigration() {
    return this.migrations.applyImprovementBacklogMigration(this);
  }

  applyPhase5ImprovementLoopMigration() {
    return this.migrations.applyPhase5ImprovementLoopMigration(this);
  }

  applyTrajectoryArtifactsMigration() {
    return this.migrations.applyTrajectoryArtifactsMigration();
  }

  applyIntentJournalMigration() {
    return this.migrations.applyIntentJournalMigration();
  }

  applyLoreVisibilitySubstrateMigration() {
    return this.migrations.applyLoreVisibilitySubstrateMigration();
  }

  applyMemoryDomainObservationMigration() {
    return this.migrations.applyMemoryDomainObservationMigration(this);
  }

  applyLifecycleFoundationMigration() {
    return this.migrations.applyLifecycleFoundationMigration(this);
  }

  applySessionEvidenceRecordIndexMigration() {
    return this.migrations.applySessionEvidenceRecordIndexMigration(this);
  }

  applyDeferredExtractionLeaseMigration() {
    return this.migrations.applyDeferredExtractionLeaseMigration(this);
  }

  ensureOpen() {
    if (!this.db) {
      throw new Error("lore database is not initialized");
    }
    registerRetrievalPolicyFunctions(this.db);
  }

  getStats(...args) {
    return getStats(this, ...args);
  }

  insertIntentJournalEntry(...args) {
    return insertIntentJournalEntry(this, ...args);
  }

  listIntentJournalEntries(...args) {
    return listIntentJournalEntries(this, ...args);
  }

  insertTrajectoryArtifact(...args) {
    return insertTrajectoryArtifact(this, ...args);
  }

  listTrajectoryArtifacts(...args) {
    return listTrajectoryArtifacts(this, ...args);
  }

  upsertActivitySuccess(...args) {
    return upsertActivitySuccess(this, ...args);
  }

  collectDirectActivityRows(...args) {
    return collectDirectActivityRows(this, ...args);
  }

  collectFallbackActivityRows(...args) {
    return collectFallbackActivityRows(this, ...args);
  }

  getActivityState(...args) {
    return getActivityState(this, ...args);
  }

  deriveActivityStateFallback(...args) {
    return deriveActivityStateFallback(this, ...args);
  }

  buildActivityFallbackScope(...args) {
    return buildActivityFallbackScope(this, ...args);
  }

  readActivityFallbackRows(...args) {
    return readActivityFallbackRows(this, ...args);
  }

  serializeActivityStateFallback(...args) {
    return serializeActivityStateFallback(this, ...args);
  }

  serializeActivityFallbackContext(...args) {
    return serializeActivityFallbackContext(this, ...args);
  }

  serializeActivityFallbackExtraction(...args) {
    return serializeActivityFallbackExtraction(this, ...args);
  }

  serializeActivityFallbackMaintenance(...args) {
    return serializeActivityFallbackMaintenance(this, ...args);
  }

  serializeActivityFallbackTrace(...args) {
    return serializeActivityFallbackTrace(this, ...args);
  }

  resolveActivityFallbackUpdatedAt(...args) {
    return resolveActivityFallbackUpdatedAt(this, ...args);
  }

  readLatestContextFallbackRow(...args) {
    return readLatestContextFallbackRow(this, ...args);
  }

  readLatestTraceFallbackRow(...args) {
    return readLatestTraceFallbackRow(this, ...args);
  }

  readLatestMaintenanceFallbackRow(...args) {
    return readLatestMaintenanceFallbackRow(this, ...args);
  }

  readLatestExtractionFallbackRow(...args) {
    return readLatestExtractionFallbackRow(this, ...args);
  }

  collectActivityFallbackTimestamps(...args) {
    return collectActivityFallbackTimestamps(this, ...args);
  }

  buildActivityStateFallbackRow(...args) {
    return buildActivityStateFallbackRow(this, ...args);
  }

  normalizeRetrievalTraceHook(...args) {
    return normalizeRetrievalTraceHook(this, ...args);
  }

  normalizeRetrievalTraceScopeType(...args) {
    return normalizeRetrievalTraceScopeType(this, ...args);
  }

  normalizeRetrievalTraceSectionTitles(...args) {
    return normalizeRetrievalTraceSectionTitles(this, ...args);
  }

  buildRetrievalTraceSampleRecord(...args) {
    return buildRetrievalTraceSampleRecord(this, ...args);
  }

  writeRetrievalTraceSample(...args) {
    return writeRetrievalTraceSample(this, ...args);
  }

  insertRetrievalTraceSample(...args) {
    return insertRetrievalTraceSample(this, ...args);
  }

  pruneRetrievalTraceSamples(...args) {
    return pruneRetrievalTraceSamples(this, ...args);
  }

  listRetrievalTraceSamples(...args) {
    return listRetrievalTraceSamples(this, ...args);
  }

  insertErrorTelemetry(...args) {
    return insertErrorTelemetry(this, ...args);
  }

  pruneErrorTelemetry(...args) {
    return pruneErrorTelemetry(this, ...args);
  }

  getSemanticMemoryByIds(...args) {
    return getSemanticMemoryByIds(this, ...args);
  }

  getEpisodeDigestsByIds(...args) {
    return getEpisodeDigestsByIds(this, ...args);
  }

  previewScopeChanges(...args) {
    return previewScopeChanges(this, ...args);
  }

  insertScopeOverrideAudit(...args) {
    return insertScopeOverrideAudit(this, ...args);
  }

  applyScopeChanges(...args) {
    return applyScopeChanges(this, ...args);
  }

  listScopeOverrideAudit(...args) {
    return listScopeOverrideAudit(this, ...args);
  }

  upsertImprovementArtifact(...args) {
    return upsertImprovementArtifact(this, ...args);
  }

  updateImprovementArtifactStatus(...args) {
    return updateImprovementArtifactStatus(this, ...args);
  }

  getImprovementArtifact(...args) {
    return getImprovementArtifact(this, ...args);
  }

  setImprovementArtifactProposal(...args) {
    return setImprovementArtifactProposal(this, ...args);
  }

  listImprovementArtifacts(...args) {
    return listImprovementArtifacts(this, ...args);
  }

  countGeneratedSemanticMemoriesBySession(...args) {
    return countGeneratedSemanticMemoriesBySession(this, ...args);
  }

  getEpisodeDigestBySession(...args) {
    return getEpisodeDigestBySession(this, ...args);
  }

  createBackfillRun(...args) {
    return createBackfillRun(this, ...args);
  }

  insertBackfillRunItems(...args) {
    return insertBackfillRunItems(this, ...args);
  }

  getBackfillRun(...args) {
    return getBackfillRun(this, ...args);
  }

  listBackfillRunItems(...args) {
    return listBackfillRunItems(this, ...args);
  }

  updateBackfillRunItem(...args) {
    return updateBackfillRunItem(this, ...args);
  }

  getBackfillRunCounts(...args) {
    return getBackfillRunCounts(this, ...args);
  }

  deriveBackfillRunStatus(...args) {
    return deriveBackfillRunStatus(this, ...args);
  }

  deriveBackfillRunLastError(...args) {
    return deriveBackfillRunLastError(this, ...args);
  }

  buildBackfillRunSummaryUpdate(...args) {
    return buildBackfillRunSummaryUpdate(this, ...args);
  }

  writeBackfillRunSummary(...args) {
    return writeBackfillRunSummary(this, ...args);
  }

  refreshBackfillRunSummary(...args) {
    return refreshBackfillRunSummary(this, ...args);
  }

  listBackfillRuns(...args) {
    return listBackfillRuns(this, ...args);
  }

  createMaintenanceRun(...args) {
    return createMaintenanceRun(this, ...args);
  }

  reclaimStaleMaintenanceRuns(...args) {
    return reclaimStaleMaintenanceRuns(this, ...args);
  }

  completeMaintenanceRun(...args) {
    return completeMaintenanceRun(this, ...args);
  }

  listMaintenanceRuns(...args) {
    return listMaintenanceRuns(this, ...args);
  }

  listMaintenanceTaskStates(...args) {
    return listMaintenanceTaskStates(this, ...args);
  }

  recordMaintenanceTaskStart(...args) {
    return recordMaintenanceTaskStart(this, ...args);
  }

  recordMaintenanceTaskResult(...args) {
    return recordMaintenanceTaskResult(this, ...args);
  }

  buildSemanticMemoryWriteContext(...args) {
    return buildSemanticMemoryWriteContext(this, ...args);
  }

  findActiveSuppression(...args) {
    return findActiveSuppression(this, ...args);
  }

  isMemorySuppressed(...args) {
    return isMemorySuppressed(this, ...args);
  }

  listActiveMemorySuppressions(...args) {
    return listActiveMemorySuppressions(this, ...args);
  }

  findManualSemanticMemoryMatch(...args) {
    return findManualSemanticMemoryMatch(this, ...args);
  }

  findScopedSemanticMemoryMatch(...args) {
    return findScopedSemanticMemoryMatch(this, ...args);
  }

  buildSemanticMemoryMetadata(...args) {
    return buildSemanticMemoryMetadata(this, ...args);
  }

  updateManualSemanticMemoryMatch(...args) {
    return updateManualSemanticMemoryMatch(this, ...args);
  }

  updateProtectedSemanticMemoryMatch(...args) {
    return updateProtectedSemanticMemoryMatch(this, ...args);
  }

  updateScopedSemanticMemoryMatch(...args) {
    return updateScopedSemanticMemoryMatch(this, ...args);
  }

  insertNewSemanticMemory(...args) {
    return insertNewSemanticMemory(this, ...args);
  }

  upsertManualSemanticMemory(...args) {
    return upsertManualSemanticMemory(this, ...args);
  }

  upsertScopedSemanticMemory(...args) {
    return upsertScopedSemanticMemory(this, ...args);
  }

  insertSemanticMemory(...args) {
    return insertSemanticMemory(this, ...args);
  }

  upsertSessionEvidence(evidence, capturedAt = nowIso()) {
    return upsertLifecycleEvidence(this, evidence, capturedAt);
  }

  listSemanticEvidence(memoryId) {
    return listLifecycleSemanticEvidence(this, memoryId);
  }

  reconcileGeneratedMemories(options) {
    return reconcileLifecycleMemories(this, options);
  }

  getIngestionCheckpoint(client, sessionId) {
    return getLifecycleCheckpoint(this, client, sessionId);
  }

  saveIngestionCheckpoint(client, sessionId, state = {}) {
    return saveLifecycleCheckpoint(this, client, sessionId, state);
  }

  listCaptureHealth(options = {}) {
    return listLifecycleCaptureHealth(this, options);
  }

  getRepositoryMappings() {
    return getLifecycleRepositoryMappings(this);
  }

  setRepositoryMapping(options) {
    return setLifecycleRepositoryMapping(this, options);
  }

  withSemanticMemoryTransaction(...args) {
    return withSemanticMemoryTransaction(this, ...args);
  }

  verifySemanticMemoryDurability(...args) {
    return verifySemanticMemoryDurability(this, ...args);
  }

  upsertMemoryDomain(...args) {
    return upsertMemoryDomain(this, ...args);
  }

  getMemoryDomain(...args) {
    return getMemoryDomain(this, ...args);
  }

  listMemoryDomains(...args) {
    return listMemoryDomains(this, ...args);
  }

  upsertObservation(...args) {
    return upsertObservation(this, ...args);
  }

  getObservation(...args) {
    return getObservation(this, ...args);
  }

  listObservations(...args) {
    return listObservations(this, ...args);
  }

  deleteGeneratedSemanticMemories(...args) {
    return deleteGeneratedSemanticMemories(this, ...args);
  }

  enqueueDeferredExtraction(...args) {
    return enqueueDeferredExtraction(this, ...args);
  }

  listDeferredExtractions(...args) {
    return listDeferredExtractions(this, ...args);
  }

  markDeferredExtractionRunning(...args) {
    return markDeferredExtractionRunning(this, ...args);
  }

  claimDeferredExtraction(...args) {
    return claimDeferredExtraction(this, ...args);
  }

  heartbeatDeferredExtraction(...args) {
    return heartbeatDeferredExtraction(this, ...args);
  }

  reclaimStaleDeferredExtractions(...args) {
    return reclaimStaleDeferredExtractions(this, ...args);
  }

  completeDeferredExtraction(...args) {
    return completeDeferredExtraction(this, ...args);
  }

  failDeferredExtraction(...args) {
    return failDeferredExtraction(this, ...args);
  }

  forgetMemory({ id, supersededBy, actor = "user", reason = "manual_forget" }) {
    return forgetLifecycleMemory(this, { id, supersededBy, actor, reason });
  }

  listActiveStabilisationMemories(...args) {
    return listActiveStabilisationMemories(this, ...args);
  }

  listMemoryHygieneEpisodes(...args) {
    return listMemoryHygieneEpisodes(this, ...args);
  }

  restoreMemoriesBySupersessionMarker(...args) {
    return restoreMemoriesBySupersessionMarker(this, ...args);
  }

  hasEpisodeDigest(...args) {
    return hasEpisodeDigest(this, ...args);
  }

  upsertEpisodeDigest(...args) {
    return upsertEpisodeDigest(this, ...args);
  }

  refreshDaySummary(...args) {
    return refreshDaySummary(this, ...args);
  }

  mapRetrievalRepositories(...args) {
    return mapRetrievalRepositories(this, ...args);
  }

  searchSemantic(...args) {
    return searchSemantic(this, ...args);
  }

  ensureMemoryEmbeddingTable(...args) {
    return ensureMemoryEmbeddingTable(this, ...args);
  }

  listSemanticMemoriesForEmbedding(...args) {
    return listSemanticMemoriesForEmbedding(this, ...args);
  }

  countSemanticMemoriesForEmbedding(...args) {
    return countSemanticMemoriesForEmbedding(this, ...args);
  }

  getMemoryEmbedding(...args) {
    return getMemoryEmbedding(this, ...args);
  }

  setMemoryEmbedding(...args) {
    return setMemoryEmbedding(this, ...args);
  }

  searchEpisodes(...args) {
    return searchEpisodes(this, ...args);
  }

  findRelevantEpisodesDetailed(...args) {
    return findRelevantEpisodesDetailed(this, ...args);
  }

  findRelevantEpisodes(...args) {
    return findRelevantEpisodes(this, ...args);
  }

  getDaySummary(...args) {
    return getDaySummary(this, ...args);
  }

  getDaySummaries(...args) {
    return getDaySummaries(this, ...args);
  }

  findRelevantEpisodesByDateDetailed(...args) {
    return findRelevantEpisodesByDateDetailed(this, ...args);
  }

  searchPromptSemanticRows(...args) {
    return searchPromptSemanticRows(this, ...args);
  }

  searchPromptSemanticFallback(...args) {
    return searchPromptSemanticFallback(this, ...args);
  }

  buildPromptSemanticContext(...args) {
    return buildPromptSemanticContext(this, ...args);
  }

  buildEffectivePromptStyleSection(...args) {
    return buildEffectivePromptStyleSection(this, ...args);
  }

  filterPromptDaySummaries(...args) {
    return filterPromptDaySummaries(this, ...args);
  }

  buildIdentityOnlyEpisodeDetails(...args) {
    return buildIdentityOnlyEpisodeDetails(this, ...args);
  }

  buildPromptEpisodeContext(...args) {
    return buildPromptEpisodeContext(this, ...args);
  }

  buildPromptTemporalContext(...args) {
    return buildPromptTemporalContext(this, ...args);
  }

  buildPromptCrossRepoContext(...args) {
    return buildPromptCrossRepoContext(this, ...args);
  }

  determinePromptDaySummaryReason(...args) {
    return determinePromptDaySummaryReason(this, ...args);
  }

  buildPromptTemporalVerifier(...args) {
    return buildPromptTemporalVerifier(this, ...args);
  }

  buildPromptContextFlags(...args) {
    return buildPromptContextFlags(this, ...args);
  }

  buildLexicalPrompt(...args) {
    return buildLexicalPrompt(this, ...args);
  }

  resolvePromptRenderTerms(...args) {
    return resolvePromptRenderTerms(this, ...args);
  }

  buildExplainComputedState(...args) {
    return buildExplainComputedState(this, ...args);
  }

  collectPromptContext(...args) {
    return collectPromptContext(this, ...args);
  }

  explainPromptContext(...args) {
    return explainPromptContext(this, ...args);
  }

  buildPromptContext(...args) {
    return buildPromptContext(this, ...args);
  }
}
