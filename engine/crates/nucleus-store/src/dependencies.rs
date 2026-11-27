use std::collections::{HashMap, VecDeque, hash_map::Entry};

use nucleus_core::ReportArtifact;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use crate::{EventDraft, Store, StoreError, append, board_state};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS task_prerequisite_waits (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    reason TEXT NOT NULL,
    released_at_ms INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    prerequisite_id TEXT NOT NULL REFERENCES tasks(id),
    after_dispatch INTEGER NOT NULL CHECK (after_dispatch IN (0, 1)),
    PRIMARY KEY (task_id, after_dispatch, prerequisite_id),
    CHECK (task_id != prerequisite_id)
) STRICT;
CREATE INDEX IF NOT EXISTS task_dependency_dependents
    ON task_dependencies (prerequisite_id, task_id);
CREATE TABLE IF NOT EXISTS task_prerequisite_notices (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    release_version INTEGER NOT NULL,
    detail TEXT NOT NULL,
    attempted_at_ms INTEGER,
    PRIMARY KEY (task_id, release_version)
) STRICT;
CREATE INDEX IF NOT EXISTS pending_prerequisite_notices
    ON task_prerequisite_notices (task_id, release_version)
    WHERE attempted_at_ms IS NULL";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Dependencies {
    pub before_dispatch: Vec<String>,
    pub wait: Option<PrerequisiteWait>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PrerequisiteWait {
    pub ids: Vec<String>,
    pub reason: String,
    pub released_at_ms: Option<i64>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct PrerequisiteRelease {
    pub prerequisites: Vec<String>,
    pub reason: String,
}

#[derive(Clone, Copy)]
pub enum DependencyEdit<'a> {
    BeforeDispatch(&'a [String]),
    Wait { ids: &'a [String], reason: &'a str },
    ReleaseWait,
}

impl Store {
    /// Read the two lists, including any released wait retained for history.
    ///
    /// # Errors
    /// Returns a database error if either list cannot be read.
    pub fn dependencies(&self, id: &str) -> Result<Dependencies, StoreError> {
        read(&self.connection, id)
    }

    /// Check both gates using current durable prerequisite phases.
    ///
    /// # Errors
    /// Returns a database error if the gate cannot be read.
    pub fn dependency_blocked(&self, id: &str) -> Result<bool, StoreError> {
        dependency_gate(&self.connection, id, false)
    }

    /// Whether a blocking dependency needs an owner edit before work can proceed.
    ///
    /// # Errors
    /// Returns a database error if the gate cannot be read.
    pub fn dependency_needs_edit(&self, id: &str) -> Result<bool, StoreError> {
        dependency_gate(&self.connection, id, true)
    }

    /// Find tasks to wake and invalidate after a prerequisite's state changes.
    ///
    /// # Errors
    /// Returns a database error if the reverse index cannot be read.
    pub fn dependents(&self, id: &str) -> Result<Vec<(String, i64)>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT DISTINCT t.id, t.version FROM task_dependencies d
             JOIN tasks t ON t.id = d.task_id WHERE d.prerequisite_id = ?1",
        )?;
        let rows = query.query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Read the oldest pending informational notice for a task.
    ///
    /// # Errors
    /// Returns a database or decoding error if the notice cannot be read.
    pub fn pending_prerequisite_notice(
        &self,
        id: &str,
    ) -> Result<Option<(i64, PrerequisiteRelease)>, StoreError> {
        let stored = self
            .connection
            .query_row(
                "SELECT release_version, detail FROM task_prerequisite_notices
             WHERE task_id = ?1 AND attempted_at_ms IS NULL ORDER BY release_version LIMIT 1",
                [id],
                |row| Ok((row.get(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        stored
            .map(|(version, detail)| Ok((version, serde_json::from_str(&detail)?)))
            .transpose()
    }

    /// Record the exact notice attempt before native I/O.
    ///
    /// # Errors
    /// Returns a database error on a failed transaction.
    pub fn claim_prerequisite_notice(
        &mut self,
        id: &str,
        release_version: i64,
        event: &EventDraft,
    ) -> Result<bool, StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE task_prerequisite_notices SET attempted_at_ms = ?3
             WHERE task_id = ?1 AND release_version = ?2 AND attempted_at_ms IS NULL",
            params![id, release_version, event.at],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        append(&tx, id, event)?;
        tx.commit()?;
        Ok(true)
    }

    /// Read the last settled artifact even after the task has returned to work.
    /// # Errors
    /// Returns an error if the recorded artifact cannot be read.
    pub fn last_report_artifact(&self, id: &str) -> Result<Option<ReportArtifact>, StoreError> {
        let artifact = self
            .connection
            .query_row(
                "SELECT detail -> '$.artifact' FROM events
                 WHERE task_id = ?1 AND kind IN ('report_ready', 'report_returned_to_work')
                 AND json_type(CASE WHEN json_valid(detail) THEN detail END, '$.artifact') = 'object'
                 ORDER BY sequence DESC LIMIT 1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(artifact.as_deref().map(serde_json::from_str).transpose()?)
    }

    /// Whether the first attempt was rejected for the release or the exact report artifact.
    /// # Errors
    /// Returns an error if the recorded rejection cannot be read.
    pub fn planner_notice_rejected(
        &self,
        id: &str,
        release_version: Option<i64>,
    ) -> Result<bool, StoreError> {
        // The first publication also scopes rejections recorded before revisions
        // had separate retry allowances. A repeated report keeps that boundary.
        Ok(self.connection.query_row(
            "SELECT EXISTS (
                SELECT 1 FROM events WHERE task_id = ?1 AND kind = 'planner_notice_rejected'
                AND detail ->> '$.releaseVersion' IS ?2
                AND sequence > coalesce((
                    SELECT min(ready.sequence) FROM events ready
                    JOIN tasks task ON task.id = ready.task_id
                    WHERE ready.task_id = ?1 AND ready.kind = 'report_ready' AND ?2 IS NULL
                    AND CASE WHEN json_valid(ready.detail) THEN
                        ready.detail ->> '$.artifact.key' = task.report_task ->> '$.delivery.artifact.key'
                        AND ready.detail -> '$.artifact.version' = task.report_task -> '$.delivery.artifact.version'
                        AND ready.detail ->> '$.artifact.digest' = task.report_task ->> '$.delivery.artifact.digest'
                    END
                ), 0)
            )",
            params![id, release_version],
            |row| row.get(0),
        )?)
    }

    /// Re-arm a release notice after a proven non-delivery and record the reason.
    /// # Errors
    /// Returns an error if the exact attempted release cannot be updated.
    pub fn reopen_prerequisite_notice(
        &mut self,
        id: &str,
        release_version: i64,
        attempted: &EventDraft,
        outcome: &EventDraft,
    ) -> Result<(), StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute(
            "UPDATE task_prerequisite_notices SET attempted_at_ms = NULL
             WHERE task_id = ?1 AND release_version = ?2 AND attempted_at_ms = ?3",
            params![id, release_version, attempted.at],
        )? != 1
        {
            return Err(StoreError::StaleTask);
        }
        append(&tx, id, outcome)?;
        tx.commit()?;
        Ok(())
    }

    /// Replace one dependency list or release the retained wait, with CAS and audit.
    ///
    /// # Errors
    /// Returns an error on a stale version, invalid edge or database failure.
    pub fn edit_dependencies(
        &mut self,
        id: &str,
        version: i64,
        edit: DependencyEdit<'_>,
        event: &EventDraft,
        clock: DependencyClock<'_>,
    ) -> Result<i64, StoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE tasks SET version = version + 1 WHERE id = ?1 AND version = ?2",
            params![id, version],
        )?;
        if changed != 1 {
            return Err(StoreError::StaleTask);
        }
        match edit {
            DependencyEdit::BeforeDispatch(ids) => {
                preflight_edges(&tx, id, ids)?;
                replace_edges(&tx, id, ids, false)?;
            }
            DependencyEdit::Wait { ids, reason } => {
                preflight_edges(&tx, id, ids)?;
                if ids.is_empty() {
                    tx.execute(
                        "DELETE FROM task_prerequisite_waits WHERE task_id = ?1",
                        [id],
                    )?;
                } else {
                    tx.execute(
                        "INSERT INTO task_prerequisite_waits VALUES (?1, ?2, NULL)
                         ON CONFLICT(task_id) DO UPDATE SET reason = excluded.reason, released_at_ms = NULL",
                        params![id, reason],
                    )?;
                }
                replace_edges(&tx, id, ids, true)?;
            }
            DependencyEdit::ReleaseWait => {
                if tx.execute(
                    "UPDATE task_prerequisite_waits SET released_at_ms = ?2
                     WHERE task_id = ?1 AND released_at_ms IS NULL AND NOT EXISTS (
                        SELECT 1 FROM task_dependencies d
                        LEFT JOIN tasks p ON p.id = d.prerequisite_id
                        WHERE d.task_id = ?1 AND d.after_dispatch = 1
                        AND coalesce(p.phase, '') != 'done'
                     )",
                    params![id, event.at],
                )? != 1
                {
                    return Err(StoreError::StaleTask);
                }
                let wait = read(&tx, id)?.wait.ok_or(StoreError::StaleTask)?;
                let detail = serde_json::to_string(&PrerequisiteRelease {
                    prerequisites: wait.ids,
                    reason: wait.reason,
                })?;
                tx.execute(
                    "INSERT INTO task_prerequisite_notices (task_id, release_version, detail)
                     VALUES (?1, ?2, ?3)",
                    params![id, version + 1, detail],
                )?;
            }
        }
        record_board_gate(&tx, id, clock, event.at)?;
        append(&tx, id, event)?;
        tx.commit()?;
        Ok(version + 1)
    }
}

