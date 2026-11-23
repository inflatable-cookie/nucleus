use std::{
    path::{Component, Path},
    sync::LazyLock,
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{RetainedThread, RunState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{Binding, HostError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    #[serde(rename = "snapshotSequence")]
    sequence: u64,
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
    subagents: Option<Vec<Subagent>>,
    #[serde(skip)]
    windowed: bool,
    #[serde(skip)]
    sequence: u64,
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
    parent_thread_id: Option<String>,
    provider_instance_id: Option<String>,
    model_selection: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: String,
    status: Status,
    user_message_id: Option<String>,
    root_node_id: Option<String>,
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
pub(crate) struct Subagent {
    pub id: String,
    pub child_thread_id: Option<String>,
    pub origin: String,
    pub completion_delivery: Option<CompletionDelivery>,
}

#[derive(Deserialize)]
pub(crate) struct CompletionDelivery {
    pub state: String,
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
    file_name: Option<Value>,
    started_at: Option<Value>,
}

/// A display-only summary of a running item on the launch's exact native run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunActivity {
    pub label: String,
    pub started_at: Option<u64>,
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
            sequence,
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
        projection.sequence = sequence;
        Ok(projection)
    }

    pub(crate) fn require_parent_provider(&self, instance: &str) -> Result<(), HostError> {
        if self.thread.parent_thread_id.is_some()
            || self.thread.provider_instance_id.as_deref() != Some(instance)
            || !self
                .thread
                .model_selection
                .as_ref()
                .is_some_and(|model| model["instanceId"] == instance && model["model"] == "nucleus")
        {
            return Err(HostError::Binding);
        }
        Ok(())
    }

    pub(crate) fn belongs_to_parent(&self, parent: &str) -> bool {
        self.thread.deleted_at.is_some() || self.thread.parent_thread_id.as_deref() == Some(parent)
    }

    pub(crate) fn matches_selection(&self, expected: &Value) -> bool {
        let Some(actual) = &self.thread.model_selection else {
            return false;
        };
        self.thread.provider_instance_id.as_deref() == expected["instanceId"].as_str()
            && actual["instanceId"] == expected["instanceId"]
            && actual["model"] == expected["model"]
            && expected["options"].as_array().is_none_or(|options| {
                actual["options"].as_array().is_some_and(|current| {
                    options.iter().all(|requested| current.contains(requested))
                })
            })
    }

    pub(crate) fn live_parent_run(&self) -> Option<(&str, &str)> {
        if self.archived() || self.thread.deleted_at.is_some() {
            return None;
        }
        let mut live = self
            .runs
            .iter()
            .filter(|run| matches!(run.status, Status::Running | Status::Waiting));
        let run = live.next()?;
        if live.next().is_some() {
            return None;
        }
        Some((
            &run.id,
            run.root_node_id
                .as_deref()
                .filter(|node| !node.is_empty())?,
        ))
    }

    pub(crate) const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) fn subagents(&self) -> Result<&[Subagent], HostError> {
        if self.windowed {
            return Err(HostError::Uncertain);
        }
        self.subagents.as_deref().ok_or(HostError::Uncertain)
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

    pub(crate) fn activity(&self, message_id: &str) -> Option<RunActivity> {
        if self.windowed || self.thread.deleted_at.is_some() {
            return None;
        }
        // A message attached as a steer does not own the target run.
        let run = self.runs.iter().find(|run| {
            run.user_message_id.as_deref() == Some(message_id)
                && !matches!(run.status, Status::RolledBack)
        })?;
        let checkout = Path::new(self.thread.worktree_path.as_deref()?);
        self.turn_items
            .as_ref()?
            .iter()
            .filter(|item| item.run_id.as_ref() == Some(&run.id) && item.status == "running")
            .filter_map(|item| item.activity(checkout))
            .max_by_key(|activity| activity.started_at)
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

impl TurnItem {
    fn activity(&self, checkout: &Path) -> Option<RunActivity> {
        let label = match self.kind.as_str() {
            "command_execution" => command_label(self.input.as_ref()?.as_str()?).into(),
            "file_change" => {
                let relative = file_label(checkout, self.file_name.as_ref()?.as_str()?);
                relative.map_or_else(|| "Editing a file".into(), |file| format!("Editing {file}"))
            }
            _ => return None,
        };
        let started_at = self
            .started_at
            .as_ref()
            .and_then(Value::as_str)
            .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
            .and_then(|value| u64::try_from(value.unix_timestamp_nanos() / 1_000_000).ok());
        Some(RunActivity { label, started_at })
    }
}

fn command_label(input: &str) -> &'static str {
    // Match known invocations without exposing raw arguments or shell input.
    let mut words = shlex::Shlex::new(input);
    let Some(program) = words.next() else {
        return "Running a command";
    };
    let option = words.next();
    let program = executable(&program);
    if matches!(program, "sh" | "bash" | "zsh")
        && matches!(option.as_deref(), Some("-c" | "-lc" | "-cl"))
        && let Some(script) = words.next()
    {
        let mut command = shlex::Shlex::new(&script);
        let program = command.next().unwrap_or_default();
        let option = command.next();
        let argument = command.next();
        return invocation_label(executable(&program), option.as_deref(), argument.as_deref());
    }
    invocation_label(program, option.as_deref(), words.next().as_deref())
}

fn executable(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or_default()
}

fn invocation_label(program: &str, option: Option<&str>, argument: Option<&str>) -> &'static str {
    match (program, option, argument) {
        ("cargo", Some("test" | "nextest"), _) | ("effigy", Some("engine:nextest"), _) => {
            "Running Rust tests"
        }
        ("cargo", Some("check"), _) | ("effigy", Some("engine:check"), _) => "Checking Rust code",
        ("cargo", Some("clippy"), _) | ("effigy", Some("engine:clippy"), _) => "Linting Rust code",
        ("effigy", Some(selector), _) if selector == "test" || selector.starts_with("test:") => {
            "Running tests"
        }
        ("bun" | "npm" | "pnpm", Some("test"), _)
        | ("pytest", _, _)
        | ("python" | "python3", Some("-m"), Some("pytest")) => "Running tests",
        ("effigy", Some("qa:docs"), _) => "Checking documentation",
        ("effigy", Some("check"), _) => "Checking the project",
        ("git", Some("diff"), _) => "Inspecting changes",
        ("git", Some("status"), _) => "Checking the worktree",
        _ => "Running a command",
    }
}

#[cfg(test)]
#[test]
fn wrapped_effigy_selectors_get_friendly_labels() {
    for (command, label) in [
        (
            "zsh -lc 'effigy engine:nextest -- -p nucleus-hosts'",
            "Running Rust tests",
        ),
        ("bash -c \"effigy check\"", "Checking the project"),
        ("sh -lc 'effigy test:integration'", "Running tests"),
        ("effigy test:affected --run", "Running tests"),
        ("effigy qa:docs", "Checking documentation"),
        (
            "zsh -lc 'unknown --token fixture-secret'",
            "Running a command",
        ),
        ("zsh -lc 'cargo test", "Running a command"),
    ] {
        assert_eq!(command_label(command), label);
    }
}

fn file_label(checkout: &Path, file: &str) -> Option<String> {
    static REDACTOR: LazyLock<Redactor> =
        LazyLock::new(|| Redactor::new([], RedactionRules::common()));
    let path = Path::new(file);
    let relative = if path.is_absolute() {
        path.strip_prefix(checkout).ok()?
    } else {
        path
    };
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || file.chars().any(char::is_control)
    {
        return None;
    }
    let redacted = REDACTOR.redact(relative.to_str()?);
    Some(redacted.text.chars().take(120).collect())
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
