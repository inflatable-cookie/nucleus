//! Live Codex adapter: spawns `codex app-server --stdio` and drives its
//! JSON-RPC protocol behind the shared [`AgentSessionRuntime`] boundary.
//!
//! Wire protocol, process lifecycle, and turn-event handling live here.
//! Tool-call semantics stay host-side: the host's handler receives each
//! dynamic tool call and returns result text; this driver only wraps it in
//! the Codex response envelope.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use nucleus_agent_protocol::{
    AgentLiveSession, AgentModelOption, AgentReasoningOption, AgentSessionRuntime,
    AgentSessionStartRequest, AgentStartedSessionInfo, AgentToolCall, AgentToolCallHandler,
    AgentTurnReply, AgentTurnRequest,
};
use serde_json::{json, Value};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

/// The Codex app-server runtime.
pub struct CodexSessionRuntime;

pub const CODEX_LIVE_ADAPTER_ID: &str = "codex-app-server";

impl AgentSessionRuntime for CodexSessionRuntime {
    fn adapter_id(&self) -> &str {
        CODEX_LIVE_ADAPTER_ID
    }

    fn start_session(
        &self,
        request: AgentSessionStartRequest,
    ) -> Result<Box<dyn AgentLiveSession + Send>, String> {
        let (child, mut rpc) = initialized_app_server()?;
        let response = if let Some(thread_id) = &request.resume_provider_thread_id {
            rpc.request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "cwd": request.working_directory,
                    "model": request.model,
                    "config": { "model_reasoning_effort": request.reasoning_effort },
                    "developerInstructions": request.developer_instructions,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "dynamicTools": request.dynamic_tools
                }),
                REQUEST_TIMEOUT,
            )?
        } else {
            rpc.request(
                "thread/start",
                json!({
                    "cwd": request.working_directory,
                    "model": request.model,
                    "config": { "model_reasoning_effort": request.reasoning_effort },
                    "developerInstructions": request.developer_instructions,
                    "allowProviderModelFallback": false,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "ephemeral": false,
                    "dynamicTools": request.dynamic_tools
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
        if let Some(expected) = &request.resume_provider_thread_id {
            if &thread_id != expected {
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

        Ok(Box::new(CodexLiveSession {
            info: AgentStartedSessionInfo {
                provider_thread_id: thread_id,
                model,
                reasoning_effort,
            },
            child,
            rpc,
        }))
    }

    fn model_catalog(&self) -> Result<Vec<AgentModelOption>, String> {
        let (mut child, mut rpc) = initialized_app_server()?;
        let response = rpc.request(
            "model/list",
            json!({ "limit": 100, "includeHidden": false }),
            REQUEST_TIMEOUT,
        );
        let _ = child.kill();
        let _ = child.wait();
        parse_model_catalog(&response?)
    }
}

struct CodexLiveSession {
    info: AgentStartedSessionInfo,
    child: Child,
    rpc: CodexAppServerRpc,
}

impl AgentLiveSession for CodexLiveSession {
    fn info(&self) -> &AgentStartedSessionInfo {
        &self.info
    }

    fn send_turn(
        &mut self,
        request: AgentTurnRequest,
        on_tool_call: &mut AgentToolCallHandler<'_>,
    ) -> Result<AgentTurnReply, String> {
        let response = self.rpc.request(
            "turn/start",
            json!({
                "threadId": self.info.provider_thread_id,
                "model": request.model,
                "effort": request.reasoning_effort,
                "approvalPolicy": "never",
                "sandboxPolicy": { "type": "readOnly" },
                "input": [{ "type": "text", "text": request.message }]
            }),
            REQUEST_TIMEOUT,
        )?;
        let turn_id = response
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex turn/start response did not include a turn id".to_owned())?
            .to_owned();
        let assistant_message = self.rpc.wait_for_turn(&turn_id, TURN_TIMEOUT, on_tool_call)?;
        self.info.model = request.model;
        self.info.reasoning_effort = Some(request.reasoning_effort);
        Ok(AgentTurnReply {
            turn_id,
            assistant_message,
        })
    }
}

impl Drop for CodexLiveSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn initialized_app_server() -> Result<(Child, CodexAppServerRpc), String> {
    let mut child = Command::new("codex")
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start codex app-server: {error}"))?;
    let mut rpc = CodexAppServerRpc::from_child(&mut child)?;
    rpc.request(
        "initialize",
        json!({
            "clientInfo": { "name": "nucleus", "title": "Nucleus", "version": "0.0.0" }
        }),
        REQUEST_TIMEOUT,
    )?;
    rpc.notify("initialized", None)?;
    Ok((child, rpc))
}

fn parse_model_catalog(value: &Value) -> Result<Vec<AgentModelOption>, String> {
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex model/list response did not include model data".to_owned())?;

    let models = data
        .iter()
        .filter(|model| {
            !model
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|model| {
            let model_id = model.get("model")?.as_str()?.to_owned();
            let supported_reasoning_efforts = model
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    Some(AgentReasoningOption {
                        reasoning_effort: effort.get("reasoningEffort")?.as_str()?.to_owned(),
                        description: effort
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    })
                })
                .collect();
            Some(AgentModelOption {
                model: model_id.clone(),
                display_name: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(&model_id)
                    .to_owned(),
                description: model
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                default_reasoning_effort: model
                    .get("defaultReasoningEffort")
                    .and_then(Value::as_str)
                    .unwrap_or("low")
                    .to_owned(),
                supported_reasoning_efforts,
            })
        })
        .collect::<Vec<_>>();

    if models.is_empty() {
        return Err("Codex model/list response did not include visible models".to_owned());
    }
    Ok(models)
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
            if self.reject_unknown_server_request(&value)? {
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

    fn wait_for_turn(
        &mut self,
        turn_id: &str,
        timeout: Duration,
        on_tool_call: &mut AgentToolCallHandler<'_>,
    ) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        let mut assistant_message = String::new();
        let mut completed_assistant_message = None;
        loop {
            let value = self.read_until(deadline, "Codex turn completion")?;
            if self.handle_turn_server_message(&value, turn_id, on_tool_call)? {
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
                        Ok(message)
                    };
                }
                _ => {}
            }
        }
    }

    /// Handle a server-initiated request during a turn: dynamic tool calls
    /// route to the host handler; anything else gets method-not-found.
    fn handle_turn_server_message(
        &mut self,
        value: &Value,
        active_turn_id: &str,
        on_tool_call: &mut AgentToolCallHandler<'_>,
    ) -> Result<bool, String> {
        if value.get("method").and_then(Value::as_str) == Some("item/tool/call") {
            if let Some(id) = value.get("id").cloned() {
                let params = value.get("params").cloned().unwrap_or(Value::Null);
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let call_id = params
                    .get("callId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let tool = params
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let outcome = if turn_id != active_turn_id {
                    Err("dynamic tool call belongs to another turn".to_owned())
                } else if call_id.is_empty() {
                    Err("dynamic tool call did not include a call id".to_owned())
                } else {
                    on_tool_call(AgentToolCall {
                        tool,
                        turn_id,
                        call_id,
                        arguments: params.get("arguments").cloned().unwrap_or(Value::Null),
                    })
                };
                let (success, text) = match outcome {
                    Ok(text) => (true, text),
                    Err(error) => (false, error),
                };
                self.write(&json!({
                    "id": id,
                    "result": {
                        "success": success,
                        "contentItems": [{ "type": "inputText", "text": text }]
                    }
                }))?;
                return Ok(true);
            }
        }
        self.reject_unknown_server_request(value)
    }

    fn reject_unknown_server_request(&mut self, value: &Value) -> Result<bool, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_catalog_parses_visible_models_with_reasoning_options() {
        let value = json!({
            "data": [
                {
                    "model": "gpt-5.4",
                    "displayName": "GPT-5.4",
                    "description": "Flagship",
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "fast" },
                        { "reasoningEffort": "high", "description": "deep" }
                    ]
                },
                { "model": "hidden-model", "hidden": true }
            ]
        });
        let catalog = parse_model_catalog(&value).expect("catalog");

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].model, "gpt-5.4");
        assert_eq!(catalog[0].supported_reasoning_efforts.len(), 2);
    }

    #[test]
    fn empty_or_hidden_catalog_is_an_error() {
        assert!(parse_model_catalog(&json!({ "data": [] })).is_err());
    }
}
