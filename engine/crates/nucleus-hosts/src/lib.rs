//! Host observation and delivery for the isolated Rust task engine.

mod launch;
mod parenting;
mod process;
mod projection;
mod questions;
mod rpc;
mod runtime;
#[cfg(test)]
mod t3_tests;

use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub use launch::{Binding, Dispatch, RoleProfile, RunRequest};
use launch::{Method, Wire, delegated_child, message_id};
use nucleus_core::{Host, Launch, LaunchInputs, RetainedThread, Run, RunState};
pub use parenting::{ArchiveStep, ParentRun, ParentStep, ParentWrite, parent_thread};
use process::{Activity, Inventory};
use projection::Projection;
pub use projection::RunActivity;
pub use questions::{
    NoticeAuthorization, NoticeDispatch, NoticeHost, NoticeSend, NoticeState, NoticeTarget,
    NoticeWrite, PlannerThread,
};
pub use rpc::ThreadHint;
use rpc::{Read, Reply, Rpc};
use runtime::ServerRuntime;
use serde_json::{Value, json};
use tokio::sync::OnceCell;

const LATE_REPLY_MS: u64 = 10 * 60 * 1000;
pub const T3_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(15);

pub struct LaunchRequest<'a> {
    pub binding: Binding,
    pub parent: Option<ParentRun>,
    pub via: &'a Launch,
    pub profile: &'a RoleProfile,
    pub title: String,
    pub instance: &'a str,
    pub started_at: u64,
    pub text: String,
}

#[derive(Clone, Copy, Debug, thiserror::Error)]
pub enum HostError {
    #[error("the host endpoint, credential or role profile is invalid")]
    Configuration,
    #[error("the host could not be reached")]
    Unavailable,
    #[error("the host read or mutation timed out")]
    Timeout,
    #[error("the host deferred requests until {until:?}")]
    Deferred { until: tokio::time::Instant },
    #[error("the host reply could not be confirmed")]
    Protocol,
    #[error("the host thread does not match the configured project and checkout")]
    Binding,
    #[error("the host observation or mutation outcome is unknown")]
    Uncertain,
    #[error("the local process census could not confirm workspace custody")]
    ProcessCoverage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    Sent,
    /// T3 returned a durable rejection for this exact native command ID.
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopProgress {
    Waiting,
    Write(ControlDispatch),
    /// No matching delivery was visible after the late-reply window. Persist a
    /// new send timestamp before replaying the reserved wire, then stop again.
    ReplayDue,
    Settled(Host),
}

/// A control command bound to the destination read by native reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlDispatch {
    binding: Binding,
    payload: Value,
}

impl ControlDispatch {
    #[must_use]
    pub const fn binding(&self) -> &Binding {
        &self.binding
    }
}

/// A single exact send, scoped to the run and timestamp that authorized it.
pub struct ReplayAuthorization {
    instance: String,
    thread: String,
    input: String,
    wire: Wire,
    prior_send: Option<u64>,
    revoked: bool,
    archived: bool,
}

/// Frozen native write whose send marker must be committed before dispatch.
pub struct RunDispatch {
    instance: String,
    wire: Wire,
}

impl ReplayAuthorization {
    #[must_use]
    pub const fn binding(&self) -> &Binding {
        &self.wire.binding
    }

    #[must_use]
    pub fn unarchive(&self) -> Option<ControlDispatch> {
        self.archived.then(|| ControlDispatch {
            binding: self.wire.binding.clone(),
            payload: json!({
                "type":"thread.unarchive", "commandId":format!("{}-unarchive", self.instance), "threadId":self.thread,
            }),
        })
    }

    /// Apply the marker to the exact task used to prepare the authorization.
    /// Persist the resulting task before using the authorization on the wire.
    ///
    /// # Errors
    /// Returns an error if the run or its delivery state changed after authorization.
    pub fn record(self, task: &mut nucleus_core::Task) -> Result<RunDispatch, HostError> {
        let run = task.run().ok_or(HostError::Binding)?;
        if self.archived
            || run.launch().instance != self.instance
            || run.launch().input != self.input
            || run.revoked() != self.revoked
            || run.last_send_at_ms() != self.prior_send
        {
            return Err(HostError::Binding);
        }
        task.record_send(&self.instance, clock_ms()?)
            .map_err(|_| HostError::Binding)?;
        Ok(RunDispatch {
            instance: self.instance,
            wire: self.wire,
        })
    }
}

/// Decision evidence and optional presentation from the same exact native read.
#[derive(Debug)]
pub struct RunObservation {
    pub host: Host,
    pub activity: Option<RunActivity>,
}

