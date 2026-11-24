use rusqlite::{OptionalExtension, params};

use crate::{Store, StoreError};

pub(crate) const SCHEMA: &str = "CREATE TABLE task_titles (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  thread TEXT NOT NULL UNIQUE,
  desired TEXT NOT NULL,
  confirmed TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  retry_at INTEGER NOT NULL DEFAULT 0,
  delay_ms INTEGER NOT NULL DEFAULT 5000 CHECK (delay_ms BETWEEN 5000 AND 300000)
) STRICT";

/// Durable presentation intent. No title participates in a task decision.
pub struct TitleReceipt {
    pub task_id: String,
    pub desired: String,
    pub generation: i64,
    pub retry_at: i64,
}

impl Store {
    /// Record a new title only when the rendered text or destination changes.
    /// # Errors
    /// Returns an error when the intent cannot be stored.
    pub fn desire_title(&self, task: &str, thread: &str, title: &str) -> Result<bool, StoreError> {
        Ok(self.connection.execute(
            "INSERT INTO task_titles (task_id, thread, desired) VALUES (?1, ?2, ?3)
             ON CONFLICT(task_id) DO UPDATE SET thread = excluded.thread, desired = excluded.desired,
               confirmed = NULL,
               generation = task_titles.generation + 1, retry_at = 0, delay_ms = 5000
             WHERE task_titles.desired <> excluded.desired OR task_titles.thread <> excluded.thread",
            params![task, thread, title],
        )? != 0)
    }

    /// Read outstanding presentation work for one observed native thread.
    /// # Errors
    /// Returns an error if the receipt cannot be read.
    pub fn pending_title(&self, thread: &str) -> Result<Option<TitleReceipt>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT task_id, desired, generation, retry_at FROM task_titles
             WHERE thread = ?1 AND confirmed IS NOT desired",
                [thread],
                |row| {
                    Ok(TitleReceipt {
                        task_id: row.get(0)?,
                        desired: row.get(1)?,
                        generation: row.get(2)?,
                        retry_at: row.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Keep the native request ID on retry and record the next due time.
    /// # Errors
    /// Returns an error when the current attempt cannot be recorded.
    pub fn defer_title(&self, receipt: &TitleReceipt, now: i64) -> Result<bool, StoreError> {
        Ok(self.connection.execute(
            "UPDATE task_titles SET retry_at = ?3 + delay_ms, delay_ms = min(delay_ms * 2, 300000)
             WHERE task_id = ?1 AND generation = ?2 AND confirmed IS NOT desired",
            params![receipt.task_id, receipt.generation, now],
        )? != 0)
    }

    /// Confirm only the generation that was actually applied.
    /// # Errors
    /// Returns an error if the native receipt cannot be recorded.
    pub fn confirm_title(&self, receipt: &TitleReceipt) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE task_titles SET confirmed = desired WHERE task_id = ?1 AND generation = ?2",
            params![receipt.task_id, receipt.generation],
        )?;
        Ok(())
    }
}
