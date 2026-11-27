use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_row_snoozes (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    thread TEXT NOT NULL,
    receipt TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS parent_snoozes (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    command TEXT NOT NULL,
    thread TEXT NOT NULL,
    intent TEXT NOT NULL CHECK(json_valid(intent)),
    until_ms INTEGER NOT NULL CHECK(until_ms >= 0),
    due_ms INTEGER NOT NULL CHECK(due_ms >= 0),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    PRIMARY KEY (task_id, command)
) STRICT;
CREATE INDEX IF NOT EXISTS parent_snoozes_due ON parent_snoozes(due_ms)";

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

/// Pending restoration of an operator's visibility setting.
pub struct StoredParentSnooze {
    pub task: String,
    pub command: String,
    pub intent: String,
    pub until_ms: u64,
    pub attempt: i64,
}

impl Store {
    /// Record the current horizon before its exact parent command is sent.
    ///
    /// # Errors
    /// Returns an error if the intent cannot be saved.
    pub fn record_parent_snooze(
        &self,
        task: &str,
        command: &str,
        thread: &str,
        intent: &impl Serialize,
        until_ms: u64,
        now: u64,
    ) -> Result<(), StoreError> {
        let until_ms = sql_time(until_ms);
        let now = sql_time(now);
        let tx = self.connection.unchecked_transaction()?;
        // A newly observed operator horizon takes precedence over an older
        // restoration even if the new send has not yet reached T3.
        tx.execute(
            "DELETE FROM parent_snoozes WHERE task_id=?1 AND thread=?2 AND until_ms<>?3",
            params![task, thread, until_ms],
        )?;
        tx.execute(
            "INSERT INTO parent_snoozes (task_id, command, thread, intent, until_ms, due_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(task_id, command) DO UPDATE SET
               intent=excluded.intent, until_ms=excluded.until_ms, due_ms=excluded.due_ms,
               attempt=0 WHERE parent_snoozes.intent<>excluded.intent",
            params![
                task,
                command,
                thread,
                serde_json::to_string(intent)?,
                until_ms,
                now
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Read a bounded batch of due visibility work.
    ///
    /// # Errors
    /// Returns an error if the pending rows cannot be read.
    pub fn due_parent_snoozes(&self, now: u64) -> Result<Vec<StoredParentSnooze>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT task_id, command, intent, until_ms, attempt
             FROM parent_snoozes WHERE due_ms <= ?1 ORDER BY due_ms, rowid LIMIT 16",
        )?;
        Ok(query
            .query_map([sql_time(now)], |row| {
                Ok(StoredParentSnooze {
                    task: row.get(0)?,
                    command: row.get(1)?,
                    intent: row.get(2)?,
                    until_ms: row.get::<_, i64>(3)?.unsigned_abs(),
                    attempt: row.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    /// Check the due row again after acquiring its task fence.
    ///
    /// # Errors
    /// Returns an error if the current intent cannot be read.
    pub fn parent_snooze_is_due(
        &self,
        row: &StoredParentSnooze,
        now: u64,
    ) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM parent_snoozes
             WHERE task_id=?1 AND command=?2 AND intent=?3 AND attempt=?4 AND due_ms<=?5)",
            params![
                row.task,
                row.command,
                row.intent,
                row.attempt,
                sql_time(now)
            ],
            |row| row.get(0),
        )?)
    }

    /// Find the earliest pending restoration deadline.
    ///
    /// # Errors
    /// Returns an error if the deadline cannot be read.
    pub fn next_parent_snooze(&self) -> Result<Option<u64>, StoreError> {
        let due: Option<i64> =
            self.connection
                .query_row("SELECT min(due_ms) FROM parent_snoozes", [], |row| {
                    row.get(0)
                })?;
        Ok(due.map(i64::unsigned_abs))
    }

    /// Check whether an operator horizon takes precedence over automatic visibility.
    ///
    /// # Errors
    /// Returns an error if the pending work cannot be read.
    pub fn parent_snooze_pending(&self, task: &str, thread: &str) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM parent_snoozes WHERE task_id=?1 AND thread=?2)",
            params![task, thread],
            |row| row.get(0),
        )?)
    }

    /// Settle a restoration or record its next attempt and deadline.
    ///
    /// # Errors
    /// Returns an error if the outcome cannot be saved.
    pub fn finish_parent_snooze(
        &self,
        task: &str,
        command: &str,
        retry: Option<(i64, u64)>,
    ) -> Result<(), StoreError> {
        if let Some((attempt, due)) = retry {
            self.connection.execute(
                "UPDATE parent_snoozes SET attempt=?3, due_ms=?4 WHERE task_id=?1 AND command=?2",
                params![task, command, attempt, sql_time(due)],
            )?;
        } else {
            self.connection.execute(
                "DELETE FROM parent_snoozes WHERE task_id=?1 AND command=?2",
                params![task, command],
            )?;
        }
        Ok(())
    }

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

fn sql_time(time: u64) -> i64 {
    i64::try_from(time).unwrap_or(i64::MAX)
}
