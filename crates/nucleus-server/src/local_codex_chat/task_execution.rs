use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::GoalRunRoute;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TASK_TURN_TIMEOUT: Duration = Duration::from_secs(900);

pub(super) struct TaskExecutionRequest<'a> {
    pub project_root: &'a str,
    pub route: &'a GoalRunRoute,
    pub prompt: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TaskExecutionLinkage {
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum TaskExecutionOutcome {
    Completed(TaskExecutionLinkage),
    WaitingForApproval(TaskExecutionLinkage),
    WaitingForUserInput(TaskExecutionLinkage),
    Cancelled {
        linkage: Option<TaskExecutionLinkage>,
        reason: String,
    },
    Failed {
        linkage: Option<TaskExecutionLinkage>,
        reason: String,
    },
    RecoveryRequired {
        linkage: Option<TaskExecutionLinkage>,
        reason: String,
    },
}

pub(super) fn run_task<F>(
    request: TaskExecutionRequest<'_>,
    mut on_started: F,
) -> Result<TaskExecutionOutcome, String>
where
    F: FnMut(&TaskExecutionLinkage) -> Result<(), String>,
{
    let mut child = spawn_codex()?;
    let outcome = run_with_child(&mut child, request, &mut on_started);
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

fn run_with_child<F>(
    child: &mut Child,
    request: TaskExecutionRequest<'_>,
    on_started: &mut F,
) -> Result<TaskExecutionOutcome, String>
where
    F: FnMut(&TaskExecutionLinkage) -> Result<(), String>,
{
    let mut rpc = TaskRpc::from_child(child)?;
    rpc.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "nucleus-task-workflow",
                "title": "Nucleus Task Workflow",
                "version": "0.0.0"
            },
            "capabilities": {
                "experimentalApi": true,
                "optOutNotificationMethods": null
            }
        }),
        REQUEST_TIMEOUT,
    )?;
    rpc.notify("initialized", None)?;
    let thread = rpc.request(
        "thread/start",
        json!({
            "cwd": request.project_root,
            "model": request.route.model,
            "config": {
                "model_reasoning_effort": request.route.reasoning_effort
            },
            "developerInstructions": "Execute only the supplied Nucleus task. Work inside the project workspace. Do not mutate Nucleus task, Goal, review, mandate, or SCM publication state. Stop when a stated stop condition applies. Do not request broader scope.",
            "approvalPolicy": "never",
            "sandbox": "workspace-write",
            "ephemeral": false
        }),
        REQUEST_TIMEOUT,
    )?;
    let thread_id = string_path(&thread, &["thread", "id"], "thread id")?;
    let session_id = format!("task-session:{thread_id}");
    let turn = rpc.request(
        "turn/start",
        json!({
            "threadId": thread_id,
            "approvalPolicy": "never",
            "sandboxPolicy": {
                "type": "workspaceWrite",
                "writableRoots": [request.project_root],
                "networkAccess": false
            },
            "input": [{ "type": "text", "text": request.prompt }]
        }),
        REQUEST_TIMEOUT,
    )?;
    let turn_id = string_path(&turn, &["turn", "id"], "turn id")?;
    let linkage = TaskExecutionLinkage {
        session_id,
        thread_id,
        turn_id,
    };
    on_started(&linkage)?;
    rpc.wait_for_turn(&linkage, TASK_TURN_TIMEOUT)
}

fn spawn_codex() -> Result<Child, String> {
    Command::new("codex")
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start task Codex app-server: {error}"))
}

struct TaskRpc {
    stdin: ChildStdin,
    stdout: Receiver<String>,
    next_id: u64,
}

impl TaskRpc {
    fn from_child(child: &mut Child) -> Result<Self, String> {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "task Codex stdin is unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "task Codex stdout is unavailable".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "task Codex stderr is unavailable".to_owned())?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                if line.is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            stdin,
            stdout: receiver,
            next_id: 1,
        })
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({ "id": id, "method": method, "params": params }))?;
        let deadline = Instant::now() + timeout;
        loop {
            let value = self.read(deadline, "Codex response")?;
            if value.get("method").is_some() {
                if value.get("id").is_some() {
                    self.reject_unexpected_request(&value)?;
                }
                continue;
            }
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(format!("Codex {method} request failed: {error}"));
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| format!("Codex {method} response did not include a result"));
        }
    }

    fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut value = json!({ "method": method });
        if let Some(params) = params {
            value["params"] = params;
        }
        self.write(&value)
    }

    fn wait_for_turn(
        &mut self,
        linkage: &TaskExecutionLinkage,
        timeout: Duration,
    ) -> Result<TaskExecutionOutcome, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let value = match self.read(deadline, "task turn completion") {
                Ok(value) => value,
                Err(error) => {
                    return Ok(TaskExecutionOutcome::RecoveryRequired {
                        linkage: Some(linkage.clone()),
                        reason: error,
                    })
                }
            };
            if let Some(method) = value.get("method").and_then(Value::as_str) {
                if value.get("id").is_some() {
                    if method == "item/tool/requestUserInput" {
                        return Ok(TaskExecutionOutcome::WaitingForUserInput(linkage.clone()));
                    }
                    if is_approval_request(method) {
                        return Ok(TaskExecutionOutcome::WaitingForApproval(linkage.clone()));
                    }
                    self.reject_unexpected_request(&value)?;
                    continue;
                }
                if method != "turn/completed" {
                    continue;
                }
                let turn = value.get("params").and_then(|params| params.get("turn"));
                if turn.and_then(|turn| turn.get("id")).and_then(Value::as_str)
                    != Some(linkage.turn_id.as_str())
                {
                    continue;
                }
                let status = turn
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                return Ok(match status {
                    "completed" => TaskExecutionOutcome::Completed(linkage.clone()),
                    "cancelled" | "canceled" => TaskExecutionOutcome::Cancelled {
                        linkage: Some(linkage.clone()),
                        reason: "Codex task turn was cancelled.".to_owned(),
                    },
                    _ => TaskExecutionOutcome::Failed {
                        linkage: Some(linkage.clone()),
                        reason: format!("Codex task turn ended with status {status}"),
                    },
                });
            }
        }
    }

    fn reject_unexpected_request(&mut self, request: &Value) -> Result<(), String> {
        let id = request
            .get("id")
            .cloned()
            .ok_or_else(|| "Codex server request did not include an id".to_owned())?;
        self.write(&json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": "Nucleus task workflow does not handle this request"
            }
        }))
    }

    fn read(&self, deadline: Instant, label: &str) -> Result<Value, String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| format!("timed out waiting for {label}"))?;
        let line = self
            .stdout
            .recv_timeout(remaining)
            .map_err(|_| format!("timed out waiting for {label}"))?;
        serde_json::from_str(&line)
            .map_err(|_| "task Codex app-server emitted invalid JSON".to_owned())
    }

    fn write(&mut self, value: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, value)
            .map_err(|error| format!("failed to encode task Codex request: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| format!("failed to write task Codex request: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("failed to flush task Codex request: {error}"))
    }
}

fn is_approval_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "applyPatchApproval"
            | "execCommandApproval"
    )
}

fn string_path(value: &Value, path: &[&str], label: &str) -> Result<String, String> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key).ok_or(()))
        .ok()
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Codex response did not include {label}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_methods_are_kept_distinct_from_user_input() {
        assert!(is_approval_request("item/commandExecution/requestApproval"));
        assert!(is_approval_request("item/fileChange/requestApproval"));
        assert!(!is_approval_request("item/tool/requestUserInput"));
    }
}
