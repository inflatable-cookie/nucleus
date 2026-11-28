//! The Rust engine's independent `SQLite` database.

mod allowance;
mod backups;
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

use nucleus_core::{
    Head, Identity, Phase, QueuePriority, Role, Task,
    profiles::{BriefPolicy, RotationCounts, Slots, TaskWeight},
};
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
    Backups, BargePaths, EngineSettings, EngineStorage, LockedProfile, RetentionSettings,
    SettingsFile, SettingsSnapshot, SettingsValue, StorageError, StoragePlacement, VerifiedBackup,
};
pub use settings_domains::{
    DispatchMode, DispatchSettings, Hosts, NamedProfile, PlannerClaim, PlannerModel, Profiles,
    ProjectSettings, Projects, RepositorySettings, T3Settings,
};
pub use task_rows::{RowSnooze, SnoozeOutcome, StoredParentSnooze};
pub use tells::{
    StoredTell, TellDelivery, TellDispatch, TellProject, TellRows, TellState, TellSubmission,
};
pub use titles::{StoredTitle, TitleReceipt};
pub use usage::{ProfileUsage, SubscriptionPause, UsageWindow};
pub use volume::{PinnedVolume, StorageDirectory};

const APPLICATION_ID: i32 = i32::from_be_bytes(*b"N070");
const SCHEMA_VERSION: i32 = 15;
const TASK_SCHEMA: &str = include_str!("tasks.sql");
const DATABASE_FILE: &str = "engine.sqlite";
const TASK_COLUMNS: &str = "id, reference, repository, base, entry, brief, phase, threads, run, pr, verdict, attempts, question, hold, origin_thread, report_task, work_continuation, queue_priority, merge_hold";
const LEGACY_PROJECT_IMPORT_JOURNAL: &str = "
CREATE TABLE IF NOT EXISTS legacy_project_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pending TEXT CHECK (json_valid(pending))
) STRICT";
const PAPERCUT_TITLE: &str = "(SELECT CASE WHEN json_valid(i.snapshot) THEN
    CASE WHEN json_extract(i.snapshot, '$.kind')='papercut' AND json_type(i.snapshot, '$.title')='text'
    THEN json_extract(i.snapshot, '$.title') END END
    FROM planning_task_sources s JOIN planning_items i ON i.project=s.project AND i.id=s.item_id
    WHERE s.task_id=tasks.id) AS papercut_title";
const PUBLIC_NUMBER: &str =
    "(SELECT number FROM task_numbers WHERE task_id = tasks.id) AS public_number";
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
    #[error("stored task failed integrity validation")]
    UnreadableTask(Box<UnreadableTask>),
    #[error("task identity is immutable")]
    IdentityChanged,
    #[error("task changed since it was read")]
    StaleTask,
    #[error("review publication journal does not match the outstanding intent")]
    ReviewPublicationConflict,
    #[error("dependency change would create a cycle ({})", .path.join(" -> "))]
    DependencyCycle { path: Vec<String> },
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

/// Identity and revision remain available when the execution snapshot cannot be restored.
#[derive(Debug)]
pub struct UnreadableTask {
    pub identity: Identity,
    pub number: Option<i64>,
    pub version: i64,
    pub reference: String,
    pub cause: String,
}

#[derive(Default)]
pub struct TaskList {
    pub readable: Vec<TaskRow>,
    pub unreadable: Vec<UnreadableTask>,
}

fn declared_weight(brief: Option<&str>) -> TaskWeight {
    brief
        .and_then(|brief| BriefPolicy::parse(brief).ok())
        .map(|policy| policy.weight())
        .unwrap_or_default()
}

fn read_seed(row: &Row<'_>) -> rusqlite::Result<TaskSeed> {
    let priority = match row.get::<_, String>(3)?.as_str() {
        "promoted" => QueuePriority::Promoted,
        _ => QueuePriority::Normal,
    };
    Ok(TaskSeed {
        id: row.get(0)?,
        admission_order: row.get(1)?,
        closeout: row.get(2)?,
        queue_priority: priority,
        weight: declared_weight(row.get::<_, Option<String>>(4)?.as_deref()),
    })
}