pub(super) fn dependency_gate(
    connection: &Connection,
    id: &str,
    needs_edit: bool,
) -> Result<bool, StoreError> {
    Ok(connection.query_row(
        "SELECT EXISTS (
                SELECT 1 FROM task_dependencies d
                LEFT JOIN tasks p ON p.id = d.prerequisite_id
                JOIN tasks t ON t.id = d.task_id
                WHERE d.task_id = ?1 AND CASE ?2 WHEN 0 THEN coalesce(p.phase, '') != 'done'
                                      ELSE p.phase IS NULL OR p.phase = 'cancelled' END
                AND CASE d.after_dispatch
                    WHEN 0 THEN json_extract(t.threads, '$.worker') IS NULL
                            AND json_extract(t.threads, '$.reviewer') IS NULL
                    ELSE EXISTS (
                        SELECT 1 FROM task_prerequisite_waits w
                        WHERE w.task_id = d.task_id AND w.released_at_ms IS NULL
                    )
                END
            )",
        params![id, needs_edit],
        |row| row.get(0),
    )?)
}

/// Reports the committed dependency gate to the service's label comparison.
pub type DependencyClock<'a> = &'a mut dyn FnMut(bool) -> bool;

pub(super) fn record_board_gate(
    connection: &Connection,
    id: &str,
    clock: DependencyClock<'_>,
    at: i64,
) -> Result<(), StoreError> {
    if clock(dependency_gate(connection, id, false)?) {
        board_state::record(connection, id, at)?;
    }
    Ok(())
}

