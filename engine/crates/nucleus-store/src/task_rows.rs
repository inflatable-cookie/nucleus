use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::{EventDraft, Store, StoreError, append};

const FLIP_INTERVAL_MS: i64 = 120_000;

pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS task_row_snoozes (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    thread TEXT NOT NULL,
    receipt TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS task_row_flips (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    attempted_at INTEGER NOT NULL,
    prior_at INTEGER,
    deferred INTEGER NOT NULL DEFAULT 0
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

    /// Claim one visibility write and its ownership receipt together. Returns
    /// the next eligible time if the task already attempted two writes in 120 seconds.
    ///
    /// # Errors
    /// Returns an error if the claim or its audit event cannot be saved.
    pub fn claim_row_flip(
        &mut self,
        task: &str,
        thread: &str,
        receipt: &RowSnooze,
        now: u64,
    ) -> Result<Option<u64>, StoreError> {
        let now = i64::try_from(now).unwrap_or(i64::MAX);
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let oldest: Option<(i64, bool)> = tx
            .query_row(
                "SELECT prior_at, deferred FROM task_row_flips WHERE task_id = ?1 AND prior_at IS NOT NULL",
                [task],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((at, deferred)) = oldest
            && now < at.saturating_add(FLIP_INTERVAL_MS)
        {
            let due = at.saturating_add(FLIP_INTERVAL_MS);
            if !deferred {
                tx.execute(
                    "UPDATE task_row_flips SET deferred = 1 WHERE task_id = ?1",
                    [task],
                )?;
                append(&tx, task, &EventDraft {
                    at: now,
                    kind: "native_row_flip_deferred".into(),
                    detail: serde_json::json!({
                        "thread": thread,
                        "action": if receipt.clear_attempted_for.is_some() { "clear" } else { "snooze" },
                        "oldestAttemptAt": at,
                        "eligibleAt": due,
                    }).to_string(),
                })?;
            }
            tx.commit()?;
            return Ok(Some(due.unsigned_abs()));
        }
        tx.execute(
            "INSERT INTO task_row_flips (task_id, attempted_at) VALUES (?1, ?2)
             ON CONFLICT(task_id) DO UPDATE SET prior_at = task_row_flips.attempted_at,
                 attempted_at = excluded.attempted_at, deferred = 0",
            params![task, now],
        )?;
        save(&tx, task, thread, receipt)?;
        tx.commit()?;
        Ok(None)
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
