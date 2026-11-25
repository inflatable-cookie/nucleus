//! Host observation and delivery for the isolated Rust task engine.

mod admission;
mod assignment;
mod catalog;
mod inbox;
mod launch;
mod parenting;
mod process;
mod projection;
mod provider_setup;
mod questions;
mod rpc;
mod runtime;
#[cfg(test)]
mod t3_tests;
mod task_row;
mod theme;
mod thread_snapshots;
mod title_shell;
mod traffic;

use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub use assignment::{T3_ASSIGNMENT_LIMIT, assignment_units};
pub use catalog::{ProfileCatalog, ProfileOffer};
pub use inbox::{
    INBOX_THREAD, InboxOperatorMessage, InboxPreviewError, InboxStatus, InboxStep, InboxTarget,
    InboxWrite,
};
pub use launch::{
    Binding, Dispatch, ModelOption, RoleProfile, RunRequest, child_origin_instance,
    launch_diagnostic, launch_provider_instance, unpinned_worker_continuation,
};
use launch::{Method, Wire, delegated_child, message_id};
use nucleus_core::{Host, Launch, LaunchInputs, RetainedThread, Role, Run, RunState, Task};
pub use parenting::{
    ActiveChild, ArchiveWrite, DoneArchive, FrozenParentWrite, ParentAttempt, ParentRun,
    ParentSendError, ParentStep, ParentWrite, is_parent_reentry, is_pinned_parent_hold,
    parent_thread,
};
/// A link within the same T3 environment as the task thread.
#[must_use]
pub fn thread_link(thread: &str) -> Option<String> {
    (!thread.is_empty()
        && thread
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:%".contains(&byte)))
    .then(|| format!("t3-thread://v1/{thread}"))
}

pub use process::ProcessEvidenceFailure;
use process::{Activity, Inventory};
pub use projection::RunActivity;
use projection::{MissingReceipt, Projection};
pub use provider_setup::{
    NUCLEUS_RUST_PROVIDER, ProviderRegistration, ProviderSetup, ProviderSetupError,
};
pub use questions::{
    NoticeAuthorization, NoticeDispatch, NoticeHost, NoticeObservation, NoticeSend, NoticeState,
    NoticeTarget, NoticeWrite, PlannerIdentity, PlannerThread,
};
pub use rpc::ThreadHint;
use rpc::{Read, Reply, Rpc, ThreadReply, closed_row};
use runtime::ServerRuntime;
use serde_json::{Value, json};
pub use task_row::{RowChange, RowChildren, RowObservation, RowVisibility, snooze_deadline};
use thread_snapshots::{ShellCustody, ThreadRead, row_activity};
pub use title_shell::TitleTarget;
use tokio::sync::OnceCell;
pub use traffic::HostCalls;

pub const LATE_REPLY_MS: u64 = 10 * 60 * 1000;
pub const T3_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(15);

pub struct LaunchRequest<'a> {
    pub binding: Binding,
    pub parent: Option<ParentRun>,
    pub reuse_parent: bool,
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
    #[error("the retained role thread binding changed before the send")]
    RetainedBindingChanged,
    #[error("the host observation or mutation outcome is unknown")]
    Uncertain,
    #[error("T3 rejected the pinned parent hold")]
    ParentHoldRejected,
    #[error("the operator snoozed the destination until {until} ms")]
    OperatorSnoozed { until: u64 },
    #[error("the operator snoozed the retained role thread’s parent until {until} ms")]
    RetainedParentSnoozed { until: u64 },
    #[error(
        "the retained thread read returned no thread while the held shell still listed it (held revision {revision:?})"
    )]
    HeldThreadMissing { revision: Option<u64> },
    #[error(
        "the retained thread at revision {revision} lacks idle proof (provider roster {providers}, turn items {turn_items}, shell background coverage {shell_background})"
    )]
    RetainedIdleCoverage {
        revision: u64,
        providers: bool,
        turn_items: bool,
        shell_background: bool,
    },
    #[error(
        "parent message preflight failed: {predicate} (prepared revision {prepared}, observed revision {observed:?})"
    )]
    ParentPreflight {
        predicate: &'static str,
        prepared: u64,
        observed: Option<u64>,
    },
    #[error("parent row is snoozed until {until} ms (verified revision {revision})")]
    ParentSnoozed { until: u64, revision: u64 },
    #[error(
        "parent shell {field} changed after verification (prepared revision {prepared}, observed revision {observed:?}, expected {before:016x}, observed {after:016x}, custody before {activity_before:?}, custody now {activity_now:?}; values are fingerprints)"
    )]
    ParentShellChanged {
        field: &'static str,
        prepared: u64,
        observed: Option<u64>,
        before: u64,
        after: u64,
        activity_before: RowChildren,
        activity_now: RowChildren,
    },
    #[error("the held shell could not confirm all recorded role children are quiet")]
    RowChildBusy,
    #[error("the local process census could not confirm workspace custody: {0}")]
    ProcessCoverage(ProcessEvidenceFailure),
    #[error("the frozen assignment exceeds T3's 120,000-character input limit")]
    AssignmentLimit,
    #[error("a process still occupies the task checkout or run scratch directory")]
    WorkspaceBusy,
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

    #[must_use]
    pub fn command_id(&self) -> Option<&str> {
        self.payload["commandId"].as_str()
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
    wake: Option<ControlDispatch>,
    parent_row: Option<RowObservation>,
    queued_continuation: bool,
}

