//! Service entry points for the isolated Rust task engine.

mod acp;
mod inbox;
mod pass;
mod presentation;
mod profiles;
mod project;
mod question;
mod schedule;
#[cfg(test)]
mod tests;
mod ticket;
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
    Action, Authority, Command, CommandError, Entry, Forge, Identity, Observation, Observed,
    OperatorDecline, Phase, Report, Task, WaitReason,
};
use nucleus_forge::{Branches, ForgeError, GitHub};
use nucleus_hosts::{HostError, RunActivity, T3, T3_RETRY_DELAY, ThreadHint};
use nucleus_store::{
    EngineStorage, Event, EventDraft, SettingsFile, StorageError, Store, StoreError, TaskRow,
};
use nucleus_work::{WorkError, Worktrees, checkout_path};
use rustix::fs::{FlockOperation, Mode, OFlags, flock, open};
use schedule::{DueTask, PASS_BATCH, Priority, Schedule};
use tokio::{
    sync::{Mutex, Notify, OwnedMutexGuard, broadcast, mpsc},
    time::Instant,
};

pub use project::{LaunchBudget, Project, ProjectMode, RegisteredAgent, RegisteredRole};
pub use ticket::ReportTicket;
pub use web::{Controller, router};

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("the task is outside this engine's configured project")]
    Project,
    #[error("task was not found")]
    Missing,
    #[error("task input is invalid")]
    Input,
    #[error("the question is assigned to a different planner")]
    QuestionPlanner,
    #[error("planner authority is not yet known. Retry shortly.")]
    PlannerAuthorityUnknown,
    #[error("the caller is no longer the responsible planner for this task")]
    PlannerAuthorityRefused,
    #[error("a task effect is still in progress. Retry shortly.")]
    EffectInProgress,
    #[error("an isolated engine is already serving this profile or its lock is unreadable")]
    ProfileLock,
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
    project: Project,
    host: T3,
    forge: GitHub,
    inbox: Option<inbox::Inbox>,
    callback: SocketAddr,
    report_command: PathBuf,
    state: Mutex<State>,
    pass_lock: Mutex<()>,
    watch_lock: Mutex<()>,
    changes: broadcast::Sender<TaskChange>,
    wake: Notify,
    planner_wake: Notify,
    forge_until: AtomicU64,
    forge_retry_secs: AtomicU64,
    // Keep the exclusive OS lock for the service lifetime.
    _profile: OwnedFd,
}

