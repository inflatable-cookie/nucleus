//! Host observation and delivery for the isolated Rust task engine.

mod launch;
mod process;
mod projection;
mod rpc;

use std::{future::Future, path::Path};

pub use launch::{Binding, Dispatch, RoleProfile, RunRequest};
use launch::{Method, Wire, message_id};
use nucleus_core::{Host, RetainedThread, Run, RunState};
use projection::Projection;
use rpc::{Read, Reply, Rpc};
use serde_json::{Value, json};

const LATE_REPLY_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("the host endpoint, credential or role profile is invalid")]
    Configuration,
    #[error("the host could not be reached")]
    Unavailable,
    #[error("the host read or mutation timed out")]
    Timeout,
    #[error("the host reply could not be confirmed")]
    Protocol,
    #[error("the host thread does not match the configured project and checkout")]
    Binding,
    #[error("the host observation or mutation outcome is unknown")]
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    Sent,
    Adopted,
    /// T3 returned a durable rejection for this exact native command ID.
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopProgress {
    Waiting,
    /// No matching delivery was visible after the late-reply window. Persist a
    /// new send timestamp before replaying the reserved wire, then stop again.
    ReplayDue,
    Settled(Host),
}

/// The service serializes commands and effects for each task and persists
/// `Task::record_send` immediately before passing the saved run to `send`.
pub trait TaskHost: Send + Sync {
    fn observe_retained(
        &self,
        binding: &Binding,
        thread: &str,
    ) -> impl Future<Output = Result<Host, HostError>> + Send;

    fn observe_run(
        &self,
        run: &Run,
        now_ms: u64,
    ) -> impl Future<Output = Result<Host, HostError>> + Send;

    fn send(&self, run: &Run) -> impl Future<Output = Result<SendOutcome, HostError>> + Send;

    /// Reconcile the revoked run. Request archival for a replay at a superseded
    /// review head. Unsent reservations and deleted threads need no archive.
    fn stop(
        &self,
        run: &Run,
        now_ms: u64,
        archive: bool,
    ) -> impl Future<Output = Result<StopProgress, HostError>> + Send;
}

pub struct T3 {
    rpc: Rpc,
}

impl T3 {
    /// Construct a client for a local version-2 T3 RPC endpoint.
    ///
    /// # Errors
    /// Returns an error for an invalid endpoint or bearer.
    pub fn new(endpoint: &str, bearer: &str) -> Result<Self, HostError> {
        Ok(Self {
            rpc: Rpc::new(endpoint, bearer)?,
        })
    }

    /// Check the host protocol and the configured role profiles before admission.
    ///
    /// # Errors
    /// Returns an error if the configuration is unreadable or a profile is unavailable.
    pub async fn check(&self, profiles: &[&RoleProfile]) -> Result<(), HostError> {
        let Reply::Value(config) = self
            .rpc
            .call("server.getConfig", json!({}), Read::One)
            .await?
        else {
            return Err(HostError::Protocol);
        };
        if config
            .pointer("/environment/orchestrationProtocolVersion")
            .and_then(Value::as_u64)
            != Some(2)
        {
            return Err(HostError::Protocol);
        }
        let providers = config["providers"].as_array().ok_or(HostError::Protocol)?;
        if !profiles.iter().all(|profile| {
            providers
                .iter()
                .any(|provider| available(provider, profile))
        }) {
            return Err(HostError::Configuration);
        }
        Ok(())
    }

    async fn thread(&self, binding: &Binding, id: &str) -> Result<Option<Projection>, HostError> {
        let reply = self
            .rpc
            .call(
                "orchestration.subscribeThread",
                json!({"threadId": id, "requestCompletionMarker": true, "acceptBoundedSnapshot": true}),
                Read::Snapshot,
            )
            .await?;
        match reply {
            Reply::Value(value) => Projection::parse(value, binding, id).map(Some),
            Reply::Failure(cause) if projection::missing_thread(&cause, id) => Ok(None),
            Reply::Failure(_) => Err(HostError::Protocol),
        }
    }

    async fn delivery(
        &self,
        run: &Run,
        wire: &Wire,
    ) -> Result<(Option<Projection>, RunState), HostError> {
        let launch = run.launch();
        let thread = self.thread(&wire.binding, &launch.thread).await?;
        let state = match &thread {
            Some(thread) => thread.run(&message_id(&launch.instance))?,
            None if wire.method == Method::Continue => RunState::Gone,
            None => RunState::ReadyToSend,
        };
        Ok((thread, state))
    }

    async fn thread_command(&self, payload: Value) -> Result<(), HostError> {
        match self
            .rpc
            .call("orchestration.dispatchCommand", payload, Read::One)
            .await?
        {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }
}

impl TaskHost for T3 {
    async fn observe_retained(&self, binding: &Binding, thread: &str) -> Result<Host, HostError> {
        let projection = self.thread(binding, thread).await?;
        let state = if quiet(binding, projection.as_ref()).await? {
            projection
                .as_ref()
                .map_or(RetainedThread::Gone, Projection::retained)
        } else {
            RetainedThread::Busy
        };
        Ok(Host::Retained {
            thread: thread.into(),
            state,
        })
    }