/// Scheduling facts for one task from the active backstop scan.
#[derive(Debug, PartialEq, Eq)]
pub struct TaskSeed {
    /// The durable task ID.
    pub id: String,
    /// The capacity queue ordinal for tasks awaiting a slot. The paged scan
    /// reports it only before the first role.
    pub admission_order: Option<i64>,
    /// Whether the task is closing or settling terminal work.
    pub closeout: bool,
    /// Queue dispatch order for capacity waiters.
    pub queue_priority: QueuePriority,
    /// The slot weight of a task awaiting its first role.
    pub weight: TaskWeight,
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

/// Pending completion notice recipient (`None` for the dispatching planner, `Some(thread)` for a watcher).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionNotice {
    pub watcher: Option<String>,
    pub retry: bool,
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
                Self::upgrade_schema(tx, path, backup, version)?;
            }
            _ => {
                return Err(StoreError::Incompatible {
                    application,
                    version,
                });
            }
        }
        // This independent table is additive to every supported task schema.
        usage::prepare_pauses(tx)?;
        tx.execute(LEGACY_PROJECT_IMPORT_JOURNAL, [])?;
        tx.execute(titles::INBOX_SCHEMA, [])?;
        tx.execute_batch(task_rows::SCHEMA)?;
        tx.execute(inbox::COMMAND_RECEIPTS, [])?;
        tx.execute_batch(allowance::SCHEMA)?;
        tx.execute(planning::decisions::USAGE_PERMISSION_INDEX, [])?;
        tx.execute_batch(tells::SCHEMA)?;
        tx.execute_batch(dependencies::SCHEMA)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS completion_notices (
            task_id TEXT NOT NULL REFERENCES tasks(id),
            recipient TEXT NOT NULL,
            retry INTEGER CHECK (retry IN (0,1)),
            PRIMARY KEY (task_id, recipient)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS pending_completion_notices ON completion_notices(task_id, recipient) WHERE retry IS NOT NULL;
        CREATE TABLE IF NOT EXISTS task_watchers (
            task_id TEXT NOT NULL REFERENCES tasks(id),
            thread TEXT NOT NULL,
            added_at_ms INTEGER NOT NULL,
            PRIMARY KEY (task_id, thread)
        ) STRICT;",
        )?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS housekeeping_runs (
            name TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, next_batch_ms INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS thread_prune_attempts (
            thread TEXT PRIMARY KEY, archived_ms INTEGER NOT NULL, attempts INTEGER NOT NULL
        ) STRICT;",
        )?;
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='planning_record_clocks')",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            tx.execute_batch(include_str!("planning/clocks.sql"))?;
        }
        tx.execute(board_state::SCHEMA, [])?;
        Ok(())
    }

    fn upgrade_schema(
        tx: &Transaction<'_>,
        path: &Path,
        backup: &StorageDirectory,
        version: i32,
    ) -> Result<(), StoreError> {
        Self::backup_before_upgrade(path, backup, version)?;
        if version == 1 {
            tx.execute(
                "ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)",
                [],
            )?;
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
        } else if version < 13 {
            if version == 10 {
                tx.execute(
                    "ALTER TABLE tasks ADD COLUMN work_continuation TEXT CHECK (json_valid(work_continuation))",
                    [],
                )?;
            }
            tx.execute(
                "ALTER TABLE tasks ADD COLUMN queue_priority TEXT NOT NULL DEFAULT 'normal' CHECK (queue_priority IN ('normal','promoted'))",
                [],
            )?;
        }
        if version < 12 {
            tx.execute_batch(include_str!("parent_delivery.sql"))?;
            tx.execute_batch(include_str!("parent_delivery_legacy.sql"))?;
        }
        // Earlier schemas rebuild tasks from TASK_SCHEMA above.
        if (10..14).contains(&version) {
            tx.execute(
                "ALTER TABLE tasks ADD COLUMN merge_hold TEXT CHECK (json_valid(merge_hold))",
                [],
            )?;
        }
        if version < 15
            && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='completion_notices')",
                [],
                |r| r.get::<_, bool>(0),
            )?
            && !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('completion_notices') WHERE name='recipient')",
                [],
                |r| r.get::<_, bool>(0),
            )?
        {
            tx.execute_batch(
                "CREATE TABLE completion_notices_v15 (
                    task_id TEXT NOT NULL REFERENCES tasks(id),
                    recipient TEXT NOT NULL,
                    retry INTEGER CHECK (retry IN (0,1)),
                    PRIMARY KEY (task_id, recipient)
                ) STRICT;
                INSERT INTO completion_notices_v15 (task_id, recipient, retry)
                SELECT task_id, '', retry FROM completion_notices;
                DROP TABLE completion_notices;
                ALTER TABLE completion_notices_v15 RENAME TO completion_notices;",
            )?;
        }
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
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
        self.connection
            .query_row(
                &format!(
                    "SELECT {TASK_COLUMNS}, version, {PUBLIC_NUMBER}, {PAPERCUT_TITLE} FROM tasks WHERE id = ?1"
                ),
                [id],
                decode_listed_row,
            )
            .optional()?
            .transpose()
            .map_err(StoreError::UnreadableTask)
    }

    /// Read active task IDs in admission order, with the ordinal for first workers.
    /// # Errors
    /// Returns an error if the database cannot read the page.
    pub fn active_ids(&self, after: Option<&str>, limit: u32) -> Result<Vec<TaskSeed>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "WITH cursor AS (SELECT coalesce((SELECT rowid FROM tasks WHERE id = ?2), 0) AS seq),
             due AS (SELECT rowid AS admitted, id FROM tasks WHERE (phase NOT IN ('done','cancelled') OR run IS NOT NULL)
             AND NOT (phase IN ('done','cancelled') AND EXISTS
                  (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.kind = 'project_removed'))
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
               THEN due.admitted END, t.phase IN ('closing', 'done', 'cancelled'), t.queue_priority,
               CASE WHEN t.phase IN ('queued', 'working') AND t.run IS NULL
               THEN json_extract(t.brief, '$.text') END
             FROM due JOIN tasks t ON t.id = due.id ORDER BY due.admitted",
        )?;
        let ids = query.query_map(params![limit, after.unwrap_or_default()], read_seed)?;
        Ok(ids.collect::<Result<_, _>>()?)
    }

    /// Every task whose next send needs a launch slot, whatever its role. A
    /// restart ranks all of them before it assigns a slot to any one.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the tasks.
    pub fn slot_candidates(&self) -> Result<Vec<TaskSeed>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT id, rowid, 0, queue_priority, json_extract(brief, '$.text') FROM tasks
             WHERE phase IN ('queued', 'working', 'reviewing') AND hold IS NULL AND question IS NULL
               AND (run IS NULL OR json_extract(run, '$.last_send_at_ms') IS NULL)
             ORDER BY rowid",
        )?;
        let seeds = query.query_map([], read_seed)?;
        Ok(seeds.collect::<Result<_, _>>()?)
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

    /// Count other tasks whose possibly sent run still holds a launch slot, by
    /// the weight each held brief declares.
    /// # Errors
    /// Returns an error if row custody cannot be read.
    pub fn occupied_slots(&self, except: &str) -> Result<Slots, StoreError> {
        let mut query = self.connection.prepare_cached("SELECT json_extract(brief, '$.text') FROM tasks WHERE id <> ?1 AND run IS NOT NULL AND json_extract(run, '$.last_send_at_ms') IS NOT NULL")?;
        let mut rows = query.query([except])?;
        let mut occupied = Slots::default();
        while let Some(row) = rows.next()? {
            occupied.add(declared_weight(row.get::<_, Option<String>>(0)?.as_deref()));
        }
        Ok(occupied)
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

    /// Page completed tasks for native thread housekeeping. A removed project's
    /// tasks have no route left and are never due.
    /// # Errors
    /// Returns an error if the pending archive page cannot be read.
    pub fn archive_due_ids(
        &self,
        after: Option<&str>,
        limit: u32,
        parenting: bool,
    ) -> Result<Vec<String>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT id FROM tasks WHERE id > ?1 AND phase IN ('done','cancelled') AND run IS NULL
             AND (?3 OR (phase='done' AND report_task IS NOT NULL))
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = tasks.id AND e.kind = 'project_removed')
             UNION SELECT n.task_id FROM completion_notices n JOIN tasks t ON t.id=n.task_id
             WHERE n.task_id > ?1 AND n.retry IS NOT NULL AND t.phase IN ('done','cancelled') AND t.run IS NULL
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.kind = 'project_removed')
             ORDER BY 1 LIMIT ?2",
        )?;
        let rows = query.query_map(
            params![after.unwrap_or_default(), limit, parenting],
            |row| row.get(0),
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// First attempt (false), sole retry (true), or no pending origin closeout notice.
    ///
    /// # Errors
    /// Returns an error if the notice cannot be read.
    pub fn completion_notice(&self, id: &str) -> Result<Option<bool>, StoreError> {
        self.completion_notice_for(id, None)
    }

    /// First attempt (false), sole retry (true), or no pending closeout notice for one recipient.
    ///
    /// # Errors
    /// Returns an error if the notice cannot be read.
    pub fn completion_notice_for(
        &self,
        id: &str,
        watcher: Option<&str>,
    ) -> Result<Option<bool>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT retry FROM completion_notices WHERE task_id=?1 AND recipient=?2 AND retry IS NOT NULL",
                params![id, watcher.unwrap_or("")],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// All pending closeout notice recipients for a task (origin planner first, then watchers).
    ///
    /// # Errors
    /// Returns an error if the notices cannot be read.
    pub fn completion_notices(&self, id: &str) -> Result<Vec<CompletionNotice>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT CASE WHEN recipient = '' THEN NULL ELSE recipient END, retry
             FROM completion_notices WHERE task_id=?1 AND retry IS NOT NULL ORDER BY recipient",
        )?;
        let rows = query.query_map([id], |row| {
            Ok(CompletionNotice {
                watcher: row.get(0)?,
                retry: row.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Claim or reopen the exact pending attempt for one recipient together with its native evidence.
    ///
    /// # Errors
    /// Returns an error if the occurrence changed or the evidence cannot be saved.
    pub fn set_completion_notice(
        &mut self,
        id: &str,
        watcher: Option<&str>,
        expected: Option<bool>,
        next: Option<bool>,
        audit: &EventDraft,
    ) -> Result<(), StoreError> {
        let tx = self.connection.transaction()?;
        if tx.execute(
            "UPDATE completion_notices SET retry=?4 WHERE task_id=?1 AND recipient=?2 AND retry IS ?3",
            params![id, watcher.unwrap_or(""), expected, next],
        )? != 1
        {
            return Err(StoreError::StaleTask);
        }
        append(&tx, id, audit)?;
        Ok(tx.commit()?)
    }

    /// Subscribe `thread` to a non-terminal task's completion notice in one transaction.
    /// Returns `None` when the task does not exist, or `(row, true)` when subscribed.
    ///
    /// # Errors
    /// Returns an error if the task or watcher table cannot be updated.
    pub fn watch_task(
        &mut self,
        id: &str,
        thread: &str,
        now_ms: i64,
    ) -> Result<Option<(TaskRow, bool)>, StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(row) = load(&tx, id)? else {
            return Ok(None);
        };
        if row.task.phase().is_terminal() {
            return Ok(Some((row, false)));
        }
        tx.execute(
            "INSERT OR IGNORE INTO task_watchers (task_id, thread, added_at_ms) VALUES (?1, ?2, ?3)",
            params![id, thread, now_ms],
        )?;
        tx.commit()?;
        Ok(Some((row, true)))
    }

    /// Remove `thread` from a task's watchers in one transaction.
    /// Returns `None` when the task does not exist.
    ///
    /// # Errors
    /// Returns an error if the task or watcher table cannot be updated.
    pub fn unwatch_task(&mut self, id: &str, thread: &str) -> Result<Option<TaskRow>, StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(row) = load(&tx, id)? else {
            return Ok(None);
        };
        tx.execute(
            "DELETE FROM task_watchers WHERE task_id = ?1 AND thread = ?2",
            params![id, thread],
        )?;
        tx.commit()?;
        Ok(Some(row))
    }

    /// Watcher count for `id`, and whether `thread` is currently watching.
    ///
    /// # Errors
    /// Returns an error if the watcher summary cannot be read.
    pub fn watcher_summary(
        &self,
        id: &str,
        thread: Option<&str>,
    ) -> Result<(usize, bool), StoreError> {
        let (count, watching): (i64, bool) = self.connection.query_row(
            "SELECT count(*), coalesce(max(CASE WHEN ?2 IS NOT NULL AND thread = ?2 THEN 1 ELSE 0 END), 0)
             FROM task_watchers WHERE task_id = ?1",
            params![id, thread],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((usize::try_from(count).unwrap_or_default(), watching))
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
            "SELECT {TASK_COLUMNS}, {PAPERCUT_TITLE} FROM tasks WHERE phase NOT IN ('done','cancelled') OR run IS NOT NULL ORDER BY id"
        ))
    }

    /// Read all tasks for the board, including terminal rows.
    /// # Errors
    /// Returns an error if the database cannot read or decode the rows.
    pub fn list(&self) -> Result<TaskList, StoreError> {
        self.list_rows("ORDER BY id")
    }

    /// Read restorable active rows that predate their native presentation binding.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the task listing.
    pub fn tasks_without_titles(&self) -> Result<Vec<TaskRow>, StoreError> {
        Ok(self
            .list_rows(
                "WHERE phase NOT IN ('done','cancelled')
             AND NOT EXISTS (SELECT 1 FROM task_titles WHERE task_id = tasks.id)",
            )?
            .readable)
    }

    fn list_rows(&self, clause: &str) -> Result<TaskList, StoreError> {
        let mut query = self.connection.prepare_cached(&format!(
            "SELECT {TASK_COLUMNS}, version, {PUBLIC_NUMBER}, {PAPERCUT_TITLE} FROM tasks {clause}"
        ))?;
        let mut tasks = TaskList::default();
        for row in query.query_map([], decode_listed_row)? {
            match row? {
                Ok(row) => tasks.readable.push(row),
                Err(damaged) => tasks.unreadable.push(*damaged),
            }
        }
        Ok(tasks)
    }

    fn tasks(&self, statement: &str) -> Result<Vec<Task>, StoreError> {
        let mut query = self.connection.prepare_cached(statement)?;
        let rows = query.query_map([], decode_display_task)?;
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
        self.set_subscription_pause(
            group,
            SubscriptionPause {
                until_ms,
                fallback: false,
            },
            now_ms,
        )?;
        Ok(())
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

    /// Whether this closeout owes the dispatching planner a completion notice
    /// (rulings 55 and 42). A report-only task that already sent its report
    /// notice is not owed a second one.
    fn completion_notice_owed(task: &Task) -> bool {
        if task
            .report_task()
            .is_some_and(|report| report.notice_attempted)
        {
            return false;
        }
        nucleus_core::profiles::BriefPolicy::parse(&task.brief().text)
            .is_ok_and(|policy| policy.notifies_origin_on_closeout())
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
            if !row.task.phase().is_terminal() {
                let id = &task.identity().id;
                if Self::completion_notice_owed(task) {
                    tx.execute(
                        "INSERT OR IGNORE INTO completion_notices (task_id, recipient, retry) VALUES (?1, '', 0)",
                        [id],
                    )?;
                    tx.execute(
                        "INSERT OR IGNORE INTO completion_notices (task_id, recipient, retry)
                         SELECT task_id, thread, 0 FROM task_watchers
                         WHERE task_id = ?1 AND (?2 IS NULL OR thread != ?2)",
                        params![id, task.identity().origin_thread.as_deref()],
                    )?;
                } else {
                    tx.execute(
                        "INSERT OR IGNORE INTO completion_notices (task_id, recipient, retry)
                         SELECT task_id, thread, 0 FROM task_watchers WHERE task_id = ?1",
                        [id],
                    )?;
                }
                tx.execute("DELETE FROM task_watchers WHERE task_id = ?1", [id])?;
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
        if row.task.phase() != task.phase() {
            append(
                &tx,
                &task.identity().id,
                &EventDraft {
                    at: event.at,
                    kind: "phase_transition".into(),
                    detail: serde_json::json!({
                        "from": row.task.phase(),
                        "to": task.phase(),
                    })
                    .to_string(),
                },
            )?;
        }
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

    /// Read the latest shared-model notice from the reservation audit.
    ///
    /// # Errors
    /// Returns an error if history cannot be read.
    pub fn last_shared_model(&self, id: &str) -> Result<Option<String>, StoreError> {
        self.last_event_text(id, "$.sharedModel.message", Some("run_reserved"))
    }

    /// Read the lifecycle audit records in task order.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the display history.
    pub fn lifecycle_events(&self, id: &str) -> Result<Vec<Event>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT sequence, at, kind, detail FROM events
             WHERE task_id = ?1 AND (
                kind IN ('host_send', 'reported', 'phase_transition', 'provider_limit')
                OR json_type(CASE WHEN json_valid(detail) THEN detail END, '$.presentation') = 'array'
             ) ORDER BY sequence",
        )?;
        let rows = query.query_map([id], event_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The latest merge commit recorded from an observed merge of this task.
    ///
    /// # Errors
    /// Returns an error if history cannot be read or holds an invalid commit.
    pub fn merge_commit(&self, id: &str) -> Result<Option<Head>, StoreError> {
        Ok(self
            .last_event_text(id, "$.mergeCommit", None)?
            .map(|commit| serde_json::from_value(Value::String(commit)))
            .transpose()?)
    }

    fn last_event_text(
        &self,
        id: &str,
        path: &str,
        kind: Option<&str>,
    ) -> Result<Option<String>, StoreError> {
        Ok(self
            .connection
            .prepare_cached(
                "SELECT json_extract(detail, ?2) FROM events
             WHERE task_id = ?1 AND (?3 IS NULL OR kind = ?3)
               AND json_type(CASE WHEN json_valid(detail) THEN detail END, ?2) = 'text'
             ORDER BY sequence DESC LIMIT 1",
            )?
            .query_row(params![id, path, kind], |row| row.get(0))
            .optional()?)
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
            &format!("SELECT {TASK_COLUMNS}, version, {PUBLIC_NUMBER}, {PAPERCUT_TITLE} FROM tasks WHERE id = ?1"),
            [id],
            decode_row,
        )
        .optional()
}

fn decode_row(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        task: decode_display_task(row)?,
        version: row.get("version")?,
        number: row.get("public_number")?,
    })
}

fn decode_listed_row(row: &Row<'_>) -> rusqlite::Result<Result<TaskRow, Box<UnreadableTask>>> {
    match decode_row(row) {
        Ok(task) => Ok(Ok(task)),
        Err(rusqlite::Error::FromSqlConversionFailure(_, _, cause)) => {
            let identity: Identity = serde_json::from_value(identity_columns(row)?)
                .map_err(|error| decode_error(0, error))?;
            let number: Option<i64> = row.get("public_number")?;
            let reference = number.map_or_else(
                || identity.reference.clone(),
                |n| numbers::reference(&identity.repository, n),
            );
            Ok(Err(Box::new(UnreadableTask {
                identity,
                number,
                reference,
                version: row.get("version")?,
                cause: cause.to_string(),
            })))
        }
        Err(error) => Err(error),
    }
}

fn identity_columns(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "reference": row.get::<_, String>(1)?,
        "repository": row.get::<_, String>(2)?,
        "base": row.get::<_, String>(3)?,
        "entry": row.get::<_, String>(4)?,
        "origin_thread": row.get::<_, Option<String>>(14)?,
    }))
}