/// Frozen native write whose send marker must be committed before dispatch.
pub struct RunDispatch {
    instance: String,
    wire: Wire,
    queued_continuation: bool,
    owned_parent_snoozes: Vec<u64>,
}

impl RunDispatch {
    /// Pass the exact parent horizons owned by the task’s presentation record.
    pub fn allow_owned_parent_snoozes(&mut self, horizons: Vec<u64>) {
        self.owned_parent_snoozes = horizons;
    }
}

impl ReplayAuthorization {
    #[must_use]
    pub const fn binding(&self) -> &Binding {
        &self.wire.binding
    }

    #[must_use]
    pub const fn parent_row(&self) -> Option<RowObservation> {
        self.parent_row
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

    /// The parent of a queued role continuation, if it has one.
    #[must_use]
    pub fn queued_parent(&self) -> Option<&str> {
        self.wire
            .parent
            .as_deref()
            .filter(|_| self.queued_continuation)
    }

    /// Get the explicit wake for continuations using the visibility fence.
    #[must_use]
    pub fn unsettle(&self) -> Option<ControlDispatch> {
        self.wake.clone()
    }

    /// Apply the marker to the exact task used to prepare the authorization.
    /// Persist the resulting task before using the authorization on the wire.
    ///
    /// # Errors
    /// Returns an error if the run or its delivery state changed after authorization.
    pub fn record(self, task: &mut nucleus_core::Task) -> Result<RunDispatch, HostError> {
        let run = task.run().ok_or(HostError::Binding)?;
        if self.archived
            || self.wake.is_some()
            || run.launch().instance != self.instance
            || run.launch().input != self.input
            || run.revoked() != self.revoked
            || (!run.revoked() && run.report().is_some())
            || run.last_send_at_ms() != self.prior_send
        {
            return Err(HostError::Binding);
        }
        task.record_send(&self.instance, clock_ms()?)
            .map_err(|_| HostError::Binding)?;
        Ok(RunDispatch {
            instance: self.instance,
            queued_continuation: self.queued_continuation,
            owned_parent_snoozes: Vec::new(),
            wire: self.wire,
        })
    }
}

/// Decision evidence and optional presentation from the same exact native read.
#[derive(Debug)]
pub struct RunObservation {
    pub host: Host,
    pub activity: Option<RunActivity>,
    pub provider_limit: Option<ProviderLimit>,
    pub routing: Option<RunRouting>,
    pub active_child: Option<ActiveChild>,
}

/// Provider and model recorded on the exact native run after it started.
#[derive(Debug, PartialEq, Eq)]
pub struct RunRouting {
    pub provider: String,
    pub model: String,
}

/// Terminal usage-limit evidence for the exact native run.
#[derive(Debug, PartialEq, Eq)]
pub struct ProviderLimit {
    pub instance: String,
    pub ended_at_ms: u64,
    pub reset_at_ms: Option<u64>,
}

/// The service serializes commands and effects for each task and persists
/// the authorized send marker immediately before using it on the wire.
pub trait TaskHost: Send + Sync {
    fn profile_catalog(&self) -> impl Future<Output = Result<&ProfileCatalog, HostError>> + Send;

