//! Project-scoped planning records and their append-only history.

mod decisions;
pub mod legacy;
mod model;

use std::collections::BTreeSet;

use nucleus_core::Task;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};

use crate::{EventDraft, Store, StoreError, append, decode_error, persist};

pub use model::*;

/// Space for legacy Markdown even when every character uses four UTF-8 bytes.
pub const MAX_TEXT_BYTES: usize = 4_000_000;

pub(super) const SCHEMA: &str = include_str!("schema.sql");

use RecordKind::{
    Decision as DecisionRecord, Item as ItemRecord, Lane as LaneRecord, Plan as PlanRecord,
};

impl Store {
    /// Read the project's ordered plan. An unset plan has version zero.
    ///
    /// # Errors
    /// Returns an error if the plan cannot be read.
    pub fn plan(&self, project: &str) -> Result<Plan, StoreError> {
        Ok(read(&self.connection, PlanRecord, project, project)?.unwrap_or_default())
    }

    /// Replace the ordered plan if the supplied version is current.
    ///
    /// # Errors
    /// Returns an error for a stale version, unknown or repeated lane, or database failure.
    pub fn set_plan(
        &mut self,
        project: &str,
        mut input: Plan,
        stamp: WriteAt<'_>,
    ) -> Result<Plan, StoreError> {
        let tx = self.planning_write()?;
        let current: Plan = read(&tx, PlanRecord, project, project)?.unwrap_or_default();
        input.version = next_version(current.version, input.version)?;
        let mut keys = BTreeSet::new();
        for entry in &input.lanes {
            if !keys.insert(&entry.key)
                || read::<Lane>(&tx, LaneRecord, project, &entry.key)?.is_none()
            {
                return Err(StoreError::PlanningInput);
            }
        }
        save(&tx, PlanRecord, project, project, "set", &input, stamp)?;
        tx.commit()?;
        Ok(input)
    }

    /// Read a project's lanes by key, including closed lanes.
    ///
    /// # Errors
    /// Returns an error if the lanes cannot be read.
    pub fn lanes(&self, project: &str) -> Result<Vec<Lane>, StoreError> {
        list(&self.connection, LaneRecord, project)
    }

    /// Write the lane document and its metadata at the expected version.
    ///
    /// # Errors
    /// Returns an error for a stale version, invalid input, or database failure.
    pub fn put_lane(
        &mut self,
        project: &str,
        key: &str,
        version: u64,
        document: LaneDocument,
        stamp: WriteAt<'_>,
    ) -> Result<Lane, StoreError> {
        if !valid_key(key)
            || document.title.trim().is_empty()
            || document.aim.trim().is_empty()
            || document.document.len() > MAX_TEXT_BYTES
        {
            return Err(StoreError::PlanningInput);
        }
        let tx = self.planning_write()?;
        let current: Option<Lane> = read(&tx, LaneRecord, project, key)?;
        let lane = Lane {
            key: key.into(),
            version: next_version(current.as_ref().map_or(0, |lane| lane.version), version)?,
            document,
            disposition: current.map_or_else(LaneDisposition::default, |lane| lane.disposition),
        };
        save(&tx, LaneRecord, project, key, "put", &lane, stamp)?;
        tx.commit()?;
        Ok(lane)
    }

    /// Change the lane status without changing the document version.
    ///
    /// # Errors
    /// Returns an error if the lane is missing, the closing note is blank, or the write fails.
    pub fn set_lane_status(
        &mut self,
        project: &str,
        key: &str,
        disposition: LaneDisposition,
        stamp: WriteAt<'_>,
    ) -> Result<Lane, StoreError> {
        match &disposition {
            LaneDisposition::Done { note } | LaneDisposition::Dropped { note }
                if note.trim().is_empty() =>
            {
                return Err(StoreError::PlanningInput);
            }
            _ => {}
        }
        let tx = self.planning_write()?;
        let mut lane: Lane = required(&tx, LaneRecord, project, key)?;
        lane.disposition = disposition;
        save(&tx, LaneRecord, project, key, "status", &lane, stamp)?;
        tx.commit()?;
        Ok(lane)
    }

    /// Read a project's items, including their current states.
    ///
    /// # Errors
    /// Returns an error if the items cannot be read.
    pub fn items(&self, project: &str) -> Result<Vec<Item>, StoreError> {
        list(&self.connection, ItemRecord, project)
    }

    /// Read one item by its project and ID.
    ///
    /// # Errors
    /// Returns an error if the item cannot be read.
    pub fn item(&self, project: &str, id: &str) -> Result<Option<Item>, StoreError> {
        read(&self.connection, ItemRecord, project, id)
    }