struct State {
    store: Store,
    settings: web::RuntimeSettings,
    schedule: Schedule,
    fences: BTreeMap<String, Arc<Mutex<()>>>,
    waits: BTreeMap<String, (WaitReason, Instant)>,
    capacity_waiters: VecDeque<String>,
    observed_forge: BTreeMap<String, (i64, Forge)>,
    forge_requested: BTreeSet<String>,
    activity: BTreeMap<String, presentation::ActivityAt>,
    planner_authority: Option<question::PlannerAuthority>,
    planner_authority_epoch: u64,
    thread_tasks: BTreeMap<String, BTreeMap<String, Option<ThreadHint>>>,
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
        let storage = settings.storage()?;
        storage.scratch().ensure()?;
        storage.log().ensure()?;
        let git = project::LocalGit(storage.scratch().path().into());
        project.verify(&git)?;
        let runtime_settings = web::RuntimeSettings::open(settings)?;
        if !callback.ip().is_loopback()
            || callback.port() == 0
            || !report_command.is_absolute()
            || !report_command.is_file()
        {
            return Err(ServiceError::Ticket);
        }
        let database = storage.database();
        database.ensure()?;
        let profile = open(
            database.path().join("service.lock"),
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|_| ServiceError::ProfileLock)?;
        flock(&profile, FlockOperation::NonBlockingLockExclusive)
            .map_err(|_| ServiceError::ProfileLock)?;
        let store = Store::open(&storage)?;
        let (changes, _) = broadcast::channel(64);
        Ok(Self {
            storage,
            git,
            settings: settings.clone(),
            project,
            host,
            forge,
            inbox: None,
            callback,
            report_command,
            state: Mutex::new(State {
                store,
                settings: runtime_settings,
                schedule: Schedule::new(),
                fences: BTreeMap::new(),
                waits: BTreeMap::new(),
                capacity_waiters: VecDeque::new(),
                observed_forge: BTreeMap::new(),
                forge_requested: BTreeSet::new(),
                activity: BTreeMap::new(),
                planner_authority: None,
                planner_authority_epoch: 0,
                thread_tasks: BTreeMap::new(),
            }),
            pass_lock: Mutex::new(()),
            watch_lock: Mutex::new(()),
            changes,
            wake: Notify::new(),
            planner_wake: Notify::new(),
            forge_until: AtomicU64::new(0),
            forge_retry_secs: AtomicU64::new(0),
            _profile: profile,
        })
    }

    /// Admit a brief on the configured synthetic project.
    ///
    /// # Errors
    /// Returns an error for malformed or duplicate input or a storage failure.
    pub async fn admit(
        &self,
        id: String,
        reference: String,
        brief: String,
        caller: &Authority,
    ) -> Result<Task, ServiceError> {
        let identity = Identity {
            id,
            reference,
            repository: self.project.repository.clone(),
            base: self.project.base.clone(),
            entry: Entry::Brief,
            origin_thread: match caller {
                Authority::Planner { actor } => Some(actor.clone()),
                Authority::Operator { .. } => None,
            },
        };
        self.project.scope(&identity)?;
        if identity.reference.trim().is_empty() || brief.trim().is_empty() {
            return Err(ServiceError::Input);
        }
        self.storage.database().verify()?;
        let task = Task::new(identity, brief, None);
        let mut state = self.state.lock().await;
        if state.settings.fixture_slots(&self.project).is_none() {
            return Err(ServiceError::Project);
        }
        state.store.create(&task, &event("admitted"))?;
        self.wake_task(&mut state, &task.identity().id, 1, Priority::Wake);
        Ok(task)
    }

    /// Wait for a due task and process one bounded batch.
    ///
    /// # Errors
    /// Returns an error if the engine cannot verify its volume or read its rows.
    pub async fn pass(&self) -> Result<Vec<PassOutcome>, ServiceError> {
        let _cycle = self.pass_lock.lock().await;
        self.storage.database().verify()?;
        let mut first = Some(self.wait_due_task().await?);
        let host = self.host.pass(self.storage.scratch().path());
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
            {
                let mut state = self.state.lock().await;
                self.track(&mut state, &row.task);
            }
            let result = Box::pin(self.advance_due_task(&row, &host)).await;
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
        if let Err(error) = self.clear_stale_inbox(row).await
            && row.task.operator_question().is_some()
            && row.task.operator_decline().is_none()
        {
            return Err(error);
        }
        if row.task.phase() == Phase::Done
            && row.task.run().is_none()
            && self.project.acp_provider.is_some()
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
                    state.settings.fixture_slots(&self.project).is_some(),
                    state.settings.profiles.is_some(),
                )
            };
            if !enabled || (!configured && self.project.mode == ProjectMode::Project) {
                return Ok(Action::Wait(WaitReason::Capacity));
            }
            if !configured {
                let catalog = host.profile_catalog().await?;
                if ![&self.project.worker, &self.project.reviewer]
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
            Box::pin(self.watch_planner_authority())
        );
    }

    async fn watch_thread_hints(&self) {
        loop {
            let (sender, mut hints) = mpsc::channel(128);
            let watch = self.host.watch_threads(&sender);
            tokio::pin!(watch);
            loop {
                tokio::select! {
                    _ = &mut watch => break,
                    Some(hint) = hints.recv() => self.wake_from_host(hint).await,
                }
            }
            {
                let mut state = self.state.lock().await;
                state.settings.host = web::CachedHost::Unavailable;
                state.invalidate_planner_authority();
            }
            tokio::time::sleep(T3_RETRY_DELAY).await;
        }
    }

    async fn wake_from_host(&self, hint: ThreadHint) {
        let mut state = self.state.lock().await;
        state.settings.host = web::CachedHost::Reachable;
        if hint.closed() {
            state.planner_thread_closed(&hint.thread);
        }
        let State {
            thread_tasks,
            schedule,
            ..
        } = &mut *state;
        let now = Instant::now();
        for (id, threads) in thread_tasks {
            if let Some(prior) = threads.get_mut(&hint.thread)
                && prior.as_ref() != Some(&hint)
            {
                *prior = Some(hint.clone());
                schedule.wake(id, now, Priority::Decision);
                self.wake.notify_one();
            }
        }
    }

    async fn launch_capacity(&self, id: &str, recovery: bool) -> Result<bool, ServiceError> {
        let state = self.state.lock().await;
        let fallback_slots = self.project.launch_budget.slots;
        let project_slots = match state.settings.fixture_slots(&self.project) {
            Some(slots) => slots,
            None if recovery => fallback_slots,
            None => return Ok(false),
        };
        let slots = state
            .settings
            .dispatch
            .as_ref()
            .map_or(fallback_slots, |dispatch| dispatch.slots);
        Ok(state.store.occupied_slots(id)? < slots.min(project_slots))
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
                schedule.seed(store, now, self.project.acp_provider.is_some())?;
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
        let archive_due = self.project.acp_provider.is_some()
            && current.task.phase() == Phase::Done
            && current.task.run().is_none()
            && !state.store.archive_confirmed(id)?;
        if !archive_due && !active(&current.task) && !state.forge_requested.contains(id) {
            state.set_wait(id, None);
            return Ok(());
        }
        if current.version != row.version {
            if state.schedule.due(id).is_none() {
                state.schedule.wake(id, Instant::now(), Priority::Decision);
            }
            return Ok(());
        }
        let now = Instant::now();
        let (delay, priority) = schedule::retry(wait);
        let due = match result {
            Err(
                ServiceError::Host(HostError::Deferred { until })
                | ServiceError::InboxUnavailable { until },
            ) => *until,
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
        state.schedule.wake(id, due, priority);
        let prior = state.set_wait(id, wait);
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
        let state = self.state.lock().await;
        let _ = self.lookup(&state, id)?;
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
        self.command_with_session(id, authority, command, None)
            .await
    }

    async fn command_with_session(
        &self,
        id: &str,
        authority: &Authority,
        command: Command,
        session: Option<&acp::WriteAccess>,
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
        if self.inbox.is_some()
            && prior.task.operator_question().is_some()
            && matches!(&command, Command::Answer(_))
        {
            return Err(ServiceError::AnswerInInbox);
        }
        if let Some(session) = session {
            if acp::writer_controller(&state, id, &session.credential) != Some(session.controller) {
                return Err(ServiceError::AcpUnauthorized);
            }
            if let Authority::Planner { actor } = authority
                && !matches!(command, Command::Answer(_))
            {
                state.check_planner_authority(&prior.task, actor)?;
            }
        }
        let observation = state.command_observation(&prior);
        let mut task = prior.task.clone();
        let explicit_move = matches!(command, Command::Move(_));
        match state.preflight(&mut task, authority, &observation, command)? {
            Preflight::Ready => {
                let version = if explicit_move || prior.task != task {
                    let mut audit = event("command");
                    if prior.task.phase() != task.phase()
                        && matches!(
                            task.phase(),
                            nucleus_core::Phase::Closing | nucleus_core::Phase::Done
                        )
                    {
                        presentation::note_merge(&mut audit, &observation.forge);
                    }
                    self.commit(&mut state, &prior, &task, &audit, None)?
                } else {
                    prior.version
                };
                Ok(CommandOutcome::Applied(Box::new(TaskRow { task, version })))
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
        let prior = self.task(id).await?;
        let mut task = prior.task.clone();
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
        self.save(&prior, task, &event("reported")).await?;
        Ok(())
    }

    fn lookup(&self, state: &State, id: &str) -> Result<TaskRow, ServiceError> {
        let row = state.store.row(id)?.ok_or(ServiceError::Missing)?;
        self.project.scope(row.task.identity())?;
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

    async fn check_project(&self) -> Result<(), ServiceError> {
        let project = self.project.clone();
        let git = self.git.clone();
        tokio::task::spawn_blocking(move || project.verify(&git))
            .await
            .map_err(|_| ServiceError::Project)??;
        let root = self
            .project
            .checkout
            .to_str()
            .ok_or(ServiceError::Project)?;
        self.host
            .check_project(&self.project.host_project, root)
            .await?;
        Ok(())
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
        Ok(TaskRow { task, version })
    }

    fn commit(
        &self,
        state: &mut State,
        prior: &TaskRow,
        task: &Task,
        audit: &EventDraft,
        subscription_group: Option<&str>,
    ) -> Result<i64, ServiceError> {
        let id = &task.identity().id;
        let audit = presentation::decorate(&prior.task, task, audit, &state.store);
        let version = match subscription_group {
            Some(group) => state
                .store
                .save_profile_launch(prior, task, &audit, group)?,
            None => state.store.save_row(prior, task, &audit)?,
        };
        self.track(state, task);
        state.set_wait(id, None);
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
            commit_priority(&prior.task, task, &audit),
        );
        Ok(version)
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
    fn set_wait(&mut self, id: &str, wait: Option<WaitReason>) -> Option<WaitReason> {
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
            .find(|id| !self.schedule.effect_ready(id, now))
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
        if self.project.acp_provider.is_some() {
            let checkout = checkout_path(self.storage.work().path(), &self.project.repository, id);
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
        nucleus_core::Phase::Done | nucleus_core::Phase::Cancelled
    ) && task.operator_decline() != Some(OperatorDecline::Notified)
        || task.run().is_some()
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
        let ready = match task.command(command, actor, observation) {
            Ok(()) if !awaiting_planner => Preflight::Ready,
            Ok(()) | Err(CommandError::HeadUnverified) => Preflight::Pending,
            Err(error) => return Err(error.into()),
        };
        if let Some(actor) = planner_answer {
            self.check_planner_authority(task, actor)?;
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
