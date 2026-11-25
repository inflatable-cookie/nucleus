use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_row_snoozes (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    thread TEXT NOT NULL,
    receipt TEXT NOT NULL
) STRICT";

/// Recorded outcome of one exact native snooze command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SnoozeOutcome {
    Unknown,
    Refused,
    Observed,
}

/// Ownership of the requested horizon and, during renewal, the previous one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowSnooze {
    pub episode: u64,
    pub until_ms: u64,
    pub previous_until_ms: Option<u64>,
    pub outcome: SnoozeOutcome,
    pub clear_attempted_for: Option<u64>,
    pub ended: bool,
}

impl RowSnooze {
    /// Compare the timestamp reported by T3 with the exact recorded occurrence.
    #[must_use]
    pub fn owns(&self, observed: Option<u64>) -> bool {
        observed.is_some()
            && ((self.outcome != SnoozeOutcome::Refused && observed == Some(self.until_ms))
                || observed == self.previous_until_ms)
    }
}

impl Store {
    /// Read the last snooze intent for the exact task and native destination.
    ///
    /// # Errors
    /// Returns an error if the receipt cannot be read or decoded.
    pub fn row_snooze(&self, task: &str, thread: &str) -> Result<Option<RowSnooze>, StoreError> {
        let receipt: Option<String> = self
            .connection
            .query_row(
                "SELECT receipt FROM task_row_snoozes WHERE task_id = ?1 AND thread = ?2",
                params![task, thread],
                |row| row.get(0),
            )
            .optional()?;
        Ok(receipt.as_deref().map(serde_json::from_str).transpose()?)
    }

    /// Store an intent before dispatch or record facts from native readback.
    ///
    /// # Errors
    /// Returns an error if the receipt cannot be saved.
    pub fn save_row_snooze(
        &self,
        task: &str,
        thread: &str,
        receipt: &RowSnooze,
    ) -> Result<(), StoreError> {
        save(&self.connection, task, thread, receipt)
    }

    /// Forget presentation ownership when a task finishes or its snooze ends.
    ///
    /// # Errors
    /// Returns an error if the receipt cannot be deleted.
    pub fn forget_row_snooze(&self, task: &str) -> Result<(), StoreError> {
        forget(&self.connection, task)
    }
}

fn save(
    connection: &Connection,
    task: &str,
    thread: &str,
    receipt: &RowSnooze,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO task_row_snoozes (task_id, thread, receipt) VALUES (?1, ?2, ?3)
         ON CONFLICT(task_id) DO UPDATE SET thread = excluded.thread, receipt = excluded.receipt",
        params![task, thread, serde_json::to_string(receipt)?],
    )?;
    Ok(())
}

pub(crate) fn forget(connection: &Connection, task: &str) -> Result<(), StoreError> {
    connection.execute("DELETE FROM task_row_snoozes WHERE task_id = ?1", [task])?;
    Ok(())
}
