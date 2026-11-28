use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_row_snoozes (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    thread TEXT NOT NULL,
    receipt TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS delivery_snoozes (
    command TEXT PRIMARY KEY,
    thread TEXT NOT NULL,
    intent TEXT NOT NULL CHECK(json_valid(intent)),
    until_ms INTEGER NOT NULL CHECK(until_ms >= 0),
    due_ms INTEGER NOT NULL CHECK(due_ms >= 0),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS delivery_snoozes_due ON delivery_snoozes(due_ms);
CREATE INDEX IF NOT EXISTS delivery_snoozes_thread ON delivery_snoozes(thread)";

pub(crate) fn prepare(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(SCHEMA)?;
    if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='parent_snoozes')",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        connection.execute_batch(
            "INSERT OR IGNORE INTO delivery_snoozes (command, thread, intent, until_ms, due_ms, attempt)
             SELECT command, thread, intent, until_ms, due_ms, attempt FROM parent_snoozes;
             DROP TABLE parent_snoozes;",
        )?;
    }
    Ok(())
}

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
pub struct StoredDeliverySnooze {
    pub command: String,
    pub intent: String,
    pub until_ms: u64,
    pub attempt: i64,
}

impl Store {
    /// Record an operator horizon before the command that can clear it is sent.
    ///
    /// # Errors
    /// Returns an error if the intent cannot be saved.
    pub fn record_delivery_snooze(
        &self,
        command: &str,
        thread: &str,
        intent: &impl Serialize,
        until_ms: u64,
        now: u64,
    ) -> Result<(), StoreError> {
        let until_ms = sql_time(until_ms);
        let now = sql_time(now);
        let intent = serde_json::to_string(intent)?;
        let tx = self.connection.unchecked_transaction()?;
        // A newly observed operator horizon takes precedence over an older
        // restoration even if the new send has not yet reached T3.
        tx.execute(
            "DELETE FROM delivery_snoozes WHERE thread=?1 AND
             (until_ms<>?2 OR json_extract(intent, '$.snoozed_at_ms')
              IS NOT json_extract(?3, '$.snoozed_at_ms'))",
            params![thread, until_ms, intent],
        )?;
        tx.execute(
            "INSERT INTO delivery_snoozes (command, thread, intent, until_ms, due_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(command) DO NOTHING",
            params![command, thread, intent, until_ms, now],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Record an accepted native send without disturbing a newer horizon.
    ///
    /// # Errors
    /// Returns an error if the receipt cannot be saved.
    pub fn accept_delivery_snooze(&self, command: &str, sequence: u64) -> Result<bool, StoreError> {
        Ok(self.connection.execute(
            "UPDATE delivery_snoozes SET intent=json_set(intent, '$.accepted_sequence', ?2),
             due_ms=0 WHERE command=?1",
            params![command, sql_time(sequence)],
        )? != 0)
    }

    /// Wait for the held shell to reflect an acknowledged restoration.
    ///
    /// # Errors
    /// Returns an error if the receipt cannot be saved.
    pub fn note_snooze_restoration(
        &self,
        command: &str,
        sequence: u64,
        due: u64,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE delivery_snoozes SET intent=json_set(intent, '$.restored_sequence', ?2),
             due_ms=?3 WHERE (thread, until_ms) =
             (SELECT thread, until_ms FROM delivery_snoozes WHERE command=?1)",
            params![command, sql_time(sequence), sql_time(due)],
        )?;
        Ok(())
    }

    /// Read a bounded batch of due visibility work.
    ///
    /// # Errors
    /// Returns an error if the pending rows cannot be read.
    pub fn due_delivery_snoozes(&self, now: u64) -> Result<Vec<StoredDeliverySnooze>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT command, intent, until_ms, attempt
             FROM delivery_snoozes WHERE due_ms <= ?1 ORDER BY due_ms, rowid LIMIT 16",
        )?;
        Ok(query
            .query_map([sql_time(now)], |row| {
                Ok(StoredDeliverySnooze {
                    command: row.get(0)?,
                    intent: row.get(1)?,
                    until_ms: row.get::<_, i64>(2)?.unsigned_abs(),
                    attempt: row.get(3)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    /// Check that a new send has not superseded the restoration.
    ///
    /// # Errors
    /// Returns an error if the current intent cannot be read.
    pub fn delivery_snooze_is_due(
        &self,
        row: &StoredDeliverySnooze,
        now: u64,
    ) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM delivery_snoozes
             WHERE command=?1 AND intent=?2 AND attempt=?3 AND due_ms<=?4)",
            params![row.command, row.intent, row.attempt, sql_time(now)],
            |row| row.get(0),
        )?)
    }

    /// Find the earliest pending restoration deadline.
    ///
    /// # Errors
    /// Returns an error if the deadline cannot be read.
    pub fn next_delivery_snooze(&self) -> Result<Option<u64>, StoreError> {
        let due: Option<i64> =
            self.connection
                .query_row("SELECT min(due_ms) FROM delivery_snoozes", [], |row| {
                    row.get(0)
                })?;
        Ok(due.map(i64::unsigned_abs))
    }

    /// Check whether an operator horizon takes precedence over automatic visibility.
    ///
    /// # Errors
    /// Returns an error if the pending work cannot be read.
    pub fn delivery_snooze_pending(&self, thread: &str) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM delivery_snoozes WHERE thread=?1)",
            [thread],
            |row| row.get(0),
        )?)
    }

    /// Bring the visibility decision forward when the destination's shell row changes.
    ///
    /// # Errors
    /// Returns an error if the due time cannot be saved.
    pub fn wake_delivery_snooze(&self, thread: &str) -> Result<bool, StoreError> {
        Ok(self.connection.execute(
            "UPDATE delivery_snoozes SET due_ms=0 WHERE thread=?1 AND due_ms<>0",
            [thread],
        )? != 0)
    }

    /// Settle a restoration or record its next attempt and deadline.
    ///
    /// # Errors
    /// Returns an error if the outcome cannot be saved.
    pub fn finish_delivery_snooze(
        &self,
        command: &str,
        retry: Option<(i64, u64)>,
    ) -> Result<(), StoreError> {
        if let Some((attempt, due)) = retry {
            self.connection.execute(
                "UPDATE delivery_snoozes SET attempt=?2, due_ms=?3 WHERE command=?1",
                params![command, attempt, sql_time(due)],
            )?;
        } else {
            self.connection
                .execute("DELETE FROM delivery_snoozes WHERE command=?1", [command])?;
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
