use std::{
    path::{Component, Path},
    sync::LazyLock,
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::RunState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    Binding, HostError, ProviderLimit, RowObservation, task_row::ThreadVisibility,
    thread_snapshots::ShellCustody,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum MissingReceipt {
    Fresh,
    LegacyContinuation,
    Queue,
}

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
    turn_items: Option<Vec<TurnItem>>,
    #[serde(skip)]
    windowed: bool,
    #[serde(skip)]
    compact_turn_items: bool,
    #[serde(skip)]
    sequence: u64,
    /// Set when the projection comes from a closed shell row: whether that
    /// row still shows work.
    #[serde(skip)]
    closed_row_busy: Option<bool>,
    #[serde(skip)]
    shell_failure: Option<ShellFailure>,
}

struct ShellFailure {
    run: String,
    limited: bool,
    reset_at_ms: Option<u64>,
}

fn subscription_limit(class: &str, message: Option<&str>) -> bool {
    if class == "usage_limit" {
        return true;
    }
    let Some((status, body)) = message.and_then(|text| text.split_once(':')) else {
        return false;
    };
    if class != "provider_error" {
        return false;
    }
    match status {
        "402" => true,
        "429" if body.len() <= 8192 => {
            let Ok(reply) = serde_json::from_str::<Value>(body) else {
                return false;
            };
            let error = reply.get("error").unwrap_or(&reply);
            ["code", "type"].iter().any(|key| {
                matches!(
                    error[*key].as_str(),
                    Some("usage_limit" | "insufficient_quota" | "quota_exceeded")
                )
            })
        }
        _ => false,
    }
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
    updated_at: Option<String>,
    parent_thread_id: Option<String>,
    lineage: Option<Lineage>,
    provider_instance_id: Option<String>,
    active_provider_thread_id: Option<String>,
    last_snooze_wake_at: Option<String>,
    model_selection: Option<Value>,
    #[serde(flatten)]
    visibility: ThreadVisibility,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lineage {
    parent_thread_id: Option<String>,
    relationship_to_parent: Option<String>,
    root_thread_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: String,
    status: Status,
    user_message_id: Option<String>,
    root_node_id: Option<String>,
    provider_instance_id: Option<String>,
    model_selection: Option<RunSelection>,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunSelection {
    instance_id: String,
    model: String,
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
struct TurnItem {
    #[serde(rename = "type")]
    kind: String,
    status: String,
    run_id: Option<String>,
    node_id: Option<String>,
    id: Option<String>,
    ordinal: Option<u64>,
    updated_at: Option<String>,
    failure: Option<Value>,
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

fn timestamp_ms(value: Option<&str>) -> Option<u64> {
    let time = OffsetDateTime::parse(value?, &Rfc3339).ok()?;
    u64::try_from(time.unix_timestamp_nanos() / 1_000_000).ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
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
    pub(crate) fn closed(
        row: &Value,
        sequence: Option<u64>,
        binding: &Binding,
        id: &str,
    ) -> Result<Self, HostError> {
        let shell = ShellCustody(row);
        let live = row["deletedAt"].is_null();
        let quiet = shell.activity() == crate::RowChildren::Quiet;
        let runs = match (row["latestRunId"].as_str(), row["status"].as_str()) {
            (
                Some(run),
                Some(
                    status @ ("completed" | "interrupted" | "failed" | "cancelled" | "rolled_back"),
                ),
            ) if live && quiet => json!([{"id":run,"status":status}]),
            _ => json!([]),
        };
        let mut projection = Self::parse(
            json!({
                "snapshotSequence": sequence.unwrap_or_default(),
                "projection": {"thread": row, "runs": runs, "messages": [], "runtimeRequests": []}
            }),
            binding,
            id,
        )?;
        projection.closed_row_busy = Some(live && !quiet);
        projection.windowed = true;
        Ok(projection)
    }

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
        projection.windowed = has_more_history == Some(true);
        projection.compact_turn_items = turn_items_omit_local_visible == Some(true);
        projection.sequence = sequence;
        Ok(projection)
    }

    pub(crate) fn require_parent_provider(&self, instance: &str) -> Result<(), HostError> {
        if self.parent_binding(instance) != [true; 3] {
            return Err(HostError::Binding);
        }
        Ok(())
    }

    pub(crate) fn parent_binding(&self, instance: &str) -> [bool; 3] {
        [
            self.thread.parent_thread_id.is_none()
                && self
                    .thread
                    .lineage
                    .as_ref()
                    .is_none_or(|lineage| lineage.parent_thread_id.is_none()),
            self.thread.provider_instance_id.as_deref() == Some(instance),
            self.thread.model_selection.as_ref().is_some_and(|model| {
                model["instanceId"] == instance && model["model"] == "nucleus"
            }),
        ]
    }

    pub(crate) fn belongs_to_parent(&self, parent: &str, in_parent_roster: bool) -> bool {
        if self.thread.deleted_at.is_some() {
            return true;
        }
        let recorded = self.thread.parent_thread_id.as_deref();
        if recorded.is_some_and(|thread| thread != parent) {
            return false;
        }
        self.thread.lineage.as_ref().map_or_else(
            || in_parent_roster || recorded == Some(parent),
            |lineage| {
                lineage.parent_thread_id.as_deref() == Some(parent)
                    && lineage.root_thread_id.as_deref() == Some(parent)
                    && lineage.relationship_to_parent.as_deref() == Some("subagent")
            },
        )
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

    pub(crate) fn live_parent_run(&self, message_id: &str) -> Option<(&str, &str)> {
        if self.archived() || self.thread.deleted_at.is_some() {
            return None;
        }
        let mut live = self
            .runs
            .iter()
            .filter(|run| matches!(run.status, Status::Running | Status::Waiting));
        let run = live.next()?;
        if live.next().is_some() || run.user_message_id.as_deref() != Some(message_id) {
            return None;
        }
        Some((
            &run.id,
            run.root_node_id
                .as_deref()
                .filter(|node| !node.is_empty())?,
        ))
    }

    pub(crate) fn active_run(&self, id: &str) -> bool {
        !self.archived()
            && self.thread.deleted_at.is_none()
            && self
                .runs
                .iter()
                .any(|run| run.id == id && matches!(run.status, Status::Running | Status::Waiting))
    }

    pub(crate) fn terminal_run(&self, id: &str) -> bool {
        self.runs.iter().any(|run| {
            run.id == id
                && matches!(
                    run.status,
                    Status::Completed
                        | Status::Failed
                        | Status::Interrupted
                        | Status::Cancelled
                        | Status::RolledBack
                )
        })
    }

    pub(crate) const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) fn matches_shell_revision(&self, row: &Value) -> bool {
        row["updatedAt"].as_str() == self.thread.updated_at.as_deref()
            && row["projectId"] == self.thread.project_id
            && row["worktreePath"].as_str() == self.thread.worktree_path.as_deref()
            && row["branch"].as_str() == self.thread.branch.as_deref()
            && row["providerInstanceId"].as_str() == self.thread.provider_instance_id.as_deref()
    }

    pub(crate) fn use_shell_failure(&mut self, row: &Value, same_revision: bool) {
        let shell = ShellCustody(row);
        // The shell retains the failed run's root error when a compact
        // projection omits it. Match the same custody revision and run.
        if (self.windowed || self.compact_turn_items)
            && (same_revision
                || self
                    .thread
                    .updated_at
                    .as_deref()
                    .is_some_and(|updated| row["updatedAt"] == updated))
            && row["id"] == self.thread.id
            && row["projectId"] == self.thread.project_id
            && row["worktreePath"].as_str() == self.thread.worktree_path.as_deref()
            && row["branch"].as_str() == self.thread.branch.as_deref()
            && row["providerInstanceId"].as_str() == self.thread.provider_instance_id.as_deref()
            && row["activeProviderThreadId"].as_str()
                == self.thread.active_provider_thread_id.as_deref()
            && row["archivedAt"].as_str() == self.thread.archived_at.as_deref()
            && row["deletedAt"].as_str() == self.thread.deleted_at.as_deref()
            && !shell.has_active_turn()
            && matches!(
                row["status"].as_str(),
                Some("completed" | "failed" | "interrupted" | "cancelled")
            )
            && row["latestRunId"]
                .as_str()
                .is_some_and(|id| self.terminal_run(id))
        {
            // T3 selects the last failed error on the presented run's root node
            // for this shell row, including when the compact thread omits it.
            if row["status"] == "failed"
                && let (Some(run), Some(class)) =
                    (row["latestRunId"].as_str(), row["lastErrorClass"].as_str())
            {
                self.shell_failure = Some(ShellFailure {
                    run: run.into(),
                    limited: subscription_limit(class, row["lastError"].as_str()),
                    reset_at_ms: timestamp_ms(row["usageLimitResetAt"].as_str()),
                });
            }
        }
    }

    pub(crate) fn run(
        &self,
        message_id: &str,
        missing_receipt: MissingReceipt,
        quiet: impl FnOnce() -> bool,
    ) -> Result<RunState, HostError> {
        if self.closed_row_busy == Some(true) {
            return Err(HostError::Uncertain);
        }
        if self.closed_row_busy.is_some() || self.thread.deleted_at.is_some() {
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
            // T3 deduplicates the frozen queue command even when history is paged.
            if missing_receipt != MissingReceipt::Queue
                && ((self.windowed && missing_receipt == MissingReceipt::Fresh) || !quiet())
            {
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

    pub(crate) fn has_exact_run(&self, message_id: &str) -> bool {
        self.runs
            .iter()
            .any(|run| run.user_message_id.as_deref() == Some(message_id))
    }

    pub(crate) fn last_snooze_wake_ms(&self) -> Option<u64> {
        crate::task_row::timestamp_ms(self.thread.last_snooze_wake_at.as_deref()?).ok()
    }

    pub(crate) fn has_delivery(&self, message_id: &str) -> bool {
        let (message, run) = self.delivery(message_id);
        message.is_some() || run.is_some()
    }

    pub(crate) fn row_observation(&self) -> Result<Option<RowObservation>, HostError> {
        if self.archived() || self.thread.deleted_at.is_some() {
            return Ok(None);
        }
        Ok(Some(RowObservation {
            sequence: self.sequence(),
            visibility: self.thread.visibility.read()?,
        }))
    }

    pub(crate) const fn archived(&self) -> bool {
        self.thread.archived_at.is_some()
    }

    pub(crate) const fn deleted(&self) -> bool {
        self.thread.deleted_at.is_some()
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

    pub(crate) fn rejected_assignment(&self, message_id: &str) -> bool {
        if self.windowed {
            return false;
        }
        self.delivery(message_id).1.is_some_and(|run| {
            run.user_message_id.as_deref() == Some(message_id)
                && matches!(run.status, Status::Failed)
                && self
                    .turn_items
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .any(|item| {
                        item.run_id.as_ref() == Some(&run.id)
                            && item.kind == "error"
                            && item.failure.as_ref().is_some_and(|failure| {
                                failure["class"] == "validation_error"
                                    && failure["message"].as_str().is_some_and(|message| {
                                        message.starts_with(
                                    "Message exceeds 120,000 characters after expanding quotes"
                                )
                                    })
                            })
                    })
        })
    }

    pub(crate) fn run_routing(&self, message_id: &str) -> Option<crate::RunRouting> {
        let run = self.delivery(message_id).1?;
        if run.user_message_id.as_deref() != Some(message_id) || run.started_at.is_none() {
            return None;
        }
        let selected = run.model_selection.as_ref()?;
        let provider = run.provider_instance_id.as_ref()?;
        (provider == &selected.instance_id && !provider.is_empty() && !selected.model.is_empty())
            .then(|| crate::RunRouting {
                provider: provider.clone(),
                model: selected.model.clone(),
            })
    }

    pub(crate) fn provider_limit(&self, message_id: &str) -> Option<ProviderLimit> {
        if self.thread.deleted_at.is_some() {
            return None;
        }
        let run = self.delivery(message_id).1.filter(|run| {
            run.user_message_id.as_deref() == Some(message_id) && run.status == Status::Failed
        })?;
        let root = run
            .root_node_id
            .as_deref()
            .filter(|node| !node.is_empty())?;
        let (reset_at_ms, ended_at_ms) =
            if let Some(shell) = self.shell_failure.as_ref().filter(|f| f.run == run.id) {
                if !shell.limited {
                    return None;
                }
                (
                    shell.reset_at_ms,
                    timestamp_ms(run.completed_at.as_deref())?,
                )
            } else {
                let terminal = self
                    .turn_items
                    .as_ref()?
                    .iter()
                    .filter(|item| {
                        item.kind == "error"
                            && item.status == "failed"
                            && item.run_id.as_ref() == Some(&run.id)
                            && item.node_id.as_deref() == Some(root)
                    })
                    .max_by_key(|item| (&item.updated_at, item.ordinal, &item.id))?;
                let failure = terminal.failure.as_ref()?;
                if !subscription_limit(failure["class"].as_str()?, failure["message"].as_str()) {
                    return None;
                }
                (
                    timestamp_ms(failure["resetAt"].as_str()),
                    timestamp_ms(run.completed_at.as_deref())
                        .or_else(|| timestamp_ms(terminal.updated_at.as_deref()))?,
                )
            };
        Some(ProviderLimit {
            instance: run
                .provider_instance_id
                .as_ref()
                .filter(|id| !id.is_empty())?
                .clone(),
            ended_at_ms,
            reset_at_ms,
        })
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
        let run = self
            .runs
            .iter()
            .find(|run| run.user_message_id.as_deref() == Some(id))
            .or_else(|| {
                self.runs
                    .iter()
                    .find(|run| linked_id == Some(run.id.as_str()))
            });
        (message, run)
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
        let started_at = timestamp_ms(self.started_at.as_ref().and_then(Value::as_str));
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
