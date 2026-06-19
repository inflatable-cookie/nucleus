use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub(super) type JsonRpcResult = Value;

pub(super) struct CodexAppServerRpc {
    stdin: ChildStdin,
    stdout: Receiver<String>,
    next_id: u64,
    counts: CodexRpcCounts,
}

#[derive(Clone, Copy, Default)]
pub(super) struct CodexRpcCounts {
    pub(super) notifications: usize,
    pub(super) server_requests: usize,
}

impl CodexAppServerRpc {
    pub(super) fn from_child(child: &mut Child) -> Result<Self, String> {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server stdin unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server stdout unavailable".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "codex app-server stderr unavailable".to_owned())?;

        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if line.is_err() {
                    break;
                }
            }
        });

        Ok(Self {
            stdin,
            stdout: rx,
            next_id: 1,
            counts: CodexRpcCounts::default(),
        })
    }

    pub(super) fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<JsonRpcResult, String> {
        let request_id = self.next_id;
        self.next_id += 1;
        let message = json!({
            "id": request_id,
            "method": method,
            "params": params,
        });
        self.write_json_line(&message)?;
        self.read_response(request_id, timeout)
    }

    pub(super) fn counts(&self) -> CodexRpcCounts {
        self.counts
    }

    pub(super) fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut message = json!({
            "method": method,
        });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_json_line(&message)
    }

    pub(super) fn wait_for_turn_completed(
        &mut self,
        turn_id: &str,
        timeout: Duration,
    ) -> Result<Option<String>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Ok(None);
            };
            let line = match self.stdout.recv_timeout(remaining) {
                Ok(line) => line,
                Err(_) => return Ok(None),
            };
            let value: Value = serde_json::from_str(&line)
                .map_err(|_| "codex app-server emitted invalid JSON".to_owned())?;
            match self.handle_turn_completion(&value, turn_id)? {
                TurnCompletionMatch::Matched(status) => return Ok(Some(status)),
                TurnCompletionMatch::OtherCompletion => continue,
                TurnCompletionMatch::NotCompletion => {}
            }
            self.handle_non_response(&value)?;
        }
    }

    fn read_response(&mut self, request_id: u64, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| format!("timed out waiting for codex response id {request_id}"))?;
            let line = self
                .stdout
                .recv_timeout(remaining)
                .map_err(|_| format!("timed out waiting for codex response id {request_id}"))?;
            let value: Value = serde_json::from_str(&line)
                .map_err(|_| "codex app-server emitted invalid JSON".to_owned())?;
            if self.handle_non_response(&value)? {
                continue;
            }
            if value.get("id").and_then(Value::as_u64) != Some(request_id) {
                continue;
            }
            if value.get("error").is_some() {
                return Err(format!(
                    "codex app-server returned JSON-RPC error for {request_id}"
                ));
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| format!("codex response id {request_id} missing result"));
        }
    }

    fn handle_non_response(&mut self, value: &Value) -> Result<bool, String> {
        let has_method = value.get("method").and_then(Value::as_str).is_some();
        let has_id = value.get("id").is_some();
        if has_method && has_id {
            self.counts.server_requests += 1;
            self.respond_method_not_found(value)?;
            return Ok(true);
        }
        if has_method {
            self.counts.notifications += 1;
            return Ok(true);
        }
        Ok(false)
    }

    fn handle_turn_completion(
        &mut self,
        value: &Value,
        expected_turn_id: &str,
    ) -> Result<TurnCompletionMatch, String> {
        if value.get("method").and_then(Value::as_str) != Some("turn/completed") {
            return Ok(TurnCompletionMatch::NotCompletion);
        }
        self.counts.notifications += 1;
        let turn = value
            .get("params")
            .and_then(|params| params.get("turn"))
            .ok_or_else(|| "codex turn/completed notification missing turn".to_owned())?;
        if turn.get("id").and_then(Value::as_str) != Some(expected_turn_id) {
            return Ok(TurnCompletionMatch::OtherCompletion);
        }
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_owned();
        Ok(TurnCompletionMatch::Matched(status))
    }

    fn respond_method_not_found(&mut self, request: &Value) -> Result<(), String> {
        let id = request
            .get("id")
            .cloned()
            .ok_or_else(|| "codex server request missing id".to_owned())?;
        self.write_json_line(&json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": "method not found"
            }
        }))
    }

    fn write_json_line(&mut self, value: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut self.stdin, value)
            .map_err(|error| format!("failed to encode codex request: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| format!("failed to write codex request: {error}"))?;
        self.stdin
            .flush()
            .map_err(|error| format!("failed to flush codex request: {error}"))
    }
}

enum TurnCompletionMatch {
    Matched(String),
    OtherCompletion,
    NotCompletion,
}