    /// Prepare the host's immutable launch inputs and native identity.
    /// # Errors
    /// Returns an error when the launch is unsupported or cannot be encoded.
    fn prepare_launch(&self, request: LaunchRequest<'_>) -> Result<LaunchInputs, HostError>;

    fn observe_retained(
        &self,
        binding: &Binding,
        thread: &str,
    ) -> impl Future<Output = Result<Host, HostError>> + Send;

    fn observe_retained_role(
        &self,
        binding: &Binding,
        thread: &str,
    ) -> impl Future<Output = Result<Host, HostError>> + Send {
        self.observe_retained(binding, thread)
    }

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

pub struct RegisteredProject {
    pub root: String,
    pub title: Option<String>,
}

impl RegisteredProject {
    fn read(row: &Value) -> Option<Self> {
        Some(Self {
            root: row["workspaceRoot"]
                .as_str()
                .filter(|root| !closed_row(row) && !root.is_empty())?
                .into(),
            title: row["title"].as_str().map(str::to_owned),
        })
    }
}

pub struct T3 {
    rpc: Rpc,
    runtime_descriptor: Option<PathBuf>,
}

/// Exact T3 reads share a single bounded process inventory within each pass.
pub struct T3Pass<'a> {
    host: &'a T3,
    evidence: Arc<PassEvidence>,
    scratch: Option<&'a Path>,
    run_scratch: Option<PathBuf>,
    role_threads: [Option<String>; 2],
}

#[derive(Default)]
struct PassEvidence {
    profiles: OnceCell<Result<Arc<ProfileCatalog>, HostError>>,
    processes: OnceCell<Result<Inventory, HostError>>,
    sent: AtomicBool,
}

impl T3 {
    /// Start serving shell reads from the service's sole live subscription.
    pub fn use_held_shell(&self) {
        self.rpc.use_held_shell();
    }

    /// The next time a transport request may be attempted.
    #[must_use]
    pub fn request_retry_at(&self) -> Option<tokio::time::Instant> {
        self.rpc.retry_at()
    }

    #[must_use]
    pub fn host_calls(&self) -> HostCalls {
        self.rpc.traffic.totals()
    }

    pub async fn wait_for_requests(&self) {
        while let Some(until) = self.request_retry_at() {
            tokio::time::sleep_until(until).await;
        }
    }

    pub async fn count_pass_calls<T>(work: impl Future<Output = T>) -> (T, HostCalls) {
        traffic::measure(work).await
    }

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

    /// Identify the local host session without issuing another host request.
    /// Hosts without a configured descriptor use their endpoint identity.
    #[must_use]
    pub fn runtime_identity(&self) -> Option<String> {
        match self.runtime_descriptor.as_deref() {
            Some(descriptor) => {
                ServerRuntime::read(descriptor, self.rpc.endpoint()).map(|server| server.identity())
            }
            None => Some(self.endpoint().to_owned()),
        }
    }

    /// Identify the running native process that owns this store's receipts.
    #[must_use]
    pub fn verified_runtime_identity(&self) -> Option<String> {
        self.runtime_descriptor.as_deref().and_then(|descriptor| {
            ServerRuntime::read(descriptor, self.rpc.endpoint()).map(|server| server.identity())
        })
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
            evidence: Arc::new(PassEvidence::default()),
            scratch: Some(scratch),
            run_scratch: None,
            role_threads: [None, None],
        }
    }

    /// Give a loopback RPC fixture a known process census.
    #[cfg(any(test, feature = "loopback-fixture"))]
    #[must_use]
    pub fn fixture_pass(&self) -> T3Pass<'_> {
        T3Pass {
            host: self,
            evidence: Arc::new(PassEvidence {
                processes: OnceCell::new_with(Some(Ok(Inventory::quiet_fixture()))),
                ..PassEvidence::default()
            }),
            scratch: None,
            run_scratch: None,
            role_threads: [None, None],
        }
    }

