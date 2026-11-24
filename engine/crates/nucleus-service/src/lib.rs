//! Service entry points for the isolated Rust task engine.

mod acp;
mod dependencies;
mod enrollment;
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
mod tell;
#[cfg(test)]
mod tests;
mod ticket;
mod titles;
mod web;

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
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
use nucleus_hosts::{HostError, RunActivity, T3, T3_RETRY_DELAY, ThreadHint};
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
    #[error("the Rust Inbox bridge needs a loopback endpoint, engine ID and owner-only key file")]
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
    inbox: Option<inbox::Inbox>,
    native_inbox: Option<native_inbox::NativeInbox>,
    callback: SocketAddr,
    report_command: PathBuf,
    state: Mutex<State>,
    project_writes: RwLock<()>,
    pass_lock: Mutex<()>,
    watch_lock: Mutex<()>,
    changes: broadcast::Sender<TaskChange>,
    project_changes: watch::Sender<()>,
    settings_changes: watch::Sender<()>,
    /// The environment's board theme inputs, cached from the host's config stream.
    theme: watch::Sender<Option<serde_json::Value>>,
    wake: Notify,
    planner_wake: Notify,
    title_wake: Notify,
    enrollment_wake: Notify,
    tell_wake: Notify,
    forge_until: AtomicU64,
    forge_retry_secs: AtomicU64,
    // Keep the exclusive OS lock for the service lifetime.
    _profile: OwnedFd,
}

struct State {
    store: Store,
    settings: web::RuntimeSettings,
    registry_mode: bool,
    schedule: Schedule,
    fences: BTreeMap<String, Arc<Mutex<()>>>,
    waits: BTreeMap<String, (WaitReason, Instant)>,
    capacity_waiters: VecDeque<String>,
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
    thread_tasks: BTreeMap<String, BTreeMap<String, Option<SeenThread>>>,
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
}

