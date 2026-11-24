use rusqlite::{OptionalExtension, params};

use crate::{Store, StoreError};

pub(super) const SCHEMA: &str = "
CREATE TABLE inbox_bindings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  task_version INTEGER NOT NULL CHECK (task_version > 0),
  decision_id TEXT NOT NULL UNIQUE,
  head TEXT NOT NULL
) STRICT";

pub(super) const COMMAND_RECEIPTS: &str = "
CREATE TABLE IF NOT EXISTS inbox_command_receipts (
  message_id TEXT PRIMARY KEY,
  attempted_at_ms INTEGER NOT NULL
) STRICT";

/// An outbox binding survives a lost response or a task moving on.
pub struct InboxBinding {
    pub task_version: i64,
    pub decision_id: String,
    pub head: String,
}

impl Store {
    /// Record the attempt before an Inbox message can cause a side effect.
    ///
    /// # Errors
    /// Returns an error when the receipt cannot be persisted.
    pub fn claim_inbox_message(
        &mut self,
        message_id: &str,
        at_ms: i64,
    ) -> Result<bool, StoreError> {
        Ok(self.connection.execute(
            "INSERT INTO inbox_command_receipts (message_id, attempted_at_ms) VALUES (?1, ?2)
             ON CONFLICT(message_id) DO NOTHING",
            params![message_id, at_ms],
        )? == 1)
    }

    /// Read the exact decision the scheduler may have sent.
    /// # Errors
    /// Returns an error if the binding cannot be read.
    pub fn inbox_binding(&self, task: &str) -> Result<Option<InboxBinding>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT task_version, decision_id, head FROM inbox_bindings WHERE task_id = ?1",
                [task],
                |row| {
                    Ok(InboxBinding {
                        task_version: row.get(0)?,
                        decision_id: row.get(1)?,
                        head: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Persist the exact wire identity before attempting to create the decision.
    /// # Errors
    /// Returns an error if the task changed or already has a binding.
    pub fn bind_inbox(&mut self, task: &str, binding: &InboxBinding) -> Result<(), StoreError> {
        let count = self.connection.execute(
            "INSERT INTO inbox_bindings (task_id, task_version, decision_id, head)
             SELECT id, version, ?3, ?4 FROM tasks WHERE id = ?1 AND version = ?2",
            params![
                task,
                binding.task_version,
                binding.decision_id,
                binding.head
            ],
        )?;
        if count != 1 {
            return Err(StoreError::StaleTask);
        }
        Ok(())
    }

    /// Remove a binding after the Inbox acknowledges withdrawal.
    /// # Errors
    /// Returns an error if the binding cannot be removed.
    pub fn clear_inbox(&mut self, task: &str, decision: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "DELETE FROM inbox_bindings WHERE task_id = ?1 AND decision_id = ?2",
            [task, decision],
        )?;
        Ok(())
    }
}