    /// Record a new item. Its author comes from the authenticated write.
    ///
    /// # Errors
    /// Returns an error for invalid content, a duplicate ID, or database failure.
    pub fn add_item(
        &mut self,
        project: &str,
        id: String,
        kind: ItemKind,
        content: ItemContent,
        stamp: WriteAt<'_>,
    ) -> Result<Item, StoreError> {
        validate_item(&content)?;
        let tx = self.planning_write()?;
        let item = Item {
            id,
            kind,
            author: stamp.actor.into(),
            task_links: Vec::new(),
            content,
            state: ItemState::Open,
        };
        insert(&tx, ItemRecord, project, &item.id, &item, stamp)?;
        tx.commit()?;
        Ok(item)
    }

    /// Replace the item content, retaining the original author and its prior history.
    ///
    /// # Errors
    /// Returns an error if the item is missing, the content is invalid, or the write fails.
    pub fn edit_item(
        &mut self,
        project: &str,
        id: &str,
        content: ItemContent,
        stamp: WriteAt<'_>,
    ) -> Result<Item, StoreError> {
        validate_item(&content)?;
        let tx = self.planning_write()?;
        let mut item: Item = required(&tx, ItemRecord, project, id)?;
        item.content = content;
        save(&tx, ItemRecord, project, id, "edit", &item, stamp)?;
        tx.commit()?;
        Ok(item)
    }

    /// Park or drop an item. Promoted items retain their source link.
    ///
    /// # Errors
    /// Returns an error for a missing or promoted item, invalid disposition, or database failure.
    pub fn set_item_state(
        &mut self,
        project: &str,
        id: &str,
        state: ItemState,
        stamp: WriteAt<'_>,
    ) -> Result<Item, StoreError> {
        let action = match &state {
            ItemState::Parked { reason, .. } if !reason.trim().is_empty() => "park",
            ItemState::Dropped { .. } => "drop",
            _ => return Err(StoreError::PlanningInput),
        };
        let tx = self.planning_write()?;
        let mut item: Item = required(&tx, ItemRecord, project, id)?;
        if matches!(item.state, ItemState::Promoted { .. })
            || matches!(
                (&item.state, &state),
                (ItemState::Dropped { .. }, ItemState::Parked { .. })
            )
        {
            return Err(StoreError::PlanningConflict);
        }
        item.state = state;
        save(&tx, ItemRecord, project, id, action, &item, stamp)?;
        tx.commit()?;
        Ok(item)
    }

    /// Admit the task, link its source and record the item's promotion together.
    ///
    /// # Errors
    /// Returns an error if the current item is ineligible, the task has a different brief,
    /// or any part of admission fails.
    pub fn promote_item(
        &mut self,
        source: &ItemSource,
        task: &Task,
        event: &EventDraft,
        stamp: WriteAt<'_>,
    ) -> Result<Item, StoreError> {
        let tx = self.planning_write()?;
        let ItemSource {
            project_id: project,
            item_id: id,
        } = source;
        let mut item: Item = required(&tx, ItemRecord, project, id)?;
        if !matches!(item.state, ItemState::Open | ItemState::Parked { .. })
            || item.content.body != task.brief().text
        {
            return Err(StoreError::PlanningConflict);
        }
        persist(&tx, task, false)?;
        append(&tx, &task.identity().id, event)?;
        link_task(&tx, source, &task.identity().id)?;
        item.state = ItemState::Promoted {
            task_id: task.identity().id.clone(),
        };
        save(&tx, ItemRecord, project, id, "promote", &item, stamp)?;
        tx.commit()?;
        Ok(item)
    }

    /// Read the planning source of a task admitted by promotion.
    ///
    /// # Errors
    /// Returns an error if the source cannot be read.
    pub fn task_source(&self, task: &str) -> Result<Option<ItemSource>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT project, item_id FROM planning_task_sources WHERE task_id = ?1",
                [task],
                |row| {
                    Ok(ItemSource {
                        project_id: row.get(0)?,
                        item_id: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// Read a record's snapshots in commit order.
    ///
    /// # Errors
    /// Returns an error if the history cannot be read.
    pub fn planning_history(
        &self,
        project: &str,
        kind: RecordKind,
        id: &str,
    ) -> Result<Vec<History>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT sequence, actor, at_ms, action, snapshot FROM planning_history
             WHERE project = ?1 AND kind = ?2 AND id = ?3 ORDER BY sequence",
        )?;
        let history = query.query_map(params![project, kind.as_str(), id], |row| {
            Ok(History {
                sequence: row.get(0)?,
                actor: row.get(1)?,
                at_ms: row.get(2)?,
                action: row.get(3)?,
                snapshot: decode(row, 4)?,
            })
        })?;
        Ok(history.collect::<Result<_, _>>()?)
    }

    fn planning_write(&mut self) -> Result<Transaction<'_>, StoreError> {
        Ok(self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?)
    }
}