    /// Stream thread change hints over a socket independent of exact reads.
    /// A successful return means the synchronized stream reached planned rotation.
    /// # Errors
    /// Returns an error on disconnect or if the listener missed a hint.
    pub async fn watch_threads(
        &self,
        hints: &tokio::sync::mpsc::Sender<ThreadHint>,
        _title_provider: Option<&str>,
        inbox_thread: Option<&str>,
    ) -> Result<(), HostError> {
        let result = self
            .rpc
            .watch_threads(hints, inbox_thread)
            .await
            .inspect_err(|error| {
                self.rpc
                    .stream_failed("orchestration.subscribeShell", *error);
            });
        self.rpc.clear_shell();
        result
    }

    /// Follow the environment's theme settings and published themes. The
    /// cached value stays while the stream reconnects.
    /// # Errors
    /// Returns an error on disconnect or a malformed stream.
    pub async fn watch_theme(
        &self,
        theme: &tokio::sync::watch::Sender<Option<Value>>,
    ) -> Result<(), HostError> {
        let outcome = self.rpc.watch_theme(theme).await;
        self.rpc.invalidate_catalog();
        outcome.inspect_err(|error| {
            self.rpc.stream_failed("subscribeServerConfig", *error);
        })
    }

    /// Read the board-safe projection of the cached provider catalog.
    /// Resolve an observed provider instance from the current cached catalog.
    #[must_use]
    pub fn cached_provider_family(
        &self,
        instance: &str,
    ) -> Option<nucleus_core::profiles::Provider> {
        self.rpc.cached_provider_family(instance)
    }

    #[must_use]
    pub fn board_catalog(&self) -> Value {
        self.rpc.board_catalog()
    }

