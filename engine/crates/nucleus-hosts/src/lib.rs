//! Host observation and delivery for the isolated Rust task engine.

mod launch;
mod process;
mod projection;
mod rpc;
#[cfg(test)]
mod t3_tests;

use std::{
    future::Future,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub use launch::{Binding, Dispatch, RoleProfile, RunRequest};
use launch::{Method, Wire, message_id};
use nucleus_core::{Host, RetainedThread, Run, RunState};
use process::{Activity, Inventory};
use projection::Projection;
use rpc::{Read, Reply, Rpc};
use serde_json::{Value, json};
use tokio::sync::OnceCell;

const LATE_REPLY_MS: u64 = 10 * 60 * 1000;

#[derive(Clone, Copy, Debug, thiserror::Error)]
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

/// A single exact send, scoped to the run and timestamp that authorized it.
pub struct ReplayAuthorization {
    instance: String,
    prior_send: Option<u64>,
    send_at: u64,
    revoked: bool,
}

impl ReplayAuthorization {
    /// Apply the marker to the exact task used to prepare the authorization.
    /// Persist the resulting task before using the authorization on the wire.
    ///
    /// # Errors
    /// Returns an error if the run or its delivery state changed after authorization.
    pub fn record(&self, task: &mut nucleus_core::Task) -> Result<(), HostError> {
        let run = task.run().ok_or(HostError::Binding)?;
        if run.launch().instance != self.instance
            || run.revoked() != self.revoked
            || run.last_send_at_ms() != self.prior_send
        {
            return Err(HostError::Binding);
        }
        task.record_send(&self.instance, self.send_at)
            .map_err(|_| HostError::Binding)
    }
}

/// The service serializes commands and effects for each task and persists
/// the authorized send marker immediately before using it on the wire.
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

    fn authorize_send(
        &self,
        run: &Run,
    ) -> impl Future<Output = Result<ReplayAuthorization, HostError>> + Send;

    fn send(
        &self,
        run: &Run,
        authorization: ReplayAuthorization,
    ) -> impl Future<Output = Result<SendOutcome, HostError>> + Send;

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

/// Exact T3 reads share a single bounded process inventory within each pass.
pub struct T3Pass<'a> {
    host: &'a T3,
    processes: OnceCell<Result<Inventory, HostError>>,
    sent: AtomicBool,
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

    #[must_use]
    pub fn pass(&self) -> T3Pass<'_> {
        T3Pass {
            host: self,
            processes: OnceCell::new(),
            sent: AtomicBool::new(false),
        }
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
                json!({"threadId": id, "requestCompletionMarker": true, "acceptBoundedSnapshot": false}),
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

impl T3Pass<'_> {
    async fn quiet(
        &self,
        binding: &Binding,
        projection: Option<&Projection>,
    ) -> Result<bool, HostError> {
        if let Some(projection) = projection
            && projection.retained()? == RetainedThread::Busy
        {
            return Ok(false);
        }
        if self.sent.load(Ordering::Acquire) {
            // A fresh launch may have started processes after this inventory.
            return Err(HostError::Uncertain);
        }
        let inventory = self
            .processes
            .get_or_init(Inventory::capture)
            .await
            .as_ref()
            .map_err(|error| *error)?;
        match inventory.activity(Path::new(&binding.worktree_path))? {
            Activity::Busy => Ok(false),
            Activity::Quiet => Ok(true),
            Activity::Unknown => Err(HostError::Uncertain),
        }
    }
}

