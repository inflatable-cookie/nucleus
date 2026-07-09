//! First local Codex-backed product chat runtime.
//!
//! The service owns the provider process and thread while the desktop is open.
//! Durable Nucleus conversation projection and restart recovery are separate
//! follow-on work.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use nucleus_core::PersistenceRecordId;
use nucleus_local_store::LocalStoreBackend;
use nucleus_projects::decode_project_storage_record;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ServerStateService;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatRequest {
    pub conversation_id: String,
    pub project_id: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalCodexChatReply {
    pub session_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub model: String,
    pub assistant_message: String,
}

#[derive(Default)]
pub struct LocalCodexChatService {
    sessions: HashMap<String, LocalCodexChatSession>,
}

impl LocalCodexChatService {
    pub fn send_message<B>(
        &mut self,
        state: &ServerStateService<B>,
        request: LocalCodexChatRequest,
    ) -> Result<LocalCodexChatReply, String>
    where
        B: LocalStoreBackend,
    {
        let message = request.message.trim();
        if message.is_empty() {
            return Err("chat message must not be empty".to_owned());
        }

        let project_root = project_root(state, &request.project_id)?;
        let session = match self.sessions.entry(request.conversation_id.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                LocalCodexChatSession::start(&request.conversation_id, &project_root)?,
            ),
        };

        session.send_turn(message)
    }
}

fn project_root<B>(state: &ServerStateService<B>, project_id: &str) -> Result<String, String>
where
    B: LocalStoreBackend,
{
    let record = state
        .projects()
        .get(&PersistenceRecordId(project_id.to_owned()))
        .map_err(|error| format!("project lookup failed: {error:?}"))?
        .ok_or_else(|| format!("project not found: {project_id}"))?;
    let project = decode_project_storage_record(&record.payload.bytes)
        .map_err(|error| format!("project record decode failed: {}", error.reason))?;
    let path = project
        .primary_location
        .ok_or_else(|| "project has no local repository location".to_owned())?;
    let canonical = std::fs::canonicalize(&path)
        .map_err(|error| format!("project repository is unavailable: {error}"))?;

    Ok(canonical.to_string_lossy().into_owned())
}

struct LocalCodexChatSession {
    session_id: String,
    thread_id: String,
    model: String,
    child: Child,
    rpc: CodexAppServerRpc,
}

impl LocalCodexChatSession {
    fn start(conversation_id: &str, project_root: &str) -> Result<Self, String> {
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

        let response = rpc.request(
            "thread/start",
            json!({
                "cwd": project_root,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "ephemeral": false
            }),
            REQUEST_TIMEOUT,
        )?;
        let thread_id = response
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex thread/start response did not include a thread id".to_owned())?
            .to_owned();
        let model = response
            .get("model")
            .and_then(Value::as_str)
            .ok_or_else(|| "Codex thread/start response did not include a model".to_owned())?
            .to_owned();

        Ok(Self {
            session_id: format!("session:chat:{conversation_id}"),
            thread_id,
            model,
            child,
            rpc,
        })
    }

    fn send_turn(&mut self, message: &str) -> Result<LocalCodexChatReply, String> {
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
        let assistant_message = self.rpc.wait_for_turn(&turn_id, TURN_TIMEOUT)?;

        Ok(LocalCodexChatReply {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            turn_id,
            model: self.model.clone(),
            assistant_message,
        })
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
            .ok_or_else(|| "Codex app-server stdin is unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server stdout is unavailable".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Codex app-server stderr is unavailable".to_owned())?;
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

    fn wait_for_turn(&mut self, turn_id: &str, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        let mut assistant_message = String::new();
        let mut completed_assistant_message = None;

        loop {
            let value = self.read_until(deadline, "Codex turn completion")?;
            if self.handle_server_message(&value)? {
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

    fn handle_server_message(&mut self, value: &Value) -> Result<bool, String> {
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(id) = value.get("id").cloned() else {
            return Ok(false);
        };

        self.write(&json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("Nucleus chat does not yet handle {method}")
            }
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
    use super::{LocalCodexChatRequest, LocalCodexChatSession};

    #[test]
    fn chat_request_serializes_for_tauri_boundary() {
        let request = LocalCodexChatRequest {
            conversation_id: "panel:agent-chat".to_owned(),
            project_id: "project:nucleus".to_owned(),
            message: "hello".to_owned(),
        };

        let value = serde_json::to_value(request).expect("serialize request");
        assert_eq!(value["conversation_id"], "panel:agent-chat");
        assert_eq!(value["message"], "hello");
    }

    #[test]
    #[ignore = "requires a locally authenticated Codex app-server"]
    fn live_chat_keeps_follow_up_turns_on_one_thread() {
        let cwd = std::env::current_dir().expect("current dir");
        let mut session =
            LocalCodexChatSession::start("live-smoke", cwd.to_str().expect("UTF-8 current dir"))
                .expect("start chat session");

        let first = session
            .send_turn("Reply with exactly: first nucleus chat turn")
            .expect("first turn");
        let second = session
            .send_turn("Reply with exactly: second nucleus chat turn")
            .expect("second turn");

        assert_eq!(first.thread_id, second.thread_id);
        assert!(!first.model.is_empty());
        assert!(first.assistant_message.contains("first nucleus chat turn"));
        assert!(second
            .assistant_message
            .contains("second nucleus chat turn"));
    }
}