fn read(connection: &Connection, id: &str) -> Result<Dependencies, StoreError> {
    let mut query = connection.prepare_cached(
        "SELECT prerequisite_id, after_dispatch FROM task_dependencies
         WHERE task_id = ?1 ORDER BY prerequisite_id",
    )?;
    let edges = query.query_map([id], |row| Ok((row.get(0)?, row.get::<_, bool>(1)?)))?;
    let mut before_dispatch = Vec::new();
    let mut after_dispatch = Vec::new();
    for edge in edges {
        let (prerequisite, wait) = edge?;
        if wait {
            after_dispatch.push(prerequisite);
        } else {
            before_dispatch.push(prerequisite);
        }
    }
    let wait = connection
        .query_row(
            "SELECT reason, released_at_ms FROM task_prerequisite_waits WHERE task_id = ?1",
            [id],
            |row| {
                Ok(PrerequisiteWait {
                    ids: after_dispatch,
                    reason: row.get(0)?,
                    released_at_ms: row.get(1)?,
                })
            },
        )
        .optional()?;
    Ok(Dependencies {
        before_dispatch,
        wait,
    })
}

pub(super) fn initial_edges(
    tx: &Transaction<'_>,
    id: &str,
    ids: &[String],
) -> Result<(), StoreError> {
    preflight_edges(tx, id, ids)?;
    replace_edges(tx, id, ids, false)
}

fn preflight_edges(tx: &Transaction<'_>, id: &str, ids: &[String]) -> Result<(), StoreError> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut edges = tx.prepare_cached(
        "SELECT DISTINCT d.prerequisite_id FROM task_dependencies d
         LEFT JOIN task_prerequisite_waits w
             ON d.task_id = w.task_id AND w.released_at_ms IS NULL
         WHERE d.task_id = ?1 AND (d.after_dispatch = 0 OR w.task_id IS NOT NULL)
         ORDER BY d.prerequisite_id",
    )?;
    let mut pending = VecDeque::from(ids.to_vec());
    let mut predecessor: HashMap<_, _> = ids
        .iter()
        .map(|next| (next.clone(), id.to_owned()))
        .collect();
    while let Some(current) = pending.pop_front() {
        if current == id {
            let mut path = vec![id.to_owned()];
            let mut step = id;
            while let Some(previous) = predecessor.get(step) {
                path.push(previous.clone());
                if previous == id {
                    break;
                }
                step = previous;
            }
            path.reverse();
            return Err(StoreError::DependencyCycle { path });
        }
        for next in edges.query_map([&current], |row| row.get::<_, String>(0))? {
            if let Entry::Vacant(slot) = predecessor.entry(next?) {
                pending.push_back(slot.key().clone());
                slot.insert(current.clone());
            }
        }
    }
    Ok(())
}

fn replace_edges(
    tx: &Transaction<'_>,
    id: &str,
    ids: &[String],
    after_dispatch: bool,
) -> Result<(), StoreError> {
    tx.execute(
        "DELETE FROM task_dependencies WHERE task_id = ?1 AND after_dispatch = ?2",
        params![id, after_dispatch],
    )?;
    let mut insert = tx.prepare_cached("INSERT INTO task_dependencies VALUES (?1, ?2, ?3)")?;
    for prerequisite in ids {
        insert.execute(params![id, prerequisite, after_dispatch])?;
    }
    Ok(())
}
