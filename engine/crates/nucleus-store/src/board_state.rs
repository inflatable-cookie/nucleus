use rusqlite::{Connection, params};

use crate::{Store, StoreError};

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_board_state (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    since_ms INTEGER NOT NULL CHECK (since_ms >= 0)
) STRICT";

impl Store {
    /// Read the recorded state-entry and admission times for the board.
    ///
    /// # Errors
    /// Returns an error if the timestamps cannot be read.
    pub fn board_times(&self, id: &str) -> Result<(Option<u64>, Option<u64>), StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT (SELECT since_ms FROM task_board_state WHERE task_id = ?1),
                    (SELECT at FROM events WHERE task_id = ?1 ORDER BY sequence LIMIT 1)",
        )?;
        Ok(query.query_row([id], |row| {
            let time = |column| {
                row.get::<_, Option<i64>>(column)
                    .map(|value| value.and_then(|value| u64::try_from(value).ok()))
            };
            Ok((time(0)?, time(1)?))
        })?)
    }

    /// Record the time of a scheduler transition without changing task version.
    ///
    /// # Errors
    /// Returns an error if the timestamp cannot be written.
    pub fn record_board_entry(&self, id: &str, at: i64) -> Result<(), StoreError> {
        record(&self.connection, id, at)
    }
}

pub(super) fn record(connection: &Connection, id: &str, at: i64) -> Result<(), StoreError> {
    connection
        .prepare_cached(
            "INSERT INTO task_board_state (task_id, since_ms) VALUES (?1, ?2)
         ON CONFLICT(task_id) DO UPDATE SET since_ms = excluded.since_ms",
        )?
        .execute(params![id, at])?;
    Ok(())
}
