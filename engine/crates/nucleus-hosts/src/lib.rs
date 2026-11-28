//! Host observation and delivery for the isolated Rust task engine.

macro_rules! host_log {
    ($($arg:tt)*) => {{
        let message = format!($($arg)*).replace(['\r', '\n'], " ");
        if log::log_enabled!(target: "nucleus::serve", log::Level::Warn) {
            log::warn!(target: "nucleus::serve", "{message}");
        } else {
            eprintln!("{} {message}", ::time::OffsetDateTime::now_utc());
        }
    }};
}

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
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub use assignment::{T3_ASSIGNMENT_LIMIT, assignment_units};
pub use catalog::{ProfileCatalog, ProfileOffer};
pub use inbox::{
    INBOX_THREAD, InboxOperatorMessage, InboxPreviewError, InboxStatus, InboxStep, InboxTarget,
    InboxWrite,
};
pub use launch::{
    Binding, Dispatch, ModelOption, RoleProfile, RunRequest, child_origin_instance,
    launch_diagnostic, launch_provider_instance, retained_worker_continuation,
};
use launch::{Method, Wire, delegated_child, message_id};
use nucleus_core::{Host, Launch, LaunchInputs, RetainedThread, Role, Run, RunState, Task};
pub use parenting::{
    ArchiveWrite, DoneArchive, FrozenParentWrite, HoldCheckpoint, ParentRun, ParentSendError,
    ParentShell, ParentSnooze, ParentTurn, ParentWrite, QuietCheckout, SnoozeRestoration,
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

use process::Inventory;
pub use process::ProcessEvidenceFailure;
pub use process::orphans::{OrphanProcess, OrphanScan, verify_orphans};
pub use projection::RunActivity;
use projection::{MissingReceipt, Projection};
pub use provider_setup::{
    NUCLEUS_RUST_PROVIDER, ProviderRegistration, ProviderSetup, ProviderSetupError,
};
pub use questions::{
    NoticeAuthorization, NoticeDispatch, NoticeObservation, NoticeOutcome, NoticeState,
    NoticeTarget, PlannerIdentity, PlannerThread,
};
pub use rpc::ThreadHint;
use rpc::{CallError, Read, Reply, Rpc, ThreadFence, ThreadReply, closed_row};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HostError {
    #[error("the host endpoint, credential or role profile is invalid")]
    Configuration,
    #[error("the host could not be reached")]
    Unavailable,
    #[error("the host read or mutation timed out")]
    Timeout,
    #[error("the host deferred requests until {until:?}")]
    Deferred { until: tokio::time::Instant },
    #[error("waiting for T3 to confirm the role assignment")]
    RoleReplyPending { until: tokio::time::Instant },
    #[error("the host reply could not be confirmed")]
    Protocol,
    #[error("the host thread does not match the configured project and checkout")]
    Binding,
    #[error("T3 cannot confirm report completion: {0}")]
    ReportObservation(&'static str),
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
        "parent message preflight failed: {predicate} (prepared revision {prepared}, observed revision {observed:?})"
    )]
    ParentPreflight {
        predicate: &'static str,
        prepared: u64,
        observed: Option<u64>,
    },
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
    /// The failure happened before any bytes were written to T3.
    NotSent(HostError),
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
    unarchive_fence: Option<ThreadFence>,
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
    unarchive_fence: Option<ThreadFence>,
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
    pub fn unarchive(&self) -> Option<ControlDispatch> {
        self.unarchive_fence.as_ref().map(|fence| ControlDispatch {
            binding: self.wire.binding.clone(),
            unarchive_fence: Some(fence.clone()),
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

    /// Apply the marker to the exact task used to prepare the authorization.
    /// Persist the resulting task before using the authorization on the wire.
    ///
    /// # Errors
    /// Returns an error if the run or its delivery state changed after authorization.
    pub fn record(self, task: &mut nucleus_core::Task) -> Result<RunDispatch, HostError> {
        let run = task.run().ok_or(HostError::Binding)?;
        if self.unarchive_fence.is_some()
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

    /// Identify checkout-owned orphan trees for a terminal task, and the shared
    /// services that only inherited its cwd.
    /// # Errors
    /// Missing host identity or process evidence prevents cleanup.
    fn terminal_orphans(
        &self,
        checkout: &Path,
        scratch: &Path,
    ) -> impl Future<Output = Result<OrphanScan, HostError>> + Send;

    /// Identify helpers a provider app-server left in a terminal task's checkout
    /// (the first root) or run scratch. The caller proves every role has ended.
    /// # Errors
    /// Missing process or checkout evidence prevents cleanup.
    fn terminal_helpers(
        &self,
        roots: &[PathBuf],
        scratch: &Path,
    ) -> impl Future<Output = Result<Vec<OrphanProcess>, HostError>> + Send;

    fn observe_retained_role(
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

pub struct RegisteredProject {
    pub root: String,
    pub title: Option<String>,
    pub default_model_selection: Option<Value>,
    /// T3's canonical `host/owner/name` key for the checkout's origin remote.
    /// Absent until T3 has identified the repository.
    pub origin_key: Option<String>,
}

/// The synchronized shell's answer for one repository checkout.
pub enum RepositoryProject {
    Found(String, RegisteredProject),
    /// T3 holds the folder but hasn't identified its repository yet.
    Unidentified,
    Missing,
}

impl RegisteredProject {
    fn read(row: &Value) -> Option<Self> {
        Some(Self {
            root: row["workspaceRoot"]
                .as_str()
                .filter(|root| !closed_row(row) && !root.is_empty())?
                .into(),
            title: row["title"].as_str().map(str::to_owned),
            default_model_selection: row
                .get("defaultModelSelection")
                .filter(|value| value.is_object())
                .cloned(),
            // A fork's canonical key names its upstream; `origin` then names the origin remote.
            origin_key: row
                .pointer("/repositoryIdentity/origin/canonicalKey")
                .or_else(|| row.pointer("/repositoryIdentity/canonicalKey"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}

pub struct T3 {
    #[cfg(any(test, feature = "loopback-fixture"))]
    fixture_quiet_processes: bool,
    rpc: Arc<Rpc>,
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

#[cfg(test)]
impl T3Pass<'_> {
    pub(crate) fn sent_for_test(&self) -> bool {
        self.evidence.sent.load(Ordering::Acquire)
    }
}

impl T3 {
    /// Read a thread title from the synchronized shell snapshot without a host call.
    #[must_use]
    pub fn cached_thread_title(&self, id: &str) -> Option<String> {
        self.rpc
            .thread_row(id)
            .and_then(|row| row["title"].as_str().map(str::to_owned))
            .filter(|title| !title.trim().is_empty())
    }

    /// Check the recorded worker's turn in the synchronized shell for owner acceptance.
    ///
    /// # Errors
    /// Returns the missing evidence or a refusal if the workspace binding changed.
    pub fn report_worker_idle(&self, binding: &Binding, thread: &str) -> Result<bool, HostError> {
        self.rpc.with_shell(|shell| {
            let row = shell
                .ok_or(HostError::ReportObservation(
                    "the shell is not synchronized",
                ))?
                .marker(thread)
                .ok_or(HostError::ReportObservation(
                    "the retained worker is missing from the shell",
                ))?;
            if !row["deletedAt"].is_null()
                || row["projectId"] != binding.project_id
                || row["worktreePath"] != binding.worktree_path
                || row["branch"] != binding.branch
            {
                return Err(HostError::Binding);
            }
            match ShellCustody(&row).turn_activity() {
                RowChildren::Active => Ok(false),
                RowChildren::Quiet
                    if row["status"] == "idle"
                        || row["latestRunId"].as_str().is_some_and(|id| !id.is_empty()) =>
                {
                    Ok(true)
                }
                _ => Err(HostError::ReportObservation(
                    "the retained worker's turn or input state is unknown",
                )),
            }
        })
    }

    #[cfg(feature = "loopback-fixture")]
    #[doc(hidden)]
    pub fn fixture_disconnect_shell(&self) {
        self.rpc.clear_shell();
    }

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

    /// Counts native thread reads by the evidence the caller needed.
    #[must_use]
    pub fn thread_read_reasons(&self) -> HostCalls {
        self.rpc.traffic.thread_reads()
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
            #[cfg(any(test, feature = "loopback-fixture"))]
            fixture_quiet_processes: false,
            rpc: Arc::new(Rpc::new(endpoint, bearer)?),
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
            Some(_) => self.described_runtime().map(|server| server.identity()),
            None => Some(self.endpoint().to_owned()),
        }
    }

    fn described_runtime(&self) -> Option<ServerRuntime> {
        ServerRuntime::read(self.runtime_descriptor.as_deref()?, self.rpc.endpoint())
    }

    /// Use the connected T3 server's own runtime descriptor for custody checks.
    #[must_use]
    pub fn with_runtime_descriptor(mut self, path: PathBuf) -> Self {
        self.runtime_descriptor = Some(path);
        self
    }

    #[must_use]
    pub fn pass<'a>(&'a self, scratch: &'a Path) -> T3Pass<'a> {
        #[cfg(any(test, feature = "loopback-fixture"))]
        if self.fixture_quiet_processes {
            return self.fixture_pass();
        }
        T3Pass {
            host: self,
            evidence: Arc::new(PassEvidence::default()),
            scratch: Some(scratch),
            run_scratch: None,
            role_threads: [None, None],
        }
    }

    /// Use the quiet process census for passes started inside a loopback service fixture.
    #[cfg(any(test, feature = "loopback-fixture"))]
    #[must_use]
    pub fn with_quiet_fixture_processes(mut self) -> Self {
        self.fixture_quiet_processes = true;
        self
    }

    /// Drop the cached RPC socket so the next request opens a new connection.
    #[cfg(any(test, feature = "loopback-fixture"))]
    #[doc(hidden)]
    pub fn fixture_disconnect(&self) {
        self.rpc.socket_clear_for_test();
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

    /// Resolve an observed provider instance from the current cached catalog.
    #[must_use]
    pub fn cached_provider_family(
        &self,
        instance: &str,
    ) -> Option<nucleus_core::profiles::Provider> {
        self.rpc.cached_provider_family(instance)
    }

    /// Read the current launch catalog from the cache without calling the host.
    #[must_use]
    pub fn cached_profile_catalog(&self) -> Option<std::sync::Arc<ProfileCatalog>> {
        self.rpc.cached_profile_catalog()
    }

    /// Read the board-safe projection of the cached provider catalog.
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
        policy: ThreadRead<'_>,
    ) -> Result<Option<Projection>, HostError> {
        Ok(self.observe_thread(binding, id, policy).await?.0)
    }

    async fn observe_thread(
        &self,
        binding: &Binding,
        id: &str,
        policy: ThreadRead<'_>,
    ) -> Result<(Option<Projection>, rpc::ThreadFence), HostError> {
        let rpc::ThreadObservation { reply, fence } = self.rpc.observe_thread(id, policy).await?;
        let projection = match reply {
            ThreadReply::Closed { row, sequence } => {
                Some(Projection::closed(&row, sequence, binding, id)?)
            }
            ThreadReply::Snapshot(value) => {
                let mut projection = Projection::parse(value, binding, id)?;
                if let Some(row) = &fence.row {
                    projection.use_shell_failure(row, fence.covers(projection.sequence()));
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
        policy: ThreadRead<'_>,
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
                if thread.archived()
                    && !thread.deleted()
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
                || self.terminal_role_quiet(wire, &launch.thread, thread.sequence()),
            )?,
            None if wire.method == Method::Continue => RunState::Gone,
            None => RunState::ReadyToSend,
        };
        Ok((thread, state))
    }

    fn terminal_role_quiet(&self, wire: &Wire, thread: &str, revision: u64) -> bool {
        self.quiet_row_at(thread, revision, |row| retained_row_matches(wire, row))
    }

    fn quiet_row_at(
        &self,
        thread: &str,
        revision: u64,
        matches: impl FnOnce(&Value) -> bool,
    ) -> bool {
        self.rpc.with_shell(|shell| {
            shell.is_some_and(|shell| {
                shell
                    .row_revision(thread)
                    .is_some_and(|(seq, _)| seq >= revision)
                    && shell.marker(thread).is_some_and(|row| {
                        row_activity(&row) == RowChildren::Quiet && matches(&row)
                    })
            })
        })
    }

    async fn projection_quiet(
        &self,
        thread: &str,
        view: &Projection,
        matches: impl FnOnce(&Value) -> bool + Send,
    ) -> Result<bool, HostError> {
        let revision = view.sequence();
        if view.archived() {
            Ok(self
                .quiet_archive_at(thread, revision, matches)
                .await?
                .is_some())
        } else {
            Ok(self.quiet_row_at(thread, revision, matches))
        }
    }

    // The live subscription omits archived rows. Fetch archive evidence only
    // for an exact, already-bound archive, and fence it by live shell changes.
    async fn quiet_archive_at(
        &self,
        thread: &str,
        revision: u64,
        matches: impl FnOnce(&Value) -> bool + Send,
    ) -> Result<Option<ThreadFence>, HostError> {
        let Some(fence) = self
            .rpc
            .with_shell(|shell| shell.map(|shell| self.rpc.fence_at(thread, Some(shell))))
        else {
            return Ok(None);
        };
        let quiet = |row: &Value| {
            row["deletedAt"].is_null()
                && row["archivedAt"].is_string()
                && row_activity(row) == RowChildren::Quiet
                && matches(row)
        };
        let confirmed = if let Some(row) = &fence.row {
            fence.at_or_after(revision) && quiet(row)
        } else {
            let archive = self.archived_shell().await?;
            let rows = archive["threads"].as_array().ok_or(HostError::Protocol)?;
            archive["snapshotSequence"]
                .as_u64()
                .is_some_and(|seq| seq >= revision)
                && rows
                    .iter()
                    .find(|row| row["id"] == thread)
                    .is_some_and(quiet)
        };
        Ok((confirmed && self.rpc.same_thread(thread, &fence)).then_some(fence))
    }

    async fn archived_shell(&self) -> Result<Value, HostError> {
        match self
            .rpc
            .call(
                "orchestration.getArchivedShellSnapshot",
                json!({}),
                Read::Background,
            )
            .await?
        {
            Reply::Value(value) => Ok(value),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
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
}

impl T3Pass<'_> {
    fn terminal_limit(
        &self,
        thread: &Projection,
        message: &str,
        routing: Option<&RunRouting>,
    ) -> Option<ProviderLimit> {
        let mut limit = thread.provider_limit(message)?;
        if let Some(routing) = routing
            && limit
                .reset_at_ms
                .is_none_or(|reset| reset <= limit.ended_at_ms)
        {
            limit.reset_at_ms = self
                .host
                .cached_profile_catalog()
                .and_then(|catalog| catalog.exhausted_reset(routing, limit.ended_at_ms));
        }
        Some(limit)
    }

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
        if let Some(view) = projection.filter(|projection| !projection.deleted())
            && !self
                .host
                .projection_quiet(thread, view, |row| binding.matches_shell_row(row))
                .await?
        {
            return Ok(false);
        }
        let inventory = self.process_inventory().await?;
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
                && self.host.quiet_row_at(sibling, 0, |row| {
                    row["deletedAt"].is_null() && binding.matches_shell_row(row)
                })
            {
                runtime.extend(helpers);
            }
        }
        let scratch = self.run_scratch.as_deref();
        process::verify_roots(&[Some(checkout), scratch])
            .await
            .map_err(process::coverage_error)?;
        Ok(inventory.writer(checkout, scratch, &runtime)?.is_none())
    }

    async fn process_inventory(&self) -> Result<&Inventory, HostError> {
        if self.evidence.sent.load(Ordering::Acquire) {
            // A fresh launch may have started processes after this inventory.
            return Err(HostError::Uncertain);
        }
        self.evidence
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
            .map_err(|&error| process::coverage_error(error))
    }
}

/// A local cwd census used only to protect trash from deletion.
pub struct TrashCensus(Inventory);

impl TrashCensus {
    /// Capture process evidence for one trash sweep.
    ///
    /// # Errors
    /// Returns an error when the local census cannot be read.
    pub async fn capture(scratch: &Path) -> Result<Self, HostError> {
        Inventory::capture(None, scratch).await.map(Self)
    }

    /// Build a scoped census from real wire rows in a fixture.
    #[cfg(feature = "loopback-fixture")]
    #[doc(hidden)]
    pub fn from_fixture_rows(lsof: &[u8], ps: &[u8]) -> Result<Self, HostError> {
        Inventory::from_listings(lsof, ps, rustix::process::geteuid().as_raw(), 0).map(Self)
    }

    /// A listed process working inside the entry leaves it in trash for a later
    /// sweep. A process whose working directory cannot be read does not.
    pub async fn can_remove(&self, entry: &Path) -> bool {
        self.0.trash_clear(entry).await
    }
}

impl TaskHost for T3Pass<'_> {
    async fn terminal_orphans(
        &self,
        checkout: &Path,
        scratch: &Path,
    ) -> Result<OrphanScan, HostError> {
        let inventory = self.process_inventory().await?;
        inventory.terminal_orphans(checkout, scratch).await
    }

    async fn terminal_helpers(
        &self,
        roots: &[PathBuf],
        scratch: &Path,
    ) -> Result<Vec<OrphanProcess>, HostError> {
        let inventory = self.process_inventory().await?;
        inventory.terminal_helpers(roots, scratch).await
    }

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
                    profile: request.profile.clone(),
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
        let message = wire.message_id(&run.launch().instance);
        let policy = if run.last_send_at_ms().is_some() {
            ThreadRead::SentRun(&message)
        } else {
            ThreadRead::Observation
        };
        let (thread, state) = self.host.delivery(run, &wire, policy).await?;
        if thread.is_none() && self.closed_delegation(run, &wire).await? {
            return Ok(RunObservation {
                host: current(run, RunState::ParentEnded),
                activity: None,
                provider_limit: None,
                routing: None,
            });
        }
        if state == RunState::ReadyToSend
            && !queued_continuation(run, &wire)
            && let Some(remaining) = role_reply_wait(run, now_ms)
        {
            return Err(HostError::RoleReplyPending {
                until: tokio::time::Instant::now() + remaining,
            });
        }
        let background_pending =
            if let Some(view) = thread.as_ref().filter(|_| state == RunState::Ended) {
                !self
                    .host
                    .projection_quiet(&run.launch().thread, view, |row| {
                        retained_row_matches(&wire, row)
                    })
                    .await?
            } else {
                false
            };
        if !background_pending
            && state == RunState::Ended
            && thread
                .as_ref()
                .is_some_and(|thread| thread.rejected_assignment(&message))
        {
            return Ok(assignment_rejected(run));
        }
        let routing = thread
            .as_ref()
            .and_then(|thread| thread.run_routing(&message));
        let provider_limit = thread
            .as_ref()
            .filter(|_| state == RunState::Ended)
            .and_then(|thread| self.terminal_limit(thread, &message, routing.as_ref()));
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
        let activity = thread.and_then(|thread| thread.activity(&message));
        Ok(RunObservation {
            host: current(run, state),
            activity,
            provider_limit,
            routing,
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
        if !queued && (worker || role_reply_wait(run, clock_ms()?).is_some()) {
            return Err(HostError::Uncertain);
        }
        if !queued && let Some(parent) = &wire.parent {
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
        }
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
        let id = &run.launch().thread;
        let unarchive_fence = if let Some(archived) = thread
            .as_ref()
            .filter(|view| continuation && view.archived())
        {
            Some(
                self.host
                    .quiet_archive_at(id, archived.sequence(), |row| {
                        retained_row_matches(&wire, row)
                    })
                    .await?
                    .ok_or(HostError::WorkspaceBusy)?,
            )
        } else {
            None
        };
        // The unarchive fence already proves native quiet. A revoked replay also checks local writers.
        let unchecked_thread = thread.as_ref().filter(|_| unarchive_fence.is_none());
        if run.revoked() && !self.quiet(&wire.binding, id, unchecked_thread).await? {
            return Err(HostError::WorkspaceBusy);
        }
        if !worker
            && continuation
            && let Some(projection) = &thread
            && let Some(observed) = projection.row_observation()?
            && let Some(until) = observed.visibility.snoozed_until_ms
            && until > clock_ms()?
        {
            return Err(HostError::Uncertain);
        }
        Ok(ReplayAuthorization {
            instance: run.launch().instance.clone(),
            thread: run.launch().thread.clone(),
            input: run.launch().input.clone(),
            unarchive_fence,
            wire,
            prior_send: run.last_send_at_ms(),
            revoked: run.revoked(),
            queued_continuation: queued,
        })
    }

    async fn write_control(&self, dispatch: ControlDispatch) -> Result<(), HostError> {
        let thread = dispatch.payload["threadId"]
            .as_str()
            .ok_or(HostError::Binding)?
            .to_owned();
        match self
            .host
            .rpc
            .call_guarded(
                "orchestration.dispatchCommand",
                dispatch.payload,
                Read::One,
                || {
                    if dispatch
                        .unarchive_fence
                        .as_ref()
                        .is_some_and(|fence| !self.host.rpc.same_thread(&thread, fence))
                    {
                        return Err(HostError::Uncertain);
                    }
                    Ok(true)
                },
            )
            .await?
        {
            Reply::Value(_) => Ok(()),
            Reply::Failure(_) => Err(HostError::Uncertain),
        }
    }

    async fn send(&self, dispatch: RunDispatch) -> Result<SendOutcome, HostError> {
        let wire = dispatch.wire;
        let reply = self
            .host
            .rpc
            .call_write(wire.method.rpc(), wire.payload.as_ref(), Read::One, || {
                if dispatch.queued_continuation && self.host.rpc.uses_held_shell() {
                    self.host
                        .verify_retained_target(&wire, &dispatch.owned_parent_snoozes)?;
                }
                Ok(true)
            })
            .await;
        match &reply {
            Ok(Reply::Failure(cause)) => host_log!(
                "{}: T3 {} refused with {:?}",
                dispatch.instance,
                wire.diagnostic(),
                self.host.rpc.failure_detail(cause)
            ),
            Err(CallError::NotSent(error) | CallError::Unknown(error)) => {
                host_log!("{}: T3 {}: {error}", dispatch.instance, wire.diagnostic());
            }
            Ok(Reply::Value(_)) => {}
        }
        match reply {
            Err(CallError::NotSent(error)) => Ok(SendOutcome::NotSent(error)),
            Err(CallError::Unknown(error)) => {
                self.evidence.sent.store(true, Ordering::Release);
                Err(error)
            }
            Ok(Reply::Failure(cause)) if rejected(&cause, &wire, &dispatch.instance) => {
                Ok(SendOutcome::Rejected)
            }
            Ok(Reply::Value(_)) => {
                self.evidence.sent.store(true, Ordering::Release);
                Ok(SendOutcome::Sent)
            }
            Ok(Reply::Failure(_)) => {
                self.evidence.sent.store(true, Ordering::Release);
                Err(HostError::Uncertain)
            }
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
                unarchive_fence: None,
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
            RunState::ReadyToSend if role_reply_wait(run, now_ms).is_none() => {
                Ok(StopProgress::ReplayDue)
            }
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
        if thread.deleted() {
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
        unarchive_fence: None,
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
    }
}

fn retained_row_matches(wire: &Wire, row: &Value) -> bool {
    wire.binding.matches_shell_row(row)
        && wire
            .parent
            .as_deref()
            .is_none_or(|parent| ShellCustody(row).parent() == Some(parent))
}

fn worker_continuation(run: &Run, wire: &Wire) -> bool {
    run.launch().role == Role::Worker && wire.method == Method::Continue
}

fn queued_continuation(run: &Run, wire: &Wire) -> bool {
    !run.revoked() && wire.method == Method::Continue
}

fn missing_receipt(run: &Run, wire: &Wire) -> MissingReceipt {
    if queued_continuation(run, wire) || worker_continuation(run, wire) {
        // A revoked worker is observed on the same terms. It is never authorized to send.
        MissingReceipt::Queue
    } else if wire.method == Method::Continue {
        MissingReceipt::RevokedContinuation
    } else {
        MissingReceipt::Fresh
    }
}

fn role_reply_wait(run: &Run, now_ms: u64) -> Option<Duration> {
    let sent = run.last_send_at_ms()?;
    let remaining = LATE_REPLY_MS.saturating_sub(now_ms.saturating_sub(sent));
    (remaining > 0).then(|| Duration::from_millis(remaining))
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
    launch_rejection(cause, instance, &wire.binding.project_id).is_some()
}

enum LaunchRejection {
    Create,
    InitialMessage,
}

fn launch_rejection(cause: &Value, instance: &str, project: &str) -> Option<LaunchRejection> {
    let error = command_failure(cause, instance)?;
    let defect = &error["cause"];
    if error["_tag"] != "OrchestrationV2ThreadLaunchError"
        || error["projectId"] != project
        || !defect_named(defect, "ThreadLaunchError")
    {
        return None;
    }
    [
        (
            "create-thread",
            instance.to_owned(),
            "thread.create",
            LaunchRejection::Create,
        ),
        (
            "dispatch-message",
            format!("{instance}:initial-message"),
            "message.dispatch",
            LaunchRejection::InitialMessage,
        ),
    ]
    .into_iter()
    .find_map(|(operation, command_id, command, rejected)| {
        ((defect["operation"] == operation
            || defect["message"] == format!("Thread launch {instance} failed during {operation}."))
            && rejected_command(&defect["cause"], &command_id, command))
        .then_some(rejected)
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
