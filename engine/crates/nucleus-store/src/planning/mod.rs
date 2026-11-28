//! Project-scoped planning records and their append-only history.

pub(super) mod decisions;
mod model;
mod removal;
mod retention;

use std::collections::BTreeSet;

use nucleus_core::Task;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Serialize, de::DeserializeOwned};

use crate::{EventDraft, Store, StoreError, TaskAdmissionFacts, admit, decode_error};

pub use decisions::{USAGE_APPROVE, UsagePermission};
pub use model::*;
pub use removal::{ProjectRemoval, RemovalTask};

/// Space for legacy Markdown even when every character uses four UTF-8 bytes.
pub const MAX_TEXT_BYTES: usize = 4_000_000;

pub(super) const SCHEMA: &str = include_str!("schema.sql");

use RecordKind::{
    Decision as DecisionRecord, Item as ItemRecord, Lane as LaneRecord, Plan as PlanRecord,
};

const ITEM_VIEW: &str = "SELECT i.snapshot, c.created_at, c.updated_at, c.version
    FROM planning_items i JOIN planning_record_clocks c
    ON c.project=i.project AND c.kind='item' AND c.id=i.id";

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
    /// Returns an error for a stale version, invalid completion criterion, unknown or repeated lane, or database failure.
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
            // Match the board's 300 UTF-16 code unit limit (Spec 041).
            if entry.done_when.contains(['\r', '\n'])
                || entry.done_when.encode_utf16().nth(300).is_some()
                || !keys.insert(&entry.key)
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

    /// Read one current lane by its project and key.
    ///
    /// # Errors
    /// Returns an error if the database cannot read the lane.
    pub fn lane(&self, project: &str, key: &str) -> Result<Option<Lane>, StoreError> {
        read(&self.connection, LaneRecord, project, key)
    }

    /// Read the prompt context for a lane without loading its document.
    ///
    /// # Errors
    /// Returns an error if the lane metadata cannot be read.
    pub fn lane_context(
        &self,
        project: &str,
        key: &str,
    ) -> Result<Option<(String, String)>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT json_extract(snapshot,'$.title'), json_extract(snapshot,'$.aim')
             FROM planning_lanes WHERE project = ?1 AND id = ?2",
                params![project, key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    /// Read the exact document version, including versions since superseded.
    ///
    /// # Errors
    /// Returns an error when the supplied version or stored record cannot be read.
    pub fn lane_version(
        &self,
        project: &str,
        key: &str,
        version: u64,
    ) -> Result<Option<Lane>, StoreError> {
        if let Some(lane) = self
            .lane(project, key)?
            .filter(|lane| lane.version == version)
        {
            return Ok(Some(lane));
        }
        let Ok(version) = i64::try_from(version) else {
            return Ok(None);
        };
        Ok(self.connection.query_row(
            "SELECT snapshot FROM planning_history
             WHERE project = ?1 AND kind = 'lane' AND id = ?2 AND json_extract(snapshot, '$.version') = ?3
             ORDER BY sequence DESC LIMIT 1",
            params![project, key, version],
            |row| decode(row, 0),
        ).optional()?)
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

    /// Read item snapshots with their recorded times and latest history sequence.
    ///
    /// # Errors
    /// Returns an error if the items or timestamps cannot be read.
    pub fn items_with_times(&self, project: &str) -> Result<Vec<ItemWithTimes>, StoreError> {
        let mut query = self
            .connection
            .prepare_cached(&format!("{ITEM_VIEW} WHERE i.project = ?1 ORDER BY i.id"))?;
        let rows = query.query_map([project], item_view)?;
        Ok(rows.collect::<Result<_, _>>()?)
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
        self.add_item_with_author_project(project, id, kind, content, None, stamp)
    }

    /// Record an item with the project whose planner claim authenticated its author.
    ///
    /// # Errors
    /// Returns an error for invalid content, a duplicate ID, or database failure.
    pub fn add_item_with_author_project(
        &mut self,
        project: &str,
        id: String,
        kind: ItemKind,
        content: ItemContent,
        author_project_id: Option<String>,
        stamp: WriteAt<'_>,
    ) -> Result<Item, StoreError> {
        validate_item(&content)?;
        let tx = self.planning_write()?;
        let item = Item {
            id,
            kind,
            author: stamp.actor.into(),
            author_project_id,
            repositories: Vec::new(),
            task_links: Vec::new(),
            content,
            state: ItemState::Open,
        };
        insert(&tx, ItemRecord, project, &item.id, "add", &item, stamp)?;
        tx.commit()?;
        Ok(item)
    }

    /// Replace the item content, retaining the original author and its prior history.
    /// An expected version restricts the edit to that exact item snapshot.
    ///
    /// # Errors
    /// Returns an error for a missing item, wrong kind or version, invalid content, or database failure.
    pub fn edit_item(
        &mut self,
        project: &str,
        id: &str,
        content: ItemContent,
        expected_version: Option<i64>,
        stamp: WriteAt<'_>,
    ) -> Result<ItemWithTimes, StoreError> {
        validate_item(&content)?;
        let tx = self.planning_write()?;
        let mut saved = tx
            .prepare_cached(&format!("{ITEM_VIEW} WHERE i.project = ?1 AND i.id = ?2"))?
            .query_row([project, id], item_view)
            .optional()?
            .ok_or(StoreError::PlanningMissing)?;
        if expected_version.is_some_and(|version| version != saved.version) {
            return Err(StoreError::PlanningConflict);
        }
        saved.item.content = content;
        save(&tx, ItemRecord, project, id, "edit", &saved.item, stamp)?;
        // save inserts the planning history row last, within this transaction.
        saved.version = tx.last_insert_rowid();
        saved.updated_at_ms = i64::try_from(stamp.at_ms).ok();
        tx.commit()?;
        Ok(saved)
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

    /// Reopen a parked or dropped item, retaining its prior history.
    ///
    /// # Errors
    /// Returns an error if the item or version is invalid, or the database fails.
    pub fn reopen_item(
        &mut self,
        project: &str,
        id: &str,
        version: Option<i64>,
        note: Option<&str>,
        stamp: WriteAt<'_>,
    ) -> Result<ItemWithTimes, StoreError> {
        let tx = self.planning_write()?;
        let mut saved = tx
            .prepare_cached(&format!("{ITEM_VIEW} WHERE i.project = ?1 AND i.id = ?2"))?
            .query_row([project, id], item_view)
            .optional()?
            .ok_or(StoreError::PlanningMissing)?;
        if version.is_some_and(|version| version != saved.version)
            || !matches!(
                saved.item.state,
                ItemState::Parked { .. } | ItemState::Dropped { .. }
            )
        {
            return Err(StoreError::PlanningConflict);
        }
        saved.item.state = ItemState::Open;
        save(&tx, ItemRecord, project, id, "reopen", &saved.item, stamp)?;
        saved.version = tx.last_insert_rowid();
        saved.updated_at_ms = i64::try_from(stamp.at_ms).ok();
        if let Some(note) = note {
            let mut snapshot = serde_json::to_value(&saved.item)?;
            snapshot["note"] = note.into();
            tx.execute(
                "UPDATE planning_history SET snapshot=?1 WHERE sequence=?2",
                params![snapshot.to_string(), saved.version],
            )?;
        }
        tx.commit()?;
        Ok(saved)
    }

    /// Record an item assessment send and queue its planner tell in one transaction.
    ///
    /// # Errors
    /// Returns an error if the item is missing, closed, at a different version, or the write fails.
    #[allow(clippy::too_many_arguments)]
    pub fn assess_item(
        &mut self,
        project: &str,
        id: &str,
        version: Option<i64>,
        recipient: &str,
        stamp: WriteAt<'_>,
        tell: &crate::TellSubmission<'_>,
        tell_id: &str,
    ) -> Result<ItemWithTimes, StoreError> {
        let tx = self.planning_write()?;
        let mut saved = tx
            .prepare_cached(&format!("{ITEM_VIEW} WHERE i.project = ?1 AND i.id = ?2"))?
            .query_row([project, id], item_view)
            .optional()?
            .ok_or(StoreError::PlanningMissing)?;
        if version.is_some_and(|expected| expected != saved.version)
            || !matches!(saved.item.state, ItemState::Open | ItemState::Parked { .. })
        {
            return Err(StoreError::PlanningConflict);
        }
        let mut snapshot = serde_json::to_value(&saved.item)?;
        snapshot["recipient"] = recipient.into();
        snapshot["tell"] = tell.key.into();
        record_history(
            &tx,
            ItemRecord,
            project,
            id,
            "assess",
            &snapshot.to_string(),
            stamp,
        )?;
        saved.version = tx.last_insert_rowid();
        saved.updated_at_ms = i64::try_from(stamp.at_ms).ok();
        crate::tells::insert_tell_in_tx(&tx, project, tell, tell_id)?;
        tx.commit()?;
        Ok(saved)
    }

    /// Record on the item why an assessment send is waiting for a planner, or with no
    /// cause, that it reached one. Each entry names the history entry of its send.
    /// Returns the item when this changed what that send shows.
    ///
    /// # Errors
    /// Returns an error if the item or its history cannot be read or written.
    pub fn record_assess_outcome(
        &mut self,
        send: &crate::TellDelivery,
        cause: Option<&str>,
        stamp: WriteAt<'_>,
    ) -> Result<Option<String>, StoreError> {
        let project = &send.to_project;
        let tx = self.planning_write()?;
        // A send queued by an earlier engine left no key on its history entry. That entry
        // and its message were written together, with one time and the item named first.
        let origin = tx
            .query_row(
                "SELECT sequence, id FROM planning_history
                 WHERE project = ?1 AND kind = 'item' AND action = 'assess'
                 AND (json_extract(snapshot, '$.tell') = ?2
                      OR (json_extract(snapshot, '$.tell') IS NULL AND at_ms = ?3
                          AND (instr(?4, 'Assess Lead ' || id || ' in ') = 1
                               OR instr(?4, 'Assess Papercut ' || id || ' in ') = 1)))",
                params![project, send.request_key, send.recorded_at, send.text],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((origin, id)) = origin else {
            return Ok(None);
        };
        let recorded = tx
            .query_row(
                "SELECT json_extract(snapshot, '$.cause') FROM planning_history
                 WHERE project = ?1 AND kind = 'item' AND id = ?2
                 AND json_extract(snapshot, '$.send') = ?3 ORDER BY sequence DESC LIMIT 1",
                params![project, id, origin],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        // A retry with the same cause adds nothing, and only a waiting send can arrive.
        if recorded.as_deref() == cause {
            return Ok(None);
        }
        let item: Item = required(&tx, ItemRecord, project, &id)?;
        let mut snapshot = serde_json::to_value(&item)?;
        snapshot["send"] = origin.into();
        let action = if let Some(cause) = cause {
            snapshot["cause"] = cause.into();
            "assess_blocked"
        } else {
            "assess_reached"
        };
        record_history(
            &tx,
            ItemRecord,
            project,
            &id,
            action,
            &snapshot.to_string(),
            stamp,
        )?;
        tx.commit()?;
        Ok(Some(id))
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
    ) -> Result<(Item, i64), StoreError> {
        self.promote_item_with_facts(
            source,
            PromotionCheck {
                body: &task.brief().text,
                version: None,
                source_body: None,
            },
            task,
            event,
            stamp,
            TaskAdmissionFacts::default(),
        )
    }

    /// Promote the item, including its prerequisites and any required Low usage permission, in one transaction.
    /// A changed source body (a lead's chosen complexity) is saved with the promotion, so the
    /// item's brief changes only when its task is admitted.
    ///
    /// # Errors
    /// Returns the same conflicts and write errors as [`Self::promote_item`], and a conflict
    /// when the item moved past the expected version.
    pub fn promote_item_with_facts(
        &mut self,
        source: &ItemSource,
        check: PromotionCheck<'_>,
        task: &Task,
        event: &EventDraft,
        stamp: WriteAt<'_>,
        facts: TaskAdmissionFacts<'_>,
    ) -> Result<(Item, i64), StoreError> {
        let tx = self.planning_write()?;
        let ItemSource {
            project_id: project,
            item_id: id,
        } = source;
        let ItemWithTimes {
            mut item, version, ..
        } = tx
            .prepare_cached(&format!("{ITEM_VIEW} WHERE i.project = ?1 AND i.id = ?2"))?
            .query_row([project, id], item_view)
            .optional()?
            .ok_or(StoreError::PlanningMissing)?;
        if !matches!(item.state, ItemState::Open | ItemState::Parked { .. })
            || item.content.body != check.body
            || check.version.is_some_and(|expected| expected != version)
        {
            return Err(StoreError::PlanningConflict);
        }
        if let Some(body) = check.source_body {
            item.content.body = body.into();
        }
        let number = admit(&tx, task, event, facts)?;
        link_task(&tx, source, &task.identity().id)?;
        item.state = ItemState::Promoted {
            task_id: task.identity().id.clone(),
        };
        save(&tx, ItemRecord, project, id, "promote", &item, stamp)?;
        tx.commit()?;
        Ok((item, number))
    }

    /// Lanes inherited from the source item of each promoted task.
    ///
    /// # Errors
    /// Returns an error if the joined planning rows cannot be read.
    pub fn source_lanes(&self) -> Result<Vec<(String, String, String)>, StoreError> {
        let mut query = self.connection.prepare_cached(
            "SELECT s.task_id, s.project, lane.value FROM planning_task_sources s
             JOIN planning_items i ON i.project=s.project AND i.id=s.item_id
             JOIN json_each(CASE WHEN json_valid(i.snapshot) THEN i.snapshot END, '$.lanes') lane
             WHERE lane.type='text'",
        )?;
        Ok(query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?)
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

fn item_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<ItemWithTimes> {
    Ok(ItemWithTimes {
        item: decode(row, 0)?,
        created_at_ms: row.get(1)?,
        updated_at_ms: row.get(2)?,
        version: row.get(3)?,
    })
}

fn insert<T: Serialize>(
    tx: &Transaction<'_>,
    kind: RecordKind,
    project: &str,
    id: &str,
    action: &str,
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
    record_history(tx, kind, project, id, action, &snapshot, stamp)
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
        "INSERT INTO planning_history (sequence, project, kind, id, actor, at_ms, action, snapshot)
         SELECT coalesce(max(version),0)+1, ?1, ?2, ?3, ?4, ?5, ?6, ?7 FROM planning_record_clocks",
        params![
            project,
            kind.as_str(),
            id,
            stamp.actor,
            at_ms,
            action,
            snapshot
        ],
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