/// The service serializes commands and effects for each task and persists
/// the authorized send marker immediately before using it on the wire.
pub trait TaskHost: Send + Sync {
    /// Prepare the host's immutable launch inputs and native identity.
    /// # Errors
    /// Returns an error when the launch is unsupported or cannot be encoded.
    fn prepare_launch(&self, request: LaunchRequest<'_>) -> Result<LaunchInputs, HostError>;

    fn observe_retained(
        &self,
        binding: &Binding,
        thread: &str,
    ) -> impl Future<Output = Result<Host, HostError>> + Send;

    fn observe_run(
        &self,
        run: &Run,
        now_ms: u64,
    ) -> impl Future<Output = Result<RunObservation, HostError>> + Send;

    fn authorize_send(
        &self,
        run: &Run,
    ) -> impl Future<Output = Result<ReplayAuthorization, HostError>> + Send;

    fn send(
        &self,
        dispatch: RunDispatch,
    ) -> impl Future<Output = Result<SendOutcome, HostError>> + Send;

    fn write_control(
        &self,
        dispatch: ControlDispatch,
    ) -> impl Future<Output = Result<(), HostError>> + Send;

    /// Reconcile the revoked run. Request archival for a replay at a superseded
    /// review head. This read-only method proposes any necessary native write
    /// for the service to authorize at its destination gate.
    fn stop(
        &self,
        run: &Run,
        expected: &Binding,
        now_ms: u64,
        archive: bool,
    ) -> impl Future<Output = Result<StopProgress, HostError>> + Send;
}

pub struct T3 {
    rpc: Rpc,
    runtime_descriptor: Option<PathBuf>,
}

/// Exact T3 reads share a single bounded process inventory within each pass.
pub struct T3Pass<'a> {
    host: &'a T3,
    processes: OnceCell<Result<Inventory, HostError>>,
    scratch: Option<&'a Path>,
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
            runtime_descriptor: None,
        })
    }

    #[must_use]
    pub fn endpoint(&self) -> &str {
        self.rpc.endpoint().as_str()
    }

    /// Use the connected T3 server's own runtime descriptor for custody checks.
    #[must_use]
    pub fn with_runtime_descriptor(mut self, path: PathBuf) -> Self {
        self.runtime_descriptor = Some(path);
        self
    }

    #[must_use]
    pub fn pass<'a>(&'a self, scratch: &'a Path) -> T3Pass<'a> {
        T3Pass {
            host: self,
            processes: OnceCell::new(),
            scratch: Some(scratch),
            sent: AtomicBool::new(false),
        }
    }

    /// Give a loopback RPC fixture a known process census.
    #[cfg(any(test, feature = "loopback-fixture"))]
    #[must_use]
    pub fn fixture_pass(&self) -> T3Pass<'_> {
        T3Pass {
            host: self,
            processes: OnceCell::new_with(Some(Ok(Inventory::quiet_fixture()))),
            scratch: None,
            sent: AtomicBool::new(false),
        }
    }

    /// Stream thread change hints over a socket independent of exact reads.
    /// # Errors
    /// Returns an error on disconnect or if the listener missed a hint.
    pub async fn watch_threads(
        &self,
        hints: &tokio::sync::mpsc::Sender<ThreadHint>,
    ) -> Result<(), HostError> {
        self.rpc.watch_threads(hints).await
    }

    /// Check the host protocol and configured role profiles for queued tasks.
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

    /// Verify that the selected project is active at the expected local root.
    /// This configuration read is independent of cycle observations.
    ///
    /// # Errors
    /// Returns an error when the project or snapshot cannot be verified.
    pub async fn check_project(&self, id: &str, root: &str) -> Result<(), HostError> {
        let Reply::Value(snapshot) = self.rpc.call(
            "orchestration.subscribeShell",
            json!({"requestCompletionMarker": true, "omitIdleSubagents": true, "omitOlderSettled": true}),
            Read::Shell,
        ).await? else { return Err(HostError::Protocol) };
        let projects = snapshot
            .pointer("/snapshot/projects")
            .and_then(Value::as_array)
            .ok_or(HostError::Protocol)?;
        let mut matched = projects.iter().filter(|project| project["id"] == id);
        let project = matched.next().ok_or(HostError::Binding)?;
        if matched.next().is_some()
            || project["workspaceRoot"] != root
            || !project["archivedAt"].is_null()
            || !project["deletedAt"].is_null()
        {
            return Err(HostError::Binding);
        }
        Ok(())
    }

    async fn thread(&self, binding: &Binding, id: &str) -> Result<Option<Projection>, HostError> {
        let reply = self
            .rpc
            .call(
                "orchestration.subscribeThread",
                json!({"threadId": id, "requestCompletionMarker": true, "acceptBoundedSnapshot": false}),
                Read::Thread,
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
        if let (Some(thread), Some(parent)) = (&thread, &wire.parent)
            && !thread.belongs_to_parent(parent)
        {
            return Err(HostError::Binding);
        }
        let state = match &thread {
            Some(thread) => thread.run(&wire.message_id(&launch.instance))?,
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
        thread: &str,
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
            .get_or_init(|| async {
                let server = self
                    .host
                    .runtime_descriptor
                    .as_deref()
                    .and_then(|path| ServerRuntime::read(path, self.host.rpc.endpoint()));
                Inventory::capture(server).await
            })
            .await
            .as_ref()
            .map_err(|_| HostError::ProcessCoverage)?;
        let checkout = Path::new(&binding.worktree_path);
        let activity = match self.scratch {
            Some(scratch) => inventory
                .activity_for(checkout, scratch, thread)
                .await
                .map_err(|_| HostError::ProcessCoverage)?,
            None => inventory.activity(checkout, &std::collections::HashSet::new())?,
        };
        match activity {
            Activity::Busy => Ok(false),
            Activity::Quiet => Ok(true),
            Activity::Unknown => Err(HostError::ProcessCoverage),
        }
    }
}

impl TaskHost for T3Pass<'_> {
    fn prepare_launch(&self, request: LaunchRequest<'_>) -> Result<LaunchInputs, HostError> {
        let parent = request.parent.as_ref().map(|parent| parent.thread.clone());
        let (dispatch, thread) = match request.via {
            Launch::Create if let Some(parent) = request.parent => (
                Dispatch::Delegate {
                    title: request.title,
                    profile: request.profile.clone(),
                    parent,
                },
                delegated_child(request.instance),
            ),
            Launch::Create => (
                Dispatch::Create {
                    title: request.title,
                    profile: request.profile.clone(),
                },
                format!("thread:{}", request.instance),
            ),
            Launch::Continue { thread } => (Dispatch::Continue, thread.clone()),
            Launch::SendPrepared => return Err(HostError::Binding),
        };
        RunRequest {
            binding: request.binding,
            parent,
            dispatch,
            text: request.text,
        }
        .inputs(request.instance, thread, request.started_at)
    }
    async fn observe_retained(&self, binding: &Binding, thread: &str) -> Result<Host, HostError> {
        let projection = self.host.thread(binding, thread).await?;
        let state = if self.quiet(binding, thread, projection.as_ref()).await? {
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

    async fn observe_run(&self, run: &Run, now_ms: u64) -> Result<RunObservation, HostError> {
        if run.revoked() {
            return Err(HostError::Binding);
        }
        let wire = Wire::read(run)?;
        let (thread, state) = self.host.delivery(run, &wire).await?;
        if state == RunState::ReadyToSend && awaiting_reply(run, now_ms) {
            return Err(HostError::Uncertain);
        }
        let state = if matches!(state, RunState::Ended | RunState::Gone)
            && !self
                .quiet(&wire.binding, &run.launch().thread, thread.as_ref())
                .await?
        {
            RunState::Running
        } else {
            state
        };
        let activity =
            thread.and_then(|thread| thread.activity(&wire.message_id(&run.launch().instance)));
        Ok(RunObservation {
            host: current(run, state),
            activity,
        })
    }

    async fn authorize_send(&self, run: &Run) -> Result<ReplayAuthorization, HostError> {
        if run.rejected_awaiting_archive()
            || awaiting_reply(run, clock_ms()?)
            || (run.revoked() && run.last_send_at_ms().is_none())
        {
            return Err(HostError::Uncertain);
        }
        let wire = Wire::read(run)?;
        if let Some(parent) = &wire.parent
            && self.host.thread(&wire.binding, parent).await?.is_none()
        {
            return Err(HostError::Uncertain);
        }
        let (thread, state) = self.host.delivery(run, &wire).await?;
        if state != RunState::ReadyToSend
            || !self
                .quiet(&wire.binding, &run.launch().thread, thread.as_ref())
                .await?
        {
            return Err(HostError::Uncertain);
        }
        Ok(ReplayAuthorization {
            instance: run.launch().instance.clone(),
            thread: run.launch().thread.clone(),
            input: run.launch().input.clone(),
            archived: wire.method == Method::Continue
                && thread.is_some_and(|thread| thread.archived()),
            wire,
            prior_send: run.last_send_at_ms(),
            revoked: run.revoked(),
        })
    }

    async fn write_control(&self, dispatch: ControlDispatch) -> Result<(), HostError> {
        self.host.thread_command(dispatch.payload).await
    }

    async fn send(&self, dispatch: RunDispatch) -> Result<SendOutcome, HostError> {
        let wire = dispatch.wire;
        let reply = self
            .host
            .rpc
            .call(wire.method.rpc(), wire.payload.as_ref(), Read::One)
            .await;
        if matches!(&reply, Ok(Reply::Failure(cause)) if rejected(cause, &wire, &dispatch.instance))
        {
            return Ok(SendOutcome::Rejected);
        }
        self.sent.store(true, Ordering::Release);
        match reply? {
            Reply::Value(_) => Ok(SendOutcome::Sent),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }

    async fn stop(
        &self,
        run: &Run,
        expected: &Binding,
        now_ms: u64,
        archive: bool,
    ) -> Result<StopProgress, HostError> {
        if !run.revoked() {
            return Err(HostError::Binding);
        }
        if run.last_send_at_ms().is_none() {
            return Ok(StopProgress::Settled(current(run, RunState::ReadyToSend)));
        }
        let launch = run.launch();
        let wire = Wire::read(run)?;
        if wire.binding != *expected {
            return Err(HostError::Binding);
        }
        if run.rejected_awaiting_archive() {
            return self.observe_rejected_archive(run, &wire).await;
        }
        let (thread, state) = self.host.delivery(run, &wire).await?;
        if let Some((command, target)) = thread
            .as_ref()
            .and_then(|thread| thread.stop_command(&wire.message_id(&launch.instance)))
        {
            return Ok(StopProgress::Write(ControlDispatch {
                binding: wire.binding,
                payload: json!({
                    "type": command, "commandId": format!("{}-{command}", launch.instance),
                    "threadId": launch.thread, "runId": target,
                }),
            }));
        }
        match state {
            RunState::ReadyToSend if !awaiting_reply(run, now_ms) => Ok(StopProgress::ReplayDue),
            RunState::Ended | RunState::Gone
                if self
                    .quiet(&wire.binding, &launch.thread, thread.as_ref())
                    .await? =>
            {
                if archive
                    && state == RunState::Ended
                    && thread.is_some_and(|thread| !thread.archived())
                {
                    return Ok(archive_command(run, &wire));
                }
                Ok(StopProgress::Settled(current(run, state)))
            }
            _ => Ok(StopProgress::Waiting),
        }
    }
}

impl T3Pass<'_> {
    async fn observe_rejected_archive(
        &self,
        run: &Run,
        wire: &Wire,
    ) -> Result<StopProgress, HostError> {
        let settled = StopProgress::Settled(current(run, RunState::Rejected));
        let Some(thread) = self
            .host
            .thread(&wire.binding, &run.launch().thread)
            .await?
        else {
            return Ok(settled);
        };
        if thread.retained()? == RetainedThread::Gone {
            return Ok(settled);
        }
        if !self
            .quiet(&wire.binding, &run.launch().thread, Some(&thread))
            .await?
        {
            return Ok(StopProgress::Waiting);
        }
        Ok(if thread.archived() {
            settled
        } else {
            archive_command(run, wire)
        })
    }
}

fn archive_command(run: &Run, wire: &Wire) -> StopProgress {
    let launch = run.launch();
    StopProgress::Write(ControlDispatch {
        binding: wire.binding.clone(),
        payload: json!({
            "type":"thread.archive", "commandId":format!("{}-archive", launch.instance), "threadId":launch.thread,
        }),
    })
}

fn clock_ms() -> Result<u64, HostError> {
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| HostError::Uncertain)?;
    u64::try_from(clock.as_millis()).map_err(|_| HostError::Uncertain)
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
    if wire.method == Method::Continue || wire.method == Method::Delegate {
        let command = if wire.method == Method::Delegate {
            "delegated_task.request"
        } else {
            "message.dispatch"
        };
        return command_rejected(cause, instance, command);
    }
    let Some(error) = command_failure(cause, instance) else {
        return false;
    };
    let defect = &error["cause"];
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

fn dispatch_rejected(cause: &Value, id: &str) -> bool {
    command_rejected(cause, id, "message.dispatch")
}

fn command_rejected(cause: &Value, id: &str, command: &str) -> bool {
    command_failure(cause, id).is_some_and(|error| {
        error["_tag"] == "OrchestrationV2DispatchCommandError"
            && error["commandType"] == command
            && rejected_command(&error["cause"], id, command)
    })
}

fn command_failure<'a>(cause: &'a Value, id: &str) -> Option<&'a Value> {
    let [reason] = cause.as_array()?.as_slice() else {
        return None;
    };
    let error = &reason["error"];
    (reason["_tag"] == "Fail" && error["commandId"] == id).then_some(error)
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
            parent: None,
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