impl TaskHost for T3Pass<'_> {
    async fn observe_retained(&self, binding: &Binding, thread: &str) -> Result<Host, HostError> {
        let projection = self.host.thread(binding, thread).await?;
        let state = if self.quiet(binding, projection.as_ref()).await? {
            projection
                .as_ref()
                .map_or(Ok(RetainedThread::Gone), Projection::retained)?
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
        let (thread, state) = self.host.delivery(run, &wire).await?;
        if state == RunState::ReadyToSend && awaiting_reply(run, now_ms) {
            return Err(HostError::Uncertain);
        }
        let state = if matches!(state, RunState::Ended | RunState::Gone)
            && !self.quiet(&wire.binding, thread.as_ref()).await?
        {
            RunState::Running
        } else {
            state
        };
        Ok(current(run, state))
    }

    async fn authorize_send(&self, run: &Run) -> Result<ReplayAuthorization, HostError> {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| HostError::Uncertain)?;
        let now_ms = u64::try_from(elapsed.as_millis()).map_err(|_| HostError::Uncertain)?;
        if awaiting_reply(run, now_ms) || (run.revoked() && run.last_send_at_ms().is_none()) {
            return Err(HostError::Uncertain);
        }
        let wire = Wire::read(run)?;
        let (thread, state) = self.host.delivery(run, &wire).await?;
        if state != RunState::ReadyToSend || !self.quiet(&wire.binding, thread.as_ref()).await? {
            return Err(HostError::Uncertain);
        }
        Ok(ReplayAuthorization {
            instance: run.launch().instance.clone(),
            prior_send: run.last_send_at_ms(),
            send_at: now_ms,
            revoked: run.revoked(),
        })
    }

    async fn send(
        &self,
        run: &Run,
        authorization: ReplayAuthorization,
    ) -> Result<SendOutcome, HostError> {
        let launch = run.launch();
        if run.last_send_at_ms() != Some(authorization.send_at)
            || launch.instance != authorization.instance
            || run.revoked() != authorization.revoked
        {
            return Err(HostError::Binding);
        }
        let wire = Wire::read(run)?;
        let (thread, state) = self.host.delivery(run, &wire).await?;
        match state {
            RunState::ReadyToSend if self.quiet(&wire.binding, thread.as_ref()).await? => {}
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
            self.host.thread_command(json!({
                "type": "thread.unarchive", "commandId": format!("{}-unarchive", launch.instance), "threadId": launch.thread,
            })).await?;
            let (thread, state) = self.host.delivery(run, &wire).await?;
            if state != RunState::ReadyToSend || thread.is_none_or(|thread| thread.archived()) {
                return Err(HostError::Uncertain);
            }
        }
        self.sent.store(true, Ordering::Release);
        match self
            .host
            .rpc
            .call(wire.method.rpc(), wire.payload.as_ref(), Read::One)
            .await?
        {
            Reply::Value(_) => Ok(SendOutcome::Sent),
            Reply::Failure(cause) if rejected(&cause, &wire, &launch.instance) => {
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
        let (thread, state) = self.host.delivery(run, &wire).await?;
        if let Some((command, target)) = thread
            .as_ref()
            .and_then(|thread| thread.stop_command(&message_id(&launch.instance)))
        {
            self.host
                .thread_command(json!({
                    "type": command, "commandId": format!("{}-{command}", launch.instance),
                    "threadId": launch.thread, "runId": target,
                }))
                .await?;
            return Ok(StopProgress::Waiting);
        }
        match state {
            RunState::ReadyToSend if !awaiting_reply(run, now_ms) => Ok(StopProgress::ReplayDue),
            RunState::Ended | RunState::Gone
                if self.quiet(&wire.binding, thread.as_ref()).await? =>
            {
                if archive
                    && state == RunState::Ended
                    && thread.is_some_and(|thread| !thread.archived())
                {
                    self.host.thread_command(json!({
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

fn rejected(cause: &Value, wire: &Wire, instance: &str) -> bool {
    let Some([reason]) = cause.as_array().map(Vec::as_slice) else {
        return false;
    };
    if reason["_tag"] != "Fail" {
        return false;
    }
    let error = &reason["error"];
    if error["commandId"] != instance {
        return false;
    }
    let defect = &error["cause"];
    match wire.method {
        Method::Continue => {
            error["_tag"] == "OrchestrationV2DispatchCommandError"
                && error["commandType"] == "message.dispatch"
                && rejected_command(defect, instance, "message.dispatch")
        }
        Method::Create => {
            error["_tag"] == "OrchestrationV2ThreadLaunchError"
                && error["projectId"] == wire.binding.project_id
                && defect_named(defect, "ThreadLaunchError")
                && [
                    ("create-thread", instance.to_owned(), "thread.create"),
                    (
                        "dispatch-message",
                        format!("{instance}:initial-message"),
                        "message.dispatch",
                    ),
                ]
                .iter()
                .any(|(operation, command_id, command)| {
                    (defect["operation"] == *operation
                        || defect["message"]
                            == format!("Thread launch {instance} failed during {operation}."))
                        && rejected_command(&defect["cause"], command_id, command)
                })
        }
    }
}

fn defect_named(value: &Value, name: &str) -> bool {
    value["name"] == name || value["_tag"] == name
}

fn rejected_command(value: &Value, id: &str, command: &str) -> bool {
    defect_named(value, "OrchestratorCommandPreviouslyRejectedError")
        && value["commandId"]
            .as_str()
            .is_none_or(|actual| actual == id)
        && value["commandType"]
            .as_str()
            .is_none_or(|actual| actual == command)
        && (value["commandId"] == id
            || value["message"].as_str().is_some_and(|message| {
                message.starts_with(&format!("Command {id} was previously rejected: "))
            }))
}

#[cfg(test)]
mod tests {
    use serde_json::value::to_raw_value;

    use super::*;

    #[test]
    fn effect_defects_identify_only_the_rejected_reserved_command() {
        let instance = "task-fixture-run-2";
        let binding = Binding {
            project_id: "fixture-project".into(),
            worktree_path: "/fixture".into(),
            branch: "fixture-branch".into(),
        };
        let wire = |method| Wire {
            binding: binding.clone(),
            method,
            payload: to_raw_value(&json!({})).expect("fixture wire"),
        };
        let defect = |command: &str, command_type: &str| {
            json!({
                "name": "OrchestratorCommandPreviouslyRejectedError",
                "message": format!("Command {command} was previously rejected: Failed to dispatch orchestration command {command_type} ({command})."),
            })
        };
        let continuation = json!([{"_tag":"Fail","error":{
            "_tag":"OrchestrationV2DispatchCommandError",
            "commandId":instance,
            "commandType":"message.dispatch",
            "message": defect(instance, "message.dispatch")["message"],
            "cause":defect(instance, "message.dispatch"),
        }}]);
        assert!(rejected(&continuation, &wire(Method::Continue), instance));
        assert!(!rejected(
            &continuation,
            &wire(Method::Continue),
            "different-command"
        ));
        for (stage, command, kind) in [
            ("create-thread", instance.to_owned(), "thread.create"),
            (
                "dispatch-message",
                format!("{instance}:initial-message"),
                "message.dispatch",
            ),
        ] {
            let mut launch = json!([{"_tag":"Fail","error":{
                "_tag":"OrchestrationV2ThreadLaunchError",
                "commandId":instance,
                "projectId":binding.project_id,
                "message":"Failed to launch thread",
                "cause":{
                    "name":"ThreadLaunchError",
                    "message":format!("Thread launch {instance} failed during {stage}."),
                    "cause":defect(&command, kind),
                },
            }}]);
            assert!(rejected(&launch, &wire(Method::Create), instance));
            launch[0]["error"]["cause"]["cause"] = defect("different-command", kind);
            assert!(!rejected(&launch, &wire(Method::Create), instance));
        }
    }
}
