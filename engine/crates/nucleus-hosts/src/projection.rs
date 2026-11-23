use nucleus_core::{RetainedThread, RunState};
use serde::Deserialize;
use serde_json::Value;

use crate::{Binding, HostError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    projection: Projection,
    has_more_history: Option<bool>,
    history_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Projection {
    thread: Thread,
    runs: Vec<Run>,
    messages: Vec<Message>,
    runtime_requests: Vec<Request>,
    #[serde(skip)]
    paged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    project_id: String,
    worktree_path: Option<String>,
    branch: Option<String>,
    archived_at: Option<String>,
    deleted_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: String,
    status: Status,
    user_message_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    id: String,
    run_id: Option<String>,
}

#[derive(Deserialize)]
struct Request {
    status: String,
    kind: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Idle,
    Preparing,
    Queued,
    Starting,
    Running,
    Waiting,
    Completed,
    Interrupted,
    Failed,
    Cancelled,
    RolledBack,
}

impl Status {
    const fn run_state(self) -> RunState {
        match self {
            Self::Idle => RunState::IdleWithoutTerminalRun,
            Self::Preparing | Self::Queued | Self::Starting => RunState::Starting,
            Self::Running | Self::Waiting => RunState::Running,
            Self::Completed | Self::Interrupted | Self::Failed | Self::Cancelled | Self::RolledBack => RunState::Ended,
        }
    }
}

impl Projection {
    pub(crate) fn parse(value: Value, binding: &Binding, id: &str) -> Result<Self, HostError> {
        let Snapshot { mut projection, has_more_history, history_cursor } = serde_json::from_value(value).map_err(|_| HostError::Protocol)?;
        let thread = &projection.thread;
        if thread.id != id || thread.project_id != binding.project_id {
            return Err(HostError::Binding);
        }
        if thread.deleted_at.is_none() && (thread.branch.as_ref() != Some(&binding.branch) || thread.worktree_path.as_ref() != Some(&binding.worktree_path)) {
            return Err(HostError::Binding);
        }
        projection.paged = has_more_history != Some(false) && (has_more_history == Some(true) || history_cursor.is_some());
        Ok(projection)
    }

    pub(crate) fn retained(&self) -> RetainedThread {
        if self.thread.deleted_at.is_some() {
            RetainedThread::Gone
        } else if self.thread.archived_at.is_some() || self.thread_active() {
            RetainedThread::Busy
        } else {
            RetainedThread::Idle
        }
    }

    pub(crate) fn run(&self, message_id: &str) -> Result<RunState, HostError> {
        if self.thread.deleted_at.is_some() {
            return Ok(RunState::Gone);
        }
        let message = self.messages.iter().find(|message| message.id == message_id);
        let linked_id = message.and_then(|message| message.run_id.as_deref());
        let run = self.runs.iter().find(|run| run.user_message_id.as_deref() == Some(message_id) || linked_id == Some(run.id.as_str()));
        let Some(run) = run else {
            if linked_id.is_some() || self.thread.archived_at.is_some() {
                return Err(HostError::Uncertain);
            }
            if message.is_some() {
                return Ok(RunState::Starting);
            }
            if self.paged || self.thread_active() {
                return Err(HostError::Uncertain);
            }
            return Ok(RunState::ReadyToSend);
        };
        if let Some(pending) = self.runtime_requests.iter().find(|request| request.status == "pending") {
            return Ok(if pending.kind == "user_input" { RunState::Input } else { RunState::Permission });
        }
        Ok(run.status.run_state())
    }

    fn thread_active(&self) -> bool {
        self.runtime_requests.iter().any(|request| request.status == "pending") || self.runs.iter().any(|run| matches!(run.status.run_state(), RunState::Starting | RunState::Running))
    }
}

pub(crate) fn missing_thread(cause: &Value, id: &str) -> bool {
    let Some(items) = cause.as_array() else { return false };
    let [reason] = items.as_slice() else { return false };
    let error = &reason["error"];
    if reason["_tag"] != "Fail" || error["_tag"] != "OrchestrationV2GetThreadProjectionError"
        || error["threadId"].as_str().is_some_and(|actual| actual != id) {
        return false;
    }
    let mut inner = &error["cause"];
    if tag(inner, "OrchestratorProjectionError") {
        if inner["message"].as_str().is_some_and(|message| message != format!("Failed to load orchestration projection for thread {id}.")) {
            return false;
        }
        inner = &inner["cause"];
    }
    tag(inner, "ProjectionStoreThreadNotFoundError")
        && (inner["message"] == format!("No orchestration projection exists for thread {id}.")
            || (inner["message"].is_null() && inner["threadId"] == id))
}

fn tag(value: &Value, tag: &str) -> bool {
    value["name"] == tag || value["_tag"] == tag
}

pub(crate) fn active_tools(family: &Value, id: &str) -> Result<bool, HostError> {
    let rows = family["threads"].as_array().ok_or(HostError::Protocol)?;
    if !rows.iter().any(|row| row["id"] == id) {
        return Err(HostError::Uncertain);
    }
    Ok(rows.iter().any(|row| {
        row["activeRunId"].is_string() || !row["pendingRuntimeRequest"].is_null()
            || row["pendingBackgroundTasks"].as_array().is_some_and(|tasks| !tasks.is_empty())
    }))
}