    async fn observe_run(&self, run: &Run, now_ms: u64) -> Result<Host, HostError> {
        if run.revoked() {
            return Err(HostError::Binding);
        }
        let wire = Wire::read(run)?;
        let (thread, state) = self.delivery(run, &wire).await?;
        if state == RunState::ReadyToSend && awaiting_reply(run, now_ms) {
            return Err(HostError::Uncertain);
        }
        let state = if matches!(state, RunState::Ended | RunState::Gone)
            && !quiet(&wire.binding, thread.as_ref()).await?
        {
            RunState::Running
        } else {
            state
        };
        Ok(current(run, state))
    }

    async fn send(&self, run: &Run) -> Result<SendOutcome, HostError> {
        if run.last_send_at_ms().is_none() {
            return Err(HostError::Binding);
        }
        let launch = run.launch();
        let wire = Wire::read(run)?;
        let (thread, state) = self.delivery(run, &wire).await?;
        match state {
            RunState::ReadyToSend if quiet(&wire.binding, thread.as_ref()).await? => {}
            RunState::Starting
            | RunState::Running
            | RunState::Permission
            | RunState::Input
            | RunState::Ended => {
                return Ok(SendOutcome::Adopted);
            }
            _ => return Err(HostError::Uncertain),
        }
        if wire.method == Method::Continue && thread.is_some_and(|thread| thread.archived()) {
            self.thread_command(json!({
                "type": "thread.unarchive", "commandId": format!("{}-unarchive", launch.instance), "threadId": launch.thread,
            })).await?;
            let (thread, state) = self.delivery(run, &wire).await?;
            if state != RunState::ReadyToSend || thread.is_none_or(|thread| thread.archived()) {
                return Err(HostError::Uncertain);
            }
        }
        match self
            .rpc
            .call(wire.method.rpc(), wire.payload.as_ref(), Read::One)
            .await?
        {
            Reply::Value(_) => Ok(SendOutcome::Sent),
            Reply::Failure(cause) if rejected(&cause, wire.method, &launch.instance) => {
                Ok(SendOutcome::Rejected)
            }
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }

    async fn stop(&self, run: &Run, now_ms: u64, archive: bool) -> Result<StopProgress, HostError> {
        if !run.revoked() {
            return Err(HostError::Binding);
        }
        if run.last_send_at_ms().is_none() {
            return Ok(StopProgress::Settled(current(run, RunState::ReadyToSend)));
        }
        let launch = run.launch();
        let wire = Wire::read(run)?;
        let (thread, state) = self.delivery(run, &wire).await?;
        if let Some((command, target)) = thread
            .as_ref()
            .and_then(|thread| thread.stop_command(&message_id(&launch.instance)))
        {
            self.thread_command(json!({
                "type": command, "commandId": format!("{}-{command}", launch.instance),
                "threadId": launch.thread, "runId": target,
            }))
            .await?;
            return Ok(StopProgress::Waiting);
        }
        match state {
            RunState::ReadyToSend if !awaiting_reply(run, now_ms) => Ok(StopProgress::ReplayDue),
            RunState::Ended | RunState::Gone if quiet(&wire.binding, thread.as_ref()).await? => {
                if archive
                    && state == RunState::Ended
                    && thread.is_some_and(|thread| !thread.archived())
                {
                    self.thread_command(json!({
                        "type": "thread.archive", "commandId": format!("{}-archive", launch.instance), "threadId": launch.thread,
                    })).await?;
                    return Ok(StopProgress::Waiting);
                }
                Ok(StopProgress::Settled(current(run, state)))
            }
            _ => Ok(StopProgress::Waiting),
        }
    }
}

fn current(run: &Run, state: RunState) -> Host {
    Host::Current {
        instance: run.launch().instance.clone(),
        state,
    }
}

fn awaiting_reply(run: &Run, now_ms: u64) -> bool {
    run.last_send_at_ms()
        .is_some_and(|sent| now_ms.saturating_sub(sent) < LATE_REPLY_MS)
}

async fn quiet(binding: &Binding, projection: Option<&Projection>) -> Result<bool, HostError> {
    if projection.is_some_and(|projection| projection.retained() == RetainedThread::Busy) {
        return Ok(false);
    }
    Ok(!process::busy(Path::new(&binding.worktree_path)).await?)
}

fn available(provider: &Value, profile: &RoleProfile) -> bool {
    provider["instanceId"] == profile.instance_id
        && provider["enabled"] == true
        && provider["status"] == "ready"
        && matches!(
            profile.runtime_mode.as_str(),
            "approval-required" | "auto-accept-edits" | "auto" | "full-access"
        )
        && match provider.get("supportedRuntimeModes") {
            None => true,
            Some(modes) => modes.as_array().is_some_and(|modes| {
                modes.is_empty() || modes.iter().any(|mode| mode == &profile.runtime_mode)
            }),
        }
        && provider["models"]
            .as_array()
            .is_some_and(|models| models.iter().any(|model| model["slug"] == profile.model))
}

fn rejected(cause: &Value, method: Method, instance: &str) -> bool {
    let Some([reason]) = cause.as_array().map(Vec::as_slice) else {
        return false;
    };
    if reason["_tag"] != "Fail" {
        return false;
    }
    let error = &reason["error"];
    let rejection = &error["cause"];
    let (wrapper, command) = match method {
        Method::Create => ("ThreadLaunchError", "thread.create"),
        Method::Continue => ("OrchestrationV2DispatchCommandError", "message.dispatch"),
    };
    error["_tag"] == wrapper
        && error["commandId"] == instance
        && rejection["_tag"] == "OrchestratorCommandPreviouslyRejectedError"
        && rejection["commandId"] == instance
        && rejection["commandType"] == command
}
