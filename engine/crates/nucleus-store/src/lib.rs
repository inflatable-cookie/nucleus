//! The Rust engine's independent `SQLite` database.

use std::{fs, path::Path, time::Duration};

use nucleus_core::Task;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior, named_params,
    params,
};
use serde_json::{Value, json};

const APPLICATION_ID: i32 = i32::from_be_bytes(*b"N070");
const SCHEMA_VERSION: i32 = 1;
const DATABASE_FILE: &str = "engine.sqlite";
const TASK_COLUMNS: &str = "id, reference, repository, base, entry, brief, phase, threads, run, pr, verdict, attempts, question, hold";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("could not prepare the engine data directory")]
    Directory(#[source] std::io::Error),
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventDraft {
    pub at: i64,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub sequence: i64,
    pub content: EventDraft,
}

pub struct Store {
    connection: Connection,
}

impl Store {
    /// Open the database at `data_root/engine.sqlite`.
    ///
    /// # Errors
    /// Returns an error if storage is inaccessible or the file belongs to
    /// another application or schema version.
    pub fn open(data_root: &Path) -> Result<Self, StoreError> {
        fs::create_dir_all(data_root).map_err(StoreError::Directory)?;
        let mut connection = Connection::open_with_flags(
            data_root.join(DATABASE_FILE),
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
        Ok(load(&self.connection, id)?)
    }

    /// Read tasks that can still take an engine pass, including pending stops.
    ///
    /// # Errors
    /// Returns an error if the database cannot read or decode the rows.
    pub fn active(&self) -> Result<Vec<Task>, StoreError> {
        let mut query = self.connection.prepare_cached(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE phase NOT IN ('done','cancelled') OR run IS NOT NULL ORDER BY id"
        ))?;
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
        if expected.identity() != task.identity() {
            return Err(StoreError::IdentityChanged);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load(&tx, &task.identity().id)?.as_ref() != Some(expected) {
            return Err(StoreError::StaleTask);
        }
        persist(&tx, task, true)?;
        append(&tx, &task.identity().id, event)?;
        tx.commit()?;
        Ok(())
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

fn load(connection: &Connection, id: &str) -> rusqlite::Result<Option<Task>> {
    connection
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"),
            [id],
            decode_task,
        )
        .optional()
}

fn decode_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    let value = json!({
        "identity": {
            "id": row.get::<_, String>(0)?,
            "reference": row.get::<_, String>(1)?,
            "repository": row.get::<_, String>(2)?,
            "base": row.get::<_, String>(3)?,
            "entry": row.get::<_, String>(4)?,
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
        "INSERT INTO tasks ({TASK_COLUMNS}) VALUES (\n        :id, :reference, :repository, :base, :entry, :brief, :phase, :threads,\n        :run, :pr, :verdict, :attempts, :question, :hold)"
    );
    if update {
        sql.push_str(" ON CONFLICT(id) DO UPDATE SET\n            brief = excluded.brief, phase = excluded.phase, threads = excluded.threads,\n            run = excluded.run, pr = excluded.pr, verdict = excluded.verdict,\n            attempts = excluded.attempts, question = excluded.question, hold = excluded.hold");
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