pub struct PassOutcome {
    pub task: String,
    pub result: Result<Action, ServiceError>,
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
        let runtime_settings = web::RuntimeSettings::open(settings)?;
        let store = Store::open(&storage)?;
        let registry_mode = project.is_none();
        let (changes, _) = broadcast::channel(64);
        Ok(Self {
            storage,
            git,
            settings: settings.clone(),
            project,
            registry_provider,
            host,
            forge,
            inbox: None,
            native_inbox: None,
            callback,
            report_command,
            state: Mutex::new(State {
                store,
                settings: runtime_settings,
                registry_mode,
                schedule: Schedule::new(),
                fences: BTreeMap::new(),
                waits: BTreeMap::new(),
                capacity_waiters: VecDeque::new(),
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
                thread_tasks: BTreeMap::new(),
            }),
            project_writes: RwLock::new(()),
            pass_lock: Mutex::new(()),
            watch_lock: Mutex::new(()),
            changes,
            project_changes: watch::Sender::new(()),
            settings_changes: watch::channel(()).0,
            theme: watch::channel(None).0,
            wake: Notify::new(),
            planner_wake: Notify::new(),
            title_wake: Notify::new(),
            enrollment_wake: Notify::new(),
            tell_wake: Notify::new(),
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
        self.storage.database().verify()?;
        let mut first = Some(self.wait_due_task().await?);
        let mut results = Vec::with_capacity(PASS_BATCH);
        let mut visited = BTreeSet::new();
        for _ in 0..PASS_BATCH {
            let next = match first.take() {
                Some(first) => Some(first),
                None => self
                    .state
                    .lock()
                    .await
                    .schedule
                    .take_ready(Instant::now(), &visited),
            };
            let Some(DueTask { id, priority }) = next else {
                break;
            };
            visited.insert(id.clone());
            let row = match self.task(&id).await {
                Ok(row) => row,
                Err(ServiceError::Missing) => continue,
                Err(error) => return Err(error),
            };
            let defer_refresh = {
                let mut state = self.state.lock().await;
                self.track(&mut state, &row.task);
                state.group_waits.remove(&id);
                priority == Priority::Refresh && state.fresh_running_hint(&row.task)
            };
            let result = if defer_refresh {
                Ok(Action::Wait(WaitReason::Running))
            } else {
                Box::pin(self.advance_due_task(&row, &host.for_task(&row.task))).await
            };
            self.schedule_result(&row, &result, priority).await?;
            results.push(PassOutcome { task: id, result });
        }
        Ok(results)
    }

    async fn advance_due_task(
        &self,
        row: &TaskRow,
        host: &impl nucleus_hosts::TaskHost,
    ) -> Result<Action, ServiceError> {
        if self.reconcile_prerequisites(row).await? {
            return Ok(Action::Nothing);
        }
        // A planner's availability must not hold the dependent after release.
        // Any unsent notice remains due through the store's scheduler scan.
        let _ = self.notify_prerequisite_release(row).await;
        let task = &row.task;
        if !matches!(
            task.phase(),
            Phase::Done | Phase::Cancelled | Phase::Closing
        ) && task.run().is_none()
            && task.hold().is_none()
            && task.question().is_none()
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
        if let Err(error) = self.clear_stale_inbox(row).await
            && row.task.operator_question().is_some()
            && row.task.operator_decline().is_none()
        {
            return Err(error);
        }
        if row.task.phase() == Phase::ReportReady {
            return self.notify_report_ready(row).await;
        }
        if row.task.phase() == Phase::Done
            && row.task.run().is_none()
            && (self.acp_provider().is_some() || row.task.report_task().is_some())
        {
            return self.archive_done(row).await;
        }
        if row.task.phase() == Phase::Queued
            && row.task.run().is_none()
            && row.task.hold().is_none()
            && row.task.question().is_none()
        {
            let (enabled, configured) = {
                let state = self.state.lock().await;
                (
                    self.resolve_project(&state, row.task.identity())
                        .is_ok_and(|route| route.slots.is_some()),
                    state.settings.profiles.is_some(),
                )
            };
            let fixture = self
                .project
                .as_ref()
                .filter(|project| project.mode == ProjectMode::Fixture);
            if !enabled || (!configured && fixture.is_none()) {
                return Ok(Action::Wait(WaitReason::Capacity));
            }
            if let Some(fixture) = fixture.filter(|_| !configured) {
                let catalog = host.profile_catalog().await?;
                if ![&fixture.worker, &fixture.reviewer]
                    .into_iter()
                    .all(|profile| catalog.supports(profile))
                {
                    return Err(HostError::Configuration.into());
                }
            }
        }
        self.advance(row, host).await
    }

    /// Use native thread changes to advance due times. Exact reads still own
    /// every decision, and the due queue stays live across stream failures.
    pub async fn watch_host(&self) {
        let _subscription = self.watch_lock.lock().await;
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
            let _ = self.host.watch_theme(&self.theme).await;
            tokio::time::sleep(T3_RETRY_DELAY).await;
        }
    }

