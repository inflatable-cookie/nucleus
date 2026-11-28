use rusqlite::{OptionalExtension, Row, Transaction, params};

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
    pub wire: String,
    pub due_ms: i64,
    pub result: ParentResult,
}

fn delivery_table(refresh: bool) -> &'static str {
    if refresh {
        "parent_refresh_deliveries"
    } else {
        "parent_deliveries"
    }
}

pub(super) fn migrate(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch("ALTER TABLE parent_deliveries RENAME TO parent_deliveries_v15;")?;
    tx.execute_batch(include_str!("parent_delivery.sql"))?;
    for refresh in [false, true] {
        let table = delivery_table(refresh);
        tx.execute(
            &format!(
                "INSERT INTO {table} (task_id, version, command, wire, due_ms, result)
                 SELECT task_id, version, command, wire, due_ms,
                        CASE result WHEN 'accepted' THEN 'accepted' ELSE 'pending' END
                 FROM parent_deliveries_v15 WHERE ordinal IN (
                     SELECT max(ordinal) FROM parent_deliveries_v15
                     WHERE refresh=?1 AND command<>'' GROUP BY task_id
                 )"
            ),
            [refresh],
        )?;
    }
    tx.execute_batch("DROP TABLE parent_deliveries_v15;")
}

fn delivery(row: &Row<'_>, refresh: bool) -> rusqlite::Result<ParentDelivery> {
    let result = match row.get_ref(4)?.as_str()? {
        "pending" => ParentResult::Pending,
        "accepted" => ParentResult::Accepted,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(ParentDelivery {
        version: row.get(0)?,
        command: row.get(1)?,
        refresh,
        wire: row.get(2)?,
        due_ms: row.get(3)?,
        result,
    })
}

impl Store {
    /// Read the task version's one-shot refresh independently of its hold.
    ///
    /// # Errors
    /// Returns an error if the refresh cannot be read.
    pub fn current_parent_refresh(
        &self,
        task: &str,
        version: i64,
    ) -> Result<Option<ParentDelivery>, StoreError> {
        Ok(self
            .parent_delivery(task, true)?
            .filter(|row| row.version == version))
    }

    /// Read the task's one current hold across role and task version changes.
    ///
    /// # Errors
    /// Returns an error if the row cannot be read.
    pub fn current_parent_hold(&self, task: &str) -> Result<Option<ParentDelivery>, StoreError> {
        self.parent_delivery(task, false)
    }

    fn parent_delivery(
        &self,
        task: &str,
        refresh: bool,
    ) -> Result<Option<ParentDelivery>, StoreError> {
        let table = delivery_table(refresh);
        Ok(self
            .connection
            .prepare_cached(&format!(
                "SELECT version, command, wire, due_ms, result
                 FROM {table} WHERE task_id=?1 AND wire IS NOT NULL"
            ))?
            .query_row([task], |row| delivery(row, refresh))
            .optional()?)
    }

    /// Keep the task version that owns an unresolved parent preparation.
    ///
    /// # Errors
    /// Returns an error if the delivery record cannot be read.
    pub fn pending_parent_preparation(&self, task: &str, version: i64) -> Result<bool, StoreError> {
        Ok(self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM parent_deliveries
             WHERE task_id=?1 AND version=?2 AND result='pending' AND wire IS NOT NULL
               AND coalesce(json_extract(wire, '$.checkpoint.preparing_launch'), 1))",
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
        let table = delivery_table(value.refresh);
        Ok(self.connection.execute(
            &format!(
                "INSERT INTO {table} (task_id,version,command,wire,due_ms,result)
             SELECT id,version,?3,?4,?5,'pending' FROM tasks WHERE id=?1 AND version=?2
             ON CONFLICT(task_id) DO UPDATE SET
                 version=excluded.version, command=excluded.command, wire=excluded.wire,
                 due_ms=excluded.due_ms, result='pending'
             WHERE {table}.version<>excluded.version OR {table}.command<>excluded.command
                 OR {table}.wire IS NULL"
            ),
            params![task, value.version, value.command, value.wire, value.due_ms],
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
        let table = delivery_table(delivery.refresh);
        let count = self.connection.execute(
            &format!(
                "UPDATE {table}
             SET command=?5, wire=?6, due_ms=?7, result='pending'
             WHERE task_id=?1 AND version=?2 AND command=?3 AND result<>'accepted'
               AND EXISTS (SELECT 1 FROM tasks WHERE id=?1 AND version=?4)"
            ),
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
        let table = delivery_table(delivery.refresh);
        let count = self.connection.execute(
            &format!(
                "UPDATE {table} SET result=?6, due_ms=?7
             WHERE task_id=?1 AND version=?2 AND command=?3 AND (result='accepted')=?4
               AND EXISTS (SELECT 1 FROM tasks WHERE id=?1 AND version=?5)"
            ),
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
