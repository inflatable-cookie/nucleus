use rusqlite::{Row, params};

use crate::{Store, StoreError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentResult {
    Pending,
    Accepted,
}

impl ParentResult {
    fn label(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
        }
    }
}

#[derive(Debug)]
pub struct ParentDelivery {
    pub version: i64,
    pub command: String,
    pub refresh: bool,
    pub wire: Option<String>,
    pub legacy_prompt: Option<String>,
    pub due_ms: i64,
    pub result: ParentResult,
}

fn delivery(row: &Row<'_>) -> rusqlite::Result<ParentDelivery> {
    let result = match row.get_ref(6)?.as_str()? {
        // Schema 12 used three additional outcomes. Any exact command that
        // wasn't accepted can now be retried using its original ID.
        "pending" | "refused" | "failed" | "held" => ParentResult::Pending,
        "accepted" => ParentResult::Accepted,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(ParentDelivery {
        version: row.get(0)?,
        command: row.get(1)?,
        refresh: row.get(2)?,
        wire: row.get(3)?,
        legacy_prompt: row.get(4)?,
        due_ms: row.get(5)?,
        result,
    })
}

impl Store {
    /// Read the current task's deliveries and any occurrence of its exact retained child.
    ///
    /// # Errors
    /// Returns an error if the delivery rows cannot be read.
    pub fn parent_deliveries(
        &self,
        task: &str,
        version: i64,
        child: Option<&str>,
    ) -> Result<Vec<ParentDelivery>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT version, command, refresh, wire, legacy_prompt, due_ms, result
             FROM parent_deliveries WHERE task_id=?1 AND command<>'' AND
               (version=?2 OR (version<?2 AND instr(command, ?3)=1)) ORDER BY ordinal DESC",
        )?;
        Ok(query
            .query_map(params![task, version, child], delivery)?
            .collect::<Result<_, _>>()?)
    }

    /// Keep the task version that owns an unresolved parent preparation.
    ///
    /// # Errors
    /// Returns an error if the delivery record cannot be read.
    pub fn pending_parent_preparation(&self, task: &str, version: i64) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT coalesce((SELECT result<>'accepted' FROM parent_deliveries
             WHERE task_id=?1 AND version=?2 AND command<>'' AND refresh=0
             ORDER BY ordinal DESC LIMIT 1), 0)",
            params![task, version],
            |row| row.get(0),
        )?)
    }

    /// Freeze one native delivery before crossing the wire, under the task version fence.
    ///
    /// # Errors
    /// Returns an error if persistence fails.
    pub fn freeze_parent_delivery(
        &self,
        task: &str,
        value: &ParentDelivery,
    ) -> Result<bool, StoreError> {
        Ok(self.connection.execute(
            "INSERT INTO parent_deliveries (task_id,version,command,refresh,wire,due_ms,result)
             SELECT id,version,?3,?4,?5,?6,'pending' FROM tasks WHERE id=?1 AND version=?2
             ON CONFLICT(task_id, version, command) DO NOTHING",
            params![
                task,
                value.version,
                value.command,
                value.refresh,
                value.wire,
                value.due_ms
            ],
        )? == 1)
    }

    /// Store a due retry of the same command or its replacement after rejection.
    ///
    /// # Errors
    /// Returns an error if persistence fails or the task or intent has changed.
    pub fn retry_parent_delivery(
        &self,
        task: &str,
        current_version: i64,
        delivery: &ParentDelivery,
        command: &str,
        wire: &str,
        due_ms: i64,
    ) -> Result<(), StoreError> {
        let count = self.connection.execute(
            "UPDATE parent_deliveries
             SET command=?5, wire=?6, due_ms=?7, runtime=NULL, legacy_prompt=NULL, result='pending'
             WHERE task_id=?1 AND version=?2 AND command=?3 AND result<>'accepted'
               AND EXISTS (SELECT 1 FROM tasks WHERE id=?1 AND version=?4)",
            params![
                task,
                delivery.version,
                delivery.command,
                current_version,
                command,
                wire,
                due_ms
            ],
        )?;
        if count != 1 {
            return Err(StoreError::StaleTask);
        }
        Ok(())
    }

    /// Update the exact command's outcome and retry deadline.
    ///
    /// # Errors
    /// Returns an error if persistence fails or the task has changed.
    pub fn finish_parent_delivery(
        &self,
        task: &str,
        current_version: i64,
        delivery: &ParentDelivery,
        result: ParentResult,
        due_ms: i64,
    ) -> Result<(), StoreError> {
        let count = self.connection.execute(
            "UPDATE parent_deliveries SET result=?6, due_ms=?7
             WHERE task_id=?1 AND version=?2 AND command=?3 AND (result='accepted')=?4
               AND EXISTS (SELECT 1 FROM tasks WHERE id=?1 AND version=?5)",
            params![
                task,
                delivery.version,
                delivery.command,
                delivery.result == ParentResult::Accepted,
                current_version,
                result.label(),
                due_ms
            ],
        )?;
        if count != 1 {
            return Err(StoreError::StaleTask);
        }
        Ok(())
    }
}
