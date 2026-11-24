use rusqlite::{Connection, params};

use crate::{Store, StoreError};

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_board_state (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    label TEXT NOT NULL,
    since_ms INTEGER NOT NULL CHECK (since_ms >= 0)
) STRICT";

/// The current display label and when it became effective.
pub struct BoardState {
    pub label: String,
    pub since_ms: i64,
}

impl Store {
    /// Read the committed display state and the admission time.
    ///
    /// # Errors
    /// Returns an error if the display state or admission audit cannot be read.
    pub fn board_state(&self, id: &str) -> Result<(Option<BoardState>, Option<u64>), StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT label, since_ms, (
                SELECT at FROM events WHERE task_id = ?1 ORDER BY sequence LIMIT 1
             ) FROM (SELECT 1) LEFT JOIN task_board_state ON task_id = ?1",
        )?;
        Ok(query.query_row([id], |row| {
            let label = row.get::<_, Option<String>>(0)?;
            let current = label
                .map(|label| row.get(1).map(|since_ms| BoardState { label, since_ms }))
                .transpose()?;
            let created = row
                .get::<_, Option<i64>>(2)?
                .and_then(|at| u64::try_from(at).ok());
            Ok((current, created))
        })?)
    }

    /// Record the scheduler's current display state without changing task version.
    ///
    /// # Errors
    /// Returns an error if the projection cannot be written.
    pub fn record_board_state(&self, id: &str, label: &str, at: i64) -> Result<bool, StoreError> {
        record(&self.connection, id, label, at)
    }
}

pub(super) fn record(
    connection: &Connection,
    id: &str,
    label: &str,
    at: i64,
) -> Result<bool, StoreError> {
    let mut query = connection.prepare_cached(
        "INSERT INTO task_board_state (task_id, label, since_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(task_id) DO UPDATE SET label = excluded.label, since_ms = excluded.since_ms
         WHERE label <> excluded.label",
    )?;
    Ok(query.execute(params![id, label, at])? != 0)
}
