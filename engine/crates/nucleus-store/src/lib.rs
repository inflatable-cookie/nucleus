//! The Rust engine's independent `SQLite` database.

mod allowance;
mod barge;
mod board_state;
pub use board_state::BoardTimes;
mod dependencies;
mod github_accounts;
mod inbox;
mod numbers;
mod parent_delivery;
pub mod planning;
mod review_publication;
mod settings;
mod settings_domains;
mod task_rows;
mod tells;
mod titles;
mod usage;
mod volume;

use std::{collections::BTreeMap, path::Path, time::Duration};

use nucleus_core::{Phase, Role, Task, profiles::RotationCounts};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior, named_params,
    params,
};
use serde_json::{Value, json};

pub use allowance::{Allowance, AllowanceExtension, AllowanceObservation, AllowanceView};
pub use dependencies::{
    Dependencies, DependencyClock, DependencyEdit, PrerequisiteRelease, PrerequisiteWait,
};
pub use github_accounts::{GITHUB_HOST, GitHubAccount, GitHubAccountSettings};
pub use inbox::InboxBinding;
pub use parent_delivery::{ParentDelivery, ParentResult};
pub use review_publication::{ReviewIntent, ReviewPublication, ReviewPublicationOutcome};
pub use settings::{
    Backups, BargePaths, EngineSettings, EngineStorage, RetentionSettings, SettingsFile,
    SettingsSnapshot, SettingsValue, StorageError, StoragePlacement, VerifiedBackup,
};
pub use settings_domains::{
    DispatchMode, DispatchSettings, Hosts, NamedProfile, PlannerClaim, PoolRole, Profiles,
    ProjectSettings, Projects, RepositorySettings, T3Settings,
};
pub use task_rows::{RowSnooze, SnoozeOutcome};
pub use tells::{
    StoredTell, TellDelivery, TellDispatch, TellProject, TellRows, TellState, TellSubmission,
};
pub use titles::TitleReceipt;
pub use usage::{ProfileUsage, UsageWindow};
pub use volume::{PinnedVolume, StorageDirectory};

const APPLICATION_ID: i32 = i32::from_be_bytes(*b"N070");
const SCHEMA_VERSION: i32 = 12;
const TASK_SCHEMA: &str = include_str!("tasks.sql");
const DATABASE_FILE: &str = "engine.sqlite";
const TASK_COLUMNS: &str = "id, reference, repository, base, entry, brief, phase, threads, run, pr, verdict, attempts, question, hold, origin_thread, report_task, work_continuation";
const LEGACY_PROJECT_IMPORT_JOURNAL: &str = "
CREATE TABLE IF NOT EXISTS legacy_project_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pending TEXT CHECK (json_valid(pending))
) STRICT";
const PUBLIC_NUMBER: &str = "(SELECT number FROM task_numbers WHERE task_id = tasks.id)";
const OCCUPIED_SLOTS_INDEX: &str = "CREATE INDEX occupied_launch_slots ON tasks (id)
  WHERE json_extract(run, '$.last_send_at_ms') IS NOT NULL";
const ACP_SESSIONS: &str = "CREATE TABLE acp_sessions (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  reader BLOB NOT NULL CHECK (length(reader) = 32),
  writer BLOB CHECK (length(writer) = 32),
  controller BLOB NOT NULL CHECK (length(controller) = 32)
) STRICT";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("could not prepare the engine data directory")]
    Storage(#[from] StorageError),
    #[error("unsupported engine database (application {application}, version {version})")]
    Incompatible { application: i32, version: i32 },
    #[error("could not verify the pre-upgrade engine database backup")]
    UpgradeBackup,
    #[error("the report-task migration found a missing database reference")]
    ReportMigrationReferences,
    #[error("task identity is immutable")]
    IdentityChanged,
    #[error("task changed since it was read")]
    StaleTask,
    #[error("review publication journal does not match the outstanding intent")]
    ReviewPublicationConflict,
    #[error("dependency change would create a cycle")]
    DependencyCycle,
    #[error("planning record was not found")]
    PlanningMissing,
    #[error("planning input is invalid")]
    PlanningInput,
    #[error("decision option labels must be distinct")]
    DuplicateDecisionOptionLabel,
    #[error("planning record conflicts with the current state")]
    PlanningConflict,
    #[error("project {0:?} has already received 20 tells in the last hour. Send later.")]
    TellRateLimit(String),
    #[error(
        "the offline project import is pending. Recover the Projects settings before starting this profile"
    )]
    ProjectImportPending,
    #[error("this restored repository needs task number recovery before admitting new tasks")]
    NumbersNeedSeed,
    #[error("the repository task number counter is exhausted")]
    NumberExhausted,
    #[error("the task allowance is no longer exhausted")]
    AllowanceNotExhausted,
    #[error("profile assignment requires a new frozen launch")]
    NoProfileLaunch,
    #[error("could not encode task state")]
    Encode(#[from] serde_json::Error),
    #[error("engine database operation failed")]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EventDraft {
    pub at: i64,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Event {
    pub sequence: i64,
    pub content: EventDraft,
}

struct AccountedUpdate {
    allowance: AllowanceObservation,
    board_state_changed: bool,
}

/// A committed fresh reviewer reservation that used the ordinary fallback.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticalReviewFallback {
    pub at_ms: u64,
    pub run_instance: String,
    pub worker_profile_id: String,
    pub reviewer_profile_id: String,
    pub reason: String,
}

/// A task's execution snapshot plus its public number. Equality fences the
/// execution snapshot, so backfill cannot invalidate a callback or launch.
#[derive(Debug, Clone)]
pub struct TaskRow {
    pub task: Task,
    pub version: i64,
    pub number: Option<i64>,
}

