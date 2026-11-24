//! Per-task wall-time accounting and its shared service clock.

use nucleus_core::{
    Task,
    profiles::{BriefPolicy, Complexity},
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::{
    EventDraft, Store, StoreError, append, decode_error,
    usage::{read_millis, sql_millis},
};

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS allowance_clock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    elapsed_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS task_allowances (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;";

const MINUTE_MS: u64 = 60_000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Allowance {
    affected_tests: bool,
    used_ms: u64,
    since_ms: Option<u64>,
    extensions: u32,
    granted_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowanceView {
    pub used_ms: u64,
    pub limit_ms: u64,
    pub exhausted: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct AllowanceObservation {
    pub elapsed_ms: u64,
    pub charging: bool,
    pub extension: Option<AllowanceExtension>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllowanceExtension {
    Automatic,
    Planner,
}

impl Allowance {
    #[must_use]
    pub fn view(&self, task: &Task, elapsed_ms: u64) -> AllowanceView {
        let used_ms = self.used_ms.saturating_add(
            self.since_ms
                .map_or(0, |since| elapsed_ms.saturating_sub(since)),
        );
        let limit_ms = self.granted_ms.max(
            self.increment(task)
                .saturating_mul(1 + u64::from(self.extensions)),
        );
        AllowanceView {
            used_ms,
            limit_ms,
            exhausted: used_ms >= limit_ms,
        }
    }

    #[must_use]
    pub fn can_extend_automatically(&self) -> bool {
        self.extensions == 0
    }

    #[must_use]
    pub fn is_charging(&self) -> bool {
        self.since_ms.is_some()
    }

    fn increment(&self, task: &Task) -> u64 {
        let complexity = BriefPolicy::parse(&task.brief().text)
            .ok()
            .and_then(|policy| policy.complexity)
            .unwrap_or_default();
        MINUTE_MS
            * match (complexity, self.affected_tests) {
                (Complexity::VeryLow | Complexity::Low, false) => 60,
                (Complexity::VeryLow | Complexity::Low, true) => 120,
                (Complexity::Medium, false) => 180,
                (Complexity::Medium, true) => 360,
                (Complexity::High, _) => 480,
                (Complexity::VeryHigh, _) => 960,
            }
    }
}

pub(crate) fn admit(
    tx: &Transaction<'_>,
    id: &str,
    affected_tests: bool,
) -> Result<(), StoreError> {
    if affected_tests {
        write(
            tx,
            id,
            &Allowance {
                affected_tests,
                ..Allowance::default()
            },
        )?;
    }
    Ok(())
}

impl Store {
    /// Read the shared budget clock checkpoint. Service downtime is excluded.
    /// # Errors
    /// Returns an error if the checkpoint cannot be read.
    pub fn allowance_elapsed(&self) -> Result<u64, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT elapsed_ms FROM allowance_clock WHERE singleton = 1",
                [],
                |row| read_millis(row, 0),
            )
            .optional()?
            .unwrap_or_default())
    }

    /// Persist only forward clock observations.
    /// # Errors
    /// Returns an error if the checkpoint cannot be recorded.
    pub fn checkpoint_allowance(&self, elapsed_ms: u64) -> Result<(), StoreError> {
        checkpoint(&self.connection, elapsed_ms)
    }

    /// Read the task's allowance. Old rows start with the plain defaults.
    /// # Errors
    /// Returns an error if the task's accounting data cannot be read.
    pub fn allowance(&self, id: &str) -> Result<Allowance, StoreError> {
        read(&self.connection, id)
    }

    /// Record an observed change in whether the task is spending its allowance.
    /// # Errors
    /// Returns a storage error if the transition cannot be written.
    pub fn observe_allowance(
        &mut self,
        task: &Task,
        observation: AllowanceObservation,
        audit: Option<&EventDraft>,
    ) -> Result<(), StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        observe(&tx, task, observation)?;
        if let Some(audit) = audit {
            append(&tx, &task.identity().id, audit)?;
        }
        tx.commit()?;
        Ok(())
    }
}

pub(crate) fn observe(
    tx: &Transaction<'_>,
    task: &Task,
    observation: AllowanceObservation,
) -> Result<(), StoreError> {
    let id = &task.identity().id;
    let mut allowance = read(tx, id)?;
    let prior = allowance.clone();
    let elapsed = observation.elapsed_ms;
    if let Some(source) = observation.extension {
        let view = allowance.view(task, elapsed);
        if !view.exhausted
            || (source == AllowanceExtension::Automatic && !allowance.can_extend_automatically())
        {
            return Err(StoreError::AllowanceNotExhausted);
        }
        allowance.extensions = allowance.extensions.saturating_add(1);
        allowance.granted_ms = view
            .used_ms
            .max(view.limit_ms)
            .saturating_add(allowance.increment(task));
    }
    match (allowance.since_ms, observation.charging) {
        (None, true) => allowance.since_ms = Some(elapsed),
        (Some(since), false) => {
            allowance.used_ms = allowance
                .used_ms
                .saturating_add(elapsed.saturating_sub(since));
            allowance.since_ms = None;
        }
        _ => {}
    }
    if allowance != prior {
        checkpoint(tx, elapsed)?;
        write(tx, id, &allowance)?;
    }
    Ok(())
}

fn checkpoint(connection: &Connection, elapsed_ms: u64) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO allowance_clock VALUES (1, ?1) ON CONFLICT(singleton) DO UPDATE
         SET elapsed_ms = excluded.elapsed_ms WHERE excluded.elapsed_ms > allowance_clock.elapsed_ms",
        [sql_millis(elapsed_ms)?],
    )?;
    Ok(())
}

fn read(connection: &Connection, id: &str) -> Result<Allowance, StoreError> {
    Ok(connection
        .query_row(
            "SELECT snapshot FROM task_allowances WHERE task_id = ?1",
            [id],
            |row| {
                serde_json::from_str(&row.get::<_, String>(0)?)
                    .map_err(|error| decode_error(0, error))
            },
        )
        .optional()?
        .unwrap_or_default())
}

fn write(connection: &Connection, id: &str, allowance: &Allowance) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO task_allowances VALUES (?1, ?2) ON CONFLICT(task_id) DO UPDATE
         SET snapshot = excluded.snapshot",
        params![id, serde_json::to_string(allowance)?],
    )?;
    Ok(())
}
