use rusqlite::params;

use crate::{Store, StoreError};

// Nothing reads this table. It stays until a schema step drops it, so every
// database at this schema version has the same tables.
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
}
