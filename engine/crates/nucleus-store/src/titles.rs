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

pub(crate) const INBOX_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS inbox_titles (
  thread TEXT PRIMARY KEY,
  desired TEXT NOT NULL,
  confirmed TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  retry_at INTEGER NOT NULL DEFAULT 0,
  delay_ms INTEGER NOT NULL DEFAULT 5000 CHECK (delay_ms BETWEEN 5000 AND 300000)
) STRICT";

/// Durable presentation intent. No title participates in a task decision.
pub struct TitleReceipt {
    pub task_id: Option<String>,
    pub thread: String,
    pub desired: String,
    pub generation: i64,
    pub retry_at: i64,
}

impl TitleReceipt {
    fn row(&self) -> (&'static str, &'static str, &str) {
        match &self.task_id {
            Some(task) => ("task_titles", "task_id", task),
            None => ("inbox_titles", "thread", &self.thread),
        }
    }
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

    /// Locate a task from the native destination already registered for its title.
    ///
    /// # Errors
    /// Returns an error if the title binding cannot be read.
    pub fn task_with_title_thread(&self, thread: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT task_id FROM task_titles WHERE thread = ?1",
                [thread],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Read outstanding presentation work for one observed native thread.
    /// # Errors
    /// Returns an error if the receipt cannot be read.
    pub fn pending_title(&self, thread: &str) -> Result<Option<TitleReceipt>, StoreError> {
        self.title_receipt("task_titles", "task_id", thread)
    }

    /// Record a desired Inbox title using the same generation and backoff as task titles.
    /// # Errors
    /// Returns an error when the intent cannot be stored.
    pub fn desire_inbox_title(&self, thread: &str, title: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO inbox_titles (thread, desired) VALUES (?1, ?2)
             ON CONFLICT(thread) DO UPDATE SET desired = excluded.desired, confirmed = NULL,
               generation = inbox_titles.generation + 1, retry_at = 0, delay_ms = 5000
             WHERE inbox_titles.desired <> excluded.desired",
            params![thread, title],
        )?;
        Ok(())
    }

    /// Read outstanding title work for the Inbox.
    /// # Errors
    /// Returns an error if the receipt cannot be read.
    pub fn pending_inbox_title(&self, thread: &str) -> Result<Option<TitleReceipt>, StoreError> {
        self.title_receipt("inbox_titles", "NULL", thread)
    }

    fn title_receipt(
        &self,
        table: &str,
        task: &str,
        thread: &str,
    ) -> Result<Option<TitleReceipt>, StoreError> {
        let sql = format!(
            "SELECT {task}, desired, generation, retry_at FROM {table}
             WHERE thread = ?1 AND confirmed IS NOT desired"
        );
        Ok(self
            .connection
            .prepare_cached(&sql)?
            .query_row([thread], |row| {
                Ok(TitleReceipt {
                    task_id: row.get(0)?,
                    thread: thread.into(),
                    desired: row.get(1)?,
                    generation: row.get(2)?,
                    retry_at: row.get(3)?,
                })
            })
            .optional()?)
    }

    /// Keep the native request ID on retry and record the next due time.
    /// # Errors
    /// Returns an error when the current attempt cannot be recorded.
    pub fn defer_title(&self, receipt: &TitleReceipt, now: i64) -> Result<bool, StoreError> {
        let (table, key, value) = receipt.row();
        let sql = format!(
            "UPDATE {table} SET retry_at = ?3 + delay_ms, delay_ms = min(delay_ms * 2, 300000)
             WHERE {key} = ?1 AND generation = ?2 AND confirmed IS NOT desired"
        );
        Ok(self.connection.prepare_cached(&sql)?.execute(params![
            value,
            receipt.generation,
            now
        ])? != 0)
    }

    /// Confirm only the generation that was actually applied.
    /// # Errors
    /// Returns an error if the native receipt cannot be recorded.
    pub fn confirm_title(&self, receipt: &TitleReceipt) -> Result<(), StoreError> {
        let (table, key, value) = receipt.row();
        let sql =
            format!("UPDATE {table} SET confirmed = desired WHERE {key} = ?1 AND generation = ?2");
        self.connection
            .prepare_cached(&sql)?
            .execute(params![value, receipt.generation])?;
        Ok(())
    }
}