impl RecordKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Lane => "lane",
            Self::Item => "item",
            Self::Decision => "decision",
        }
    }

    const fn table(self) -> &'static str {
        match self {
            Self::Plan => "planning_plans",
            Self::Lane => "planning_lanes",
            Self::Item => "planning_items",
            Self::Decision => "planning_decisions",
        }
    }
}

fn read<T: DeserializeOwned>(
    connection: &Connection,
    kind: RecordKind,
    project: &str,
    id: &str,
) -> Result<Option<T>, StoreError> {
    let mut query = connection.prepare_cached(&format!(
        "SELECT snapshot FROM {} WHERE project = ?1 AND id = ?2",
        kind.table()
    ))?;
    Ok(query
        .query_row([project, id], |row| decode(row, 0))
        .optional()?)
}

fn required<T: DeserializeOwned>(
    connection: &Connection,
    kind: RecordKind,
    project: &str,
    id: &str,
) -> Result<T, StoreError> {
    read(connection, kind, project, id)?.ok_or(StoreError::PlanningMissing)
}

fn list<T: DeserializeOwned>(
    connection: &Connection,
    kind: RecordKind,
    project: &str,
) -> Result<Vec<T>, StoreError> {
    let mut query = connection.prepare_cached(&format!(
        "SELECT snapshot FROM {} WHERE project = ?1 ORDER BY id",
        kind.table()
    ))?;
    let rows = query.query_map([project], |row| decode(row, 0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn decode<T: DeserializeOwned>(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<T> {
    let json = row.get_ref(column)?.as_str()?;
    serde_json::from_str(json).map_err(|error| decode_error(column, error))
}

fn insert<T: Serialize>(
    tx: &Transaction<'_>,
    kind: RecordKind,
    project: &str,
    id: &str,
    record: &T,
    stamp: WriteAt<'_>,
) -> Result<(), StoreError> {
    let snapshot = serde_json::to_string(record)?;
    let count = tx.execute(
        &format!("INSERT INTO {} (project, id, snapshot) VALUES (?1, ?2, ?3) ON CONFLICT (project, id) DO NOTHING", kind.table()),
        params![project, id, snapshot],
    )?;
    if count == 0 {
        return Err(StoreError::PlanningConflict);
    }
    record_history(tx, kind, project, id, "add", &snapshot, stamp)
}

fn save<T: Serialize>(
    tx: &Transaction<'_>,
    kind: RecordKind,
    project: &str,
    id: &str,
    action: &str,
    record: &T,
    stamp: WriteAt<'_>,
) -> Result<(), StoreError> {
    let snapshot = serde_json::to_string(record)?;
    tx.execute(
        &format!("INSERT INTO {} (project, id, snapshot) VALUES (?1, ?2, ?3) ON CONFLICT (project, id) DO UPDATE SET snapshot = excluded.snapshot", kind.table()),
        params![project, id, snapshot],
    )?;
    record_history(tx, kind, project, id, action, &snapshot, stamp)
}

fn record_history(
    tx: &Transaction<'_>,
    kind: RecordKind,
    project: &str,
    id: &str,
    action: &str,
    snapshot: &str,
    stamp: WriteAt<'_>,
) -> Result<(), StoreError> {
    let at_ms = i64::try_from(stamp.at_ms).map_err(|_| StoreError::PlanningInput)?;
    tx.execute(
        "INSERT INTO planning_history (project, kind, id, actor, at_ms, action, snapshot) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![project, kind.as_str(), id, stamp.actor, at_ms, action, snapshot],
    )?;
    Ok(())
}

fn link_task(tx: &Transaction<'_>, source: &ItemSource, task: &str) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO planning_task_sources (task_id, project, item_id) VALUES (?1, ?2, ?3)",
        params![task, source.project_id, source.item_id],
    )?;
    Ok(())
}

fn next_version(current: u64, expected: u64) -> Result<u64, StoreError> {
    if current != expected {
        return Err(StoreError::PlanningConflict);
    }
    current.checked_add(1).ok_or(StoreError::PlanningConflict)
}

fn validate_item(content: &ItemContent) -> Result<(), StoreError> {
    if content.title.trim().is_empty()
        || content.body.len() > MAX_TEXT_BYTES
        || !content.lanes.iter().all(|key| valid_key(key))
        || content.lanes.iter().collect::<BTreeSet<_>>().len() != content.lanes.len()
    {
        return Err(StoreError::PlanningInput);
    }
    Ok(())
}

#[must_use]
pub fn valid_key(key: &str) -> bool {
    !matches!(key, "" | "." | "..")
        && key.len() <= 128
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn task_decision_id(task: &str, version: i64) -> String {
    format!("task-{task}-{version}")
}