impl PartialEq for TaskRow {
    fn eq(&self, other: &Self) -> bool {
        self.version == other.version && self.task == other.task
    }
}

impl Eq for TaskRow {}

/// Task-scoped credential digests. The database never holds raw ACP keys.
pub struct AcpSession {
    pub reader: [u8; 32],
    pub writer: Option<[u8; 32]>,
    pub controller: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadProvenance {
    Dispatcher,
    TaskRole,
}

/// Durable inputs resolved by service admission and committed with the task.
#[derive(Default)]
pub struct TaskAdmissionFacts<'a> {
    pub prerequisites: &'a [String],
    pub usage_permission: Option<planning::UsagePermission<'a>>,
    pub affected_tests: bool,
}

pub type PruneOwners = BTreeMap<String, (String, Option<(i64, u32)>)>;

pub struct Store {
    connection: Connection,
}

impl Store {
    /// Open `engine.sqlite` under the engine's verified database root.
    ///
    /// # Errors
    /// Returns an error if storage is inaccessible or the file belongs to
    /// another application or schema version.
    pub fn open(storage: &EngineStorage) -> Result<Self, StoreError> {
        let directory = storage.database();
        directory.ensure()?;
        let path = directory.path().join(DATABASE_FILE);
        let mut connection = Self::connect_database(&path, OpenFlags::SQLITE_OPEN_CREATE)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::prepare_schema(&tx, &path, storage.backup())?;
        let pending_project_import = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM legacy_project_import WHERE pending IS NOT NULL)",
            [],
            |row| row.get::<_, bool>(0),
        )?;
        if pending_project_import {
            return Err(StoreError::ProjectImportPending);
        }
        tx.commit()?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", true)?;
        Ok(Self { connection })
    }

    fn connect_database(path: &Path, flags: OpenFlags) -> Result<Connection, StoreError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW | flags,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        // Schema migration replaces the tasks parent table. Every caller
        // enables enforcement again before doing any application writes.
        connection.pragma_update(None, "foreign_keys", false)?;
        Ok(connection)
    }

    fn prepare_schema(
        tx: &Transaction<'_>,
        path: &Path,
        backup: &StorageDirectory,
    ) -> Result<(), StoreError> {
        let application = tx.pragma_query_value(None, "application_id", |row| row.get(0))?;
        let version = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match (application, version) {
            (0, 0)
                if tx.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
                    row.get::<_, i64>(0)
                })? == 0 =>
            {
                tx.execute_batch(TASK_SCHEMA)?;
                tx.execute_batch(include_str!("schema.sql"))?;
                tx.execute(OCCUPIED_SLOTS_INDEX, [])?;
                tx.execute(ACP_SESSIONS, [])?;
                tx.execute_batch(usage::SCHEMA)?;
                tx.execute(inbox::SCHEMA, [])?;
                tx.execute(titles::SCHEMA, [])?;
                tx.execute_batch(planning::SCHEMA)?;
                tx.execute_batch(numbers::SCHEMA)?;
                tx.execute_batch(include_str!("parent_delivery.sql"))?;
                tx.pragma_update(None, "application_id", APPLICATION_ID)?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            }
            (APPLICATION_ID, SCHEMA_VERSION) => {}
            (APPLICATION_ID, 1..SCHEMA_VERSION) => {
                Self::backup_before_upgrade(path, backup, version)?;
                if version == 1 {
                    tx.execute("ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)", [])?;
                    tx.execute("ALTER TABLE tasks ADD COLUMN origin_thread TEXT", [])?;
                }
                if version < 3 {
                    tx.execute(OCCUPIED_SLOTS_INDEX, [])?;
                }
                if version < 4 {
                    tx.execute(ACP_SESSIONS, [])?;
                }
                if version < 5 {
                    tx.execute_batch(usage::SCHEMA)?;
                }
                if version < 6 {
                    tx.execute(inbox::SCHEMA, [])?;
                }
                if version < 7 {
                    tx.execute(titles::SCHEMA, [])?;
                }
                if version < 8 {
                    tx.execute_batch(planning::SCHEMA)?;
                }
                if version < 9 {
                    tx.execute_batch(numbers::SCHEMA)?;
                }
                if version < 10 {
                    Self::migrate_report_tasks(tx)?;
                } else if version == 10 {
                    tx.execute(
                        "ALTER TABLE tasks ADD COLUMN work_continuation TEXT CHECK (json_valid(work_continuation))",
                        [],
                    )?;
                }
                tx.execute_batch(include_str!("parent_delivery.sql"))?;
                tx.execute_batch(include_str!("parent_delivery_legacy.sql"))?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            }
            _ => {
                return Err(StoreError::Incompatible {
                    application,
                    version,
                });
            }
        }
        // This independent table is additive to every supported task schema.
        tx.execute(usage::PROVIDER_PAUSES, [])?;
        tx.execute(LEGACY_PROJECT_IMPORT_JOURNAL, [])?;
        tx.execute(titles::INBOX_SCHEMA, [])?;
        tx.execute_batch(task_rows::SCHEMA)?;
        tx.execute(inbox::COMMAND_RECEIPTS, [])?;
        tx.execute_batch(allowance::SCHEMA)?;
        tx.execute(planning::decisions::USAGE_PERMISSION_INDEX, [])?;
        tx.execute_batch(tells::SCHEMA)?;
        tx.execute_batch(dependencies::SCHEMA)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS completion_notices (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id), retry INTEGER CHECK (retry IN (0,1))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS pending_completion_notices ON completion_notices(task_id) WHERE retry IS NOT NULL")?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS housekeeping_runs (
            name TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, next_batch_ms INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS thread_prune_attempts (
            thread TEXT PRIMARY KEY, archived_ms INTEGER NOT NULL, attempts INTEGER NOT NULL
        ) STRICT;",
        )?;
        tx.execute(board_state::SCHEMA, [])?;
        Ok(())
    }

    fn backup_before_upgrade(
        path: &Path,
        directory: &StorageDirectory,
        version: i32,
    ) -> Result<(), StoreError> {
        let backup = Self::verified_copy(
            path,
            directory,
            version,
            &format!(".engine-before-v{version}-"),
            "quick_check",
        )?;
        let name = backup.path().file_name().and_then(|name| name.to_str());
        let published = directory.path().join(
            name.and_then(|name| name.strip_prefix('.'))
                .ok_or(StoreError::UpgradeBackup)?,
        );
        backup
            .persist_noclobber(published)
            .map_err(|error| StorageError::from(error.error))?;
        std::fs::File::open(directory.path())
            .and_then(|root| root.sync_all())
            .map_err(StorageError::from)?;
        Ok(())
    }

    fn verified_copy(
        path: &Path,
        directory: &StorageDirectory,
        version: i32,
        prefix: &str,
        check: &str,
    ) -> Result<tempfile::NamedTempFile, StoreError> {
        directory.ensure()?;
        let backup = tempfile::Builder::new()
            .prefix(prefix)
            .suffix(".sqlite")
            .tempfile_in(directory.path())
            .map_err(StorageError::from)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let source = Connection::open_with_flags(path, flags)?;
        source.execute_batch("BEGIN")?;
        {
            let mut output = Connection::open_with_flags(
                backup.path(),
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )?;
            rusqlite::backup::Backup::new(&source, &mut output)?.run_to_completion(
                256,
                Duration::from_millis(10),
                None,
            )?;
            output.pragma_update(None, "journal_mode", "DELETE")?;
        }
        let copy = Connection::open_with_flags(backup.path(), flags)?;
        if copy.pragma_query_value(None, "application_id", |row| row.get::<_, i32>(0))?
            != APPLICATION_ID
            || copy.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))? != version
            || copy.pragma_query_value(None, check, |row| row.get::<_, String>(0))? != "ok"
        {
            return Err(StoreError::UpgradeBackup);
        }
        backup.as_file().sync_all().map_err(StorageError::from)?;
        Ok(backup)
    }

    // Rebuild with the expanded phase constraint. Foreign keys are checked
    // after the table has its original name again, inside the migration transaction.
    fn migrate_report_tasks(tx: &Transaction<'_>) -> Result<(), StoreError> {
        // Keep the source projection fixed to the schema before report tasks.
        const OLD_COLUMNS: &str = "id, reference, repository, base, entry, brief, phase, threads, run, pr, verdict, attempts, question, hold, origin_thread, version";
        tx.execute_batch(&TASK_SCHEMA.replacen("CREATE TABLE tasks", "CREATE TABLE tasks_v10", 1))?;
        tx.execute_batch(&format!(
            "INSERT INTO tasks_v10 ({OLD_COLUMNS}) SELECT {OLD_COLUMNS} FROM tasks;
             DROP TABLE tasks;
             ALTER TABLE tasks_v10 RENAME TO tasks;
             CREATE INDEX active_tasks ON tasks (id)
                 WHERE phase NOT IN ('done','cancelled') OR run IS NOT NULL;"
        ))?;
        tx.execute(OCCUPIED_SLOTS_INDEX, [])?;
        if tx
            .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()?
            .is_some()
        {
            return Err(StoreError::ReportMigrationReferences);
        }
        Ok(())
    }

    /// Look up one task by its engine ID.
    ///
    /// # Errors
    /// Returns an error if the database cannot read or decode the row.
    pub fn get(&self, id: &str) -> Result<Option<Task>, StoreError> {
        Ok(self.row(id)?.map(|row| row.task))
    }

    /// Read a task with the exact version required for compare-and-set.
    /// # Errors
    /// Returns an error if the row cannot be read or decoded.
    pub fn row(&self, id: &str) -> Result<Option<TaskRow>, StoreError> {
        Ok(load(&self.connection, id)?)
    }

    /// Read active task IDs in admission order, with the ordinal for first workers.
    /// # Errors
    /// Returns an error if the database cannot read the page.
    pub fn active_ids(
        &self,
        after: Option<&str>,
        limit: u32,
    ) -> Result<Vec<(String, Option<i64>)>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "WITH cursor AS (SELECT coalesce((SELECT rowid FROM tasks WHERE id = ?2), 0) AS seq),
             due AS (SELECT rowid AS admitted, id FROM tasks WHERE (phase NOT IN ('done','cancelled') OR run IS NOT NULL)
             AND (run IS NOT NULL OR phase NOT IN ('report_ready','blocked','error')
                  OR phase = 'report_ready' AND coalesce(json_extract(report_task, '$.notice_attempted'), 0) = 0)
             AND (run IS NOT NULL OR coalesce(json_extract(question, '$.operator_decline'), '') != 'notified')
             AND rowid > (SELECT seq FROM cursor)
             UNION SELECT t.rowid, b.task_id FROM inbox_bindings b JOIN tasks t ON t.id = b.task_id
               WHERE t.rowid > (SELECT seq FROM cursor) AND t.phase NOT IN ('done','cancelled')
             UNION SELECT t.rowid, n.task_id FROM task_prerequisite_notices n JOIN tasks t ON t.id = n.task_id
               WHERE t.rowid > (SELECT seq FROM cursor) AND n.attempted_at_ms IS NULL AND t.phase NOT IN ('done','cancelled')
             UNION SELECT t.rowid, w.task_id FROM task_prerequisite_waits w
               JOIN tasks t ON t.id = w.task_id
               WHERE t.rowid > (SELECT seq FROM cursor) AND w.released_at_ms IS NULL
                 AND t.phase NOT IN ('done','cancelled')
                 AND NOT EXISTS (
                    SELECT 1 FROM task_dependencies d
                    LEFT JOIN tasks p ON p.id = d.prerequisite_id
                    WHERE d.task_id = w.task_id AND d.after_dispatch = 1
                      AND coalesce(p.phase, '') != 'done'
                 )
             ORDER BY admitted LIMIT ?1)
             SELECT due.id, CASE WHEN t.phase IN ('queued', 'working') AND t.entry = 'brief' AND t.run IS NULL
               AND json_extract(t.threads, '$.worker') IS NULL AND json_extract(t.threads, '$.reviewer') IS NULL
               THEN due.admitted END
             FROM due JOIN tasks t ON t.id = due.id ORDER BY due.admitted",
        )?;
        let ids = query.query_map(params![limit, after.unwrap_or_default()], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        Ok(ids.collect::<Result<_, _>>()?)
    }

    /// Read the admission ordinal used to order capacity waiters across repositories.
    ///
    /// # Errors
    /// Returns an error if the task row cannot be read.
    pub fn admission_order(&self, id: &str) -> Result<i64, StoreError> {
        Ok(self
            .connection
            .prepare_cached("SELECT rowid FROM tasks WHERE id = ?1")?
            .query_row([id], |row| row.get(0))?)
    }

    /// Read the IDs of tasks that hold a run.
    /// # Errors
    /// Returns an error if row custody cannot be read.
    pub fn run_ids(&self) -> Result<Vec<String>, StoreError> {
        let mut query = self
            .connection
            .prepare_cached("SELECT id FROM tasks WHERE run IS NOT NULL ORDER BY id")?;
        let rows = query.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Count other tasks whose possibly sent run still holds a launch slot.
    /// # Errors
    /// Returns an error if row custody cannot be read.
    pub fn occupied_slots(&self, except: &str) -> Result<u32, StoreError> {
        Ok(self.connection.query_row("SELECT count(*) FROM tasks WHERE id <> ?1 AND run IS NOT NULL AND json_extract(run, '$.last_send_at_ms') IS NOT NULL", [except], |row| row.get(0))?)
    }

    /// Count other held slots among the repositories in one project.
    /// # Errors
    /// Returns an error if row custody cannot be read.
    pub fn occupied_project_slots(
        &self,
        except: &str,
        repositories: &[String],
    ) -> Result<u32, StoreError> {
        let repositories = serde_json::to_string(repositories)?;
        Ok(self.connection.query_row(
            "SELECT count(*) FROM tasks
             WHERE id <> ?1 AND run IS NOT NULL AND json_extract(run, '$.last_send_at_ms') IS NOT NULL
             AND EXISTS (SELECT 1 FROM json_each(?2) AS route
                 WHERE tasks.repository = route.value COLLATE NOCASE)",
            params![except, repositories],
            |row| row.get(0),
        )?)
    }

    /// Find nonterminal tasks whose managed checkout can occupy the project's workspace budget.
    /// # Errors
    /// Returns an error if task custody cannot be read.
    pub fn project_workspace_candidates(
        &self,
        except: &str,
        repositories: &[String],
    ) -> Result<Vec<(String, String)>, StoreError> {
        let repositories = serde_json::to_string(repositories)?;
        let mut query = self.connection.prepare_cached(
            "SELECT id, repository FROM tasks
             WHERE id <> ?1 AND phase NOT IN ('done', 'cancelled')
             AND EXISTS (SELECT 1 FROM json_each(?2) AS route
                 WHERE tasks.repository = route.value COLLATE NOCASE)",
        )?;
        let rows = query.query_map(params![except, repositories], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Claim a periodic service pass, including across restarts.
    ///
    /// # Errors
    /// Returns a database error if the claim cannot be recorded.
    pub fn start_housekeeping(
        &self,
        name: &str,
        now: i64,
        interval: i64,
    ) -> Result<bool, StoreError> {
        Ok(self.connection.execute(
            "INSERT INTO housekeeping_runs VALUES (?1, ?2, ?2+30000)
            ON CONFLICT(name) DO UPDATE SET started_ms=excluded.started_ms, next_batch_ms=excluded.next_batch_ms
            WHERE next_batch_ms<=?2 OR (next_batch_ms IS NULL AND started_ms<=?2-?3)",
            params![name, now, interval],
        )? == 1)
    }

    /// End a drained sweep; a partial sweep remains due on the next eligible scheduler scan.
    ///
    /// # Errors
    /// Returns a database error if the cadence cannot be saved.
    pub fn finish_housekeeping(&self, name: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE housekeeping_runs SET next_batch_ms=NULL WHERE name=?1",
            [name],
        )?;
        Ok(())
    }

    /// Native thread IDs owned exclusively by finished tasks and their prior prune attempts.
    ///
    /// # Errors
    /// Returns a database error if ownership cannot be read.
    pub fn prune_owners(&self) -> Result<PruneOwners, StoreError> {
        let mut query=self.connection.prepare_cached("WITH owned(task,thread,terminal) AS (
          SELECT id,thread,phase IN ('done','cancelled') AND run IS NULL FROM task_titles JOIN tasks ON tasks.id=task_titles.task_id
          UNION ALL SELECT id,json_extract(threads,'$.worker'),phase IN ('done','cancelled') AND run IS NULL FROM tasks
          UNION ALL SELECT id,json_extract(threads,'$.reviewer'),phase IN ('done','cancelled') AND run IS NULL FROM tasks
          UNION ALL SELECT id,origin_thread,0 FROM tasks
        ) SELECT o.thread,min(o.task),p.archived_ms,p.attempts FROM owned o
          LEFT JOIN thread_prune_attempts p ON p.thread=o.thread WHERE o.thread IS NOT NULL
          GROUP BY o.thread HAVING min(o.terminal)=1 AND count(DISTINCT o.task)=1")?;
        let rows = query.query_map([], |row| {
            Ok((
                row.get(0)?,
                (row.get(1)?, row.get::<_, Option<i64>>(2)?.zip(row.get(3)?)),
            ))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Claim one deletion after a fresh inventory of the exact archive occurrence.
    ///
    /// # Errors
    /// Returns a database error if the attempt cannot be recorded.
    pub fn claim_thread_prune(&self, thread: &str, archived_ms: i64) -> Result<bool, StoreError> {
        Ok(self.connection.execute("INSERT INTO thread_prune_attempts VALUES (?1,?2,1)
           ON CONFLICT(thread) DO UPDATE SET archived_ms=?2, attempts=CASE WHEN archived_ms=?2 THEN attempts+1 ELSE 1 END
           WHERE archived_ms<>?2 OR attempts<4", params![thread,archived_ms])? == 1)
    }

    /// Release the prune intent once T3 confirms deletion of this occurrence.
    ///
    /// # Errors
    /// Returns a database error if the intent cannot be cleared.
    pub fn confirm_thread_prune(&self, thread: &str, archived_ms: i64) -> Result<(), StoreError> {
        self.connection.execute(
            "DELETE FROM thread_prune_attempts WHERE thread=?1 AND archived_ms=?2",
            params![thread, archived_ms],
        )?;
        Ok(())
    }

    /// Page completed tasks for native thread housekeeping.
    /// # Errors
    /// Returns an error if the pending archive page cannot be read.
    pub fn archive_due_ids(
        &self,
        after: Option<&str>,
        limit: u32,
        parenting: bool,
    ) -> Result<Vec<String>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT id FROM tasks WHERE id > ?1 AND phase = 'done' AND run IS NULL
             AND (?3 OR report_task IS NOT NULL)
             UNION SELECT n.task_id FROM completion_notices n JOIN tasks t ON t.id=n.task_id
             WHERE n.task_id > ?1 AND n.retry IS NOT NULL AND t.phase IN ('done','cancelled') AND t.run IS NULL
             ORDER BY 1 LIMIT ?2",
        )?;
        let rows = query.query_map(
            params![after.unwrap_or_default(), limit, parenting],
            |row| row.get(0),
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// First attempt (false), sole retry (true), or no pending closeout notice.
    ///
    /// # Errors
    /// Returns an error if the notice cannot be read.
    pub fn completion_notice(&self, id: &str) -> Result<Option<bool>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT retry FROM completion_notices WHERE task_id=?1 AND retry IS NOT NULL",
                [id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Claim or reopen the exact pending attempt together with its native evidence.
    ///
    /// # Errors
    /// Returns an error if the occurrence changed or the evidence cannot be saved.
    pub fn set_completion_notice(
        &mut self,
        id: &str,
        expected: Option<bool>,
        next: Option<bool>,
        audit: &EventDraft,
    ) -> Result<(), StoreError> {
        let tx = self.connection.transaction()?;
        if tx.execute(
            "UPDATE completion_notices SET retry=?3 WHERE task_id=?1 AND retry IS ?2",
            params![id, expected, next],
        )? != 1
        {
            return Err(StoreError::StaleTask);
        }
        append(&tx, id, audit)?;
        Ok(tx.commit()?)
    }

    /// Append a task effect observation without changing the task version.
    ///
    /// # Errors
    /// Returns an error if the journal cannot be updated.
    pub fn record_task_effect(&mut self, id: &str, event: &EventDraft) -> Result<(), StoreError> {
        let tx = self.connection.transaction()?;
        append(&tx, id, event)?;
        tx.commit()?;
        Ok(())
    }

    /// Read provenance only for threads in the current native inventory.
    /// # Errors
    /// Returns an error if task identities or their retained roles cannot be read.
    pub fn routing_provenance(
        &self,
        repository: &str,
        candidates: &[&str],
    ) -> Result<BTreeMap<String, ThreadProvenance>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "WITH provenance(thread, is_task_role) AS (
               SELECT origin_thread, 0 FROM tasks WHERE repository = ?1
               UNION ALL
               SELECT json_extract(threads, '$.worker'), 1 FROM tasks WHERE repository = ?1
               UNION ALL
               SELECT json_extract(threads, '$.reviewer'), 1 FROM tasks WHERE repository = ?1
             )
             SELECT thread, max(is_task_role)
               FROM provenance JOIN json_each(?2) AS candidate ON candidate.value = thread
               GROUP BY thread",
        )?;
        let rows = query.query_map(
            params![repository, serde_json::to_string(candidates)?],
            |row| {
                let role = if row.get::<_, bool>(1)? {
                    ThreadProvenance::TaskRole
                } else {
                    ThreadProvenance::Dispatcher
                };
                Ok((row.get(0)?, role))
            },
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Read tasks that can still take an engine pass, including pending stops.
    ///
    /// # Errors
    /// Returns an error if the database cannot read or decode the rows.
    pub fn active(&self) -> Result<Vec<Task>, StoreError> {
        self.tasks(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE phase NOT IN ('done','cancelled') OR run IS NOT NULL ORDER BY id"
        ))
    }

    /// Read all tasks for the board, including terminal rows.
    /// # Errors
    /// Returns an error if the database cannot read or decode the rows.
    pub fn list(&self) -> Result<Vec<TaskRow>, StoreError> {
        let mut query = self.connection.prepare_cached(&format!(
            "SELECT {TASK_COLUMNS}, version, {PUBLIC_NUMBER} FROM tasks ORDER BY id"
        ))?;
        let rows = query.query_map([], decode_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Read existing active rows that predate their native presentation binding.
    ///
    /// # Errors
    /// Returns an error if the task rows cannot be read.
    pub fn tasks_without_titles(&self) -> Result<Vec<TaskRow>, StoreError> {
        let mut query = self.connection.prepare_cached(&format!(
            "SELECT {TASK_COLUMNS}, version, {PUBLIC_NUMBER} FROM tasks
             WHERE phase NOT IN ('done','cancelled')
             AND NOT EXISTS (SELECT 1 FROM task_titles WHERE task_id = tasks.id)"
        ))?;
        let rows = query.query_map([], decode_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn tasks(&self, statement: &str) -> Result<Vec<Task>, StoreError> {
        let mut query = self.connection.prepare_cached(statement)?;
        let rows = query.query_map([], decode_task)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Admit a task and append its first audit event together.
    ///
    /// # Errors
    /// Returns an error on duplicate identity, invalid state, or database failure.
    pub fn create(&mut self, task: &Task, event: &EventDraft) -> Result<i64, StoreError> {
        self.create_with_facts(task, event, TaskAdmissionFacts::default())
    }

    /// Admit a task with its prerequisites and any Low usage decision together.
    ///
    /// # Errors
    /// Returns an error if any part of admission cannot commit.
    pub fn create_with_facts(
        &mut self,
        task: &Task,
        event: &EventDraft,
        facts: TaskAdmissionFacts<'_>,
    ) -> Result<i64, StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let number = admit(&tx, task, event, facts)?;
        tx.commit()?;
        Ok(number)
    }

    /// Replace exactly the row version and run read by the caller. State and
    /// audit commit together. Remote I/O belongs outside the transaction.
    /// # Errors
    /// Returns an error on a competing write or transaction failure.
    pub fn save_row(
        &mut self,
        expected: &TaskRow,
        task: &Task,
        event: &EventDraft,
    ) -> Result<i64, StoreError> {
        self.save(expected, task, event, None, None, None)
    }

    /// Amend a queued brief and replace its resolved dependency list together.
    ///
    /// # Errors
    /// Returns an error on a stale row, invalid dependency or transaction failure.
    pub fn save_brief_with_dependencies(
        &mut self,
        expected: &TaskRow,
        task: &Task,
        event: &EventDraft,
        prerequisites: &[String],
        clock: Option<DependencyClock<'_>>,
    ) -> Result<i64, StoreError> {
        self.save(
            expected,
            task,
            event,
            None,
            Some((prerequisites, clock)),
            None,
        )
    }

    /// Commit a newly frozen profiled launch and charge its subscription group.
    /// The launch stays valid if the optional rotation history cannot be written.
    ///
    /// # Errors
    /// Returns an error on a stale row, a task without a fresh profile reservation,
    /// or failure to commit the task and its audit event.
    pub fn save_profile_launch(
        &mut self,
        expected: &TaskRow,
        task: &Task,
        event: &EventDraft,
        group: &str,
    ) -> Result<i64, StoreError> {
        self.save(expected, task, event, Some(group), None, None)
    }

    /// Save the task and account for the lifecycle transition atomically.
    ///
    /// # Errors
    /// Returns an error on a stale task row, invalid allowance extension or database failure.
    pub fn save_accounted(
        &mut self,
        expected: &TaskRow,
        task: &Task,
        event: &EventDraft,
        group: Option<&str>,
        observation: AllowanceObservation,
        board_state_changed: bool,
    ) -> Result<i64, StoreError> {
        let update = AccountedUpdate {
            allowance: observation,
            board_state_changed,
        };
        self.save(expected, task, event, group, None, Some(update))
    }

    /// Read Spec 053 counts for one candidate from the local engine database.
    /// `None` means the history could not be read and selection should use its
    /// weights alone. An empty history returns zero counts.
    #[must_use]
    pub fn rotation_counts(
        &self,
        role: Role,
        profile: &str,
        group: &str,
    ) -> Option<RotationCounts> {
        usage::counts(&self.connection, role, profile, group).ok()
    }

    /// Read the board's assignment windows and totals from recorded charges.
    ///
    /// # Errors
    /// Returns a database error if the recorded counts could not be read.
    pub fn profile_usage(&self) -> Result<ProfileUsage, StoreError> {
        Ok(usage::profile_usage(&self.connection)?)
    }

    /// Record a positive provider deadline without shortening another known pause.
    ///
    /// # Errors
    /// Returns a database error if the deadline could not be recorded.
    pub fn record_provider_pause(
        &self,
        group: &str,
        until_ms: u64,
        now_ms: u64,
    ) -> Result<(), StoreError> {
        Ok(usage::record_pause(
            &self.connection,
            group,
            until_ms,
            now_ms,
        )?)
    }

    /// Record a task effect once and return its journal sequence when newly inserted.
    ///
    /// # Errors
    /// Returns an error if the journal cannot be updated.
    pub fn claim_task_effect(
        &mut self,
        id: &str,
        event: &EventDraft,
        entered: bool,
    ) -> Result<Option<i64>, StoreError> {
        self.claim_task_effect_after(id, event, entered, None)
    }

    /// Record an effect again after a matching pre-wire refusal.
    /// # Errors
    /// Returns an error when the journal cannot be updated.
    pub fn claim_task_effect_after(
        &mut self,
        id: &str,
        event: &EventDraft,
        entered: bool,
        not_sent: Option<&str>,
    ) -> Result<Option<i64>, StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recorded: bool = tx.query_row(
            "SELECT coalesce((SELECT kind = ?2 FROM events WHERE task_id = ?1
               AND kind IN (?2, ?4) AND detail = ?3 ORDER BY sequence DESC LIMIT 1), 0)",
            params![id, event.kind, event.detail, not_sent],
            |row| row.get(0),
        )?;
        let sequence = if recorded {
            None
        } else {
            append(&tx, id, event)?;
            let sequence = tx.last_insert_rowid();
            if entered {
                board_state::record(&tx, id, event.at)?;
            }
            Some(sequence)
        };
        tx.commit()?;
        Ok(sequence)
    }

    /// Read all subscription groups with a deadline in the future.
    ///
    /// # Errors
    /// Returns a database error if the active deadlines could not be read.
    pub fn active_provider_pauses(&self, now_ms: u64) -> Result<BTreeMap<String, u64>, StoreError> {
        Ok(usage::active_pauses(&self.connection, now_ms)?)
    }

    /// Read a single subscription group's deadline if it is still active.
    ///
    /// # Errors
    /// Returns a database error if the deadline could not be read.
    pub fn provider_pause(&self, group: &str, now_ms: u64) -> Result<Option<u64>, StoreError> {
        Ok(usage::active_pause(&self.connection, group, now_ms)?)
    }

    fn save(
        &mut self,
        expected: &TaskRow,
        task: &Task,
        event: &EventDraft,
        group: Option<&str>,
        prerequisites: Option<(&[String], Option<DependencyClock<'_>>)>,
        accounted: Option<AccountedUpdate>,
    ) -> Result<i64, StoreError> {
        if expected.task.identity() != task.identity() {
            return Err(StoreError::IdentityChanged);
        }
        let mut tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = load(&tx, &task.identity().id)?.ok_or(StoreError::StaleTask)?;
        if row != *expected {
            return Err(StoreError::StaleTask);
        }
        persist(&tx, task, true)?;
        if task.phase().is_terminal() {
            task_rows::forget(&tx, &task.identity().id)?;
            if !row.task.phase().is_terminal()
                && nucleus_core::profiles::BriefPolicy::parse(&task.brief().text)
                    .is_ok_and(|policy| policy.notify_origin_on_closeout)
            {
                tx.execute(
                    "INSERT OR IGNORE INTO completion_notices (task_id, retry) VALUES (?1, 0)",
                    [&task.identity().id],
                )?;
            }
        }
        if let Some((prerequisites, clock)) = prerequisites {
            let id = &task.identity().id;
            dependencies::initial_edges(&tx, id, prerequisites)?;
            if let Some(clock) = clock {
                dependencies::record_board_gate(&tx, id, clock, event.at)?;
            }
        }
        if let Some(update) = accounted {
            allowance::observe(&tx, task, update.allowance)?;
            if update.board_state_changed {
                board_state::record(&tx, &task.identity().id, event.at)?;
            }
        }
        if task.phase() == Phase::Done {
            tx.execute(
                "UPDATE acp_sessions SET writer = NULL WHERE task_id = ?1",
                [&task.identity().id],
            )?;
            if row.task.phase() != Phase::Done {
                append(
                    &tx,
                    &task.identity().id,
                    &EventDraft {
                        at: event.at,
                        kind: "entered_done".into(),
                        detail: String::new(),
                    },
                )?;
            }
        }
        append(&tx, &task.identity().id, event)?;
        if let Some(group) = group {
            let launch = task
                .run()
                .filter(|run| !run.revoked() && run.last_send_at_ms().is_none())
                .filter(|_| row.task.run().is_none())
                .map(nucleus_core::Run::launch)
                .ok_or(StoreError::NoProfileLaunch)?;
            let profile = launch.profile().ok_or(StoreError::NoProfileLaunch)?;
            if let Ok(history) = tx.savepoint()
                && usage::record(&history, launch, &profile.id, group, event.at).is_ok()
            {
                let _ = history.commit();
            }
        }
        tx.commit()?;
        Ok(row.version + 1)
    }

    /// Rotate the session credentials attached to an existing task.
    ///
    /// # Errors
    /// Returns an error if the task is missing or the session cannot be saved.
    pub fn bind_acp(&self, id: &str, session: &AcpSession) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO acp_sessions (task_id, reader, writer, controller)
             VALUES (?1, ?2, ?3, ?4) ON CONFLICT(task_id) DO UPDATE
               SET reader = excluded.reader, writer = excluded.writer, controller = excluded.controller",
            params![id, session.reader, session.writer, session.controller],
        )?;
        Ok(())
    }

    /// Read the session's verifiers for this exact task.
    ///
    /// # Errors
    /// Returns an error if the credential record is unreadable.
    pub fn acp_session(&self, id: &str) -> Result<Option<AcpSession>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT reader, writer, controller FROM acp_sessions WHERE task_id = ?1",
                [id],
                |row| {
                    Ok(AcpSession {
                        reader: row.get(0)?,
                        writer: row.get(1)?,
                        controller: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Read a page of display history, newest first.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the history.
    pub fn history(
        &self,
        id: &str,
        before: Option<i64>,
        limit: u32,
    ) -> Result<Vec<Event>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT sequence, at, kind, detail FROM events\n             WHERE task_id = ?1 AND (?2 IS NULL OR sequence < ?2)\n             ORDER BY sequence DESC LIMIT ?3",
        )?;
        let rows = query.query_map(params![id, before, limit], event_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Read the fallback receipts written with fresh reviewer reservations.
    ///
    /// # Errors
    /// Returns an error if a stored receipt cannot be read.
    pub fn critical_review_fallbacks(
        &self,
        id: &str,
    ) -> Result<Vec<CriticalReviewFallback>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT detail -> '$.criticalReviewFallback' FROM events
             WHERE task_id = ?1 AND kind = 'run_reserved'
               AND json_type(CASE WHEN json_valid(detail) THEN detail END, '$.criticalReviewFallback') = 'object'
             ORDER BY sequence",
        )?;
        let receipts = query.query_map([id], |row| {
            serde_json::from_str(&row.get::<_, String>(0)?).map_err(|error| decode_error(0, error))
        })?;
        Ok(receipts.collect::<Result<_, _>>()?)
    }

    /// Read the lifecycle audit records in task order.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the display history.
    pub fn lifecycle_events(&self, id: &str) -> Result<Vec<Event>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT sequence, at, kind, detail FROM events
             WHERE task_id = ?1 AND (
                kind IN ('host_send', 'reported')
                OR json_type(CASE WHEN json_valid(detail) THEN detail END, '$.presentation') = 'array'
             ) ORDER BY sequence",
        )?;
        let rows = query.query_map([id], event_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        sequence: row.get(0)?,
        content: EventDraft {
            at: row.get(1)?,
            kind: row.get(2)?,
            detail: row.get(3)?,
        },
    })
}

fn load(connection: &Connection, id: &str) -> rusqlite::Result<Option<TaskRow>> {
    connection
        .query_row(
            &format!("SELECT {TASK_COLUMNS}, version, {PUBLIC_NUMBER} FROM tasks WHERE id = ?1"),
            [id],
            decode_row,
        )
        .optional()
}

fn decode_row(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        task: decode_task(row)?,
        version: row.get(17)?,
        number: row.get(18)?,
    })
}

fn decode_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let value = json!({
        "identity": {
            "id": row.get::<_, String>(0)?,
            "reference": row.get::<_, String>(1)?,
            "repository": row.get::<_, String>(2)?,
            "base": row.get::<_, String>(3)?,
            "entry": row.get::<_, String>(4)?,
            "origin_thread": row.get::<_, Option<String>>(14)?,
        },
        "brief": json_column(row, 5)?,
        "phase": row.get::<_, String>(6)?,
        "threads": json_column(row, 7)?,
        "run": json_column(row, 8)?,
        "pr": json_column(row, 9)?,
        "verdict": json_column(row, 10)?,
        "attempts": row.get::<_, u8>(11)?,
        "question": json_column(row, 12)?,
        "hold": json_column(row, 13)?,
        "report_task": json_column(row, 15)?,
        "work_continuation": json_column(row, 16)?,
    });
    serde_json::from_value(value).map_err(|error| decode_error(0, error))
}

fn json_column(row: &Row<'_>, column: usize) -> rusqlite::Result<Value> {
    match row.get::<_, Option<String>>(column)? {
        Some(text) => serde_json::from_str(&text).map_err(|error| decode_error(column, error)),
        None => Ok(Value::Null),
    }
}

fn decode_error(column: usize, error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}

fn admit(
    tx: &Transaction<'_>,
    task: &Task,
    event: &EventDraft,
    facts: TaskAdmissionFacts<'_>,
) -> Result<i64, StoreError> {
    let identity = task.identity();
    let number = numbers::reserve(tx, identity)?;
    persist(tx, task, false)?;
    numbers::assign(tx, &identity.id, &identity.repository, number)?;
    append(tx, &identity.id, event)?;
    board_state::record(tx, &identity.id, event.at)?;
    allowance::admit(tx, &identity.id, facts.affected_tests)?;
    if !facts.prerequisites.is_empty() {
        dependencies::initial_edges(tx, &identity.id, facts.prerequisites)?;
    }
    if let Some(permission) = facts.usage_permission {
        let reference = numbers::reference(&identity.repository, number);
        planning::decisions::insert_usage_permission(tx, &identity.id, &reference, &permission)?;
    }
    Ok(number)
}

fn persist(tx: &Transaction<'_>, task: &Task, update: bool) -> Result<(), StoreError> {
    let identity = task.identity();
    let snapshot = serde_json::to_value(task)?;
    let mut sql = format!(
        "INSERT INTO tasks ({TASK_COLUMNS}) VALUES (\n        :id, :reference, :repository, :base, :entry, :brief, :phase, :threads,\n        :run, :pr, :verdict, :attempts, :question, :hold, :origin_thread, :report_task, :work_continuation)"
    );
    if update {
        sql.push_str(" ON CONFLICT(id) DO UPDATE SET\n            brief = excluded.brief, phase = excluded.phase, threads = excluded.threads,\n            run = excluded.run, pr = excluded.pr, verdict = excluded.verdict,\n            attempts = excluded.attempts, question = excluded.question, hold = excluded.hold,\n            report_task = excluded.report_task, work_continuation = excluded.work_continuation, version = tasks.version + 1");
    }
    let nullable_json = |key: &str| (!snapshot[key].is_null()).then(|| snapshot[key].to_string());
    tx.execute(
        &sql,
        named_params! {
            ":id": identity.id,
            ":reference": identity.reference,
            ":repository": identity.repository,
            ":base": identity.base,
            ":entry": snapshot["identity"]["entry"].as_str(),
            ":brief": snapshot["brief"].to_string(),
            ":phase": snapshot["phase"].as_str(),
            ":threads": snapshot["threads"].to_string(),
            ":run": nullable_json("run"),
            ":pr": nullable_json("pr"),
            ":verdict": nullable_json("verdict"),
            ":attempts": task.attempts(),
            ":question": nullable_json("question"),
            ":hold": nullable_json("hold"),
            ":origin_thread": identity.origin_thread,
            ":report_task": nullable_json("report_task"),
            ":work_continuation": nullable_json("work_continuation"),
        },
    )?;
    Ok(())
}

fn append(tx: &Transaction<'_>, id: &str, event: &EventDraft) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO events (task_id, at, kind, detail) VALUES (?1, ?2, ?3, ?4)",
        params![id, event.at, event.kind, event.detail],
    )?;
    Ok(())
}