    /// Subscribe to changes in the cached provider catalog.
    #[must_use]
    pub fn catalog_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.rpc.catalog_changes()
    }

    /// Verify that the selected project is active at the expected local root.
    /// This configuration read is independent of cycle observations.
    ///
    /// # Errors
    /// Returns an error when the project or snapshot cannot be verified.
    pub async fn check_project(&self, id: &str, root: &str) -> Result<(), HostError> {
        if self.registered_project(id).await?.root != root {
            return Err(HostError::Binding);
        }
        Ok(())
    }

    /// Resolve the exact registered local root for an active native project.
    ///
    /// # Errors
    /// Returns an error when the project or snapshot cannot be verified.
    pub async fn registered_project(&self, id: &str) -> Result<RegisteredProject, HostError> {
        if self.projects_synchronized() {
            return self.cached_project(id);
        }
        let snapshot = self.rpc.shell(json!({"requestCompletionMarker": true, "omitIdleSubagents": true, "omitOlderSettled": true})).await?;
        let projects = snapshot
            .pointer("/snapshot/projects")
            .and_then(Value::as_array)
            .ok_or(HostError::Protocol)?;
        let mut matched = projects.iter().filter(|project| project["id"] == id);
        let project = matched
            .next()
            .and_then(RegisteredProject::read)
            .ok_or(HostError::Binding)?;
        if matched.next().is_some() {
            return Err(HostError::Binding);
        }
        Ok(project)
    }

    async fn thread(&self, binding: &Binding, id: &str) -> Result<Option<Projection>, HostError> {
        self.read_thread(binding, id, ThreadRead::Exact).await
    }

    async fn read_thread(
        &self,
        binding: &Binding,
        id: &str,
        policy: ThreadRead,
    ) -> Result<Option<Projection>, HostError> {
        Ok(self.observe_thread(binding, id, policy).await?.0)
    }

    async fn observe_thread(
        &self,
        binding: &Binding,
        id: &str,
        policy: ThreadRead,
    ) -> Result<(Option<Projection>, rpc::ThreadFence), HostError> {
        let rpc::ThreadObservation { reply, fence } = self.rpc.observe_thread(id, policy).await?;
        let projection = match reply {
            ThreadReply::Closed { row, sequence } => {
                Some(Projection::closed(&row, sequence, binding, id)?)
            }
            ThreadReply::Snapshot(value) => {
                let mut projection = Projection::parse(value, binding, id)?;
                if let Some(row) = &fence.row {
                    projection.use_shell_background(row, fence.covers(projection.sequence()));
                }
                Some(projection)
            }
            ThreadReply::Missing => None,
        };
        Ok((projection, fence))
    }

    async fn delivery(
        &self,
        run: &Run,
        wire: &Wire,
        policy: ThreadRead,
    ) -> Result<(Option<Projection>, RunState), HostError> {
        let launch = run.launch();
        let thread = self
            .read_thread(&wire.binding, &launch.thread, policy)
            .await?;
        if let (Some(thread), Some(parent)) = (&thread, &wire.parent)
            && !thread.belongs_to_parent(parent, false)
        {
            return Err(HostError::Binding);
        }
        let state = match &thread {
            Some(thread)
                if thread.archived_in_shell()
                    && wire.method == Method::Continue
                    && run.last_send_at_ms().is_none()
                    && !run.revoked() =>
            {
                // This only permits unarchiving. A send still needs a live exact read.
                RunState::ReadyToSend
            }
            Some(thread) => thread.run(
                &wire.message_id(&launch.instance),
                missing_receipt(run, wire),
            )?,
            None if wire.method == Method::Continue => RunState::Gone,
            None => RunState::ReadyToSend,
        };
        Ok((thread, state))
    }

    fn terminal_role_quiet(&self, wire: &Wire, thread: &str, terminal_revision: u64) -> bool {
        self.rpc.with_shell(|shell| {
            shell
                .filter(|shell| shell.revision().is_some_and(|seq| seq >= terminal_revision))
                .and_then(|shell| shell.marker(thread))
                .is_some_and(|row| {
                    retained_row_matches(wire, &row) && row_activity(&row) == RowChildren::Quiet
                })
        })
    }

    fn verify_retained_target(
        &self,
        wire: &Wire,
        owned_parent_snoozes: &[u64],
    ) -> Result<(), HostError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RetainedTarget<'a> {
            thread_id: &'a str,
        }
        let target: RetainedTarget<'_> = serde_json::from_str(wire.payload.get())
            .map_err(|_| HostError::RetainedBindingChanged)?;
        let row = self
            .rpc
            .thread_row(target.thread_id)
            .ok_or(HostError::RetainedBindingChanged)?;
        let parent = wire.parent.as_deref();
        if !retained_row_matches(wire, &row)
            || !row["archivedAt"].is_null()
            || !row["deletedAt"].is_null()
        {
            return Err(HostError::RetainedBindingChanged);
        }
        if let Some(parent) = parent
            && let Some(row) = self.rpc.thread_row(parent)
        {
            task_row::check_delivery_snooze(&row, owned_parent_snoozes).map_err(
                |error| match error {
                    HostError::OperatorSnoozed { until } => {
                        HostError::RetainedParentSnoozed { until }
                    }
                    error => error,
                },
            )?;
        }
        task_row::check_delivery_snooze(&row, &[])
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
    /// Scope custody to the task's recorded roles and current run scratch.
    #[must_use]
    pub fn for_task(&self, task: &Task, run_scratch: Option<PathBuf>) -> Self {
        Self {
            host: self.host,
            evidence: Arc::clone(&self.evidence),
            scratch: self.scratch,
            run_scratch,
            role_threads: [Role::Worker, Role::Reviewer]
                .map(|role| task.threads().get(role).map(str::to_owned)),
        }
    }

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
        if self.evidence.sent.load(Ordering::Acquire) {
            // A fresh launch may have started processes after this inventory.
            return Err(HostError::Uncertain);
        }
        let inventory = self
            .evidence
            .processes
            .get_or_init(|| async {
                let server = self
                    .host
                    .runtime_descriptor
                    .as_deref()
                    .and_then(|path| ServerRuntime::read(path, self.host.rpc.endpoint()));
                let scratch = self.scratch.ok_or(HostError::Configuration)?;
                Inventory::capture(server, scratch).await
            })
            .await
            .as_ref()
            .map_err(|&error| process::coverage_error(error))?;
        let checkout = Path::new(&binding.worktree_path);
        let mut runtime = inventory.standing_pids(thread);
        for sibling in self
            .role_threads
            .iter()
            .flatten()
            .filter(|id| *id != thread)
        {
            let helpers = inventory.bound_helpers(checkout, sibling);
            if !helpers.is_empty()
                && let Some(observed) = self.host.thread(binding, sibling).await?
                && observed.retained()? == RetainedThread::Idle
            {
                runtime.extend(helpers);
            }
        }
        let activity = match self.scratch {
            Some(scratch) => inventory
                .activity_for(checkout, self.run_scratch.as_deref(), scratch, &runtime)
                .await
                .map_err(process::coverage_error)?,
            None => inventory.activity(checkout, &runtime)?,
        };
        match activity {
            Activity::Busy => Ok(false),
            Activity::Quiet => Ok(true),
            Activity::Unknown(pid) => Err(HostError::ProcessCoverage(
                pid.map_or(ProcessEvidenceFailure::Incomplete, |pid| {
                    ProcessEvidenceFailure::Cwd { pid }
                }),
            )),
        }
    }
}

