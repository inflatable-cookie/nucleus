//! Exact thread snapshots are reusable while their synchronized shell row holds.

use std::{collections::BTreeMap, sync::Arc};

use serde_json::{Value, json};

use crate::{RegisteredProject, rpc::closed_row, task_row::RowChildren};

const MAX_SNAPSHOTS: usize = 64;
const MAX_SNAPSHOT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy)]
pub(crate) enum ThreadRead {
    Observation,
    Exact,
    Inbox,
    Terminal,
}

impl ThreadRead {
    pub(crate) const fn terminal(self) -> bool {
        matches!(self, Self::Terminal)
    }
}

pub(crate) struct ShellCustody<'a>(pub &'a Value);

impl<'a> ShellCustody<'a> {
    pub(crate) fn parent(&self) -> Option<&'a str> {
        let lineage = &self.0["lineage"];
        let parent = lineage["parentThreadId"].as_str()?;
        (lineage["rootThreadId"] == parent && lineage["relationshipToParent"] == "subagent")
            .then_some(parent)
    }

    pub(crate) fn background(&self) -> Option<bool> {
        self.0["pendingBackgroundTasks"]
            .as_array()
            .map(|tasks| !tasks.is_empty())
    }

    pub(crate) fn has_active_turn(&self) -> bool {
        let row = self.0;
        !row["activeRunId"].is_null()
            || !row["pendingRuntimeRequest"].is_null()
            || matches!(
                row["status"].as_str(),
                Some("pending" | "preparing" | "queued" | "starting" | "running" | "waiting")
            )
    }

    pub(crate) fn activity(&self) -> RowChildren {
        let row = self.0;
        if self.has_active_turn() || self.background() == Some(true) {
            RowChildren::Active
        } else if row.get("activeRunId").is_some_and(Value::is_null)
            && row.get("pendingRuntimeRequest").is_some_and(Value::is_null)
            && self.background() == Some(false)
            && matches!(
                row["status"].as_str(),
                Some("idle" | "completed" | "failed" | "interrupted" | "cancelled")
            )
        {
            RowChildren::Quiet
        } else {
            RowChildren::Unknown
        }
    }

    pub(crate) fn changed_field(&self, other: &Self) -> Option<&'static str> {
        [
            "id",
            "projectId",
            "worktreePath",
            "branch",
            "lineage",
            "providerInstanceId",
            "modelSelection",
            "activeProviderThreadId",
            "archivedAt",
            "deletedAt",
            "activeRunId",
            "status",
            "latestRunId",
            "latestRunCompletedAt",
            "pendingRuntimeRequest",
            "pendingBackgroundTasks",
        ]
        .into_iter()
        .find(|&field| self.0.get(field) != other.0.get(field))
    }
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
    reply: Value,
    used_at: u64,
}

pub(crate) fn row_activity(row: &Value) -> RowChildren {
    ShellCustody(row).activity()
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

    pub(crate) fn update(&mut self, item: &Value) -> bool {
        if let Some(sequence) = item["sequence"].as_u64() {
            if self.sequence.is_some_and(|prior| sequence < prior) {
                return false;
            }
            self.sequence = Some(sequence);
        }
        match item["kind"].as_str() {
            Some("thread.updated") => {
                let row = &item["thread"];
                if let Some(id) = row["id"].as_str()
                    && self.rows.get(id).is_none_or(|prior| **prior != *row)
                {
                    if let Some(revision) = item["sequence"].as_u64() {
                        self.row_revisions.insert(id.to_owned(), revision);
                    }
                    self.held.remove(id);
                    self.rows.insert(id.to_owned(), Arc::new(row.clone()));
                }
            }
            Some("thread.removed") => {
                if let Some(id) = item["threadId"].as_str() {
                    if let Some(row) = self.rows.get(id)
                        && let Some(location) = item["location"].as_str()
                        && (location == "archived") == row["archivedAt"].is_null()
                    {
                        return false;
                    }
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
        true
    }

    pub(crate) fn forget(&mut self, id: &str) {
        self.held.remove(id);
    }

    pub(crate) const fn revision(&self) -> Option<u64> {
        self.sequence
    }

    pub(crate) fn row_revision(&self, id: &str) -> Option<(u64, bool)> {
        self.row_revisions
            .get(id)
            .map(|&revision| (revision, false))
            .or_else(|| self.initial_revision.map(|revision| (revision, true)))
    }

    pub(crate) fn marker(&self, id: &str) -> Option<Arc<Value>> {
        self.rows.get(id).cloned()
    }

    pub(crate) fn children(&self, parent: &str) -> impl Iterator<Item = &str> {
        self.rows.iter().filter_map(move |(id, row)| {
            (row["deletedAt"].is_null()
                && (row["parentThreadId"] == parent || row["lineage"]["parentThreadId"] == parent))
                .then_some(id.as_str())
        })
    }

    pub(crate) fn row_children(&self, parent: &str, roles: &[&str]) -> RowChildren {
        roles
            .iter()
            .copied()
            .chain(self.children(parent))
            .map(|id| {
                self.rows
                    .get(id)
                    .map_or(RowChildren::Unknown, |row| row_activity(row))
            })
            .max()
            .unwrap_or(RowChildren::Quiet)
    }

    pub(crate) fn project(&self, id: &str) -> Option<RegisteredProject> {
        RegisteredProject::read(self.projects.get(id)?)
    }

    pub(crate) fn title_threads(&self, provider: &str) -> Vec<String> {
        self.rows
            .iter()
            .filter(|(_, row)| {
                !closed_row(row)
                    && row["providerInstanceId"] == provider
                    && row["projectId"]
                        .as_str()
                        .is_some_and(|id| self.project(id).is_some())
            })
            .map(|(id, _)| id.clone())
            .collect()
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

    pub(crate) fn get(&mut self, id: &str) -> Option<Value> {
        let held = self.held.get_mut(id)?;
        self.reads += 1;
        held.used_at = self.reads;
        Some(held.reply.clone())
    }

    pub(crate) fn keep(&mut self, id: &str, marker: &Value, reply: &Value, policy: ThreadRead) {
        // Shell rows can omit active turn items and the bodies of pending requests.
        if !matches!(policy, ThreadRead::Inbox) && row_activity(marker) == RowChildren::Active {
            return;
        }
        if reply
            .pointer("/projection/thread/id")
            .and_then(Value::as_str)
            != Some(id)
            || marker["updatedAt"].as_str().is_some_and(|updated| {
                reply
                    .pointer("/projection/thread/updatedAt")
                    .and_then(Value::as_str)
                    != Some(updated)
            })
            || reply.to_string().len() > MAX_SNAPSHOT_BYTES
        {
            return;
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
