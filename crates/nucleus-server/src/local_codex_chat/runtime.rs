use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

mod tool_calls;

use super::persistence::StoredChatSession;
use super::task_authoring::{TaskAuthoringReceipt, TaskToolOutcome};
use super::task_ledger::dynamic_tool_spec as task_ledger_spec;
use super::task_workflow::{dynamic_tool_spec as task_workflow_spec, TaskWorkflowReceipt};
use super::{
    LocalCodexChatReply, CHAT_ADAPTER_ID, CHAT_MODEL, CHAT_PROVIDER_INSTANCE_ID,
    CHAT_REASONING_EFFORT, CHAT_TASK_TOOLSET_VERSION,
};
use tool_calls::{consolidate_task_receipts, prepare_tool_call_response};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(180);
const TASK_TOOL_INSTRUCTIONS: &str = "You are operating inside Nucleus. You have exactly two Nucleus portals. task_ledger inspects, creates, and updates durable Goals and tasks; use inspect before updates and fill every inferable field. task_workflow inspects or runs exactly one task or one Goal snapshot. Call task_workflow run only when the current operator message explicitly authorizes execution; copy an exact authorizing excerpt, cite the current scope revision, and supply a stable idempotency key. Selection and readiness are not authority. Never invent task arrays, project sweeps, lifecycle transitions, delegation stages, or dispatch stages. Provider completion does not accept review, complete tasks, achieve Goals, or publish SCM changes. The portals are independent of the chat thread's read-only repository sandbox.";

pub(super) struct LocalCodexChatSession {
    session_id: String,
    thread_id: String,
    model: String,
    reasoning_effort: Option<String>,
    child: Child,
    rpc: CodexAppServerRpc,
}

impl LocalCodexChatSession {
    pub(super) fn stored_session(
        &self,
        conversation_id: String,
        project_id: String,
        turn_count: u64,
    ) -> StoredChatSession {
        StoredChatSession {
            conversation_id,
            project_id,
            session_id: self.session_id.clone(),
            provider_thread_id: self.thread_id.clone(),
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            adapter_id: CHAT_ADAPTER_ID.to_owned(),
            provider_instance_id: CHAT_PROVIDER_INSTANCE_ID.to_owned(),
            turn_count,
            task_toolset_version: CHAT_TASK_TOOLSET_VERSION,
        }
    }

    pub(super) fn start(
        conversation_id: &str,
        project_root: &str,
        stored: Option<&StoredChatSession>,
        migration_context: Option<&str>,
    ) -> Result<Self, String> {
        let mut child = Command::new("codex")
            .arg("app-server")
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("failed to start Codex app-server: {error}"))?;
        let mut rpc = CodexAppServerRpc::from_child(&mut child)?;

        rpc.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "nucleus-desktop",
                    "title": "Nucleus Desktop",
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

        let developer_instructions = migration_context.map_or_else(
            || TASK_TOOL_INSTRUCTIONS.to_owned(),
            |context| {
                format!(
                    "{TASK_TOOL_INSTRUCTIONS}\n\nThis Nucleus conversation moved to a tool-enabled provider thread. Use this prior transcript as context:\n\n{context}"
                )
            },
        );
        let can_resume =
            stored.is_some_and(|session| session.task_toolset_version >= CHAT_TASK_TOOLSET_VERSION);
        let response = if can_resume {
            let stored = stored.expect("resume capability requires stored session");
            rpc.request(
                "thread/resume",
                json!({
                    "threadId": stored.provider_thread_id,
                    "cwd": project_root,
                    "model": CHAT_MODEL,
                    "config": { "model_reasoning_effort": CHAT_REASONING_EFFORT },
                    "developerInstructions": developer_instructions,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "dynamicTools": dynamic_tool_specs()
                }),
                REQUEST_TIMEOUT,
            )?
        } else {
            rpc.request(
                "thread/start",
                json!({
                    "cwd": project_root,
                    "model": CHAT_MODEL,
                    "config": { "model_reasoning_effort": CHAT_REASONING_EFFORT },
                    "developerInstructions": developer_instructions,
                    "allowProviderModelFallback": false,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "ephemeral": false,
                    "dynamicTools": dynamic_tool_specs()
                }),
                REQUEST_TIMEOUT,
            )?
        };
        let thread_id = response
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex thread response did not include a thread id".to_owned())?
            .to_owned();
        if can_resume {
            let stored = stored.expect("resume capability requires stored session");
            if thread_id != stored.provider_thread_id {
                return Err("Codex resumed a different provider thread".to_owned());
            }
        }
        let model = response
            .get("model")
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex thread response did not include a model".to_owned())?
            .to_owned();
        let reasoning_effort = response
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_owned);

        Ok(Self {
            session_id: stored
                .map(|stored| stored.session_id.clone())
                .unwrap_or_else(|| format!("session:chat:{conversation_id}")),
            thread_id,
            model,
            reasoning_effort,
            child,
            rpc,
        })
    }

    pub(super) fn send_turn<F>(
        &mut self,
        message: &str,
        task_tool: &mut F,
    ) -> Result<LocalCodexChatReply, String>
    where
        F: FnMut(&str, &str, &str, Value) -> Result<TaskToolOutcome, String>,
    {
        let response = self.rpc.request(
            "turn/start",
            json!({
                "threadId": self.thread_id,
                "approvalPolicy": "never",
                "sandboxPolicy": { "type": "readOnly" },
                "input": [{ "type": "text", "text": message }]
            }),
            REQUEST_TIMEOUT,
        )?;
        let turn_id = response
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex turn/start response did not include a turn id".to_owned())?
            .to_owned();
        let (assistant_message, task_receipts, workflow_receipts) =
            self.rpc.wait_for_turn(&turn_id, TURN_TIMEOUT, task_tool)?;

        Ok(LocalCodexChatReply {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            turn_id,
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            assistant_message,
            task_receipts,
            workflow_receipts,
        })
    }
}

