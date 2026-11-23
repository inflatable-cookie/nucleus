use nucleus_core::{RetainedThread, RunState};
use serde::Deserialize;
use serde_json::Value;

use crate::{Binding, HostError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    #[serde(rename = "snapshotSequence")]
    _snapshot_sequence: u64,
    projection: Projection,
    has_more_history: Option<bool>,
    history_cursor: Option<String>,
    id_table: Option<bool>,
    turn_items_omit_local_visible: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Projection {
    thread: Thread,
    runs: Vec<Run>,
    messages: Vec<Message>,
    runtime_requests: Vec<Request>,
    provider_threads: Option<Vec<ProviderThread>>,
    turn_items: Option<Vec<TurnItem>>,
    #[serde(skip)]
    windowed: bool,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderThread {
    #[serde(default)]
    pending_background_tasks: Vec<BackgroundTask>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundTask {
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnItem {
    #[serde(rename = "type")]
    kind: String,
    status: String,
    run_id: Option<String>,
    input: Option<Value>,
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
    const fn in_flight(self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Queued | Self::Starting | Self::Running | Self::Waiting
        )
    }

    const fn run_state(self) -> RunState {
        match self {
            Self::Idle => RunState::IdleWithoutTerminalRun,
            Self::Preparing | Self::Queued | Self::Starting => RunState::Starting,
            Self::Running | Self::Waiting => RunState::Running,
            Self::Completed
            | Self::Interrupted
            | Self::Failed
            | Self::Cancelled
            | Self::RolledBack => RunState::Ended,
        }
    }
}

impl Projection {
    pub(crate) fn parse(value: Value, binding: &Binding, id: &str) -> Result<Self, HostError> {
        let Snapshot {
            mut projection,
            has_more_history,
            history_cursor,
            id_table,
            turn_items_omit_local_visible,
            ..
        } = serde_json::from_value(value).map_err(|_| HostError::Protocol)?;
        if id_table.is_some() || (has_more_history == Some(true)) != history_cursor.is_some() {
            return Err(HostError::Protocol);
        }
        let thread = &projection.thread;
        if thread.id != id || thread.project_id != binding.project_id {
            return Err(HostError::Binding);
        }
        if thread.deleted_at.is_none()
            && (thread.branch.as_ref() != Some(&binding.branch)
                || thread.worktree_path.as_ref() != Some(&binding.worktree_path))
        {
            return Err(HostError::Binding);
        }
        projection.windowed =
            has_more_history == Some(true) || turn_items_omit_local_visible == Some(true);
        Ok(projection)
    }

    pub(crate) fn retained(&self) -> Result<RetainedThread, HostError> {
        if self.thread.deleted_at.is_some() {
            return Ok(RetainedThread::Gone);
        }
        if self.thread_active() || self.background_work() {
            return Ok(RetainedThread::Busy);
        }
        if self.windowed || self.provider_threads.is_none() || self.turn_items.is_none() {
            return Err(HostError::Uncertain);
        }
        Ok(RetainedThread::Idle)
    }

    // Equivalent presence tests to T3's pending background work derivation.
    // Keep every active item that could be a writer, including unawaited work.
    fn background_work(&self) -> bool {
        self.provider_threads.iter().flatten().any(|thread| {
            thread
                .pending_background_tasks
                .iter()
                .any(|task| !task.task_id.is_empty())
        }) || self.turn_items.iter().flatten().any(|item| {
            matches!(
                item.kind.as_str(),
                "command_execution" | "dynamic_tool" | "subagent"
            ) && matches!(item.status.as_str(), "pending" | "running" | "waiting")
                && !(item.kind == "dynamic_tool"
                    && item
                        .input
                        .as_ref()
                        .is_some_and(|input| input["persistent"] == true))
                && !self.runs.iter().any(|run| {
                    matches!(run.status, Status::RolledBack)
                        && item.run_id.as_ref() == Some(&run.id)
                })
        })
    }

    pub(crate) fn run(&self, message_id: &str) -> Result<RunState, HostError> {
        if self.thread.deleted_at.is_some() {
            return Ok(RunState::Gone);
        }
        let (message, run) = self.delivery(message_id);
        let Some(run) = run else {
            if message.is_some_and(|message| message.run_id.is_some()) {
                return Err(HostError::Uncertain);
            }
            if message.is_some() {
                return Ok(RunState::Starting);
            }
            if self.retained()? != RetainedThread::Idle {
                return Err(HostError::Uncertain);
            }
            return Ok(RunState::ReadyToSend);
        };
        if run.status.in_flight()
            && let Some(pending) = self
                .runtime_requests
                .iter()
                .find(|request| request.status == "pending")
        {
            return Ok(if pending.kind == "user_input" {
                RunState::Input
            } else {
                RunState::Permission
            });
        }
        Ok(run.status.run_state())
    }

    pub(crate) const fn archived(&self) -> bool {
        self.thread.archived_at.is_some()
    }

    pub(crate) fn stop_command(&self, message_id: &str) -> Option<(&'static str, &str)> {
        let run = self.delivery(message_id).1?;
        match run.status {
            Status::Queued => Some(("queued-run.cancel", &run.id)),
            status if status.in_flight() => Some(("run.interrupt", &run.id)),
            _ => None,
        }
    }

    fn delivery(&self, id: &str) -> (Option<&Message>, Option<&Run>) {
        let message = self.messages.iter().find(|message| message.id == id);
        let linked_id = message.and_then(|message| message.run_id.as_deref());
        let run = self.runs.iter().find(|run| {
            run.user_message_id.as_deref() == Some(id) || linked_id == Some(run.id.as_str())
        });
        (message, run)
    }

    fn thread_active(&self) -> bool {
        self.runtime_requests
            .iter()
            .any(|request| request.status == "pending")
            || self.runs.iter().any(|run| run.status.in_flight())
    }
}

pub(crate) fn missing_thread(cause: &Value, id: &str) -> bool {
    let Some(items) = cause.as_array() else {
        return false;
    };
    let [reason] = items.as_slice() else {
        return false;
    };
    let error = &reason["error"];
    if reason["_tag"] != "Fail"
        || error["_tag"] != "OrchestrationV2GetThreadProjectionError"
        || error["threadId"]
            .as_str()
            .is_some_and(|actual| actual != id)
    {
        return false;
    }
    let mut inner = &error["cause"];
    if tag(inner, "OrchestratorProjectionError") {
        if inner["message"].as_str().is_some_and(|message| {
            message != format!("Failed to load orchestration projection for thread {id}.")
        }) {
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
