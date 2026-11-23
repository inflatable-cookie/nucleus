//! Host observation and delivery for the isolated Rust task engine.

mod projection;
mod rpc;

use std::future::Future;

use nucleus_core::{Host, LaunchInputs, PreparedLaunch, RunState};
use projection::Projection;
use rpc::{Read, Reply, Rpc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("the host endpoint or credential is invalid")]
    Configuration,
    #[error("the host could not be reached")]
    Unavailable,
    #[error("the host read or mutation timed out")]
    Timeout,
    #[error("the host reply could not be confirmed")]
    Protocol,
    #[error("the host thread does not match the configured project and checkout")]
    Binding,
    #[error("the host mutation outcome is unknown")]
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub project_id: String,
    pub worktree_path: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleProfile {
    pub instance_id: String,
    pub model: String,
    pub runtime_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Dispatch {
    Create { title: String, profile: RoleProfile },
    Continue,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RunRequest {
    pub binding: Binding,
    pub dispatch: Dispatch,
    pub text: String,
}

impl std::fmt::Debug for RunRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("RunRequest").field("dispatch", &self.dispatch).finish_non_exhaustive()
    }
}

impl RunRequest {
    /// Freeze the inputs that will be used for creation and exact-ID replay.
    ///
    /// # Errors
    /// Returns an error if the run request cannot be encoded.
    pub fn inputs(&self, thread: String, started_at: u64) -> Result<LaunchInputs, HostError> {
        let input = serde_json::to_string(self).map_err(|_| HostError::Configuration)?;
        Ok(LaunchInputs { thread, started_at, input })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Readiness {
    /// Exact project/thread and complete message projection permit delivery.
    Send,
    /// The exact message or turn has already landed.
    Adopt,
}

/// The service resolves a durable request before each host-side effect.
pub trait TaskHost: Send + Sync {
    fn observe_retained(&self, binding: &Binding, thread: &str) -> impl Future<Output = Result<Host, HostError>> + Send;

    fn observe_run(&self, launch: &PreparedLaunch) -> impl Future<Output = Result<Host, HostError>> + Send;

    fn send(&self, launch: &PreparedLaunch) -> impl Future<Output = Result<Readiness, HostError>> + Send;

    fn stop(&self, launch: &PreparedLaunch) -> impl Future<Output = Result<(), HostError>> + Send;
}

pub struct T3 {
    rpc: Rpc,
}

impl T3 {
    /// Construct a client for the configured version-2 T3 RPC endpoint.
    ///
    /// # Errors
    /// Returns an error for an invalid endpoint or bearer.
    pub fn new(endpoint: &str, bearer: &str) -> Result<Self, HostError> {
        Ok(Self { rpc: Rpc::new(endpoint, bearer)? })
    }

    /// Check that the endpoint speaks version 2 before admitting a task.
    ///
    /// # Errors
    /// Returns an error if the handshake or host configuration is unreadable.
    pub async fn check(&self) -> Result<(), HostError> {
        let result = self.rpc.call("server.getConfig", json!({}), Read::One).await?;
        match result {
            Reply::Value(value) if value.pointer("/environment/orchestrationProtocolVersion").and_then(Value::as_u64) == Some(2) => Ok(()),
            _ => Err(HostError::Protocol),
        }
    }

    async fn thread(&self, binding: &Binding, id: &str) -> Result<Option<Projection>, HostError> {
        let reply = self.rpc.call("orchestration.subscribeThread", json!({
            "threadId": id, "requestCompletionMarker": true, "acceptBoundedSnapshot": true,
        }), Read::Snapshot).await?;
        match reply {
            Reply::Value(value) => Projection::parse(value, binding, id).map(Some),
            Reply::Failure(cause) if projection::missing_thread(&cause, id) => Ok(None),
            Reply::Failure(_) => Err(HostError::Protocol),
        }
    }

    async fn active_tools(&self, id: &str) -> Result<bool, HostError> {
        let reply = self.rpc.call("orchestration.getThreadFamily", json!({"threadId": id}), Read::One).await?;
        let Reply::Value(value) = reply else { return Err(HostError::Protocol) };
        projection::active_tools(&value, id)
    }

    async fn run_state(&self, launch: &PreparedLaunch, request: &RunRequest) -> Result<RunState, HostError> {
        let Some(thread) = self.thread(&request.binding, &launch.thread).await? else {
            return Ok(match request.dispatch { Dispatch::Create { .. } => RunState::ReadyToSend, Dispatch::Continue => RunState::Gone });
        };
        let state = thread.run(&message_id(launch))?;
        if state == RunState::Ended && self.active_tools(&launch.thread).await? {
            return Ok(RunState::Running);
        }
        Ok(state)
    }

    async fn write(&self, method: &str, payload: Value) -> Result<(), HostError> {
        match self.rpc.call(method, payload, Read::One).await? {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }
}

impl TaskHost for T3 {
    async fn observe_retained(&self, binding: &Binding, thread: &str) -> Result<Host, HostError> {
        let state = match self.thread(binding, thread).await? {
            Some(projection) => projection.retained(),
            None => nucleus_core::RetainedThread::Gone,
        };
        Ok(Host::Retained { thread: thread.into(), state })
    }

    async fn observe_run(&self, launch: &PreparedLaunch) -> Result<Host, HostError> {
        let request: RunRequest = serde_json::from_str(&launch.input).map_err(|_| HostError::Configuration)?;
        let state = self.run_state(launch, &request).await?;
        Ok(Host::Current { instance: launch.instance.clone(), state })
    }

    async fn send(&self, launch: &PreparedLaunch) -> Result<Readiness, HostError> {
        let request: RunRequest = serde_json::from_str(&launch.input).map_err(|_| HostError::Configuration)?;
        // Probe the durable projection immediately before every send, including replay.
        match self.run_state(launch, &request).await? {
            RunState::ReadyToSend => {},
            RunState::Gone => return Err(HostError::Binding),
            _ => return Ok(Readiness::Adopt),
        }
        let message = message_id(launch);
        let (method, payload) = match request.dispatch {
            Dispatch::Create { title, profile } => ("orchestration.launchThread", json!({
                "commandId": launch.instance, "threadId": launch.thread,
                "projectId": request.binding.project_id, "title": title,
                "modelSelection": {"instanceId": profile.instance_id, "model": profile.model},
                "runtimeMode": profile.runtime_mode, "interactionMode": "default",
                "workspaceStrategy": {"type": "existing_worktree", "worktreePath": request.binding.worktree_path},
                "initialMessage": {"messageId": message, "text": request.text, "attachments": []},
            })),
            Dispatch::Continue => ("orchestration.dispatchCommand", json!({
                "type": "message.dispatch", "commandId": launch.instance, "threadId": launch.thread,
                "messageId": message, "text": request.text, "attachments": [],
                "createdBy": "user", "creationSource": "server", "dispatchMode": {"type": "queue_after_active"},
            })),
        };
        self.write(method, payload).await?;
        Ok(Readiness::Send)
    }

    async fn stop(&self, launch: &PreparedLaunch) -> Result<(), HostError> {
        let request: RunRequest = serde_json::from_str(&launch.input).map_err(|_| HostError::Configuration)?;
        match self.run_state(launch, &request).await? {
            RunState::Ended | RunState::Gone | RunState::Rejected => Ok(()),
            RunState::Running | RunState::Permission | RunState::Input | RunState::Starting => self.write("orchestration.dispatchCommand", json!({
                "type": "thread.stop", "commandId": format!("{}-stop", launch.instance), "threadId": launch.thread,
            })).await,
            RunState::ReadyToSend | RunState::IdleWithoutTerminalRun => Err(HostError::Uncertain),
        }
    }
}

fn message_id(launch: &PreparedLaunch) -> String {
    format!("{}-message", launch.instance)
}
