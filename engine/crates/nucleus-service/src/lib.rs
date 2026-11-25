//! Service entry points for the isolated Rust task engine.

mod acp;
mod allowance;
mod attention;
mod dependencies;
mod enrollment;
pub mod github_accounts;
mod inbox;
mod native_inbox;
mod numbers;
mod pass;
mod planning;
mod presentation;
mod profiles;
mod project;
mod prompt;
mod question;
mod report_only;
mod schedule;
mod scratch;
mod task_rows;
mod tell;
#[cfg(test)]
mod tests;
mod ticket;
mod titles;
mod web;

use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    os::fd::OwnedFd,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{
    Action, Authority, Command, CommandError, Forge, Identity, Observation, Observed,
    OperatorDecline, Phase, Report, Task, WaitReason,
};
use nucleus_forge::{Branches, ForgeError, GitHub};
use nucleus_hosts::{HostCalls, HostError, RunActivity, T3, T3_RETRY_DELAY, ThreadHint};
use nucleus_store::{
    DispatchMode, EngineStorage, Event, EventDraft, SettingsFile, StorageError, Store, StoreError,
    TaskRow,
};
use nucleus_work::{WorkError, Worktrees, checkout_path};
use schedule::{DueTask, PASS_BATCH, Priority, Schedule};
use tokio::{
    sync::{Mutex, Notify, OwnedMutexGuard, RwLock, broadcast, mpsc, watch},
    time::Instant,
};