fn decode_display_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let mut task = decode_task(row)?;
    task.papercut_title = row.get("papercut_title")?;
    Ok(task)
}

fn decode_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let value = json!({
        "identity": identity_columns(row)?,
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
        "queue_priority": row.get::<_, String>(17)?,
        "merge_hold": json_column(row, 18)?,
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
        "INSERT INTO tasks ({TASK_COLUMNS}) VALUES (\n        :id, :reference, :repository, :base, :entry, :brief, :phase, :threads,\n        :run, :pr, :verdict, :attempts, :question, :hold, :origin_thread, :report_task, :work_continuation, :queue_priority, :merge_hold)"
    );
    if update {
        sql.push_str(" ON CONFLICT(id) DO UPDATE SET\n            brief = excluded.brief, phase = excluded.phase, threads = excluded.threads,\n            run = excluded.run, pr = excluded.pr, verdict = excluded.verdict,\n            attempts = excluded.attempts, question = excluded.question, hold = excluded.hold,\n            report_task = excluded.report_task, work_continuation = excluded.work_continuation,\n            queue_priority = excluded.queue_priority, merge_hold = excluded.merge_hold, version = tasks.version + 1");
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
            ":queue_priority": if task.queue_priority().is_promoted() { "promoted" } else { "normal" },
            ":merge_hold": nullable_json("merge_hold"),
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

#[cfg(test)]
mod completion_notice_tests {
    use nucleus_core::{Entry, Head, Identity, Task};
    use serde_json::{Value, json};

    use crate::{EventDraft, Store, settings::test_store};

    const PLAIN: &str = "---\nqueue:\n  complexity: low\n---\n# Fix rounding";
    const ON: &str = "---\nqueue:\n  notifyOriginOnCloseout: true\n---\n# Fix rounding";
    const OFF: &str = "---\nqueue:\n  notifyOriginOnCloseout: false\n---\n# Fix rounding";

    fn identity(id: &str) -> Identity {
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: "fixture/repo".into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        }
    }

    fn event(kind: &str) -> EventDraft {
        EventDraft {
            at: 1,
            kind: kind.into(),
            detail: String::new(),
        }
    }

    fn fixture() -> (tempfile::TempDir, Store) {
        let temporary = tempfile::tempdir().expect("fixture home");
        let root = temporary.path().canonicalize().expect("canonical home");
        let store = test_store(&root.join("engine"));
        (temporary, store)
    }

    /// Move the stored task to `phase` through the same save path closeout uses.
    fn settle(store: &mut Store, id: &str, phase: &str) {
        let row = store.row(id).unwrap().unwrap();
        let mut value = serde_json::to_value(&row.task).unwrap();
        value["phase"] = json!(phase);
        let settled: Task = serde_json::from_value(value).unwrap();
        store.save_row(&row, &settled, &event("settled")).unwrap();
    }

    #[test]
    fn a_closeout_owes_a_notice_unless_its_brief_opts_out() {
        let (_home, mut store) = fixture();
        for (id, brief) in [
            ("plain-done", PLAIN),
            ("plain-cancelled", PLAIN),
            ("off-done", OFF),
            ("on-done", ON),
        ] {
            store
                .create(
                    &Task::new(identity(id), brief.into(), None),
                    &event("admitted"),
                )
                .unwrap();
        }
        settle(&mut store, "plain-done", "done");
        settle(&mut store, "plain-cancelled", "cancelled");
        settle(&mut store, "off-done", "done");
        settle(&mut store, "on-done", "done");

        assert_eq!(store.completion_notice("plain-done").unwrap(), Some(false));
        assert_eq!(
            store.completion_notice("plain-cancelled").unwrap(),
            Some(false)
        );
        assert_eq!(store.completion_notice("off-done").unwrap(), None);
        assert_eq!(store.completion_notice("on-done").unwrap(), Some(false));
    }

    #[test]
    fn a_report_only_task_sends_no_second_notice_after_its_report_notice() {
        let (_home, mut store) = fixture();
        let head: Head = serde_json::from_value(json!("a".repeat(40))).unwrap();
        for id in ["unreported", "reported"] {
            store
                .create(
                    &Task::new_report_only(
                        identity(id),
                        PLAIN.into(),
                        "fixture".into(),
                        "qa".into(),
                        head.clone(),
                    ),
                    &event("admitted"),
                )
                .unwrap();
        }

        // The worker reported, and the report notice went to the planner.
        let row = store.row("reported").unwrap().unwrap();
        let mut value: Value = serde_json::to_value(&row.task).unwrap();
        value["phase"] = json!("report_ready");
        value["report_task"]["delivery"] = json!({
            "artifact": {"key": "qa/fix", "version": 1, "digest": "fixture"},
            "summary": "Synthetic report"
        });
        let mut reported: Task = serde_json::from_value(value).unwrap();
        reported.mark_report_notice_attempted();
        store.save_row(&row, &reported, &event("reported")).unwrap();

        settle(&mut store, "unreported", "cancelled");
        settle(&mut store, "reported", "cancelled");

        assert_eq!(store.completion_notice("unreported").unwrap(), Some(false));
        assert_eq!(store.completion_notice("reported").unwrap(), None);
    }

    #[test]
    fn watchers_expand_completion_notices_once_per_recipient() {
        let (_home, mut store) = fixture();
        let mut origin_identity = identity("watched");
        origin_identity.origin_thread = Some("origin-planner".into());
        store
            .create(
                &Task::new(origin_identity, PLAIN.into(), None),
                &event("admitted"),
            )
            .unwrap();
        store
            .create(
                &Task::new(identity("opt-out"), OFF.into(), None),
                &event("admitted"),
            )
            .unwrap();

        for (task, thread, at) in [
            ("watched", "origin-planner", 10),
            ("watched", "other-planner", 11),
            ("watched", "unwatched-planner", 12),
            ("watched", "other-planner", 13),
            ("opt-out", "other-planner", 14),
        ] {
            assert!(store.watch_task(task, thread, at).unwrap().unwrap().1);
        }
        assert!(
            store
                .unwatch_task("watched", "unwatched-planner")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            store
                .watcher_summary("watched", Some("other-planner"))
                .unwrap(),
            (2, true)
        );
        assert_eq!(
            store
                .watcher_summary("watched", Some("unwatched-planner"))
                .unwrap(),
            (2, false)
        );

        settle(&mut store, "watched", "done");
        settle(&mut store, "opt-out", "cancelled");

        assert_eq!(
            store
                .watcher_summary("watched", Some("other-planner"))
                .unwrap(),
            (0, false)
        );
        assert_eq!(
            store.completion_notices("watched").unwrap(),
            vec![
                crate::CompletionNotice {
                    watcher: None,
                    retry: false,
                },
                crate::CompletionNotice {
                    watcher: Some("other-planner".into()),
                    retry: false,
                },
            ]
        );
        assert_eq!(
            store.completion_notices("opt-out").unwrap(),
            vec![crate::CompletionNotice {
                watcher: Some("other-planner".into()),
                retry: false,
            }]
        );
        assert!(
            !store
                .watch_task("watched", "late-planner", 20)
                .unwrap()
                .unwrap()
                .1
        );
        assert_eq!(store.completion_notices("watched").unwrap().len(), 2);

        store
            .set_completion_notice(
                "watched",
                Some("other-planner"),
                Some(false),
                None,
                &event("sent"),
            )
            .unwrap();
        assert_eq!(
            store.completion_notices("watched").unwrap(),
            vec![crate::CompletionNotice {
                watcher: None,
                retry: false,
            }]
        );
    }

    #[test]
    fn upgrading_schema_14_migrates_completion_notices_per_recipient() {
        let (home, mut store) = fixture();
        store
            .create(
                &Task::new(identity("watched"), PLAIN.into(), None),
                &event("admitted"),
            )
            .unwrap();
        settle(&mut store, "watched", "done");
        drop(store);

        let root = home.path().canonicalize().unwrap().join("engine");
        let db = rusqlite::Connection::open(root.join("data/databases/engine.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE completion_notices_v14 (task_id TEXT PRIMARY KEY REFERENCES tasks(id), retry INTEGER CHECK (retry IN (0,1))) STRICT;
             INSERT INTO completion_notices_v14 (task_id, retry) SELECT task_id, retry FROM completion_notices WHERE recipient = '' AND retry IS NOT NULL;
             DROP TABLE completion_notices;
             ALTER TABLE completion_notices_v14 RENAME TO completion_notices;
             PRAGMA user_version = 14;",
        )
        .unwrap();
        drop(db);
        let reopened = crate::settings::test_store(&root);
        assert_eq!(
            reopened.completion_notices("watched").unwrap(),
            vec![crate::CompletionNotice {
                watcher: None,
                retry: false,
            }]
        );
    }
}