    async fn watch_thread_hints(&self) {
        loop {
            let (sender, mut hints) = mpsc::channel(128);
            let inbox = self.native_inbox.as_ref();
            let watch = self.host.watch_threads(
                &sender,
                self.acp_provider(),
                inbox.map(|_| nucleus_hosts::INBOX_THREAD),
            );
            tokio::pin!(watch);
            loop {
                tokio::select! {
                    _ = &mut watch => break,
                    Some(hint) = hints.recv() => self.wake_from_host(hint).await,
                }
            }
            if let Some(inbox) = inbox {
                inbox.unobserved();
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
                    self.project_changes.send_replace(());
                    self.settings_changes.send_replace(());
                }
                for seen in state
                    .thread_tasks
                    .values_mut()
                    .flat_map(|threads| threads.values_mut())
                {
                    *seen = None;
                }
            }
            tokio::time::sleep(T3_RETRY_DELAY).await;
        }
    }

    async fn wake_from_host(&self, hint: ThreadHint) {
        if let Some(inbox) = &self.native_inbox
            && hint.thread == nucleus_hosts::INBOX_THREAD
        {
            inbox.wake();
        }
        let mut state = self.state.lock().await;
        self.set_cached_host(&mut state, web::CachedHost::Reachable);
        let authorities = state.planner_authority.len();
        state.planner_thread_changed(&hint);
        if state.invalidate_enrolled_planner(&hint) {
            self.project_changes.send_replace(());
            self.settings_changes.send_replace(());
        }
        if authorities != state.planner_authority.len() {
            self.settings_changes.send_replace(());
        }
        let State {
            thread_tasks,
            schedule,
            ..
        } = &mut *state;
        let now = Instant::now();
        for (id, threads) in thread_tasks {
            if let Some(prior) = threads.get_mut(&hint.thread) {
                let backed_off = schedule.reset_host_backoff(id);
                let changed = prior.as_ref().is_none_or(|prior| prior.hint != hint);
                *prior = Some(SeenThread {
                    hint: hint.clone(),
                    at: now,
                });
                if changed {
                    schedule.wake(id, now, Priority::Decision);
                    self.wake.notify_one();
                } else if backed_off {
                    schedule.wake(id, now + T3_RETRY_DELAY, Priority::Decision);
                    self.wake.notify_one();
                }
            }
        }
    }

    fn set_cached_host(&self, state: &mut State, status: web::CachedHost) {
        if state.settings.host != status {
            state.settings.host = status;
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
        let state = self.state.lock().await;
        let route = self.resolve_project(&state, identity)?;
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
                    store, schedule, ..
                } = &mut *state;
                schedule.seed(store, now, self.acp_provider().is_some())?;
                if let Some(ready) = schedule.take_ready(now, &BTreeSet::new()) {
                    return Ok(ready);
                }
                next = schedule.next();
            }
            tokio::select! {
                () = self.wake.notified() => {},
                () = tokio::time::sleep_until(next) => {},
            }
        }
    }

    async fn schedule_result(
        &self,
        row: &TaskRow,
        result: &Result<Action, ServiceError>,
        previous: Priority,
    ) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let wait = match result {
            Ok(Action::Wait(reason)) => Some(*reason),
            Err(ServiceError::Host(_)) => Some(WaitReason::HostUnknown),
            Err(ServiceError::Workspace(_)) => Some(WaitReason::WorkspaceUnknown),
            Err(ServiceError::Forge(_)) => Some(WaitReason::ForgeUnknown),
            Err(ServiceError::InboxUnavailable { .. }) => Some(WaitReason::Question),
            Err(ServiceError::Profile(_) | ServiceError::ProfileConfiguration) => {
                Some(WaitReason::Capacity)
            }
            _ => None,
        };
        let mut state = self.state.lock().await;
        let current = self.lookup(&state, id)?;
        let archive_due = (self.acp_provider().is_some() || current.task.report_task().is_some())
            && current.task.phase() == Phase::Done
            && current.task.run().is_none()
            && !state.store.archive_confirmed(id)?;
        if !archive_due && !active(&current.task) && !state.forge_requested.contains(id) {
            state.set_wait(id, None);
            state.schedule.reset_host_backoff(id);
            return Ok(());
        }
        if current.version != row.version {
            if state.schedule.due(id).is_none() {
                state.schedule.wake(id, Instant::now(), Priority::Decision);
            }
            return Ok(());
        }
        let now = Instant::now();
        let (delay, priority) = state.schedule.retry_task(id, wait);
        let due = match result {
            Err(ServiceError::Host(HostError::Deferred { until })) => (*until).max(now + delay),
            Err(ServiceError::InboxUnavailable { until }) => *until,
            _ if wait == Some(WaitReason::ForgeUnknown) => now + self.forge_backoff().max(delay),
            _ => now + delay,
        };
        let priority = if wait == Some(WaitReason::Capacity) {
            priority
        } else if row
            .task
            .run()
            .is_some_and(|run| run.revoked() || run.last_send_at_ms().is_none())
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
        let prior = state.set_wait(id, wait);
        if (prior == Some(WaitReason::Running)) != (wait == Some(WaitReason::Running)) {
            self.title_wake.notify_one();
        }
        self.desire_title(&state, &row.task, row.reference().as_ref(), wait);
        if prior != wait {
            self.publish(id, current.version);
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
            Preflight::Pending => {
                state.forge_requested.insert(id.into());
                state
                    .schedule
                    .wake(id, Instant::now() + self.forge_backoff(), Priority::Wake);
                self.wake.notify_one();
                Ok(CommandOutcome::Pending {
                    version: prior.version,
                })
            }
        }
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
            branches.target(&pr.url).map_err(|_| ServiceError::Input)?;
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
        let version = state
            .store
            .save_brief_with_dependencies(prior, task, &audit, &ids)?;
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
        let version = match subscription_group {
            Some(group) => state
                .store
                .save_profile_launch(prior, task, &audit, group)?,
            None => state.store.save_row(prior, task, &audit)?,
        };
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
        }
        if state.set_wait(id, None) == Some(WaitReason::Running) {
            self.title_wake.notify_one();
        }
        self.desire_title(state, task, prior.reference().as_ref(), None);
        state.schedule.reset_host_backoff(id);
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
            self.publish(id, row.version);
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
            self.publish(id, row.version);
        }
        Ok(())
    }

    fn wake_task(&self, state: &mut State, id: &str, version: i64, priority: Priority) {
        state.schedule.wake(id, Instant::now(), priority);
        self.wake.notify_one();
        self.publish(id, version);
    }

    fn publish(&self, id: &str, version: i64) {
        let _ = self.changes.send(TaskChange {
            task_id: id.into(),
            version,
        });
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
        "run_reserved"
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
        self.waits
            .get(id)
            .is_some_and(|(wait, _)| *wait == WaitReason::Running)
            && self
                .thread_tasks
                .get(id)
                .and_then(|threads| threads.get(&run.launch().thread))
                .and_then(Option::as_ref)
                .is_some_and(|seen| seen.hint.running() && seen.at.elapsed() < schedule::LIVE_CHECK)
    }

    fn set_wait(&mut self, id: &str, wait: Option<WaitReason>) -> Option<WaitReason> {
        if wait != Some(WaitReason::Capacity) {
            self.group_waits.remove(id);
        }
        let prior = self.waits.get(id).map(|(reason, _)| *reason);
        if prior == wait {
            return prior;
        }
        match wait {
            Some(reason) => {
                self.waits.insert(id.into(), (reason, Instant::now()));
            }
            None => {
                self.waits.remove(id);
            }
        }
        if prior == Some(WaitReason::Capacity) {
            self.capacity_waiters.retain(|waiting| waiting != id);
        } else if wait == Some(WaitReason::Capacity) {
            self.capacity_waiters.push_back(id.into());
        }
        prior
    }

    fn wake_capacity(&mut self, now: Instant) {
        if let Some(id) = self
            .capacity_waiters
            .iter()
            .find(|id| !self.group_waits.contains_key(*id) && !self.schedule.effect_ready(id, now))
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
        let thread = task
            .run()
            .map(|run| run.launch().thread.as_str())
            .or_else(|| {
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
        tracked.retain(|thread, _| threads.contains(thread));
        for thread in threads {
            tracked.entry(thread).or_insert(None);
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
        let ready = match task.command(command, actor, observation) {
            Ok(()) if !awaiting_planner => Preflight::Ready,
            Ok(()) | Err(CommandError::HeadUnverified) => Preflight::Pending,
            Err(error) => return Err(error.into()),
        };
        authority?;
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