impl TaskHost for T3Pass<'_> {
    async fn profile_catalog(&self) -> Result<&ProfileCatalog, HostError> {
        self.evidence
            .profiles
            .get_or_init(|| self.host.rpc.profile_catalog())
            .await
            .as_ref()
            .map(Arc::as_ref)
            .map_err(|error| *error)
    }

    fn prepare_launch(&self, request: LaunchRequest<'_>) -> Result<LaunchInputs, HostError> {
        let parent = request
            .parent
            .as_ref()
            .map(|parent| parent.thread.clone())
            .or_else(|| {
                request
                    .reuse_parent
                    .then(|| parent_thread(Path::new(&request.binding.worktree_path)))
            });
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
            Launch::Continue { thread } => (
                Dispatch::Continue {
                    profile: Some(request.profile.clone()),
                },
                thread.clone(),
            ),
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
        let projection = self
            .host
            .read_thread(binding, thread, ThreadRead::Observation)
            .await?;
        let retained = projection
            .as_ref()
            .map_or(Ok(RetainedThread::Gone), Projection::retained)?;
        let state =
            if retained == RetainedThread::Busy || !self.quiet(binding, thread, None).await? {
                RetainedThread::Busy
            } else {
                retained
            };
        Ok(Host::Retained {
            thread: thread.into(),
            state,
        })
    }

    async fn observe_retained_role(
        &self,
        binding: &Binding,
        thread: &str,
    ) -> Result<Host, HostError> {
        let projection = self
            .host
            .read_thread(binding, thread, ThreadRead::Observation)
            .await?;
        let state = if projection.is_some_and(|view| !view.deleted()) {
            RetainedThread::Queueable
        } else {
            RetainedThread::Gone
        };
        Ok(Host::Retained {
            thread: thread.into(),
            state,
        })
    }

    async fn observe_run(&self, run: &Run, now_ms: u64) -> Result<RunObservation, HostError> {
        if run.revoked() || run.report().is_some() {
            return Err(HostError::Binding);
        }
        let wire = Wire::read(run)?;
        if run.last_send_at_ms().is_none() && wire.assignment_too_large() {
            return Ok(assignment_rejected(run));
        }
        let (thread, state) = self
            .host
            .delivery(run, &wire, ThreadRead::Observation)
            .await?;
        if thread.is_none() && self.closed_delegation(run, &wire).await? {
            return Ok(RunObservation {
                host: current(run, RunState::ParentEnded),
                activity: None,
                provider_limit: None,
                routing: None,
                active_child: None,
            });
        }
        if state == RunState::ReadyToSend
            && !queued_continuation(run, &wire)
            && (awaiting_reply(run, now_ms)
                || (worker_continuation(run, &wire) && run.last_send_at_ms().is_some()))
        {
            return Err(HostError::Uncertain);
        }
        let background_pending = match &thread {
            Some(thread) if state == RunState::Ended => {
                // The exact run proves the end. A synchronized, bound shell can
                // prove an empty background roster at that revision or later.
                !self
                    .host
                    .terminal_role_quiet(&wire, &run.launch().thread, thread.sequence())
                    && thread.terminal_background_pending()?
            }
            _ => false,
        };
        let message = wire.message_id(&run.launch().instance);
        if !background_pending
            && state == RunState::Ended
            && thread
                .as_ref()
                .is_some_and(|thread| thread.rejected_assignment(&message))
        {
            return Ok(assignment_rejected(run));
        }
        let provider_limit = thread
            .as_ref()
            .filter(|_| state == RunState::Ended)
            .and_then(|thread| thread.provider_limit(&message));
        let state = if background_pending {
            RunState::Running
        } else if provider_limit.is_some() {
            RunState::UsageLimited
        } else if state == RunState::Ended
            && !thread
                .as_ref()
                .is_some_and(|thread| thread.has_exact_run(&message))
        {
            // A steer's linked turn can settle a report or a stop, but it
            // cannot prove that the assignment ran without reporting.
            RunState::IdleWithoutTerminalRun
        } else {
            state
        };
        let routing = thread
            .as_ref()
            .and_then(|thread| thread.run_routing(&message));
        let active_child = ActiveChild {
            binding: wire.binding,
            thread: run.launch().thread.clone(),
            instance: run.launch().instance.clone(),
            native: thread
                .as_ref()
                .and_then(|thread| thread.owned_active_run(&message))
                .map(str::to_owned),
        };
        let active_child = self
            .host
            .active_child_in_shell(&active_child)
            .then_some(active_child);
        let activity = thread.and_then(|thread| thread.activity(&message));
        Ok(RunObservation {
            host: current(run, state),
            activity,
            provider_limit,
            routing,
            active_child,
        })
    }

    async fn authorize_send(&self, run: &Run) -> Result<ReplayAuthorization, HostError> {
        if run.rejected_awaiting_archive()
            || (run.revoked() && run.last_send_at_ms().is_none())
            || (!run.revoked() && run.report().is_some())
        {
            return Err(HostError::Uncertain);
        }
        let wire = Wire::read(run)?;
        if wire.assignment_too_large() {
            return Err(HostError::AssignmentLimit);
        }
        let continuation = wire.method == Method::Continue;
        let worker = worker_continuation(run, &wire);
        let queued = queued_continuation(run, &wire);
        if !queued && (worker || awaiting_reply(run, clock_ms()?)) {
            return Err(HostError::Uncertain);
        }
        let parent_row = if !queued && let Some(parent) = &wire.parent {
            let projection = self
                .host
                .thread(&wire.binding, parent)
                .await?
                .ok_or(HostError::Uncertain)?;
            if let Some(run) = wire.delegated_parent_run()?
                && !projection.active_run(&run)
            {
                return Err(HostError::Uncertain);
            }
            if !run.revoked() && continuation {
                projection.row_observation()?
            } else {
                None
            }
        } else {
            None
        };
        let policy = if queued {
            ThreadRead::Observation
        } else {
            ThreadRead::Exact
        };
        let (thread, state) = self.host.delivery(run, &wire, policy).await?;
        if continuation
            && ((!worker && run.launch().profile().is_some())
                || run.report_reminder_for().is_some())
            && !wire.selection.as_ref().is_some_and(|selection| {
                thread
                    .as_ref()
                    .is_some_and(|thread| thread.matches_selection(selection))
            })
        {
            return Err(HostError::Binding);
        }
        if state != RunState::ReadyToSend {
            return Err(HostError::Uncertain);
        }
        if (run.revoked() || (continuation && !queued))
            && !self
                .quiet(&wire.binding, &run.launch().thread, thread.as_ref())
                .await?
        {
            return Err(HostError::WorkspaceBusy);
        }
        let wake = if !worker
            && continuation
            && let Some(projection) = &thread
            && let Some(observed) = projection.row_observation()?
        {
            let now = clock_ms()?;
            let visibility = observed.visibility;
            if visibility.snoozed_until_ms.is_some_and(|until| until > now) {
                // Only the task parent has a snooze we could own.
                return Err(HostError::Uncertain);
            }
            visibility.settled.then(|| {
                let occurrence = visibility.settled_at_ms.unwrap_or_default();
                ControlDispatch {
                    binding: wire.binding.clone(),
                    payload: json!({
                        "type":"thread.unsettle", "commandId":format!("{}-unsettle-{occurrence}", run.launch().instance),
                        "threadId":run.launch().thread, "reason":"user",
                    }),
                }
            })
        } else {
            None
        };
        Ok(ReplayAuthorization {
            instance: run.launch().instance.clone(),
            thread: run.launch().thread.clone(),
            input: run.launch().input.clone(),
            archived: continuation && thread.is_some_and(|thread| thread.archived()),
            wire,
            wake,
            prior_send: run.last_send_at_ms(),
            revoked: run.revoked(),
            parent_row,
            queued_continuation: queued,
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
            .call_guarded(wire.method.rpc(), wire.payload.as_ref(), Read::One, || {
                if dispatch.queued_continuation && self.host.rpc.uses_held_shell() {
                    self.host
                        .verify_retained_target(&wire, &dispatch.owned_parent_snoozes)?;
                }
                Ok(true)
            })
            .await;
        match &reply {
            Ok(Reply::Failure(cause)) => eprintln!(
                "{}: T3 {} refused with {:?}",
                dispatch.instance,
                wire.diagnostic(),
                self.host.rpc.failure_detail(cause)
            ),
            Err(error) => eprintln!("{}: T3 {}: {error}", dispatch.instance, wire.diagnostic()),
            Ok(Reply::Value(_)) => {}
        }
        if matches!(&reply, Ok(Reply::Failure(cause)) if rejected(cause, &wire, &dispatch.instance))
        {
            return Ok(SendOutcome::Rejected);
        }
        self.evidence.sent.store(true, Ordering::Release);
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
        let (thread, state) = self.host.delivery(run, &wire, ThreadRead::Exact).await?;
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
        if thread.is_none() && self.closed_delegation(run, &wire).await? {
            return Ok(StopProgress::Settled(current(run, RunState::ParentEnded)));
        }
        match state {
            RunState::ReadyToSend if worker_continuation(run, &wire) => Ok(StopProgress::Waiting),
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
    async fn closed_delegation(&self, run: &Run, wire: &Wire) -> Result<bool, HostError> {
        let (Some(parent), Some(parent_run)) = (&wire.parent, wire.delegated_parent_run()?) else {
            return Ok(false);
        };
        if !self
            .host
            .thread(&wire.binding, parent)
            .await?
            .is_some_and(|projection| projection.terminal_run(&parent_run))
        {
            return Ok(false);
        }
        // Observe the exact child again after proving its parent can no longer launch it.
        // With no send intent, discarding the reservation cannot abandon child work.
        let (child, state) = self.host.delivery(run, wire, ThreadRead::Exact).await?;
        Ok(child.is_none()
            && state == RunState::ReadyToSend
            && (run.last_send_at_ms().is_none()
                || self
                    .quiet(&wire.binding, &run.launch().thread, None)
                    .await?))
    }

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

fn assignment_rejected(run: &Run) -> RunObservation {
    RunObservation {
        host: current(run, RunState::AssignmentRejected),
        activity: None,
        provider_limit: None,
        routing: None,
        active_child: None,
    }
}

fn retained_row_matches(wire: &Wire, row: &Value) -> bool {
    row["projectId"] == wire.binding.project_id
        && row["worktreePath"] == wire.binding.worktree_path
        && row["branch"] == wire.binding.branch
        && wire
            .parent
            .as_deref()
            .is_none_or(|parent| ShellCustody(row).parent() == Some(parent))
}

fn worker_continuation(run: &Run, wire: &Wire) -> bool {
    run.launch().role == Role::Worker && wire.method == Method::Continue
}

fn queued_continuation(run: &Run, wire: &Wire) -> bool {
    !run.revoked() && wire.method == Method::Continue && wire.pinned
}

fn missing_receipt(run: &Run, wire: &Wire) -> MissingReceipt {
    if queued_continuation(run, wire) || worker_continuation(run, wire) {
        // An older worker wire may be observed, but can never be authorized to send.
        MissingReceipt::Queue
    } else if wire.method == Method::Continue {
        MissingReceipt::LegacyContinuation
    } else {
        MissingReceipt::Fresh
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
            pinned: false,
            binding: binding.clone(),
            parent: None,
            method,
            selection: None,
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
