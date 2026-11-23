//! The Rust engine's independent `SQLite` database.

mod settings;
mod volume;

use std::time::Duration;

use nucleus_core::Task;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior, named_params,
    params,
};
use serde_json::{Value, json};

pub use settings::{EngineSettings, EngineStorage, SettingsFile, StorageError};
pub use volume::{PinnedVolume, StorageDirectory};

const APPLICATION_ID: i32 = i32::from_be_bytes(*b"N070");
const SCHEMA_VERSION: i32 = 2;
const DATABASE_FILE: &str = "engine.sqlite";
const TASK_COLUMNS: &str = "id, reference, repository, base, entry, brief, phase, threads, run, pr, verdict, attempts, question, hold, origin_thread";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("could not prepare the engine data directory")]
    Storage(#[from] StorageError),
    #[error("unsupported engine database (application {application}, version {version})")]
    Incompatible { application: i32, version: i32 },
    #[error("task identity is immutable")]
    IdentityChanged,
    #[error("task changed since it was read")]
    StaleTask,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    pub task: Task,
    pub version: i64,
}

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
        let mut connection = Connection::open_with_flags(
            directory.path().join(DATABASE_FILE),
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let application = tx.pragma_query_value(None, "application_id", |row| row.get(0))?;
        let version = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match (application, version) {
            (0, 0)
                if tx.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
                    row.get::<_, i64>(0)
                })? == 0 =>
            {
                tx.execute_batch(include_str!("schema.sql"))?;
                tx.pragma_update(None, "application_id", APPLICATION_ID)?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            }
            (APPLICATION_ID, SCHEMA_VERSION) => {}
            (APPLICATION_ID, 1) => {
                tx.execute("ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)", [])?;
                tx.execute("ALTER TABLE tasks ADD COLUMN origin_thread TEXT", [])?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            }
            _ => {
                return Err(StoreError::Incompatible {
                    application,
                    version,
                });
            }
        }
        tx.commit()?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", true)?;
        Ok(Self { connection })
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

    /// Read one bounded page of active task IDs from the active index.
    /// # Errors
    /// Returns an error if the database cannot read the page.
    pub fn active_ids(&self, after: Option<&str>, limit: u32) -> Result<Vec<String>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT id FROM tasks WHERE (phase NOT IN ('done','cancelled') OR run IS NOT NULL)
             AND (?1 IS NULL OR id > ?1) ORDER BY id LIMIT ?2",
        )?;
        let rows = query.query_map(params![after, limit], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Count other tasks whose possibly sent run still holds a launch slot.
    /// # Errors
    /// Returns an error if row custody cannot be read.
    pub fn occupied_slots(&self, except: &str) -> Result<u32, StoreError> {
        Ok(self.connection.query_row("SELECT count(*) FROM tasks WHERE id <> ?1 AND json_extract(run, '$.last_send_at_ms') IS NOT NULL", [except], |row| row.get(0))?)
    }

    /// Read bounded project provenance for responsible planner discovery.
    /// # Errors
    /// Returns an error if task identities or their retained roles cannot be read.
    pub fn routing_tasks(&self, repository: &str, limit: u32) -> Result<Vec<Task>, StoreError> {
        let mut query = self.connection.prepare_cached(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE repository = ?1 ORDER BY id LIMIT ?2"
        ))?;
        let rows = query.query_map(params![repository, limit], decode_task)?;
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
            "SELECT {TASK_COLUMNS}, version FROM tasks ORDER BY id"
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
    pub fn create(&mut self, task: &Task, event: &EventDraft) -> Result<(), StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        persist(&tx, task, false)?;
        append(&tx, &task.identity().id, event)?;
        tx.commit()?;
        Ok(())
    }

    /// Replace a task if its observed state is still current. State and audit
    /// event commit together. Callers perform remote I/O outside the transaction.
    ///
    /// # Errors
    /// Returns an error if the expected state is stale or the write fails.
    pub fn save(
        &mut self,
        expected: &Task,
        task: &Task,
        event: &EventDraft,
    ) -> Result<(), StoreError> {
        self.replace(expected, None, task, event).map(|_| ())
    }

    /// Replace exactly the row version and run read by the caller.
    /// # Errors
    /// Returns an error on a competing write or transaction failure.
    pub fn save_row(
        &mut self,
        expected: &TaskRow,
        task: &Task,
        event: &EventDraft,
    ) -> Result<i64, StoreError> {
        self.replace(&expected.task, Some(expected.version), task, event)
    }

    fn replace(
        &mut self,
        expected: &Task,
        version: Option<i64>,
        task: &Task,
        event: &EventDraft,
    ) -> Result<i64, StoreError> {
        if expected.identity() != task.identity() {
            return Err(StoreError::IdentityChanged);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = load(&tx, &task.identity().id)?.ok_or(StoreError::StaleTask)?;
        if &row.task != expected || version.is_some_and(|version| version != row.version) {
            return Err(StoreError::StaleTask);
        }
        persist(&tx, task, true)?;
        append(&tx, &task.identity().id, event)?;
        tx.commit()?;
        Ok(row.version + 1)
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
        let rows = query.query_map(params![id, before, limit], |row| {
            Ok(Event {
                sequence: row.get(0)?,
                content: EventDraft {
                    at: row.get(1)?,
                    kind: row.get(2)?,
                    detail: row.get(3)?,
                },
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

fn load(connection: &Connection, id: &str) -> rusqlite::Result<Option<TaskRow>> {
    connection
        .query_row(
            &format!("SELECT {TASK_COLUMNS}, version FROM tasks WHERE id = ?1"),
            [id],
            decode_row,
        )
        .optional()
}

fn decode_row(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        task: decode_task(row)?,
        version: row.get(15)?,
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

fn persist(tx: &Transaction<'_>, task: &Task, update: bool) -> Result<(), StoreError> {
    let identity = task.identity();
    let snapshot = serde_json::to_value(task)?;
    let mut sql = format!(
        "INSERT INTO tasks ({TASK_COLUMNS}) VALUES (\n        :id, :reference, :repository, :base, :entry, :brief, :phase, :threads,\n        :run, :pr, :verdict, :attempts, :question, :hold, :origin_thread)"
    );
    if update {
        sql.push_str(" ON CONFLICT(id) DO UPDATE SET\n            brief = excluded.brief, phase = excluded.phase, threads = excluded.threads,\n            run = excluded.run, pr = excluded.pr, verdict = excluded.verdict,\n            attempts = excluded.attempts, question = excluded.question, hold = excluded.hold,\n            version = tasks.version + 1");
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
