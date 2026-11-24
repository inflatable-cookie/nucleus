//! Exact thread snapshots are reusable while their synchronized shell row holds.

use std::{collections::BTreeMap, sync::Arc};

use serde_json::{Value, json};

use crate::{rpc::Reply, task_row::RowChildren};

const MAX_SNAPSHOTS: usize = 64;
const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy)]
pub(crate) enum ThreadRead {
    Observation,
    Exact,
    Terminal,
}

pub(crate) struct ThreadSnapshots {
    rows: BTreeMap<String, Arc<Value>>,
    row_revisions: BTreeMap<String, u64>,
    initial_revision: Option<u64>,
    projects: BTreeMap<String, Value>,
    sequence: Option<u64>,
    held: BTreeMap<String, Held>,
    reads: u64,
}

struct Held {
    reply: Reply,
    used_at: u64,
}

impl ThreadSnapshots {
    pub(crate) fn read(shell: &Value) -> Option<Self> {
        let snapshot = &shell["snapshot"];
        let mut rows = BTreeMap::new();
        for row in snapshot["threads"]
            .as_array()?
            .iter()
            .chain(snapshot["archivedThreads"].as_array().into_iter().flatten())
        {
            if rows
                .insert(row["id"].as_str()?.to_owned(), Arc::new(row.clone()))
                .is_some()
            {
                return None;
            }
        }
        let mut projects = BTreeMap::new();
        for project in snapshot["projects"].as_array()? {
            if projects
                .insert(project["id"].as_str()?.to_owned(), project.clone())
                .is_some()
            {
                return None;
            }
        }
        let sequence = snapshot["snapshotSequence"]
            .as_u64()
            .or_else(|| shell["snapshotSequence"].as_u64());
        Some(Self {
            rows,
            row_revisions: BTreeMap::new(),
            initial_revision: sequence,
            projects,
            sequence,
            held: BTreeMap::new(),
            reads: 0,
        })
    }

    pub(crate) fn update(&mut self, item: &Value) {
        if let Some(sequence) = item["sequence"]
            .as_u64()
            .filter(|sequence| self.sequence.is_none_or(|prior| *sequence > prior))
        {
            self.sequence = Some(sequence);
        }
        match item["kind"].as_str() {
            Some("thread.updated") => {
                let row = &item["thread"];
                if let Some(id) = row["id"].as_str() {
                    if let Some(revision) = item["sequence"].as_u64() {
                        self.row_revisions.insert(id.to_owned(), revision);
                    }
                    if self.rows.get(id).is_none_or(|prior| **prior != *row) {
                        self.held.remove(id);
                        self.rows.insert(id.to_owned(), Arc::new(row.clone()));
                    }
                }
            }
            Some("thread.removed") => {
                if let Some(id) = item["threadId"].as_str() {
                    self.held.remove(id);
                    self.rows.remove(id);
                    self.row_revisions.remove(id);
                }
            }
            Some("project.updated") => {
                let project = &item["project"];
                if let Some(id) = project["id"].as_str() {
                    self.projects.insert(id.to_owned(), project.clone());
                }
            }
            Some("project.removed") => {
                if let Some(id) = item["projectId"].as_str() {
                    self.projects.remove(id);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn forget(&mut self, id: &str) {
        self.held.remove(id);
    }

    pub(crate) fn marker(&self, id: &str) -> Option<Arc<Value>> {
        self.rows.get(id).cloned()
    }

    pub(crate) fn revision(&self, id: &str) -> Option<u64> {
        self.row_revisions
            .get(id)
            .copied()
            .or(self.initial_revision)
    }

    pub(crate) fn row_children(&self, parent: &str, roles: &[&str]) -> RowChildren {
        let mut unknown = roles.iter().any(|role| !self.rows.contains_key(*role));
        let attached = self.rows.values().filter(|row| {
            row["lineage"]["parentThreadId"] == parent
                && row["lineage"]["rootThreadId"] == parent
                && row["lineage"]["relationshipToParent"] == "subagent"
        });
        for row in roles
            .iter()
            .filter_map(|role| self.rows.get(*role))
            .chain(attached)
        {
            let status = row["status"].as_str();
            let background = row["pendingBackgroundTasks"].as_array();
            if row["activeRunId"].is_string()
                || row["pendingRuntimeRequest"].is_object()
                || background.is_some_and(|tasks| !tasks.is_empty())
                || matches!(
                    status,
                    Some("pending" | "preparing" | "queued" | "starting" | "running" | "waiting")
                )
            {
                return RowChildren::Active;
            }
            unknown |= !row.get("activeRunId").is_some_and(Value::is_null)
                || !row.get("pendingRuntimeRequest").is_some_and(Value::is_null)
                || background.is_none()
                || !matches!(
                    status,
                    Some("idle" | "completed" | "failed" | "interrupted" | "cancelled")
                );
        }
        if unknown {
            RowChildren::Unknown
        } else {
            RowChildren::Quiet
        }
    }

    pub(crate) fn background_row(&self, id: &str, revision: u64) -> Option<(Arc<Value>, bool)> {
        let same_revision = self.row_revisions.get(id).map_or_else(
            || {
                self.initial_revision
                    .is_some_and(|initial| revision <= initial)
            },
            |observed| *observed == revision,
        );
        Some((self.marker(id)?, same_revision))
    }

    pub(crate) fn closed(&self, id: &str) -> Option<(Value, Option<u64>)> {
        let row = self.rows.get(id)?;
        (!row["deletedAt"].is_null() || !row["archivedAt"].is_null())
            .then(|| ((**row).clone(), self.sequence))
    }

    pub(crate) fn snapshot(&self) -> Value {
        let threads: Vec<_> = self
            .rows
            .values()
            .map(AsRef::as_ref)
            .filter(|row| row["deletedAt"].is_null() && row["archivedAt"].is_null())
            .collect();
        let projects: Vec<_> = self.projects.values().collect();
        json!({"snapshot": {"threads": threads, "projects": projects}})
    }

    pub(crate) fn get(&mut self, id: &str) -> Option<Reply> {
        let held = self.held.get_mut(id)?;
        self.reads += 1;
        held.used_at = self.reads;
        Some(held.reply.clone())
    }

    pub(crate) fn keep(&mut self, id: &str, marker: &Arc<Value>, reply: &Reply) {
        // Shell rows can omit active turn items and the bodies of pending requests.
        if !self
            .rows
            .get(id)
            .is_some_and(|row| Arc::ptr_eq(row, marker))
            || !marker["pendingRuntimeRequest"].is_null()
            || !marker["activeRunId"].is_null()
            || matches!(
                marker["status"].as_str(),
                Some("running" | "waiting" | "starting" | "queued" | "preparing")
            )
        {
            return;
        }
        match reply {
            Reply::Value(value)
                if value
                    .pointer("/projection/thread/id")
                    .and_then(Value::as_str)
                    == Some(id)
                    && value.to_string().len() <= MAX_SNAPSHOT_BYTES => {}
            _ => return,
        }
        if self.held.len() == MAX_SNAPSHOTS
            && !self.held.contains_key(id)
            && let Some(oldest) = self
                .held
                .iter()
                .min_by_key(|(_, held)| held.used_at)
                .map(|(id, _)| id.clone())
        {
            self.held.remove(&oldest);
        }
        self.reads += 1;
        self.held.insert(
            id.to_owned(),
            Held {
                reply: reply.clone(),
                used_at: self.reads,
            },
        );
    }
}