fn dynamic_tool_specs() -> Vec<Value> {
    vec![task_ledger_spec(), task_workflow_spec()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_projects_exactly_the_two_nucleus_portals() {
        let names = dynamic_tool_specs()
            .into_iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["task_ledger", "task_workflow"]);
    }
}

impl Drop for LocalCodexChatSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct CodexAppServerRpc {
    stdin: ChildStdin,
    stdout: Receiver<String>,
    next_id: u64,
}

impl CodexAppServerRpc {
    fn from_child(child: &mut Child) -> Result<Self, String> {
        let stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Codex app-server stderr is unavailable")?;
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
        let request_id = self.next_id;
        self.next_id += 1;
        self.write(&json!({ "id": request_id, "method": method, "params": params }))?;
        let deadline = Instant::now() + timeout;
        loop {
            let value = self.read_until(deadline, "Codex response")?;
            if self.handle_server_message(&value)? {
                continue;
            }
            if value.get("id").and_then(Value::as_u64) != Some(request_id) {
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

    fn wait_for_turn<F>(
        &mut self,
        turn_id: &str,
        timeout: Duration,
        task_tool: &mut F,
    ) -> Result<(String, Vec<TaskAuthoringReceipt>, Vec<TaskWorkflowReceipt>), String>
    where
        F: FnMut(&str, &str, &str, Value) -> Result<TaskToolOutcome, String>,
    {
        let deadline = Instant::now() + timeout;
        let mut assistant_message = String::new();
        let mut completed_assistant_message = None;
        let mut task_receipts = Vec::new();
        let mut workflow_receipts = Vec::new();
        loop {
            let value = self.read_until(deadline, "Codex turn completion")?;
            if self.handle_turn_server_message(
                &value,
                turn_id,
                task_tool,
                &mut task_receipts,
                &mut workflow_receipts,
            )? {
                continue;
            }
            match value.get("method").and_then(Value::as_str) {
                Some("item/agentMessage/delta") => {
                    let params = value.get("params").unwrap_or(&Value::Null);
                    if params.get("turnId").and_then(Value::as_str) == Some(turn_id) {
                        if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                            assistant_message.push_str(delta);
                        }
                    }
                }
                Some("item/completed") => {
                    let params = value.get("params").unwrap_or(&Value::Null);
                    let item = params.get("item").unwrap_or(&Value::Null);
                    if params.get("turnId").and_then(Value::as_str) == Some(turn_id)
                        && item.get("type").and_then(Value::as_str) == Some("agentMessage")
                    {
                        completed_assistant_message =
                            item.get("text").and_then(Value::as_str).map(str::to_owned);
                    }
                }
                Some("turn/completed") => {
                    let turn = value.get("params").and_then(|params| params.get("turn"));
                    if turn.and_then(|turn| turn.get("id")).and_then(Value::as_str) != Some(turn_id)
                    {
                        continue;
                    }
                    let status = turn
                        .and_then(|turn| turn.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("completed");
                    if status != "completed" {
                        return Err(format!("Codex turn ended with status {status}"));
                    }
                    let message = completed_assistant_message
                        .unwrap_or(assistant_message)
                        .trim()
                        .to_owned();
                    return if message.is_empty() {
                        Err("Codex completed the turn without an assistant message".to_owned())
                    } else {
                        let task_receipts = consolidate_task_receipts(task_receipts);
                        Ok((message, task_receipts, workflow_receipts))
                    };
                }
                _ => {}
            }
        }
    }

    fn handle_turn_server_message<F>(
        &mut self,
        value: &Value,
        active_turn_id: &str,
        task_tool: &mut F,
        task_receipts: &mut Vec<TaskAuthoringReceipt>,
        workflow_receipts: &mut Vec<TaskWorkflowReceipt>,
    ) -> Result<bool, String>
    where
        F: FnMut(&str, &str, &str, Value) -> Result<TaskToolOutcome, String>,
    {
        if let Some(outcome) = prepare_tool_call_response(value, active_turn_id, task_tool) {
            let outcome = outcome?;
            if let Some(receipt) = outcome.receipt {
                task_receipts.push(receipt);
            }
            if let Some(receipt) = outcome.workflow_receipt {
                workflow_receipts.push(receipt);
            }
            self.write(&outcome.response)?;
            return Ok(true);
        }
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(id) = value.get("id").cloned() else {
            return Ok(false);
        };
        self.write(&json!({
            "id": id,
            "error": { "code": -32601, "message": format!("Nucleus chat does not handle {method}") }
        }))?;
        Ok(true)
    }

    fn handle_server_message(&mut self, value: &Value) -> Result<bool, String> {
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(id) = value.get("id").cloned() else {
            return Ok(false);
        };
        self.write(&json!({
            "id": id,
            "error": { "code": -32601, "message": format!("Nucleus chat does not yet handle {method}") }
        }))?;
        Ok(true)
    }

    fn read_until(&self, deadline: Instant, label: &str) -> Result<Value, String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| format!("timed out waiting for {label}"))?;
        let line = self
            .stdout
            .recv_timeout(remaining)
            .map_err(|_| format!("timed out waiting for {label}"))?;
        serde_json::from_str(&line).map_err(|_| "Codex app-server emitted invalid JSON".to_owned())
    }

    fn write(&mut self, value: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, value)
            .map_err(|error| format!("failed to encode Codex request: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| format!("failed to write Codex request: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("failed to flush Codex request: {error}"))
    }
}
