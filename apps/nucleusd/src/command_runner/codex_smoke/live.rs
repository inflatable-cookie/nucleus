mod rpc;
mod values;

use std::process::{Child, Command, Stdio};
use std::time::Duration;

use nucleus_server::{
    CodexAppServerTurnStartExecutorSmokeBoundaryRecord,
    CodexAppServerTurnStartExecutorSmokeBoundaryStatus,
};
use serde_json::json;

use rpc::{CodexAppServerRpc, JsonRpcResult};
use values::{string_field, turn_field_from_start_response};

const SMOKE_PROMPT: &str = "Reply with exactly: nucleus codex direct smoke ok";

pub(super) struct LiveCodexSmokeOutcome {
    pub(super) provider_write_executed: bool,
    pub(super) thread_id: Option<String>,
    pub(super) turn_id: Option<String>,
    pub(super) turn_status: Option<String>,
    pub(super) notifications_seen: usize,
    pub(super) server_requests_seen: usize,
    status: LiveCodexSmokeStatus,
}

impl LiveCodexSmokeOutcome {
    pub(super) fn status_label(&self) -> &'static str {
        match self.status {
            LiveCodexSmokeStatus::Executed => "executed",
            LiveCodexSmokeStatus::Blocked => "blocked",
        }
    }
}

#[derive(Clone, Copy)]
enum LiveCodexSmokeStatus {
    Executed,
    Blocked,
}

pub(super) fn run_live_codex_turn_start_smoke(
    boundary: &CodexAppServerTurnStartExecutorSmokeBoundaryRecord,
) -> Result<LiveCodexSmokeOutcome, String> {
    if boundary.status
        != CodexAppServerTurnStartExecutorSmokeBoundaryStatus::EligibleForSeparatelyConfirmedRealWriteSmoke
    {
        return Ok(LiveCodexSmokeOutcome {
            provider_write_executed: false,
            thread_id: None,
            turn_id: None,
            turn_status: None,
            notifications_seen: 0,
            server_requests_seen: 0,
            status: LiveCodexSmokeStatus::Blocked,
        });
    }

    let cwd =
        std::env::current_dir().map_err(|error| format!("failed to read current dir: {error}"))?;
    let mut child = spawn_codex_app_server()?;
    let mut rpc = CodexAppServerRpc::from_child(&mut child)?;

    rpc.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "nucleusd",
                "title": "Nucleus Daemon",
                "version": "0.0.0"
            },
            "capabilities": {
                "experimentalApi": true,
                "optOutNotificationMethods": null
            }
        }),
        Duration::from_secs(30),
    )?;
    rpc.notify("initialized", None)?;

    let thread_response = rpc.request(
        "thread/start",
        json!({
            "cwd": cwd.display().to_string(),
            "approvalPolicy": "untrusted",
            "sandbox": "read-only",
            "ephemeral": true,
        }),
        Duration::from_secs(30),
    )?;
    let thread_id = extract_thread_id(thread_response)?;

    let turn_response = rpc.request(
        "turn/start",
        json!({
            "threadId": thread_id,
            "approvalPolicy": "untrusted",
            "sandboxPolicy": { "type": "readOnly" },
            "input": [
                {
                    "type": "text",
                    "text": SMOKE_PROMPT
                }
            ]
        }),
        Duration::from_secs(120),
    )?;

    let turn_id = turn_field_from_start_response(&turn_response, "id")?;
    let turn_status = rpc
        .wait_for_turn_completed(&turn_id, Duration::from_secs(120))?
        .unwrap_or_else(|| {
            turn_field_from_start_response(&turn_response, "status")
                .unwrap_or_else(|_| "unknown".to_owned())
        });
    let counts = rpc.counts();
    close_child(child);

    Ok(LiveCodexSmokeOutcome {
        provider_write_executed: true,
        thread_id: Some(thread_id),
        turn_id: Some(turn_id),
        turn_status: Some(turn_status),
        notifications_seen: counts.notifications,
        server_requests_seen: counts.server_requests,
        status: LiveCodexSmokeStatus::Executed,
    })
}

fn spawn_codex_app_server() -> Result<Child, String> {
    Command::new("codex")
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to spawn codex app-server: {error}"))
}

fn extract_thread_id(response: JsonRpcResult) -> Result<String, String> {
    let thread = response
        .get("thread")
        .ok_or_else(|| "codex thread/start response missing thread".to_owned())?;
    string_field(thread, "id").map(str::to_owned)
}

fn close_child(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}