pub use dependencies::{
    DependencyCommand, DependencyEdits, DependencyFact, DependencyState, DependencyStatus,
    PrerequisiteWaitView,
};
pub use native_inbox::native_inbox_directory;
pub use project::{LaunchBudget, Project, ProjectMode, RegisteredAgent, RegisteredRole};
pub use ticket::ReportTicket;
use web::ControllerScope;
pub use web::{
    Controller, router, router_with_board, router_with_board_and_t3_callers, router_with_t3_callers,
};

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    ArchiveEvidence(String),
    #[error("T3 parent message was not sent: {reason}")]
    ParentNotSent {
        reason: String,
        retry_at: Option<Instant>,
    },
    #[error("the next task row visibility change is scheduled")]
    RowVisibilityDeferred { until: Instant },
    #[error("T3 parent message delivery could not be confirmed: {source}")]
    ParentDeliveryUnknown { source: HostError, until: Instant },
    #[error(
        "Nucleus couldn’t verify the earlier delivery. Open the task thread, then use Next to review recovery."
    )]
    ParentDeliveryHeld,
    #[error("You snoozed this thread until {}. Nucleus resumes when it wakes.", nucleus_hosts::snooze_deadline(*until))]
    OperatorSnoozed { thread: String, until: u64 },
    #[error("run scratch is already reserved for another run")]
    RunScratchConflict,
    #[error("the task is outside this engine's configured project")]
    Project,
    #[error("the controller cannot access this project")]
    ControllerProject,
    #[error("Nucleus is verifying this T3 planner and repository. Retry shortly.")]
    PlannerEnrollmentPending,
    #[error("{0}")]
    PlannerEnrollmentRefused(&'static str),
    #[error("{0}")]
    PlannerEnrollmentUnavailable(&'static str),
    #[error("task was not found")]
    Missing,
    #[error("task reference was not found")]
    TaskReferenceMissing,
    #[error("task reference is ambiguous. Use owner/repo#N.")]
    TaskReferenceAmbiguous,
    #[error("bare task numbers require a project with exactly one repository. Use repo#N.")]
    TaskReferenceNeedsRepository,
    #[error("{0}")]
    ReportInput(String),
    #[error("report completion is waiting for a verified idle worker")]
    ReportWorkerBusy,
    #[error("the report task branch has an open pull request")]
    ReportOpenPullRequest,
    #[error("the report checkout is preserved: {0}")]
    ReportCheckout(&'static str),
    #[error("{0}")]
    DependencyInput(String),
    #[error("{0}")]
    DependencyEdit(&'static str),
    #[error("task input is invalid")]
    Input,
    #[error("queue.complexity is required: very_low, low, medium, high or very_high")]
    ComplexityRequired,
    #[error("a lead names its complexity in its brief (queue.complexity); edit the lead")]
    LeadComplexity,
    #[error("brief is {bytes} UTF-8 bytes and exceeds the {MAX_BRIEF_BYTES}-byte limit")]
    BriefTooLarge { bytes: usize },
    #[error("{0}")]
    BriefPolicy(#[from] nucleus_core::profiles::BriefPolicyError),
    #[error("tell requires project recipients and between 1 and 4000 characters of text")]
    TellInput,
    #[error("tell requires a verified planner binding with a sending project")]
    TellPlannerRequired,
    #[error("no project matches {0:?}. Use a registered project ID or name.")]
    TellUnknownProject(String),
    #[error("project name {0:?} is ambiguous. Use its project ID.")]
    TellAmbiguousProject(String),
    #[error("project {0:?} is archived")]
    TellArchivedProject(String),
    #[error("answering an operator decision requires the operator binding")]
    DecisionOperator,
    #[error("the question is assigned to a different planner")]
    QuestionPlanner,
    #[error("planner authority is not yet known. Retry shortly.")]
    PlannerAuthorityUnknown,
    #[error("the caller is no longer the responsible planner for this task")]
    PlannerAuthorityRefused,
    #[error("a task effect is still in progress. Retry shortly.")]
    EffectInProgress,
    #[error("the callback configuration or ticket is invalid")]
    Ticket,
    #[error("the ACP binding could not be saved")]
    AcpBinding,
    #[error(transparent)]
    Profile(#[from] nucleus_core::profiles::ProfileLaunchError),
    #[error("project dispatch requires a configured Profiles domain")]
    ProfileConfiguration,
    #[error("set NUCLEUS_RUST_NATIVE_INBOX to 0 or 1 and configure a T3 ACP provider when enabled")]
    InboxConfiguration,
    #[error("the Rust Inbox is unavailable")]
    InboxUnavailable { until: Instant },
    #[error("answer this operator question in the pinned Inbox")]
    AnswerInInbox,
    #[error("authentication failed")]
    AcpUnauthorized,
    #[error("local I/O failed")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Core(#[from] nucleus_core::CommandError),
    #[error(transparent)]
    Settings(#[from] StorageError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Workspace(#[from] WorkError),
    #[error(transparent)]
    Host(#[from] HostError),
    #[error(transparent)]
    Forge(#[from] ForgeError),
}

pub struct Service {
    storage: EngineStorage,
    git: project::LocalGit,
    settings: SettingsFile,
    project: Option<Project>,
    registry_provider: Option<String>,
    host: T3,
    forge: GitHub,
    pub(crate) github_accounts: Arc<github_accounts::GitHubAccounts>,
    native_inbox: Option<native_inbox::NativeInbox>,
    board: std::sync::OnceLock<web::Board>,
    callback: SocketAddr,
    report_command: PathBuf,
    state: Mutex<State>,
    project_writes: RwLock<()>,
    pass_lock: Mutex<()>,
    watch_lock: Mutex<()>,
    changes: broadcast::Sender<TaskChange>,
    project_changes: watch::Sender<()>,
    settings_changes: watch::Sender<()>,
    storage_changes: watch::Sender<()>,
    decision_changes: watch::Sender<()>,
    profile_usage_changes: watch::Sender<()>,
    planning_changes: watch::Sender<()>,
    /// The environment's board theme inputs, cached from the host's config stream.
    theme: watch::Sender<Option<serde_json::Value>>,
    wake: Notify,
    planner_wake: Notify,
    title_wake: Notify,
    enrollment_wake: Notify,
    tell_wake: Notify,
    #[cfg(test)]
    visibility_time: AtomicU64,
    forge_until: AtomicU64,
    forge_retry_secs: AtomicU64,
    // Keep the exclusive OS lock for the service lifetime.
    _profile: OwnedFd,
}

struct TaskWait {
    reason: Option<WaitReason>,
    since: Instant,
    timed: bool,
    detail: Option<WaitDetail>,
}

#[derive(PartialEq, Eq)]
enum WaitDetail {
    BeforeSend(Option<&'static str>),
    ShowingForDelivery(Option<&'static str>),
    ConfirmingDelivery(&'static str),
    Observation(&'static str),
    Workspace(String),
    Archive(String),
    OperatorSnoozed {
        version: i64,
        thread: String,
        until: u64,
        message: String,
    },
}

struct State {
    store: Store,
    allowance_clock: allowance::Clock,
    settings: web::RuntimeSettings,
    registry_mode: bool,
    schedule: Schedule,
    last_pass_calls: HostCalls,
    scheduler_error: Option<&'static str>,
    fences: BTreeMap<String, Arc<Mutex<()>>>,
    waits: BTreeMap<String, TaskWait>,
    role_observations: BTreeMap<String, (String, nucleus_core::RunState)>,
    acp_refresh_requests: BTreeMap<String, i64>,
    capacity_waiters: BTreeSet<(i64, String)>,
    group_waits: BTreeMap<String, profiles::GroupPause>,
    observed_forge: BTreeMap<String, (i64, Forge)>,
    forge_requested: BTreeSet<String>,
    activity: BTreeMap<String, presentation::ActivityAt>,
    planner_authority: BTreeMap<String, question::PlannerAuthority>,
    planner_authority_epoch: u64,
    planner_requests: BTreeSet<String>,
    planner_check: Option<String>,
    enrollments: enrollment::Enrollments,
    enrolled_planners: BTreeMap<String, enrollment::EnrolledPlanner>,
    planner_notice_waiters: BTreeSet<String>,
    thread_tasks: BTreeMap<String, BTreeMap<String, TrackedThread>>,
}

#[derive(Default)]
struct TrackedThread {
    seen: Option<SeenThread>,
    role: bool,
    due: bool,
}

struct SeenThread {
    hint: ThreadHint,
    at: Instant,
}

pub enum CommandOutcome {
    Applied(Box<TaskRow>),
    Pending { version: i64 },
}

enum Preflight {
    Ready,
    Pending,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskChange {
    pub task_id: String,
    pub version: i64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub detail_only: bool,
}

pub struct PassOutcome {
    pub task: String,
    pub result: Result<Action, ServiceError>,
}

impl Drop for Service {
    fn drop(&mut self) {
        self.github_accounts.cancel_pending();
    }
}

impl Service {
    /// Open the enabled engine on its pinned volume and claim its write lock.
    ///
    /// # Errors
    /// Returns an error if configuration, storage, or project scope is invalid.
    pub fn open(
        settings: &SettingsFile,
        project: Project,
        host: T3,
        forge: GitHub,
        callback: SocketAddr,
        report_command: PathBuf,
    ) -> Result<Self, ServiceError> {
        Self::open_runtime(
            settings,
            Some(project),
            None,
            host,
            forge,
            callback,
            report_command,
        )
    }

    /// Open one service for the repositories registered in Projects settings.
    ///
    /// # Errors
    /// Returns an error if service configuration or storage is invalid.
    pub fn open_projects(
        settings: &SettingsFile,
        acp_provider: String,
        host: T3,
        forge: GitHub,
        callback: SocketAddr,
        report_command: PathBuf,
    ) -> Result<Self, ServiceError> {
        if acp_provider.trim().is_empty() || acp_provider.trim() != acp_provider {
            return Err(ServiceError::Project);
        }
        Self::open_runtime(
            settings,
            None,
            Some(acp_provider),
            host,
            forge,
            callback,
            report_command,
        )
    }

    fn open_runtime(
        settings: &SettingsFile,
        project: Option<Project>,
        registry_provider: Option<String>,
        host: T3,
        forge: GitHub,
        callback: SocketAddr,
        report_command: PathBuf,
    ) -> Result<Self, ServiceError> {
        let storage = settings.storage()?;
        storage.scratch().ensure()?;
        storage.builds().ensure()?;
        storage.log().ensure()?;
        let git = project::LocalGit(storage.scratch().path().into());
        if let Some(project) = &project {
            project.verify(&git)?;
        }
        if !callback.ip().is_loopback()
            || callback.port() == 0
            || !report_command.is_absolute()
            || !report_command.is_file()
        {
            return Err(ServiceError::Ticket);
        }
        let profile = storage.lock_profile()?;
        let mut runtime_settings = web::RuntimeSettings::open(settings)?;
        let mut store = Store::open(&storage)?;
        if runtime_settings
            .projects
            .as_ref()
            .is_some_and(nucleus_store::Projects::has_pending_removals)
        {
            runtime_settings.projects = Some(store.clean_removed_projects(settings)?.value);
        }
        let allowance_clock = allowance::Clock::new(store.allowance_elapsed()?);
        let registry_mode = project.is_none();
        if project
            .as_ref()
            .is_none_or(|project| project.mode != ProjectMode::Fixture)
        {
            host.use_held_shell();
        }
        let (changes, _) = broadcast::channel(64);
        Ok(Self {
            storage,
            git,
            settings: settings.clone(),
            project,
            registry_provider,
            host,
            forge,
            github_accounts: Arc::new(github_accounts::GitHubAccounts::new(settings.clone())),
            native_inbox: None,
            board: std::sync::OnceLock::new(),
            callback,
            report_command,
            state: Mutex::new(State {
                store,
                allowance_clock,
                settings: runtime_settings,
                registry_mode,
                schedule: Schedule::new(),
                last_pass_calls: HostCalls::new(),
                scheduler_error: None,
                fences: BTreeMap::new(),
                waits: BTreeMap::new(),
                role_observations: BTreeMap::new(),
                acp_refresh_requests: BTreeMap::new(),
                capacity_waiters: BTreeSet::new(),
                group_waits: BTreeMap::new(),
                observed_forge: BTreeMap::new(),
                forge_requested: BTreeSet::new(),
                activity: BTreeMap::new(),
                planner_authority: BTreeMap::new(),
                planner_authority_epoch: 0,
                planner_requests: BTreeSet::new(),
                planner_check: None,
                enrollments: enrollment::Enrollments::default(),
                enrolled_planners: BTreeMap::new(),
                planner_notice_waiters: BTreeSet::new(),
                thread_tasks: BTreeMap::new(),
            }),
            project_writes: RwLock::new(()),
            pass_lock: Mutex::new(()),
            watch_lock: Mutex::new(()),
            changes,
            project_changes: watch::Sender::new(()),
            settings_changes: watch::channel(()).0,
            storage_changes: watch::channel(()).0,
            decision_changes: watch::channel(()).0,
            profile_usage_changes: watch::channel(()).0,
            planning_changes: watch::channel(()).0,
            theme: watch::channel(None).0,
            wake: Notify::new(),
            planner_wake: Notify::new(),
            title_wake: Notify::new(),
            enrollment_wake: Notify::new(),
            tell_wake: Notify::new(),
            #[cfg(test)]
            visibility_time: AtomicU64::new(0),
            forge_until: AtomicU64::new(0),
            forge_retry_secs: AtomicU64::new(0),
            _profile: profile,
        })
    }

    /// Admit a brief through the legacy single-repository route.
    ///
    /// # Errors
    /// Returns an error for malformed or duplicate input or a storage failure.
    pub async fn admit(
        &self,
        id: String,
        reference: String,
        brief: String,
        caller: &Authority,
    ) -> Result<TaskRow, ServiceError> {
        self.admit_to(None, id, reference, brief, caller).await
    }

    /// Admit a brief for a configured repository without contacting any host.
    ///
    /// # Errors
    /// Returns an error for unbound, malformed or duplicate input or a storage failure.
    pub async fn admit_to(
        &self,
        repository: Option<&str>,
        id: String,
        reference: String,
        brief: String,
        caller: &Authority,
    ) -> Result<TaskRow, ServiceError> {
        self.admit_in_scope(
            repository,
            id,
            reference,
            brief,
            caller,
            &ControllerScope::default(),
        )
        .await
    }

    async fn admit_in_scope(
        &self,
        repository: Option<&str>,
        id: String,
        reference: String,
        brief: String,
        caller: &Authority,
        scope: &ControllerScope,
    ) -> Result<TaskRow, ServiceError> {
        self.add_planned_task(
            None,
            planning::TaskAdmission {
                id: Some(id),
                reference: Some(reference),
                repository: repository.map(str::to_owned),
                brief,
                review: None,
                planning_commit: None,
            },
            caller,
            scope,
        )
        .await
    }

    /// Wait for a due task and process one bounded batch.
    ///
    /// # Errors
    /// Returns an error if the engine cannot verify its volume or read its rows.
    pub async fn pass(&self) -> Result<Vec<PassOutcome>, ServiceError> {
        self.pass_with_host(&self.host.pass(self.storage.scratch().path()))
            .await
    }

    async fn pass_with_host(
        &self,
        host: &nucleus_hosts::T3Pass<'_>,
    ) -> Result<Vec<PassOutcome>, ServiceError> {
        let _cycle = self.pass_lock.lock().await;
        let (result, calls) = T3::count_pass_calls(self.run_batch(host)).await;
        let mut state = self.state.lock().await;
        state.last_pass_calls = calls;
        state.scheduler_error = result.as_ref().err().map(|error| match error {
            ServiceError::Project => "the task is outside this engine's configured project",
            ServiceError::Settings(_) | ServiceError::Store(_) => {
                "could not read or update scheduler storage"
            }
            _ => "a scheduler pass could not complete",
        });
        result
    }

    async fn run_batch(
        &self,
        host: &nucleus_hosts::T3Pass<'_>,
    ) -> Result<Vec<PassOutcome>, ServiceError> {
        self.storage.database().verify()?;
        let mut first = Some(self.wait_due_task().await?);
        let mut results = Vec::with_capacity(PASS_BATCH);
        let mut visited = BTreeSet::new();
        for _ in 0..PASS_BATCH {
            let next = match first.take() {
                Some(first) => Some(first),
                None => self.state.lock().await.take_ready(Instant::now(), &visited),
            };
            let Some(DueTask { id, priority }) = next else {
                break;
            };
            visited.insert(id.clone());
            match self.run_due_task(&id, priority, host).await {
                Ok(Some(result)) => results.push(PassOutcome { task: id, result }),
                Ok(None) => {}
                Err(error) => {
                    self.state.lock().await.schedule.wake(
                        &id,
                        Instant::now() + schedule::RETRY,
                        priority,
                    );
                    return Err(error);
                }
            }
        }
        Ok(results)
    }

    async fn run_due_task(
        &self,
        id: &str,
        priority: Priority,
        host: &nucleus_hosts::T3Pass<'_>,
    ) -> Result<Option<Result<Action, ServiceError>>, ServiceError> {
        let row = match self.task(id).await {
            Ok(row) => row,
            Err(ServiceError::Missing) => return Ok(None),
            Err(error) => return Err(error),
        };
        let defer_refresh = {
            let mut state = self.state.lock().await;
            self.track(&mut state, &row.task);
            state.group_waits.remove(id);
            priority == Priority::Refresh && state.fresh_running_hint(&row.task)
        };
        let result = if defer_refresh {
            Ok(Action::Wait(WaitReason::Running))
        } else {
            let scratch = self.existing_run_scratch(&row.task);
            Box::pin(self.advance_due_task(&row, &host.for_task(&row.task, scratch))).await
        };
        self.schedule_result(&row, &result, priority).await?;
        // The commit can wake the watcher while this task's send fence is still held.
        if matches!(result, Ok(Action::Launch { .. })) {
            self.title_wake.notify_one();
        }
        Ok(Some(match result {
            Err(ServiceError::RowVisibilityDeferred { .. }) => {
                Ok(Action::Wait(WaitReason::HostUnknown))
            }
            result => result,
        }))
    }

    async fn advance_due_task(
        &self,
        row: &TaskRow,
        host: &impl nucleus_hosts::TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        if task.phase().is_terminal() {
            if task.run().is_some() {
                return self.advance(row, host).await;
            }
            if task.phase() == Phase::Done
                && (self.acp_provider().is_some() || task.report_task().is_some())
            {
                return self.archive_done(row).await;
            }
            return Ok(Action::Nothing);
        }
        if let Some(snoozed) = self.operator_snooze_wait(row).await {
            return Err(snoozed);
        }
        self.reenter_retained_parent(row).await?;
        if task.run().is_none() {
            self.parent_delivery_fenced(row).await?;
        }
        if self.reconcile_prerequisites(row).await? {
            return Ok(Action::Nothing);
        }
        // A planner's availability must not hold the dependent after release.
        // Any unsent notice remains due through the store's scheduler scan.
        if self.notify_prerequisite_release(row).await.unwrap_or(true) {
            self.recheck_effect(row, WaitReason::Question).await;
        }
        if dependencies::checks_prerequisites(task)
            && self.dependencies_blocked(row).await?
            && !self
                .state
                .lock()
                .await
                .forge_requested
                .contains(&task.identity().id)
        {
            return Ok(Action::Wait(WaitReason::Prerequisite));
        }
        {
            let mut state = self.state.lock().await;
            if let Some(wait) = self.usage_permission_wait(&mut state, row)? {
                return Ok(Action::Wait(wait));
            }
        }
        if self.clear_surpassed_allowance_question(row).await? {
            return Ok(Action::Advance(row.task.phase()));
        }
        if row.task.phase() == Phase::ReportReady {
            return Box::pin(self.notify_report_ready(row)).await;
        }
        if task.first_launch() && task.hold().is_none() && task.question().is_none() {
            let state = self.state.lock().await;
            if !state.forge_requested.contains(&task.identity().id)
                && !self.initial_dispatch_allowed(&state, task.identity())?
            {
                return Ok(Action::Wait(WaitReason::Capacity));
            }
        }
        self.refresh_acp_if_requested(row).await?;
        self.advance(row, host).await
    }

    /// Use native thread changes to advance due times. Exact reads still own
    /// every decision, and the due queue stays live across stream failures.
    pub async fn watch_host(&self) {
        let _subscription = self.watch_lock.lock().await;
        self.host.use_held_shell();
        tokio::join!(
            self.watch_thread_hints(),
            Box::pin(self.watch_planner_authority()),
            Box::pin(self.watch_titles()),
            Box::pin(self.watch_enrollments()),
            Box::pin(self.watch_tells()),
            Box::pin(self.watch_inbox()),
            Box::pin(self.watch_theme())
        );
    }

    /// Keep the board theme current from the host's config stream. Board reads
    /// use the cached value only; a dropped stream reconnects after the host delay.
    async fn watch_theme(&self) {
        loop {
            self.host.wait_for_requests().await;
            let _ = self.host.watch_theme(&self.theme).await;
            tokio::time::sleep(T3_RETRY_DELAY).await;
        }
    }

    async fn watch_thread_hints(&self) {
        loop {
            self.host.wait_for_requests().await;
            let (sender, mut hints) = mpsc::channel(128);
            let inbox = self.native_inbox.as_ref();
            let watch = self.host.watch_threads(
                &sender,
                self.acp_provider(),
                inbox.map(|_| nucleus_hosts::INBOX_THREAD),
            );
            tokio::pin!(watch);
            let outcome = loop {
                tokio::select! {
                    result = &mut watch => break result,
                    Some(hint) = hints.recv() => self.wake_from_host(hint).await,
                }
            };
            if let Some(inbox) = inbox {
                inbox.host_stream_ended(outcome);
            }
            {
                let mut state = self.state.lock().await;
                self.set_cached_host(&mut state, web::CachedHost::Unavailable);
                if !state.planner_authority.is_empty() {
                    self.settings_changes.send_replace(());
                }
                state.invalidate_planner_authority();
                if !state.enrolled_planners.is_empty() {
                    state.enrolled_planners.clear();
                    self.planner_routes_changed(&mut state);
                }
                for seen in state
                    .thread_tasks
                    .values_mut()
                    .flat_map(|threads| threads.values_mut())
                {
                    seen.seen = None;
                }
            }
            tokio::time::sleep(T3_RETRY_DELAY).await;
        }
    }

    async fn wake_from_host(&self, hint: ThreadHint) {
        if let Some(inbox) = &self.native_inbox
            && hint.thread == nucleus_hosts::INBOX_THREAD
        {
            if hint.inbox_synchronized()
                && let Some(identity) = self.host.runtime_identity()
            {
                inbox.host_synchronized(identity);
            }
            inbox.wake();
        }
        let mut state = self.state.lock().await;
        self.set_cached_host(&mut state, web::CachedHost::Reachable);
        let authorities = state.planner_authority.len();
        state.planner_thread_changed(&hint);
        if state.invalidate_enrolled_planner(&hint) {
            self.planner_routes_changed(&mut state);
        }
        if authorities != state.planner_authority.len() {
            self.settings_changes.send_replace(());
        }
        let State {
            thread_tasks,
            schedule,
            waits,
            ..
        } = &mut *state;
        let now = Instant::now();
        for (id, threads) in thread_tasks {
            if hint
                .parent_thread()
                .is_some_and(|parent| threads.contains_key(parent))
            {
                self.title_wake.notify_one();
            }
            if let Some(tracked) = threads.get_mut(&hint.thread) {
                let prior = tracked.seen.as_ref().map(|seen| &seen.hint);
                if tracked.role && prior != Some(&hint) {
                    self.title_wake.notify_one();
                }
                let still_snoozed = matches!(waits.get(id).and_then(|wait| wait.detail.as_ref()),
                    Some(WaitDetail::OperatorSnoozed { thread, until, .. })
                    if thread != &hint.thread || (hint.snoozed_until() == Some(*until) && !hint.closed()));
                if (tracked.due || (tracked.role && hint.positive_role_activity()))
                    && prior != Some(&hint)
                    && !still_snoozed
                {
                    schedule.wake(id, now, Priority::Decision);
                    self.wake.notify_one();
                }
                tracked.seen = Some(SeenThread {
                    hint: hint.clone(),
                    at: now,
                });
            }
        }
    }

    fn set_cached_host(&self, state: &mut State, status: web::CachedHost) {
        if state.settings.host != status {
            state.settings.host = status;
            state.refresh_allowance_clock();
            self.settings_changes.send_replace(());
        }
    }

    /// The operator's global dispatch mode from the in-memory read model.
    async fn dispatch_mode(&self) -> DispatchMode {
        self.state
            .lock()
            .await
            .settings
            .dispatch
            .as_ref()
            .map_or(DispatchMode::Running, |dispatch| dispatch.mode)
    }

    async fn launch_capacity(
        &self,
        identity: &Identity,
        recovery: bool,
    ) -> Result<bool, ServiceError> {
        self.launch_capacity_in(&*self.state.lock().await, identity, recovery)
    }

    fn initial_dispatch_allowed(
        &self,
        state: &State,
        identity: &Identity,
    ) -> Result<bool, ServiceError> {
        Ok(state
            .settings
            .dispatch
            .as_ref()
            .is_none_or(|dispatch| dispatch.mode.allows_launch(true))
            && self.launch_capacity_in(state, identity, false)?)
    }

    fn launch_capacity_in(
        &self,
        state: &State,
        identity: &Identity,
        recovery: bool,
    ) -> Result<bool, ServiceError> {
        let route = self.resolve_project(state, identity)?;
        let fallback_slots = self.project.as_ref().map_or_else(
            || nucleus_store::DispatchSettings::default().global_slots,
            |project| project.launch_budget.slots,
        );
        let project_slots = match route.slots {
            Some(slots) => slots,
            None if recovery => u32::MAX,
            None => return Ok(false),
        };
        let slots = state
            .settings
            .dispatch
            .as_ref()
            .map_or(fallback_slots, |dispatch| dispatch.global_slots);
        if state.store.occupied_slots(&identity.id)? >= slots {
            return Ok(false);
        }
        Ok(state
            .store
            .occupied_project_slots(&identity.id, &route.repositories)?
            < project_slots)
    }

    async fn wait_due_task(&self) -> Result<DueTask, ServiceError> {
        loop {
            let next;
            {
                let mut state = self.state.lock().await;
                let now = Instant::now();
                let State {
                    store,
                    schedule,
                    allowance_clock,
                    thread_tasks,
                    capacity_waiters,
                    ..
                } = &mut *state;
                if !thread_tasks.is_empty() {
                    allowance_clock.checkpoint(store, now)?;
                }
                schedule.seed(store, now, self.acp_provider().is_some(), capacity_waiters)?;
                if let Some(ready) = state.take_ready(now, &BTreeSet::new()) {
                    return Ok(ready);
                }
                next = state.schedule.next();
            }
            tokio::select! {
                () = self.wake.notified() => {},
                () = tokio::time::sleep_until(next) => {},
            }
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "preserve scheduling and the published wait under one state lock"
    )]
    async fn schedule_result(
        &self,
        row: &TaskRow,
        result: &Result<Action, ServiceError>,
        previous: Priority,
    ) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let mut state = self.state.lock().await;
        let mut current = self.lookup(&state, id)?;
        let archive_due = (self.acp_provider().is_some() || current.task.report_task().is_some())
            && current.task.phase() == Phase::Done
            && current.task.run().is_none()
            && !matches!(result, Ok(Action::Nothing));
        if !archive_due
            && !active(&current.task)
            && !state.forge_requested.contains(id)
            && state.acp_refresh_requests.get(id) != Some(&current.version)
        {
            if state.observe_wait(&current.task, None)? {
                self.title_wake.notify_one();
                self.publish(id, current.version);
            }
            state.schedule.reset_workspace(id);
            if state.store.pending_prerequisite_notice(id)?.is_none() {
                state.planner_notice_waiters.remove(id);
            }
            return Ok(());
        }
        if current.version != row.version {
            if state.schedule.due(id).is_none() {
                state.schedule.wake(id, Instant::now(), Priority::Decision);
            }
            return Ok(());
        }
        let (mut wait, mut detail) = task_wait(&state, row, result);
        if wait == Some(WaitReason::Capacity)
            && current.task.phase() == Phase::Working
            && current.task.first_launch()
            && !state
                .store
                .pending_parent_preparation(id, current.version)?
            && current.task.reconcile_capacity() == Action::Advance(Phase::Queued)
        {
            current.version = self.commit(
                &mut state,
                row,
                &current.task,
                &event("queue_capacity"),
                None,
            )?;
        }
        let row = &current;
        if let Err(error @ ServiceError::OperatorSnoozed { thread, until }) = result {
            return self.schedule_operator_snooze(
                &mut state,
                row,
                thread,
                *until,
                error.to_string(),
            );
        }
        record_incomplete_observation(&mut state, row, result)?;
        let now = Instant::now();
        let checking_workspace = wait == Some(WaitReason::WorkspaceUnknown);
        if checking_workspace {
            if state.schedule.recover_workspace(id, now) {
                wait = Some(WaitReason::WorkspaceBlocked);
                detail = Some(WaitDetail::Workspace(workspace_cause(result)));
            }
        } else {
            state.schedule.reset_workspace(id);
        }
        if archive_due
            && !checking_workspace
            && let Err(error) = result
        {
            detail = Some(WaitDetail::Archive(error.to_string()));
        }
        if state.observe_task_allowance(&row.task, wait)? {
            self.publish_detail(id, row.version);
        }
        let owner_action = wait == Some(WaitReason::HostObservationBlocked);
        if owner_action {
            state.schedule.park(id);
        } else if !checking_workspace {
            let (mut delay, priority) = schedule::retry(wait);
            if matches!(&detail, Some(WaitDetail::Observation(_)))
                && wait == Some(WaitReason::HostUnknown)
                && row
                    .task
                    .run()
                    .is_some_and(|run| run.last_send_at_ms().is_some())
            {
                delay = schedule::LIVE_CHECK;
            }
            let due = match result {
                Err(
                    ServiceError::Host(HostError::Deferred { until })
                    | ServiceError::RowVisibilityDeferred { until },
                ) => (*until).max(now + delay),
                Err(ServiceError::ParentNotSent { retry_at, .. }) => {
                    (now + delay).max(retry_at.unwrap_or(now))
                }
                Err(
                    ServiceError::InboxUnavailable { until }
                    | ServiceError::Host(HostError::RoleReplyPending { until })
                    | ServiceError::ParentDeliveryUnknown { until, .. },
                ) => *until,
                _ if wait == Some(WaitReason::ForgeUnknown) => {
                    now + self.forge_backoff().max(delay)
                }
                _ if archive_due || wait == Some(WaitReason::HostUnknown) => {
                    (now + delay).max(self.host.request_retry_at().unwrap_or(now))
                }
                _ => now + delay,
            };
            let priority = if wait == Some(WaitReason::Capacity) {
                priority
            } else if row
                .task
                .run()
                .is_some_and(|run| run.revoked() || run.last_send_at_ms().is_none())
                || matches!(result, Err(ServiceError::ParentDeliveryUnknown { .. }))
                || (previous == Priority::Effect && result.is_err())
                || (row.task.phase() == Phase::Merging && wait == Some(WaitReason::ForgeUnknown))
            {
                Priority::Effect
            } else if state.forge_requested.contains(id) {
                Priority::Wake
            } else {
                priority
            };
            match state
                .group_waits
                .get(id)
                .copied()
                .filter(|_| wait == Some(WaitReason::Capacity))
            {
                Some(profiles::GroupPause::Until(reset)) => state.schedule.wake(
                    id,
                    now + Duration::from_millis(reset.saturating_sub(now_ms())),
                    priority,
                ),
                Some(profiles::GroupPause::Manual) => state.schedule.park(id),
                None => state.schedule.wake(id, due, priority),
            }
        }
        let prior_wait = state.wait_reason(id);
        let changed = state.observe_wait_detail(&row.task, wait, detail)?;
        if owner_action && prior_wait != wait {
            state.wake_capacity(now);
            self.wake.notify_one();
        }
        self.desire_title(&state, &row.task, row.number);
        if changed {
            self.title_wake.notify_one();
            self.publish(id, current.version);
        }
        Ok(())
    }

    fn schedule_operator_snooze(
        &self,
        state: &mut State,
        row: &TaskRow,
        thread: &str,
        until: u64,
        message: String,
    ) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let delay = if self
            .host
            .row_visibility_hint(thread)
            .is_none_or(|row| row.snoozed_until_ms == Some(until))
        {
            Duration::from_millis(until.saturating_sub(now_ms()))
        } else {
            Duration::ZERO
        };
        state.schedule.defer_effect(id, Instant::now() + delay);
        let detail = WaitDetail::OperatorSnoozed {
            version: row.version,
            thread: thread.into(),
            until,
            message,
        };
        if state.observe_wait_detail(&row.task, Some(WaitReason::HostUnknown), Some(detail))? {
            self.desire_title(state, &row.task, row.number);
            self.title_wake.notify_one();
            self.publish(id, row.version);
        }
        Ok(())
    }

    /// Read the current task and its committed row version.
    ///
    /// # Errors
    /// Returns an error if the task is missing, unreadable or outside the project.
    pub async fn task(&self, id: &str) -> Result<TaskRow, ServiceError> {
        self.storage.database().verify()?;
        let state = self.state.lock().await;
        self.lookup(&state, id)
    }

    /// Read a page of display-only task history.
    ///
    /// # Errors
    /// Returns an error for lost task scope or unreadable storage.
    pub async fn history(
        &self,
        id: &str,
        before: Option<i64>,
        limit: u32,
    ) -> Result<Vec<Event>, ServiceError> {
        self.history_in_scope(id, before, limit, &ControllerScope::default())
            .await
    }

    async fn history_in_scope(
        &self,
        id: &str,
        before: Option<i64>,
        limit: u32,
        scope: &ControllerScope,
    ) -> Result<Vec<Event>, ServiceError> {
        let state = self.state.lock().await;
        let row = self.lookup(&state, id)?;
        scope.task(&state, row.task.identity())?;
        Ok(state.store.history(id, before, limit.min(100))?)
    }

    /// Subscribe to revision changes. A subscriber refetches its own task views.
    #[must_use]
    pub fn changes(&self) -> broadcast::Receiver<TaskChange> {
        self.changes.subscribe()
    }

    /// Apply an authenticated command using the pass's observation for this
    /// row revision. A pending command wakes a pass to refresh the evidence.
    ///
    /// # Errors
    /// Returns an error if the task, authorization gate or store refuses it.
    pub async fn command(
        &self,
        id: &str,
        authority: &Authority,
        command: Command,
    ) -> Result<CommandOutcome, ServiceError> {
        self.command_with_session(id, authority, command, None, &ControllerScope::default())
            .await
    }

    async fn command_with_session(
        &self,
        id: &str,
        authority: &Authority,
        command: Command,
        session: Option<&acp::WriteAccess>,
        scope: &ControllerScope,
    ) -> Result<CommandOutcome, ServiceError> {
        let fence = self.task_fence(id).await;
        let local_planner_answer = matches!(
            (&command, authority),
            (Command::Answer(_), Authority::Planner { .. })
        );
        let _fence = if session.is_some() || local_planner_answer {
            fence
                .try_lock_owned()
                .map_err(|_| ServiceError::EffectInProgress)?
        } else {
            fence.lock_owned().await
        };
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        let prior = self.lookup(&state, id)?;
        scope.task(&state, prior.task.identity())?;
        if self.uses_operator_inbox()
            && prior.task.operator_question().is_some()
            && matches!(&command, Command::Answer(_))
        {
            return Err(ServiceError::AnswerInInbox);
        }
        if let Some(session) = session
            && acp::writer_controller(&state, id, &session.credential) != Some(session.controller)
        {
            return Err(ServiceError::AcpUnauthorized);
        }
        if let Command::Amend(text) = &command {
            check_brief_size(text.len())?;
        }
        if matches!(
            command,
            Command::Move(Phase::Merging | Phase::Closing | Phase::Done) | Command::Complete { .. }
        ) && !prior.task.phase().is_terminal()
            && state.store.dependency_blocked(id)?
        {
            return Err(ServiceError::DependencyEdit(
                "this task has unfinished prerequisites",
            ));
        }
        let observation = state.command_observation(&prior);
        let mut task = prior.task.clone();
        let amendment = matches!(command, Command::Amend(_));
        let explicit_move = matches!(command, Command::Move(_) | Command::MoveWork { .. });
        let returned = matches!(command, Command::MoveWork { .. })
            .then(|| {
                prior
                    .task
                    .report_task()
                    .and_then(|report| report.delivery.as_ref())
            })
            .flatten();
        let preflight = state.preflight(&mut task, authority, &observation, command);
        if matches!(preflight, Err(ServiceError::PlannerAuthorityUnknown)) {
            self.request_planner_check(&mut state, &prior.task);
        }
        match preflight? {
            Preflight::Ready => {
                let mut audit = event("command");
                if let Some(acceptance) = task
                    .report_task()
                    .and_then(|report| report.acceptance.as_ref())
                    && prior.task.phase() != Phase::Done
                    && task.phase() == Phase::Done
                {
                    state = self
                        .fence_report_completion(
                            state, &prior, acceptance, authority, session, scope,
                        )
                        .await?;
                    audit = event("report_only_completed");
                    audit.detail = serde_json::json!({ "acceptance": acceptance }).to_string();
                } else if let Some(delivery) = returned {
                    audit = event("report_returned_to_work");
                    audit.detail = serde_json::json!({
                        "artifact": delivery.artifact, "summary": delivery.summary,
                        "instruction": task.report_task().and_then(|report| report.instruction.as_deref()),
                    }).to_string();
                } else if prior.task.phase() != task.phase()
                    && matches!(task.phase(), Phase::Closing | Phase::Done)
                {
                    presentation::note_merge(&mut audit, &observation.forge);
                }
                let version = if amendment {
                    self.commit_amendment(&mut state, &prior, &task, audit, scope)?
                } else if explicit_move || prior.task != task {
                    self.commit(&mut state, &prior, &task, &audit, None)?
                } else {
                    prior.version
                };
                Ok(CommandOutcome::Applied(Box::new(TaskRow {
                    task,
                    version,
                    number: prior.number,
                })))
            }
            Preflight::Pending => Ok(self.defer_command(&mut state, id, prior.version)),
        }
    }

    fn defer_command(&self, state: &mut State, id: &str, version: i64) -> CommandOutcome {
        state.forge_requested.insert(id.into());
        state
            .schedule
            .wake(id, Instant::now() + self.forge_backoff(), Priority::Wake);
        self.wake.notify_one();
        CommandOutcome::Pending { version }
    }

    /// Accept an idempotent report only for the current unrevoked run.
    ///
    /// # Errors
    /// Returns an error for a stale credential, a conflicting report or a failed write.
    pub async fn report(
        &self,
        id: &str,
        instance: &str,
        credential: &[u8; 32],
        report: Report,
    ) -> Result<(), ServiceError> {
        let _fence = self.fence(id).await;
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        let prior = self.lookup(&state, id)?;
        let mut task = prior.task.clone();
        if task.replay_report(instance, credential, &report)? {
            return Ok(());
        }
        let current = task.authenticate_run(instance, credential)?;
        if let Report::ReportReady(delivery) = &report
            && current.report().is_none()
        {
            if delivery.summary.trim().is_empty() {
                return Err(ServiceError::ReportInput(
                    "report_ready requires a summary".into(),
                ));
            }
            self.verify_report_artifact(&state, &task, &delivery.artifact, true)?;
        }
        task.record_report(instance, credential, report)?;
        if let Some(Report::Work(pr)) = task.run().and_then(nucleus_core::Run::report) {
            let identity = task.identity();
            let branches = Branches::new(
                &identity.repository,
                &identity.base,
                &format!("ns-{}", identity.id),
            )?;
            branches
                .target(&pr.pull_request.url)
                .map_err(|_| ServiceError::Input)?;
        }
        if task != prior.task {
            self.commit(&mut state, &prior, &task, &event("reported"), None)?;
        }
        Ok(())
    }

    fn lookup(&self, state: &State, id: &str) -> Result<TaskRow, ServiceError> {
        let row = state.store.row(id)?.ok_or(ServiceError::Missing)?;
        self.task_scope(row.task.identity())?;
        Ok(row)
    }

    async fn fence(&self, id: &str) -> OwnedMutexGuard<()> {
        self.task_fence(id).await.lock_owned().await
    }

    async fn task_fence(&self, id: &str) -> Arc<Mutex<()>> {
        let mut state = self.state.lock().await;
        Arc::clone(state.fences.entry(id.into()).or_default())
    }

    async fn effect(&self, expected: &TaskRow) -> Result<OwnedMutexGuard<()>, ServiceError> {
        let id = &expected.task.identity().id;
        let fence = self.fence(id).await;
        if self.task(id).await? != *expected {
            return Err(StoreError::StaleTask.into());
        }
        Ok(fence)
    }

    fn worktrees(&self) -> Result<Worktrees<'_>, ServiceError> {
        Ok(Worktrees::new(
            &self.storage,
            &self.git,
            Redactor::new([], RedactionRules::common()),
        )?)
    }

    async fn save(
        &self,
        prior: &TaskRow,
        task: Task,
        audit: &EventDraft,
    ) -> Result<TaskRow, ServiceError> {
        if prior.task == task {
            return Ok(prior.clone());
        }
        self.storage.database().verify()?;
        let version = {
            let mut state = self.state.lock().await;
            self.commit(&mut state, prior, &task, audit, None)?
        };
        if task.run().is_none()
            && let Some(run) = prior.task.run()
        {
            ticket::clear(self.storage.scratch(), run);
        }
        Ok(TaskRow {
            task,
            version,
            number: prior.number,
        })
    }

    fn commit_amendment(
        &self,
        state: &mut State,
        prior: &TaskRow,
        task: &Task,
        mut audit: EventDraft,
        scope: &ControllerScope,
    ) -> Result<i64, ServiceError> {
        let Some(ids) = self.amended_dependencies(state, scope, &prior.task, task)? else {
            return self.commit(state, prior, task, &audit, None);
        };
        audit.detail = serde_json::json!({ "prerequisites": ids }).to_string();
        let version = state.edit_board_dependency(task, |store, clock| {
            store.save_brief_with_dependencies(prior, task, &audit, &ids, Some(clock))
        })?;
        self.task_committed(state, prior, task, &audit, version);
        Ok(version)
    }

    fn commit(
        &self,
        state: &mut State,
        prior: &TaskRow,
        task: &Task,
        audit: &EventDraft,
        subscription_group: Option<&str>,
    ) -> Result<i64, ServiceError> {
        let audit = presentation::decorate(&prior.task, task, audit, &state.store);
        let allowance = state.allowance_transition(&prior.task, task, &audit.kind);
        let (wait, state_changed) = state.task_wait_transition(&prior.task, task)?;
        let version = state.store.save_accounted(
            prior,
            task,
            &audit,
            subscription_group,
            allowance,
            state_changed,
        )?;
        state.apply_task_wait(task, wait, state_changed);
        if subscription_group.is_some() {
            self.profile_usage_changes.send_replace(());
        }
        self.task_committed(state, prior, task, &audit, version);
        Ok(version)
    }

    fn task_committed(
        &self,
        state: &mut State,
        prior: &TaskRow,
        task: &Task,
        audit: &EventDraft,
        version: i64,
    ) {
        let id = &task.identity().id;
        if prior.task.phase() != task.phase() || prior.task.brief() != task.brief() {
            self.wake_dependents(state, id);
        }
        self.retire_native_decision(state, prior);
        self.track(state, task);
        if task.phase().is_terminal() {
            state.planner_authority.remove(id);
            state.planner_requests.remove(id);
        }
        if task.run().is_none_or(nucleus_core::Run::revoked)
            || task.run().map(|run| &run.launch().instance)
                != prior.task.run().map(|run| &run.launch().instance)
        {
            state.role_observations.remove(id);
        }
        self.desire_title(state, task, prior.number);
        state.schedule.reset_workspace(id);
        state.observed_forge.remove(id);
        state.forge_requested.remove(id);
        state.activity.remove(id);
        if occupied_slot(&prior.task) && !occupied_slot(task) {
            state.wake_capacity(Instant::now());
        }
        self.wake_task(
            state,
            id,
            version,
            commit_priority(&prior.task, task, audit),
        );
    }

    async fn observe_commands(
        &self,
        row: &TaskRow,
        forge: &Observed<Forge>,
    ) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let mut state = self.state.lock().await;
        if self.lookup(&state, id)?.version != row.version {
            return Err(StoreError::StaleTask.into());
        }
        let prior = match forge {
            Observed::Known(forge) => {
                state.forge_requested.remove(id);
                state
                    .observed_forge
                    .insert(id.clone(), (row.version, forge.clone()))
            }
            Observed::Unknown => state.observed_forge.remove(id),
        };
        if prior.as_ref() != state.observed_forge.get(id) {
            self.publish_detail(id, row.version);
        }
        Ok(())
    }

    fn forge_backoff(&self) -> Duration {
        Duration::from_millis(
            self.forge_until
                .load(Ordering::Relaxed)
                .saturating_sub(now_ms()),
        )
    }

    async fn recheck_effect(&self, row: &TaskRow, wait: WaitReason) {
        let (delay, _) = schedule::retry(Some(wait));
        self.state.lock().await.schedule.wake(
            &row.task.identity().id,
            Instant::now() + delay,
            Priority::Effect,
        );
        self.wake.notify_one();
    }

    async fn observe_activity(
        &self,
        row: &TaskRow,
        activity: Option<RunActivity>,
    ) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let mut state = self.state.lock().await;
        let current = self.lookup(&state, id)?;
        let instance = |row: &TaskRow| row.task.run().map(|run| run.launch().instance.clone());
        if current.version != row.version || instance(&current) != instance(row) {
            return Err(StoreError::StaleTask.into());
        }
        let observed =
            activity
                .zip(instance(row))
                .map(|(activity, instance)| presentation::ActivityAt {
                    version: row.version,
                    instance,
                    activity,
                });
        if state.activity.get(id) != observed.as_ref() {
            match observed {
                Some(observed) => {
                    state.activity.insert(id.clone(), observed);
                }
                None => {
                    state.activity.remove(id);
                }
            }
            self.publish_detail(id, row.version);
        }
        Ok(())
    }

    fn wake_task(&self, state: &mut State, id: &str, version: i64, priority: Priority) {
        state.schedule.wake(id, Instant::now(), priority);
        self.title_wake.notify_one();
        self.wake.notify_one();
        self.publish(id, version);
    }

    fn publish(&self, id: &str, version: i64) {
        self.publish_change(id, version, false);
    }

    fn publish_detail(&self, id: &str, version: i64) {
        self.publish_change(id, version, true);
    }

    fn publish_change(&self, id: &str, version: i64, detail_only: bool) {
        let _ = self.changes.send(TaskChange {
            task_id: id.into(),
            version,
            detail_only,
        });
    }
}

/// The decoded UTF-8 byte limit for a new or replacement task brief.
pub const MAX_BRIEF_BYTES: usize = 65_536;

/// Check the size of a submitted brief. An existing stored brief remains readable.
///
/// # Errors
/// Returns the actual size and limit when the submitted brief is too large.
pub fn check_brief_size(bytes: usize) -> Result<(), ServiceError> {
    if bytes > MAX_BRIEF_BYTES {
        return Err(ServiceError::BriefTooLarge { bytes });
    }
    Ok(())
}

fn workspace_cause(result: &Result<Action, ServiceError>) -> String {
    use longhorn_git_workspace::GitFailure;
    let cause = match result {
        Err(ServiceError::Workspace(WorkError::Git {
            source: GitFailure::NotWorktree { .. },
            ..
        })) => "The task path is occupied and could not be verified as a Git checkout".into(),
        Err(ServiceError::Workspace(WorkError::Git {
            operation, source, ..
        })) => {
            let failure = match source {
                GitFailure::TimedOut { .. } => "timed out",
                GitFailure::Unavailable { .. } => "could not complete",
                _ => "failed",
            };
            format!("{operation} {failure}")
        }
        Err(ServiceError::Workspace(error)) => error.to_string(),
        _ => "The task checkout could not be verified".into(),
    };
    format!("{cause}. Check the checkout. Hold and release the task to retry.")
}

fn task_wait(
    state: &State,
    row: &TaskRow,
    result: &Result<Action, ServiceError>,
) -> (Option<WaitReason>, Option<WaitDetail>) {
    use WaitReason as Wait;
    let showing = matches!(
        state.wait_detail(&row.task.identity().id),
        Some(WaitDetail::ShowingForDelivery(_))
    );
    let pre_wire = |cause| {
        let detail = if showing {
            WaitDetail::ShowingForDelivery(cause)
        } else {
            WaitDetail::BeforeSend(cause)
        };
        (Some(Wait::HostUnknown), Some(detail))
    };
    let observation = |wait, cause| (Some(wait), Some(WaitDetail::Observation(cause)));
    match result {
        Err(ServiceError::ArchiveEvidence(_)) => (Some(Wait::Stopping), None),
        Err(ServiceError::ParentDeliveryHeld) => observation(
            Wait::HostObservationBlocked,
            "Couldn’t verify the earlier delivery. Open the task thread, then use Next to review recovery.",
        ),
        Ok(Action::Wait(Wait::HostObservationBlocked))
        | Err(ServiceError::Host(HostError::ParentHoldRejected)) => observation(
            Wait::HostObservationBlocked,
            "The T3 task turn failed. Open the task thread to check, then update the task to retry.",
        ),
        Err(ServiceError::ParentNotSent { .. } | ServiceError::RowVisibilityDeferred { .. }) => {
            pre_wire(None)
        }
        Err(ServiceError::ParentDeliveryUnknown { .. }) => (
            Some(Wait::HostUnknown),
            Some(WaitDetail::ConfirmingDelivery(
                "Waiting for delivery confirmation.",
            )),
        ),
        Err(ServiceError::Host(error)) => {
            let cause = match error {
                HostError::Unavailable => Some("Couldn’t reach T3. Checking again."),
                HostError::Timeout => Some("T3 didn’t respond in time. Checking again."),
                HostError::RoleReplyPending { .. } => {
                    Some("Waiting for T3 to confirm the role assignment.")
                }
                HostError::ProcessCoverage(failure) => Some(process_check_detail(*failure)),
                _ => None,
            };
            if showing || row.task.run().is_none_or(unsent) {
                pre_wire(cause)
            } else {
                observation(Wait::HostUnknown, cause.unwrap_or("Waiting for T3."))
            }
        }
        Ok(Action::Wait(Wait::HostUnknown)) if showing || row.task.run().is_some_and(unsent) => {
            pre_wire(None)
        }
        Ok(Action::Wait(Wait::HostUnknown))
            if row
                .task
                .run()
                .is_some_and(|run| run.report().is_none() && run.last_send_at_ms().is_some()) =>
        {
            observation(Wait::HostUnknown, "Waiting for delivery confirmation.")
        }
        Err(ServiceError::Workspace(_)) => (Some(Wait::WorkspaceUnknown), None),
        Err(ServiceError::Forge(_)) => (Some(Wait::ForgeUnknown), None),
        Err(ServiceError::InboxUnavailable { .. }) => (Some(Wait::Question), None),
        Err(ServiceError::Profile(_) | ServiceError::ProfileConfiguration) => {
            (Some(Wait::Capacity), None)
        }
        Ok(Action::Wait(reason)) => (Some(*reason), None),
        _ => (None, None),
    }
}

fn unsent(run: &nucleus_core::Run) -> bool {
    !run.revoked() && run.last_send_at_ms().is_none() && run.report().is_none()
}

fn record_incomplete_observation(
    state: &mut State,
    row: &TaskRow,
    result: &Result<Action, ServiceError>,
) -> Result<(), StoreError> {
    let id = &row.task.identity().id;
    if let Err(ServiceError::Host(error)) = result {
        let checkpoint = match error {
            HostError::ProcessCoverage(nucleus_hosts::ProcessEvidenceFailure::Cwd { pid }) => {
                Some(("cwd_followup", Some(*pid)))
            }
            HostError::HeldThreadMissing { .. } => Some(("retained_thread_read", None)),
            HostError::RetainedIdleCoverage { .. } => Some(("retained_idle_coverage", None)),
            _ => None,
        };
        if let Some((checkpoint, pid)) = checkpoint {
            let mut audit = event("host_observation_incomplete");
            audit.detail = serde_json::json!({"version":row.version, "stage":checkpoint,
                "pid":pid, "reason":error.to_string()})
            .to_string();
            state.store.claim_task_effect(id, &audit, false)?;
        }
    }
    Ok(())
}

fn process_check_detail(failure: nucleus_hosts::ProcessEvidenceFailure) -> &'static str {
    use nucleus_hosts::ProcessEvidenceFailure;
    match failure {
        ProcessEvidenceFailure::Timeout => "The local process check timed out. Checking again.",
        ProcessEvidenceFailure::Truncated => {
            "The local process listing was cut short. Checking again."
        }
        ProcessEvidenceFailure::Scope => {
            "Couldn’t verify the checkout and scratch paths. Checking again."
        }
        ProcessEvidenceFailure::Incomplete | ProcessEvidenceFailure::Cwd { .. } => {
            "Checking whether the checkout is idle."
        }
    }
}

fn commit_priority(prior: &Task, task: &Task, audit: &EventDraft) -> Priority {
    if (task.phase() != prior.phase() && matches!(task.phase(), Phase::Merging | Phase::Closing))
        || (task.run().is_some_and(nucleus_core::Run::revoked)
            && !prior.run().is_some_and(nucleus_core::Run::revoked))
    {
        return Priority::Effect;
    }
    match audit.kind.as_str() {
        "command" | "reported" => Priority::Wake,
        "queue_admitted"
        | "run_reserved"
        | "host_send"
        | "run_revoked"
        | "review_rejected_awaiting_archive"
        | "question_asked"
        | "question_delivery" => Priority::Effect,
        _ => Priority::Decision,
    }
}

impl State {
    fn fresh_running_hint(&self, task: &Task) -> bool {
        let id = &task.identity().id;
        let Some(run) = task
            .run()
            .filter(|run| !run.revoked() && run.report().is_none())
        else {
            return false;
        };
        self.wait_reason(id) == Some(WaitReason::Running)
            && self
                .thread_tasks
                .get(id)
                .and_then(|threads| threads.get(&run.launch().thread))
                .and_then(|thread| thread.seen.as_ref())
                .is_some_and(|seen| seen.hint.running() && seen.at.elapsed() < schedule::LIVE_CHECK)
    }

    fn wait_reason(&self, id: &str) -> Option<WaitReason> {
        self.waits.get(id).and_then(|wait| wait.reason)
    }

    fn wait_detail(&self, id: &str) -> Option<&WaitDetail> {
        self.waits.get(id).and_then(|wait| wait.detail.as_ref())
    }

    fn enqueue_capacity(&mut self, id: &str) -> Result<(), StoreError> {
        if !self
            .capacity_waiters
            .iter()
            .any(|(_, waiting)| waiting == id)
        {
            self.capacity_waiters
                .insert((self.store.admission_order(id)?, id.into()));
        }
        Ok(())
    }

    fn set_wait(&mut self, id: &str, reason: Option<WaitReason>) -> bool {
        if reason != Some(WaitReason::Capacity) {
            self.group_waits.remove(id);
            self.capacity_waiters.retain(|(_, waiting)| waiting != id);
        }
        let entry = self.waits.entry(id.into()).or_insert_with(|| TaskWait {
            reason: None,
            since: Instant::now(),
            timed: false,
            detail: None,
        });
        let prior = std::mem::replace(&mut entry.reason, reason);
        if prior == reason {
            return false;
        }
        entry.since = Instant::now();
        entry.detail = None;
        true
    }

    fn observe_wait(
        &mut self,
        task: &Task,
        reason: Option<WaitReason>,
    ) -> Result<bool, StoreError> {
        self.observe_wait_detail(task, reason, None)
    }

    fn observe_wait_detail(
        &mut self,
        task: &Task,
        reason: Option<WaitReason>,
        detail: Option<WaitDetail>,
    ) -> Result<bool, StoreError> {
        let id = &task.identity().id;
        if reason == Some(WaitReason::Capacity) && self.wait_reason(id) != reason {
            self.enqueue_capacity(id)?;
        }
        // The first pass after restart establishes a baseline for a volatile wait.
        let entered = self.wait_label_changed(task, reason, detail.as_ref());
        if entered {
            self.store
                .record_board_entry(id, i64::try_from(now_ms()).unwrap_or(i64::MAX))?;
        }
        let changed = if matches!(detail, Some(WaitDetail::Archive(_))) {
            self.set_wait(id, reason)
        } else {
            self.apply_observed_wait(task, reason, entered)
        };
        let detail_changed = self.waits.get_mut(id).is_some_and(|wait| {
            if wait.detail == detail {
                return false;
            }
            wait.detail = detail;
            true
        });
        Ok(changed || detail_changed)
    }

    fn wait_label_changed(
        &self,
        task: &Task,
        reason: Option<WaitReason>,
        detail: Option<&WaitDetail>,
    ) -> bool {
        self.waits.get(&task.identity().id).is_some_and(|wait| {
            titles::task_state_label(task, wait.reason, wait.detail.as_ref())
                != titles::task_state_label(task, reason, detail)
        })
    }

    fn apply_observed_wait(
        &mut self,
        task: &Task,
        reason: Option<WaitReason>,
        entered: bool,
    ) -> bool {
        let id = &task.identity().id;
        if task.phase().is_terminal() && task.run().is_none() {
            let changed = self.set_wait(id, None);
            self.waits.remove(id);
            return changed;
        }
        let changed = self.set_wait(id, reason);
        self.waits.get_mut(id).expect("observed wait").timed |= entered;
        changed
    }

    fn apply_task_wait(&mut self, task: &Task, reason: Option<WaitReason>, entered: bool) {
        if entered || self.waits.contains_key(&task.identity().id) {
            self.apply_observed_wait(task, reason, entered);
        }
    }

    fn take_ready(&mut self, now: Instant, visited: &BTreeSet<String>) -> Option<DueTask> {
        self.schedule.take_ready(
            now,
            visited,
            self.capacity_waiters.iter().map(|(_, id)| id.as_str()),
        )
    }

    fn wake_capacity(&mut self, now: Instant) {
        if let Some(id) =
            self.capacity_waiters.iter().map(|(_, id)| id).find(|id| {
                !self.group_waits.contains_key(*id) && !self.schedule.effect_ready(id, now)
            })
        {
            self.schedule.wake(id, now, Priority::Effect);
        }
    }

    fn command_observation(&self, row: &TaskRow) -> Observation {
        let forge = self
            .observed_forge
            .get(&row.task.identity().id)
            .filter(|(version, _)| *version == row.version)
            .map_or(Observed::Unknown, |(_, forge)| {
                Observed::Known(forge.clone())
            });
        Observation {
            host: Observed::Unknown,
            forge,
            workspace: Observed::Unknown,
        }
    }
}

fn occupied_slot(task: &Task) -> bool {
    task.run()
        .and_then(nucleus_core::Run::last_send_at_ms)
        .is_some()
}

impl Service {
    fn track(&self, state: &mut State, task: &Task) {
        let id = &task.identity().id;
        if !active(task) {
            state.thread_tasks.remove(id);
            return;
        }
        let roles = task_rows::visibility_roles(task);
        let current_role = task.run().map(|run| run.launch().thread.as_str());
        let thread = current_role.or_else(|| {
            let role = match task.phase() {
                Phase::Working => nucleus_core::Role::Worker,
                Phase::Reviewing => nucleus_core::Role::Reviewer,
                _ => return None,
            };
            task.threads().get(role)
        });
        let mut threads: Vec<_> = thread.into_iter().map(str::to_owned).collect();
        if self.acp_provider().is_some() {
            let checkout =
                checkout_path(self.storage.work().path(), &task.identity().repository, id);
            threads.push(nucleus_hosts::parent_thread(&checkout));
        }
        if let Some(binding) = task.question_delivery() {
            threads.push(binding.thread.clone());
        }
        let tracked = state.thread_tasks.entry(id.clone()).or_default();
        tracked.retain(|thread, _| threads.contains(thread) || roles.contains(&thread.as_str()));
        for thread in roles
            .iter()
            .copied()
            .chain(threads.iter().map(String::as_str))
        {
            let tracked = tracked.entry(thread.to_owned()).or_default();
            tracked.role = current_role == Some(thread) || roles.contains(&thread);
            tracked.due = threads.iter().any(|due| due == thread);
        }
    }
}

fn active(task: &Task) -> bool {
    !matches!(
        task.phase(),
        Phase::ReportReady | Phase::Blocked | Phase::Error | Phase::Done | Phase::Cancelled
    ) && task.operator_decline() != Some(OperatorDecline::Notified)
        || task.run().is_some()
        || task.phase() == Phase::ReportReady
            && task
                .report_task()
                .is_some_and(|report| !report.notice_attempted)
}

impl State {
    fn preflight(
        &self,
        task: &mut Task,
        actor: &Authority,
        observation: &Observation,
        command: Command,
    ) -> Result<Preflight, ServiceError> {
        if matches!(command, Command::Answer(nucleus_core::Answer::Extend))
            && !self.allowance_view(task)?.exhausted
        {
            return Err(StoreError::AllowanceNotExhausted.into());
        }
        let planner_answer = match (&command, actor) {
            (Command::Answer(_), Authority::Planner { actor }) => Some(actor.as_str()),
            _ => None,
        };
        let awaiting_planner = if let Some(actor) = planner_answer {
            match task.question_delivery() {
                Some(binding) if binding.thread != actor => {
                    return Err(ServiceError::QuestionPlanner);
                }
                Some(_) => false,
                None => true,
            }
        } else {
            false
        };
        let authority = match actor {
            Authority::Planner { actor } => self.check_planner_authority(task, actor),
            Authority::Operator { .. } => Ok(()),
        };
        let was_terminal = task.phase().is_terminal();
        let ready = match task.command(command, actor, observation) {
            Ok(()) if !awaiting_planner => Preflight::Ready,
            Ok(()) | Err(CommandError::HeadUnverified) => Preflight::Pending,
            Err(error) => return Err(error.into()),
        };
        authority?;
        if was_terminal
            && !task.phase().is_terminal()
            && (self.store.task_project_removed(&task.identity().id)?
                || self.settings.projects.as_ref().is_some_and(|projects| {
                    projects.removed_origin(&task.identity().repository)
                        || task.report_task().is_some_and(|report| {
                            projects.removed.contains_key(&report.project)
                                && !projects.projects.contains_key(&report.project)
                        })
                }))
        {
            return Err(ServiceError::Project);
        }
        Ok(ready)
    }
}

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

fn event(kind: &str) -> EventDraft {
    EventDraft {
        at: i64::try_from(now_ms()).unwrap_or(i64::MAX),
        kind: kind.into(),
        detail: String::new(),
    }
}
