use std::{
    ops::ControlFlow,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{
    Action, CallbackCredential, CheckState, CloseWorkspace, Forge, Head, Host, Launch,
    LaunchInputs, Observation, Observed, Phase, Report, Role, Run, RunState, Task, WaitReason,
    Workspace, decide,
};
use nucleus_forge::{Branches, ForgeError, MergeWrite, PullTarget};
use nucleus_hosts::{
    ActiveChild, Binding, ControlDispatch, DoneArchive, HostError, LaunchRequest,
    NoticeAuthorization, NoticeTarget, ParentAttempt, ParentRun, ParentStep, SendOutcome,
    StopProgress, T3, TaskHost, launch_diagnostic,
};
use nucleus_store::{
    CriticalReviewFallback, DispatchMode, ParentDelivery, ParentResult, StoreError, TaskRow,
};
use nucleus_work::{Checkout, Retirement, WorkError};
use tokio::sync::RwLockReadGuard;

use crate::{
    Service, ServiceError, active, event, now_ms,
    profiles::{LaunchSelection, SelectedLaunch},
    project::ProjectRoute,
    prompt::{Assignment, LaneContext, Prompt, PromptSize, report_reminder},
    scratch, ticket,
    volume::{Limit, Step},
};

const MAX_FORGE_RETRY: Duration = Duration::from_mins(4);

fn write_prompt_artifacts(
    root: &nucleus_store::StorageDirectory,
    run: &Run,
    task: &Task,
    lanes: &LaneContext,
    size: &PromptSize,
) -> Result<(), ServiceError> {
    let launch = run.launch();
    scratch::allocate(root, launch)?;
    scratch::materialize_lane_documents(root, launch, &lanes.pins)?;
    let role = match launch.role {
        Role::Reviewer => "reviewer",
        Role::Worker if task.threads().get(Role::Worker).is_some() => "revision",
        Role::Worker => "worker",
    };
    let directory = launch.scratch.as_deref().ok_or(ServiceError::Ticket)?;
    scratch::write_prompt_size(directory, &launch.instance, role, size)
}

/// The scratch directory of the current or settled run. This can read the volume.
fn find_run_scratch(root: &Path, task: &Task) -> Option<PathBuf> {
    let id = &task.identity().id;
    if let Some(run) = task.run() {
        let launch = run.launch();
        return Some(scratch::bound_path(
            root,
            id,
            &launch.instance,
            launch.scratch.as_deref(),
        ));
    }
    if !matches!(
        task.phase(),
        Phase::Closing | Phase::Done | Phase::Cancelled
    ) {
        return None;
    }
    let (instance, recorded) = task.settled_scratch()?;
    retained_scratch_path(root, id, &instance, recorded)
}

fn retained_scratch_path(
    root: &Path,
    id: &str,
    instance: &str,
    recorded: Option<&Path>,
) -> Option<PathBuf> {
    let path = if let Some(path) = recorded {
        path.to_owned()
    } else {
        // Pre-upgrade settled rows retain the sequence but omit the absolute path.
        let short = root.join(scratch::relative_path(instance));
        if matches!(short.try_exists(), Ok(false)) {
            scratch::bound_path(root, id, instance, None)
        } else {
            short
        }
    };
    // Retention may already have removed the directory. Other errors stay fenced.
    (!matches!(path.try_exists(), Ok(false))).then_some(path)
}

enum SendAttempt {
    Deferred,
    Prerequisite,
    Allowance,
    Sent(Box<(TaskRow, SendOutcome, bool)>),
}

pub(super) enum DispatchTarget<'a> {
    Run {
        frozen: &'a Binding,
        checkout: &'a Checkout<'a>,
        launch: bool,
    },
    Presentation {
        frozen: &'a Binding,
        checkout: &'a Checkout<'a>,
    },
    Planner(&'a NoticeAuthorization),
}

pub(super) struct DispatchPermit<'a> {
    _projects: RwLockReadGuard<'a, ()>,
    superseded: bool,
}

impl Service {
    pub(super) async fn existing_run_scratch(
        &self,
        task: &Task,
    ) -> Result<Option<PathBuf>, ServiceError> {
        if let Some(path) = task.run().and_then(|run| run.launch().scratch.clone()) {
            return Ok(Some(path));
        }
        if task.run().is_none()
            && !matches!(
                task.phase(),
                Phase::Closing | Phase::Done | Phase::Cancelled
            )
        {
            return Ok(None);
        }
        let task = task.clone();
        let id = task.identity().id.clone();
        self.scratch_job(&id, "finding run scratch", move |root, _| {
            let found = find_run_scratch(root.path(), &task);
            // Absence counts only while the root it was read under is still there.
            root.verify().map_err(WorkError::from)?;
            Ok(found)
        })
        .await
    }

    pub(super) async fn clear_ticket(&self, task: &str, run: &Run) {
        let run = run.clone();
        // A ticket left behind names no current run, so it cannot report.
        let _ = self
            .scratch_job(task, "clearing a report ticket", move |root, custody| {
                // Read first: a read which hangs must not count as a running write.
                root.verify().map_err(WorkError::from)?;
                let _step = custody.mutate().map_err(WorkError::from)?;
                ticket::clear(root, &run);
                Ok(())
            })
            .await;
    }

    #[cfg(test)]
    pub(super) async fn archive_done(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let pass = self.host.pass(self.storage.scratch().path());
        let scratch = self.existing_run_scratch(&row.task).await?;
        self.archive_done_in_pass(row, &pass.for_task(&row.task, scratch))
            .await
    }

    pub(super) async fn archive_done_in_pass(
        &self,
        row: &TaskRow,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        let parenting = self.acp_provider().is_some();
        if !task.phase().is_terminal()
            || task.hold().is_some()
            || (!parenting && task.report_task().is_none())
        {
            return Ok(Action::Nothing);
        }
        let identity = task.identity();
        let _fence = self.effect(row).await?;
        let _projects = self.project_writes.read().await;
        let route = self.project_for(identity).await?;
        let step = if parenting {
            self.prepare_terminal_archive(task, &route)?
        } else {
            DoneArchive::Finished
        };
        match step {
            DoneArchive::Finished => {}
            DoneArchive::Wait(cause) => return Err(ServiceError::ArchiveEvidence(cause)),
            DoneArchive::Write(write) => {
                let running = || {
                    self.state.try_lock().is_ok_and(|state| {
                        state
                            .settings
                            .dispatch
                            .as_ref()
                            .is_none_or(|dispatch| dispatch.mode == DispatchMode::Running)
                    })
                };
                if !self.host.write_archive(write, running).await? {
                    return Err(ServiceError::ArchiveEvidence(
                        "Waiting for running Dispatch and an unchanged idle T3 thread before archiving.".into(),
                    ));
                }
                self.recheck_effect(row, WaitReason::Stopping).await;
                return Ok(Action::Wait(WaitReason::Stopping));
            }
        }
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, &identity.id)?;
        let binding = self.checkout_binding(identity, &route, &checkout)?;
        let workspace = self.observe_checkout_for_retirement(&checkout).await?;
        if workspace == Workspace::Absent {
            if self.has_prunable_registration(&checkout).await?
                && self
                    .retire_if_idle(host, task, &binding, &checkout, None)
                    .await?
                    .is_none()
            {
                return Err(ServiceError::ArchiveEvidence(
                    "Waiting for the checkout to be idle before removal.".into(),
                ));
            }
            return Ok(Action::Nothing);
        }
        self.stop_checkout_orphans(host, task, &checkout).await?;
        let head = self
            .archive_retirement_head(row, &route, &checkout, &workspace)
            .await?;
        let retained = || {
            ServiceError::ArchiveEvidence(
                "The task checkout was retained. Inspect its local changes.".into(),
            )
        };
        let Some(head) = head else {
            return Err(retained());
        };
        if workspace == Workspace::Dirty
            && self.deletion_only_head(&checkout).await?.as_ref() != Some(&head)
        {
            return Err(retained());
        }
        if task.phase() == Phase::Done && task.report_task().is_none() {
            if matches!(&workspace, Workspace::Clean(local) if *local != head) {
                return Err(retained());
            }
            let (publication, _) = self.read_forge(task, &checkout).await?;
            if !matches!(publication, Forge::Merged { ref pr, .. } if Some(pr) == task.pull_request())
            {
                return Err(ServiceError::ArchiveEvidence(
                    "The merged pull request does not confirm the retained checkout's recorded head.".into(),
                ));
            }
        }
        match self
            .retire_if_idle(host, task, &binding, &checkout, Some(&head))
            .await?
        {
            Some(Retirement::Retained) if task.report_task().is_some() => Err(
                ServiceError::ReportCheckout("the checkout changed after publication was proved"),
            ),
            Some(Retirement::Retained) => Err(retained()),
            None => Err(ServiceError::ArchiveEvidence(
                "Waiting for the checkout to be idle before removal.".into(),
            )),
            Some(Retirement::Removed | Retirement::Absent) => Ok(Action::Nothing),
        }
    }

    #[expect(
        clippy::redundant_closure_for_method_calls,
        reason = "the method path is not general over the checkout's lifetime"
    )]
    async fn has_prunable_registration(&self, checkout: &Checkout<'_>) -> Result<bool, WorkError> {
        self.checkout_job(
            checkout,
            "reading the Git registration",
            Limit::Check,
            |checkout| checkout.has_prunable_registration(),
        )
        .await
    }

    #[expect(
        clippy::redundant_closure_for_method_calls,
        reason = "the method path is not general over the checkout's lifetime"
    )]
    pub(super) async fn deletion_only_head(
        &self,
        checkout: &Checkout<'_>,
    ) -> Result<Option<Head>, WorkError> {
        self.checkout_job(
            checkout,
            "checking for deleted files",
            Limit::Check,
            |checkout| checkout.deletion_only_head(),
        )
        .await
    }

    fn prepare_terminal_archive(
        &self,
        task: &Task,
        route: &ProjectRoute,
    ) -> Result<DoneArchive, ServiceError> {
        let identity = task.identity();
        let path = nucleus_work::checkout_path(
            self.storage.work().path(),
            &identity.repository,
            &identity.id,
        );
        let branch = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(ServiceError::Project)?;
        let binding = route.thread_binding(&path, branch)?;
        Ok(self.host.prepare_archive(
            &binding,
            task.threads().get(Role::Reviewer),
            task.threads().get(Role::Worker),
        )?)
    }

    async fn archive_retirement_head(
        &self,
        row: &TaskRow,
        route: &ProjectRoute,
        checkout: &Checkout<'_>,
        workspace: &Workspace,
    ) -> Result<Option<Head>, ServiceError> {
        let task = &row.task;
        if task.phase() == Phase::Cancelled {
            let candidate = match workspace {
                Workspace::Clean(head) => Some(head.clone()),
                Workspace::Dirty => self.deletion_only_head(checkout).await?,
                Workspace::Absent => None,
            };
            let Some(head) = candidate else {
                return Ok(None);
            };
            let identity = task.identity();
            self.verify_route(identity, route).await?;
            return Ok(self
                .is_published_checkout(identity, checkout, &head)
                .await?
                .then_some(head));
        }
        if task.report_task().is_some() {
            return self.report_archive_head(row, checkout).await;
        }
        Ok((task.phase() == Phase::Done)
            .then(|| task.pull_request().map(|pr| pr.head.clone()))
            .flatten())
    }

    #[expect(
        clippy::too_many_lines,
        reason = "keep the ordered task pass and its effect gates together"
    )]
    pub(super) async fn advance(
        &self,
        row: &TaskRow,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        let forge_requested = self
            .state
            .lock()
            .await
            .forge_requested
            .contains(&task.identity().id);
        if !active(task) && !forge_requested {
            return Ok(Action::Nothing);
        }
        let run_host = if let Some(run) = task
            .run()
            .filter(|run| !run.revoked() && run.report().is_none())
        {
            let (state, error, limit) = self.read_current_run(row, run, host, &route).await?;
            if !forge_requested
                && run.last_send_at_ms().is_some()
                && task.question().is_none()
                && let Some(wait) = waiting_on_run(task, &state, error)
            {
                self.observe_commands(row, &Observed::Unknown).await?;
                return wait.map_err(ServiceError::Host);
            }
            Some((state, error, limit))
        } else {
            None
        };
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, &identity.id)?;
        let (forge, target, forge_error) = if task.report_task().is_some() {
            (Observed::Unknown, None, None)
        } else {
            match self.read_forge(task, &checkout).await {
                Ok((forge, target)) => (Observed::Known(forge), target, None),
                Err(error) => (Observed::Unknown, None, Some(error)),
            }
        };
        self.observe_commands(row, &forge).await?;
        if !active(task) {
            return forge_error.map_or(Ok(Action::Nothing), Err);
        }
        if task.phase() != Phase::Closing
            && task.run().is_none()
            && task.question().is_none()
            && task.hold().is_none()
            && !matches!(forge, Observed::Known(Forge::Merged { .. }))
            && self.dependencies_blocked(row).await?
        {
            return Ok(Action::Wait(WaitReason::Prerequisite));
        }
        let binding = route.binding(&checkout)?;
        let workspace = self.observe_checkout(&checkout).await;
        let mut observation = Observation {
            host: Observed::Unknown,
            forge,
            workspace: if matches!(workspace, Err(WorkError::Initializing))
                && self.initialization_due(task).await
            {
                Observed::Known(Workspace::Absent)
            } else {
                seen(workspace.as_ref().cloned())
            },
        };
        // The operator's global stop settles a live run through stop custody too.
        if task.run().is_some_and(nucleus_core::Run::revoked)
            || (task.run().is_some() && self.dispatch_mode().await == DispatchMode::Stopped)
        {
            return self.stop_run(row, &checkout, observation, host).await;
        }
        if task.hold().is_none()
            && let Some(
                error @ ServiceError::Forge(
                    ForgeError::UnpublishedMerge | ForgeError::UnverifiedSource,
                ),
            ) = forge_error
        {
            return Err(error);
        }
        if task.phase() == Phase::Reviewing
            && task.run().is_none()
            && task.question().is_none()
            && task.hold().is_none()
            && observation.workspace == Observed::Known(Workspace::Absent)
            && let Observed::Known(Forge::Open { pr, .. }) = &observation.forge
            && task.pull_request() == Some(pr)
            && let Some(target) = &target
        {
            let _fence = self.effect(row).await?;
            if let Some(workspace) = self
                .allocate_checkout(task, &checkout, Some((&pr.head, target.number())))
                .await?
            {
                observation.workspace = Observed::Known(workspace);
            } else if matches!(workspace, Err(WorkError::Initializing)) {
                return Ok(Action::Wait(WaitReason::Capacity));
            }
        }
        let (host_state, mut host_error, limit) =
            run_host.unwrap_or((Observed::Unknown, None, None));
        observation.host = host_state;
        let mut action = decide(task, &observation);
        if task.run().is_none()
            && matches!(
                action,
                Action::Launch { .. } | Action::Wait(WaitReason::HostUnknown)
            )
        {
            if !self
                .dispatch_mode()
                .await
                .allows_launch(task.first_launch())
            {
                return Ok(Action::Wait(WaitReason::Capacity));
            }
            // A runless task needs retained-thread custody only when it can launch.
            if action == Action::Wait(WaitReason::HostUnknown) {
                match read_retained(host, task, &binding).await {
                    Ok(state) => observation.host = state,
                    Err(error) => host_error = Some(error),
                }
                action = decide(task, &observation);
            }
        }
        match action {
            Action::Advance(Phase::Working) if task.phase() == Phase::Queued => {
                if forge_requested && let Some(error) = forge_error {
                    return Err(error);
                }
                if observation.workspace == Observed::Unknown {
                    return Err(workspace.err().unwrap_or(WorkError::MissingCheckout).into());
                }
                let _fence = self.effect(row).await?;
                let _projects = self.project_writes.read().await;
                let route = self.project_for(identity).await?;
                let Some(slots) = route.slots else {
                    return Ok(Action::Wait(WaitReason::Capacity));
                };
                if observation.workspace == Observed::Known(Workspace::Absent)
                    && !self.workspace_capacity(identity, &route, slots).await?
                {
                    return Ok(Action::Wait(WaitReason::Capacity));
                }
                let state = self.state.lock().await;
                if !self.initial_dispatch_allowed(&state, identity)? {
                    return Ok(Action::Wait(WaitReason::Capacity));
                }
                let configured = state.settings.profiles.is_some();
                drop(state);
                if !configured {
                    let Some(fixture) = self.project.as_ref() else {
                        return Ok(Action::Wait(WaitReason::Capacity));
                    };
                    let catalog = host.profile_catalog().await?;
                    if ![&fixture.worker, &fixture.reviewer]
                        .into_iter()
                        .all(|profile| catalog.supports(profile))
                    {
                        return Err(HostError::Configuration.into());
                    }
                }
                let mut state = self.state.lock().await;
                if state.store.dependency_blocked(&identity.id)? {
                    return Ok(Action::Wait(WaitReason::Prerequisite));
                }
                if !self.initial_dispatch_allowed(&state, identity)? {
                    return Ok(Action::Wait(WaitReason::Capacity));
                }
                let mut admitted = task.clone();
                admitted.reconcile(&observation);
                self.commit(&mut state, row, &admitted, &event("queue_admitted"), None)?;
                state.enqueue_capacity(&admitted)?;
                Ok(action)
            }
            Action::Wait(WaitReason::WorkspaceUnknown) if let Err(error) = workspace => {
                Err(error.into())
            }
            Action::Wait(WaitReason::WorkspaceUnknown)
                if observation.workspace == Observed::Known(Workspace::Absent) =>
            {
                Err(WorkError::MissingCheckout.into())
            }
            Action::Wait(WaitReason::HostUnknown) if let Some(error) = host_error => {
                Err(ServiceError::Host(error))
            }
            Action::Wait(WaitReason::Question) => self.notify_question(row).await,
            Action::Launch {
                via: Launch::SendPrepared,
                ..
            } => self.send_prepared(row, &checkout, observation, host).await,
            Action::Launch { role, via } => {
                self.reserve(row, &checkout, observation, role, via, host)
                    .await
            }
            Action::RemindReport => {
                self.reserve_report_reminder(row, &checkout, &observation)
                    .await
            }
            action @ Action::Advance(_)
                if let Some(target) = target.as_ref()
                    && task.run().is_some_and(|run| {
                        !run.revoked() && matches!(run.report(), Some(Report::Review { .. }))
                    }) =>
            {
                self.apply_reviewer_transition(row, target, &observation, action)
                    .await
            }
            Action::Merge { head } if let Some(target) = target.as_ref() => {
                self.merge(row, target, observation, &head).await
            }
            Action::Close { workspace, .. } if let Some(target) = target.as_ref() => {
                self.close(host, row, &checkout, &binding, target, workspace)
                    .await
            }
            Action::Wait(WaitReason::ForgeUnknown) if let Some(error) = forge_error => Err(error),
            Action::Wait(_) if forge_requested && let Some(error) = forge_error => Err(error),
            action => {
                self.apply_with_limit(row, &observation, action, limit.as_ref())
                    .await
            }
        }
    }

    async fn read_current_run(
        &self,
        row: &TaskRow,
        run: &Run,
        host: &impl TaskHost,
        route: &ProjectRoute,
    ) -> Result<(Observed<Host>, Option<HostError>, Option<serde_json::Value>), ServiceError> {
        let _step = Step::enter("observing the T3 run");
        let mut limited = None;
        let mut limit_fact = None;
        // Only a continuing worker reuses a parent turn that may already have ended.
        let reuses_parent =
            self.acp_provider().is_some() && nucleus_hosts::retained_worker_continuation(run);
        let mut unproven = false;
        let (state, activity, error, active_child) = match host.observe_run(run, now_ms()).await {
            Ok(seen) => {
                if run.launch().role == Role::Worker
                    && let Some(routing) = &seen.routing
                {
                    self.observe_run_routing(row, run, routing).await?;
                }
                if let Some(limit) = &seen.provider_limit {
                    let (cause, group, reset_at_ms) =
                        self.record_provider_limit(row, run, limit).await?;
                    if let Host::Current {
                        instance,
                        state: RunState::UsageLimited,
                    } = &seen.host
                    {
                        limit_fact = Some(serde_json::json!({
                            "instance": instance, "group": group, "resetAtMs": reset_at_ms,
                        }));
                        limited = Some(Observed::Known(Host::ProviderLimited {
                            instance: instance.clone(),
                            cause,
                        }));
                    }
                }
                unproven = reuses_parent
                    && matches!(
                        &seen.host,
                        Host::Current {
                            state: RunState::Running,
                            ..
                        }
                    );
                (
                    Observed::Known(seen.host),
                    seen.activity,
                    None,
                    seen.active_child,
                )
            }
            Err(error) => {
                if run.last_send_at_ms().is_none() {
                    service_log!(
                        "{}: before reading T3 launch state for {}: {error}",
                        run.launch().instance,
                        launch_diagnostic(run)
                    );
                }
                (Observed::Unknown, None, Some(error), None)
            }
        };
        self.observe_role_state(row, &state).await?;
        self.observe_activity(row, activity).await?;
        if let Some(child) = active_child {
            self.reenter_active_parent(row, route, &child).await?;
        } else if crate::schedule::reentry_recheck_due(unproven, run.last_send_at_ms(), now_ms()) {
            // The continuation's native run may not be visible yet. Look again
            // soon instead of waiting for the live check that may come after it ends.
            self.recheck_reentry(row).await;
        }
        Ok((limited.unwrap_or(state), error, limit_fact))
    }

    pub(super) fn check_forge_ready(&self) -> Result<(), ForgeError> {
        let deadline = self.forge_until.load(Ordering::Relaxed);
        if now_ms() < deadline {
            return Err(ForgeError::Deferred {
                until: UNIX_EPOCH + std::time::Duration::from_millis(deadline),
            });
        }
        Ok(())
    }

    pub(super) async fn command_forge(&self, task: &Task) -> Result<Forge, ServiceError> {
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, &identity.id)?;
        self.read_forge(task, &checkout)
            .await
            .map(|(forge, _)| forge)
    }

    async fn read_forge(
        &self,
        task: &Task,
        checkout: &Checkout<'_>,
    ) -> Result<(Forge, Option<PullTarget>), ServiceError> {
        self.check_forge_ready()?;
        let _step = Step::enter("reading GitHub");
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        route.binding(checkout)?;
        let review_entry = task.identity().entry == nucleus_core::Entry::ReviewEntry;
        let branches = if review_entry {
            Branches::for_review_entry(&identity.repository, &identity.base)?
        } else {
            Branches::new(&identity.repository, &identity.base, checkout.branch())?
        };
        let target = match recorded_source(task) {
            Some(pr) => Some(branches.target(&pr.url)?),
            None if review_entry => return Err(ForgeError::Identity.into()),
            None if task.phase() == Phase::Queued => None,
            None => capture_forge(self, self.forge.find_open(&branches).await)?,
        };
        match target {
            Some(target) => {
                let observed = if task.phase() == Phase::Merging && task.verdict().is_some() {
                    self.forge.observe_for_merge(&target).await
                } else {
                    self.forge.observe(&target).await
                };
                let forge = capture_forge(self, observed)?;
                self.verify_external_merge(task, &target, &forge).await?;
                Ok((forge, Some(target)))
            }
            None => Ok((Forge::Absent, None)),
        }
    }

    async fn verify_external_merge(
        &self,
        task: &Task,
        target: &PullTarget,
        forge: &Forge,
    ) -> Result<(), ServiceError> {
        let Forge::Merged { pr, commit } = forge else {
            return Ok(());
        };
        if matches!(task.verdict(), Some(nucleus_core::Verdict::Reviewed { head, decision: nucleus_core::Review::Approve, .. }) if head == &pr.head)
        {
            return Ok(());
        }
        let source = recorded_source(task).ok_or(ForgeError::UnverifiedSource)?;
        if source.url != pr.url
            || (source.head != pr.head
                && !capture_forge(
                    self,
                    self.forge
                        .pull_descends_from(target, &source.head, &pr.head)
                        .await,
                )?)
        {
            return Err(ForgeError::UnverifiedSource.into());
        }
        Ok(capture_forge(
            self,
            self.forge.verify_merge_base(target, commit).await,
        )?)
    }

    #[cfg(test)]
    pub(super) fn binding(&self, checkout: &Checkout<'_>) -> Result<Binding, ServiceError> {
        Ok(Binding {
            project_id: self.fixture().host_project.clone(),
            worktree_path: checkout
                .path()
                .to_str()
                .ok_or(ServiceError::Project)?
                .into(),
            branch: checkout.branch().into(),
        })
    }

    async fn allocate_checkout(
        &self,
        task: &Task,
        checkout: &Checkout<'_>,
        review: Option<(&Head, i32)>,
    ) -> Result<Option<Workspace>, ServiceError> {
        let _projects = self.project_writes.read().await;
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        let Some(slots) = route.slots else {
            return Ok(None);
        };
        if review.is_none()
            && identity.entry == nucleus_core::Entry::Brief
            && task.threads().get(Role::Worker).is_none()
            && !self.workspace_capacity(identity, &route, slots).await?
        {
            return Ok(None);
        }
        self.checkout_binding(identity, &route, checkout)?;
        let base_head = self.verify_route(identity, &route).await?;
        if self.initialization_due(task).await
            && self
                .checkout_job(
                    checkout,
                    "reading the task checkout",
                    Limit::Check,
                    |checkout| Ok(checkout.path().try_exists()?),
                )
                .await?
        {
            if !self
                .dispatch_mode()
                .await
                .allows_launch(task.first_launch())
                || !self.launch_capacity(identity, false).await?
            {
                return Ok(None);
            }
            self.checkout_job(
                checkout,
                "quarantining the interrupted checkout",
                Limit::Change,
                |checkout| checkout.quarantine_initialization(now_ms()),
            )
            .await?;
        }
        let step = "allocating the task checkout";
        let workspace = if let Some((head, pull)) = review {
            let head = head.clone();
            self.checkout_job(checkout, step, Limit::Change, move |checkout| {
                checkout.allocate_review(&head, pull)
            })
            .await?
        } else {
            let start = if let Some(report) = task.report_task() {
                report.planning_base.clone()
            } else if let Some(project) = &self.project {
                project.start.clone()
            } else if identity.entry == nucleus_core::Entry::Brief {
                self.published_start(identity, checkout).await?
            } else {
                base_head
            };
            self.checkout_job(checkout, step, Limit::Change, move |checkout| {
                checkout.allocate(&start)
            })
            .await?
        };
        Ok(Some(workspace))
    }

    /// A brief task starts from the fetched published base, which must hold
    /// every landed prerequisite. The registered checkout's local branch can be
    /// behind it.
    async fn published_start(
        &self,
        identity: &nucleus_core::Identity,
        checkout: &Checkout<'_>,
    ) -> Result<Head, ServiceError> {
        let landings = self.prerequisite_landings(identity).await?;
        let base = identity.base.clone();
        let fetch = checkout.job(
            self.git.clone(),
            Redactor::new([], RedactionRules::common()),
            move |checkout| checkout.published_start(&base, &landings),
        );
        // The fetch moves a ref every task of the repository reads, so a fetch
        // still running holds back all of them.
        let repository = checkout.repository().to_string_lossy();
        Ok(self
            .volume
            .run(
                &repository,
                "fetching the published base",
                Limit::Check,
                fetch,
            )
            .await
            .map_err(WorkError::from)??)
    }

    async fn initialization_due(&self, task: &Task) -> bool {
        // A possible send binds its role durably, even after the run settles.
        // A volume wait carries a detail and says nothing about initialization.
        let id = &task.identity().id;
        (task.first_launch() || task.phase() == Phase::Reviewing)
            && task.run().is_none()
            && task.threads().get(Role::Worker).is_none()
            && task.threads().get(Role::Reviewer).is_none()
            && {
                let state = self.state.lock().await;
                state.wait_reason(id) == Some(WaitReason::WorkspaceUnknown)
                    && state.wait_detail(id).is_none()
            }
    }

    pub(super) async fn workspace_capacity(
        &self,
        identity: &nucleus_core::Identity,
        route: &ProjectRoute,
        slots: u32,
    ) -> Result<bool, ServiceError> {
        let candidates = self
            .state
            .lock()
            .await
            .store
            .project_workspace_candidates(&identity.id, &route.repositories)?;
        let work = self.storage.work().clone();
        let count = move |_| {
            work.verify()?;
            let mut in_flight = 0_u32;
            for (task, repository) in candidates {
                let path = nucleus_work::checkout_path(work.path(), &repository, &task);
                match std::fs::symlink_metadata(path) {
                    Ok(_) => in_flight += 1,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(WorkError::from(error)),
                }
            }
            work.verify()?;
            Ok(in_flight)
        };
        let in_flight = self
            .volume
            .run(&identity.id, "counting task checkouts", Limit::Check, count)
            .await
            .map_err(WorkError::from)??;
        Ok(in_flight < slots.saturating_mul(2))
    }

    pub(super) async fn apply(
        &self,
        row: &TaskRow,
        observation: &Observation,
        action: Action,
    ) -> Result<Action, ServiceError> {
        self.apply_with_limit(row, observation, action, None).await
    }

    async fn apply_with_limit(
        &self,
        row: &TaskRow,
        observation: &Observation,
        action: Action,
        limit: Option<&serde_json::Value>,
    ) -> Result<Action, ServiceError> {
        let kind = match &action {
            Action::Advance(_)
                if matches!(
                    observation.host,
                    Observed::Known(Host::Current {
                        state: RunState::AssignmentRejected,
                        ..
                    })
                ) =>
            {
                "assignment_input_rejected"
            }
            Action::Advance(_) | Action::Relaunch(_) | Action::Ask(_)
                if matches!(
                    observation.host,
                    Observed::Known(Host::ProviderLimited { .. })
                ) && row
                    .task
                    .run()
                    .is_some_and(|run| !run.revoked() && run.report().is_none()) =>
            {
                "provider_limit"
            }
            Action::Advance(_)
                if matches!(
                    observation.host,
                    Observed::Known(Host::Current {
                        state: RunState::ParentEnded,
                        ..
                    })
                ) =>
            {
                "delegated_parent_ended"
            }
            Action::Advance(Phase::Working) if row.task.phase() == Phase::Merging => {
                "merge_returned_to_work"
            }
            Action::Advance(Phase::ReportReady) => "report_ready",
            Action::Advance(Phase::Blocked | Phase::Error) => "report_only_worker_returned",
            Action::Advance(_) => "phase_reconciled",
            Action::Revoke => "run_revoked",
            Action::Relaunch(_) => "run_failed",
            Action::Ask(_) => "question_asked",
            _ => return Ok(action),
        };
        let mut updated = row.task.clone();
        let _ = updated.reconcile(observation);
        let mut audit = event(kind);
        if kind == "provider_limit" {
            audit.detail =
                serde_json::json!({"cause": updated.threads().last_provider_limit, "providerLimit": limit}).to_string();
        }
        if kind == "merge_returned_to_work" {
            audit.detail = serde_json::json!({
                "instruction": updated.work_instruction(),
                "priorVerdict": row.task.verdict(),
            })
            .to_string();
        }
        if matches!(kind, "delegated_parent_ended" | "assignment_input_rejected")
            && let Some(run) = row.task.run()
        {
            audit.detail = serde_json::json!({
                "instance": run.launch().instance,
                "thread": run.launch().thread,
                "outcome": if kind == "delegated_parent_ended" {
                    "parent ended before the delegated child started"
                } else {
                    "assignment failed the host input-size check before execution"
                },
            })
            .to_string();
        }
        if updated.phase() == Phase::ReportReady
            && let Some(report) = updated.report_task()
            && let Some(delivery) = &report.delivery
        {
            audit.detail =
                serde_json::json!({ "artifact": delivery.artifact, "summary": delivery.summary })
                    .to_string();
            if row.task.phase() != Phase::ReportReady
                && report.notice_attempted
                && self
                    .state
                    .lock()
                    .await
                    .store
                    .last_report_artifact(&updated.identity().id)?
                    .is_some_and(|prior| prior != delivery.artifact)
            {
                updated.reopen_report_notice();
            }
        }
        if row.task.phase() != updated.phase() && updated.phase() == Phase::Closing {
            crate::presentation::note_merge(&mut audit, &observation.forge);
        }
        self.save(row, updated, &audit).await?;
        Ok(action)
    }

    async fn reserve(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        mut observation: Observation,
        role: Role,
        via: Launch,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let _fence = self.effect(row).await?;
        if self.dependencies_blocked(row).await? {
            return Ok(Action::Wait(WaitReason::Prerequisite));
        }
        let task = &row.task;
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        let selection = match self.select_launch(task, &observation, role, host).await? {
            LaunchSelection::Fixture => None,
            LaunchSelection::Profile(selected) => Some(selected),
            LaunchSelection::Paused => return Ok(Action::Wait(WaitReason::Capacity)),
        };
        if let Some(wait) = self.gate_allowance(row).await? {
            return Ok(wait);
        }
        let selection = selection.as_deref();
        let via = selection.map_or(via, |selected| selected.intent.via().clone());
        if role == Role::Worker && observation.workspace == Observed::Known(Workspace::Absent) {
            let Some(workspace) = self.allocate_checkout(task, checkout, None).await? else {
                return Ok(Action::Wait(WaitReason::Capacity));
            };
            observation.workspace = Observed::Known(workspace);
        }
        let instance = task.next_launch_instance()?;
        let pr = match &observation.forge {
            Observed::Known(Forge::Open { pr, .. }) => Some(pr),
            _ if role == Role::Reviewer => return Ok(Action::Wait(WaitReason::ForgeUnknown)),
            _ => task.pull_request(),
        };
        let checkout_head = match &observation.workspace {
            Observed::Known(Workspace::Clean(head)) => Some(head),
            _ => None,
        };
        let (ticket_path, scratch) = self.launch_paths(checkout, &instance)?;
        let profile = self.launch_profile(role, selection)?;
        let discovered_skill = if selection.is_some() {
            host.profile_catalog()
                .await?
                .discovered_skill(&profile.instance_id, "nucleus")
        } else {
            None
        };
        let (lanes, dependencies) = self.prompt_context(row, &route).await?;
        let assignment = Prompt {
            row,
            role,
            via: &via,
            replaced_thread: selection.and_then(|selected| selected.intent.replaced_thread()),
            instance: &instance,
            checkout: checkout.path(),
            scratch: &scratch,
            branch: checkout.branch(),
            checkout_head,
            pr,
            discovered_skill,
            model: &profile.model,
            lanes: &lanes,
            dependencies: &dependencies,
            command: &self.report_command,
            ticket: &ticket_path,
        }
        .render();
        if self.assignment_blocked(row, &assignment).await? {
            return Ok(Action::Wait(WaitReason::AssignmentTooLarge));
        }
        let binding = route.binding(checkout)?;
        let continuing_worker = role == Role::Worker && matches!(via, Launch::Continue { .. });
        let parent = match self
            .prepare_run_parent(row, checkout, &binding, host, continuing_worker)
            .await?
        {
            ControlFlow::Continue(parent) => parent,
            ControlFlow::Break(reason) => return Ok(Action::Wait(reason)),
        };
        let mut inputs = host.prepare_launch(LaunchRequest {
            binding,
            parent,
            reuse_parent: continuing_worker && self.acp_provider().is_some(),
            title: crate::titles::child_title(task, row.number, role),
            profile,
            via: &via,
            instance: &instance,
            started_at: now_ms(),
            text: assignment.text,
        })?;
        inputs.scratch = Some(scratch);
        let (updated, credential) =
            freeze_launch(task, &observation, inputs, selection, &profile.instance_id)?;
        let prompt = (lanes, assignment.size);
        self.persist_reservation(row, &updated, credential, selection, (via, prompt))
            .await
    }

    async fn reserve_report_reminder(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        observation: &Observation,
    ) -> Result<Action, ServiceError> {
        let _fence = self.effect(row).await?;
        let task = &row.task;
        if !self.dispatch_mode().await.allows_launch(false) {
            return Ok(Action::Wait(WaitReason::Capacity));
        }
        if self.dependencies_blocked(row).await? {
            return Ok(Action::Wait(WaitReason::Prerequisite));
        }
        let prior = task.run().ok_or(ServiceError::Input)?;
        let instance = task.next_launch_instance()?;
        let (ticket_path, scratch) = self.launch_paths(checkout, &instance)?;
        let assignment = report_reminder(task, prior, &self.report_command, &ticket_path);
        let route = self.project_for(task.identity()).await?;
        let binding = self.checkout_binding(task.identity(), &route, checkout)?;
        let mut inputs =
            T3::prepare_report_reminder(prior, &binding, &instance, now_ms(), &assignment.text)?;
        inputs.scratch = Some(scratch);
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).map_err(|_| ServiceError::Ticket)?;
        let mut updated = task.clone();
        let credential = updated.reserve_report_reminder(observation, inputs, &seed)?;
        let run = updated.run().ok_or(ServiceError::Input)?;
        self.storage.database().verify()?;
        let prompt = (LaneContext::default(), assignment.size);
        self.write_run_files(task, &updated, credential, prompt)
            .await?;
        let mut audit = event("run_reserved");
        audit.detail = serde_json::json!({
            "reportReminderFor": prior.launch().instance,
            "instance": instance,
        })
        .to_string();
        let id = &task.identity().id;
        if let Err(error) = self.save(row, updated.clone(), &audit).await {
            self.clear_ticket(id, run).await;
            return Err(error);
        }
        self.clear_ticket(id, prior).await;
        Ok(Action::RemindReport)
    }

    fn launch_paths(
        &self,
        checkout: &Checkout<'_>,
        instance: &str,
    ) -> Result<(PathBuf, PathBuf), ServiceError> {
        let root = self.storage.scratch();
        let ticket = ticket::path(root, instance);
        let scratch = root.path().join(scratch::relative_path(instance));
        if ticket.starts_with(checkout.path()) || scratch.starts_with(checkout.path()) {
            return Err(ServiceError::Ticket);
        }
        Ok((ticket, scratch))
    }

    async fn assignment_blocked(
        &self,
        row: &TaskRow,
        assignment: &Assignment,
    ) -> Result<bool, ServiceError> {
        let Some(mut cause) = assignment.too_large() else {
            return Ok(false);
        };
        cause["version"] = serde_json::json!(row.version);
        let mut audit = event("assignment_too_large");
        audit.detail = cause.to_string();
        let id = &row.task.identity().id;
        if self
            .state
            .lock()
            .await
            .store
            .claim_task_effect(id, &audit, false)?
            .is_some()
        {
            service_log!(
                "{id}: assignment exceeds the T3 message limit: {}",
                audit.detail
            );
        }
        Ok(true)
    }

    pub(super) async fn reenter_retained_parent(&self, row: &TaskRow) -> Result<(), ServiceError> {
        let task = &row.task;
        if self.acp_provider().is_none()
            || task.hold().is_some()
            || task.operator_decline().is_some()
        {
            return Ok(());
        }
        let identity = task.identity();
        let path = nucleus_work::checkout_path(
            self.storage.work().path(),
            &identity.repository,
            &identity.id,
        );
        let threads: Vec<_> = [Role::Worker, Role::Reviewer]
            .into_iter()
            .filter_map(|role| task.threads().get(role))
            .filter(|thread| task.run().is_none_or(|run| run.launch().thread != *thread))
            .filter(|thread| self.host.retained_reentry_due(thread, &path))
            .collect();
        if threads.is_empty() {
            return Ok(());
        }
        let launch = {
            let state = self.state.lock().await;
            crate::presentation::retained_launch(&state.store, &identity.id, &threads)?
        };
        let Some((thread, instance)) = launch else {
            return Ok(());
        };
        let route = self.project_for(identity).await?;
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, &identity.id)?;
        let binding = self.checkout_binding(identity, &route, &checkout)?;
        if let Some(child) = self
            .host
            .retained_active_child(binding, thread, instance)
            .await?
        {
            self.reenter_active_parent(row, &route, &child).await?;
        }
        Ok(())
    }

    async fn reenter_active_parent(
        &self,
        row: &TaskRow,
        route: &ProjectRoute,
        child: &ActiveChild,
    ) -> Result<(), ServiceError> {
        let task = &row.task;
        let Some(provider) = self.acp_provider().filter(|_| {
            !task.phase().is_terminal()
                && task.hold().is_none()
                && task.operator_decline().is_none()
        }) else {
            return Ok(());
        };
        let _fence = self.effect(row).await?;
        if !self.dispatch_mode().await.allows_launch(false) {
            return Ok(());
        }
        let identity = task.identity();
        let prefix = child.parent_command_prefix();
        let (prior, start_line) = {
            let state = self.state.lock().await;
            (
                state
                    .store
                    .parent_deliveries(&identity.id, row.version, Some(&prefix))?
                    .into_iter()
                    .find(|value| {
                        value.command.strip_prefix(&prefix).is_some_and(|tail| {
                            tail.starts_with(':') || tail.starts_with("-after-")
                        })
                    }),
                crate::presentation::role_start_line(task, &state.store),
            )
        };
        if let Some(record) = &prior {
            match record.result {
                ParentResult::Held => return Err(ServiceError::ParentDeliveryHeld),
                ParentResult::Failed => return Ok(()),
                ParentResult::Pending if self.replay_runtime(record).await.is_none() => {
                    return self
                        .resolve_parent_deliveries(
                            row,
                            child.binding(),
                            std::slice::from_ref(record),
                        )
                        .await;
                }
                _ => crate::acp::parent_due(record)?,
            }
        }
        let Some(write) = self
            .host
            .prepare_parent_reentry(
                child,
                provider,
                &start_line,
                prior
                    .as_ref()
                    .filter(|value| value.result != ParentResult::Refused)
                    .map(|value| value.command.as_str()),
            )
            .await?
        else {
            return Ok(());
        };
        if prior
            .as_ref()
            .is_some_and(|record| Some(record.command.as_str()) != write.command_id())
        {
            self.accept_parent_readback(row, prior.as_ref()).await?;
        }
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, &identity.id)?;
        let _ = self.send_run_parent(row, &checkout, write, prior).await?;
        Ok(())
    }

    async fn prepare_run_parent(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        binding: &Binding,
        host: &impl TaskHost,
        continuing_worker: bool,
    ) -> Result<ControlFlow<WaitReason, Option<ParentRun>>, ServiceError> {
        let Some(provider) = self.acp_provider().filter(|_| !continuing_worker) else {
            return Ok(ControlFlow::Continue(None));
        };
        let task = &row.task;
        let identity = task.identity();
        if !self.launch_capacity(identity, false).await? {
            return Ok(ControlFlow::Break(WaitReason::Capacity));
        }
        let (prior, released_at, start_line) = {
            let state = self.state.lock().await;
            (
                state
                    .store
                    .parent_deliveries(&identity.id, row.version, None)?
                    .into_iter()
                    .find(|value| !value.refresh && !value.command.is_empty()),
                state.wait_reason(&identity.id).filter(|reason| {
                    !matches!(reason, WaitReason::Starting | WaitReason::HostUnknown)
                }),
                crate::presentation::role_start_line(task, &state.store),
            )
        };
        if let Some(record) = &prior {
            match record.result {
                ParentResult::Held => return Err(ServiceError::ParentDeliveryHeld),
                _ => crate::acp::parent_due(record)?,
            }
        }
        let attempt = prior
            .as_ref()
            .filter(|value| value.result != ParentResult::Refused);
        let replay_launch = if let Some(record) = attempt.filter(|value| {
            value.result == ParentResult::Pending && value.command.ends_with("-launch")
        }) {
            self.replay_runtime(record).await.is_some()
        } else {
            false
        };
        let step = self
            .host
            .prepare_parent(
                binding,
                provider,
                &identity.reference,
                &start_line,
                attempt.map(|value| ParentAttempt {
                    command: &value.command,
                    released: released_at.is_some(),
                    replay_launch,
                    recorded_failure: value.result == ParentResult::Failed,
                }),
                host.profile_catalog(),
            )
            .await
            .map_err(|error| self.parent_not_sent(error))?;
        if matches!(
            step,
            ParentStep::Live(_) | ParentStep::Delivered | ParentStep::AfterDelivery(_)
        ) {
            self.accept_parent_readback(row, attempt).await?;
        }
        match step {
            ParentStep::Live(parent) => Ok(ControlFlow::Continue(Some(parent))),
            ParentStep::Delivered => Ok(ControlFlow::Break(WaitReason::Starting)),
            ParentStep::DeliveryUnknown => Err(ServiceError::ParentDeliveryHeld),
            ParentStep::Wait => Ok(ControlFlow::Break(
                released_at.unwrap_or(WaitReason::Starting),
            )),
            ParentStep::Failed => {
                if let Some(record) = prior
                    .as_ref()
                    .filter(|record| record.result != ParentResult::Failed)
                {
                    self.finish_parent_delivery(row, record, ParentResult::Failed, 0)
                        .await?;
                }
                Ok(ControlFlow::Break(WaitReason::HostObservationBlocked))
            }
            ParentStep::Write(write) | ParentStep::AfterDelivery(write) => {
                self.send_run_parent(row, checkout, write, prior).await
            }
        }
    }

    async fn accept_parent_readback(
        &self,
        row: &TaskRow,
        record: Option<&ParentDelivery>,
    ) -> Result<(), ServiceError> {
        if let Some(record) = record.filter(|record| record.result == ParentResult::Pending) {
            self.finish_parent_delivery(row, record, ParentResult::Accepted, 0)
                .await?;
        }
        Ok(())
    }

    async fn send_run_parent(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        write: nucleus_hosts::ParentWrite,
        prior: Option<ParentDelivery>,
    ) -> Result<ControlFlow<WaitReason, Option<ParentRun>>, ServiceError> {
        let Some(_permit) = self
            .dispatch_gate(
                &row.task,
                DispatchTarget::Run {
                    frozen: write.binding(),
                    checkout,
                    launch: false,
                },
            )
            .await?
        else {
            return Ok(ControlFlow::Break(WaitReason::WorkspaceUnknown));
        };
        self.ensure_parent_reader(&row.task.identity().id, checkout.path())
            .await?;
        let reentry = write
            .command_id()
            .is_some_and(nucleus_hosts::is_parent_reentry);
        match self.deliver_parent(row, write, prior, false).await {
            Ok(_) => {}
            Err(ServiceError::Host(HostError::ParentHoldRejected)) => {
                return Ok(ControlFlow::Break(WaitReason::HostObservationBlocked));
            }
            Err(error) => return Err(error),
        }
        if row.task.run().is_none() && !reentry {
            self.recheck_effect(row, WaitReason::HostUnknown).await;
        }
        Ok(ControlFlow::Break(WaitReason::Starting))
    }

    async fn prompt_context(
        &self,
        row: &TaskRow,
        route: &ProjectRoute,
    ) -> Result<(LaneContext, crate::DependencyStatus), ServiceError> {
        let task = &row.task;
        let policy = nucleus_core::profiles::BriefPolicy::parse(&task.brief().text)
            .map_err(nucleus_core::profiles::ProfileLaunchError::Brief)?;
        let state = self.state.lock().await;
        let dependencies =
            crate::DependencyStatus::read(&state, row, &crate::ControllerScope::default())?;
        let mut context = LaneContext::default();
        let Some(project) = &route.project_id else {
            context.missing = policy.lane_documents;
            return Ok((context, dependencies));
        };
        let mut keys = if let Some(report) = task.report_task() {
            vec![report.lane.clone()]
        } else {
            policy.lanes().to_vec()
        };
        if task.report_task().is_none()
            && let Some(source) = state.store.task_source(&task.identity().id)?
            && source.project_id == *project
            && let Some(item) = state.store.item(project, &source.item_id)?
        {
            for key in item.content.lanes {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
        for key in keys {
            if let Some(lane) = state.store.lane_context(project, &key)? {
                context.memberships.push(lane);
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for key in policy.lane_documents {
            if !seen.insert(key.clone()) {
                continue;
            }
            if let Some(lane) = state
                .store
                .lane(project, &key)?
                .filter(|lane| !lane.document.document.is_empty())
            {
                context.pins.push(lane);
            } else {
                context.missing.push(key);
            }
        }
        Ok((context, dependencies))
    }

    async fn persist_reservation(
        &self,
        row: &TaskRow,
        updated: &Task,
        credential: CallbackCredential,
        selection: Option<&SelectedLaunch>,
        (via, prompt): (Launch, (LaneContext, PromptSize)),
    ) -> Result<Action, ServiceError> {
        let run = updated.run().ok_or(ServiceError::Input)?;
        self.storage.database().verify()?;
        let mut audit = event("run_reserved");
        let pins: Vec<_> = prompt
            .0
            .pins
            .iter()
            .map(nucleus_store::planning::Lane::artifact)
            .collect();
        self.write_run_files(&row.task, updated, credential, prompt)
            .await?;
        let mut detail = serde_json::Map::new();
        if !pins.is_empty() {
            detail.insert("laneDocumentPins".into(), serde_json::json!(pins));
        }
        if let Some(selected) = selection
            && let Some(ceiling) = selected.intent.step_up_from()
        {
            detail.insert(
                "profileStepUp".into(),
                serde_json::json!({
                    "ordinaryCeiling": ceiling,
                    "selectedCapability": selected.intent.profile().capability,
                    "reason": "Every eligible profile within the ordinary ceiling is paused."
                }),
            );
        }
        if let Some(selected) = selection
            && let Some(worker) = selected.intent.critical_fallback_worker()
        {
            let receipt = CriticalReviewFallback {
                at_ms: run.launch().started_at,
                run_instance: run.launch().instance.clone(),
                worker_profile_id: worker.into(),
                reviewer_profile_id: selected.intent.profile().id.clone(),
                reason: "No available independent reviewer with a known capability at least as high as the worker. Ordinary reviewer selection used.".into(),
            };
            detail.insert("criticalReviewFallback".into(), serde_json::json!(receipt));
        }
        if !detail.is_empty() {
            audit.detail = serde_json::Value::Object(detail).to_string();
        }
        let saved = {
            let mut state = self.state.lock().await;
            if state.store.dependency_blocked(&row.task.identity().id)? {
                Ok(Action::Wait(WaitReason::Prerequisite))
            } else if selection.map_or(state.settings.profiles.is_none(), |selected| {
                selected.is_current(&state)
            }) {
                self.commit(
                    &mut state,
                    row,
                    updated,
                    &audit,
                    selection.map(|selected| selected.group.as_str()),
                )
                .map(|_| Action::Launch {
                    role: run.launch().role,
                    via,
                })
            } else {
                Ok(Action::Wait(WaitReason::Capacity))
            }
        };
        if !matches!(saved, Ok(Action::Launch { .. })) {
            self.clear_ticket(&row.task.identity().id, run).await;
        }
        saved
    }

    /// Write the reserved run's prompt artifacts and report ticket.
    async fn write_run_files(
        &self,
        prior: &Task,
        reserved: &Task,
        credential: CallbackCredential,
        (lanes, size): (LaneContext, PromptSize),
    ) -> Result<(), ServiceError> {
        let (prior, reserved) = (prior.clone(), reserved.clone());
        let endpoint = format!("http://{}", self.callback);
        let id = prior.identity().id.clone();
        self.scratch_job(&id, "writing run scratch", move |root, custody| {
            let run = reserved.run().ok_or(ServiceError::Input)?;
            root.verify().map_err(WorkError::from)?;
            {
                let _step = custody.mutate().map_err(WorkError::from)?;
                write_prompt_artifacts(root, run, &prior, &lanes, &size)?;
            }
            let _step = custody.mutate().map_err(WorkError::from)?;
            ticket::prepare(root, &reserved, run, &credential, &endpoint)
        })
        .await
    }

    async fn send_prepared(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        mut observation: Observation,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        if task
            .run()
            .is_some_and(|run| run.last_send_at_ms().is_none())
            && self.dependencies_blocked(row).await?
        {
            return Ok(Action::Wait(WaitReason::Prerequisite));
        }
        if let Some(run) = task.run()
            && nucleus_hosts::unpinned_worker_continuation(run)
        {
            let mut updated = task.clone();
            if updated.discard_paused_reservation(&observation) {
                let _fence = self.effect(row).await?;
                let mut audit = event("host_send_not_sent");
                audit.detail = serde_json::json!({
                    "command": run.launch().instance, "reason": "continuation provider was not pinned",
                }).to_string();
                self.save(row, updated, &audit).await?;
                self.clear_ticket(&task.identity().id, run).await;
                return Ok(Action::Nothing);
            }
        }
        let role = task.run().ok_or(ServiceError::Input)?.launch().role;
        if role == Role::Reviewer {
            observation.forge = Observed::Known(self.read_forge(task, checkout).await?.0);
            observation.workspace = seen(self.observe_checkout(checkout).await);
        }
        let action = decide(task, &observation);
        if !matches!(
            action,
            Action::Launch {
                via: Launch::SendPrepared,
                ..
            }
        ) {
            return self.apply(row, &observation, action).await;
        }
        if let Some(wait) = self.pause_prepared(row, &observation).await? {
            return Ok(wait);
        }
        if !self
            .dispatch_mode()
            .await
            .allows_launch(task.first_launch())
            || !self.launch_capacity(task.identity(), false).await?
        {
            return Ok(Action::Wait(WaitReason::Capacity));
        }
        let (sent, result, _) = match self.send(row, checkout, host).await? {
            SendAttempt::Sent(sent) => *sent,
            SendAttempt::Allowance => return Ok(Action::Wait(WaitReason::Question)),
            SendAttempt::Prerequisite => return Ok(Action::Wait(WaitReason::Prerequisite)),
            SendAttempt::Deferred => {
                return Ok(self
                    .pause_prepared(row, &observation)
                    .await?
                    .unwrap_or(Action::Wait(WaitReason::HostUnknown)));
            }
        };
        if result == SendOutcome::Rejected {
            observation.host = Observed::Known(current(&sent.task, RunState::Rejected)?);
            let next = decide(&sent.task, &observation);
            return self.apply(&sent, &observation, next).await;
        }
        Ok(action)
    }

    #[expect(
        clippy::too_many_lines,
        reason = "keep admission, intent and send in order"
    )]
    async fn send(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        host: &impl TaskHost,
    ) -> Result<SendAttempt, ServiceError> {
        let _step = Step::enter("sending to T3");
        let task = &row.task;
        let run = task.run().ok_or(ServiceError::Input)?;
        let _fence = self.effect(row).await?;
        let authorization = host.authorize_send(run).await.inspect_err(|error| {
            service_log!(
                "{}: before sending T3 {}: {error}",
                run.launch().instance,
                launch_diagnostic(run)
            );
        })?;
        if task
            .run()
            .is_some_and(|run| run.last_send_at_ms().is_none())
            && self.dependencies_blocked(row).await?
        {
            return Ok(SendAttempt::Prerequisite);
        }
        let target = DispatchTarget::Run {
            frozen: authorization.binding(),
            checkout,
            launch: true,
        };
        let Some(permit) = self.dispatch_gate(task, target).await? else {
            return Ok(SendAttempt::Deferred);
        };
        if !task.run().is_some_and(nucleus_core::Run::revoked)
            && self.gate_allowance(row).await?.is_some()
        {
            return Ok(SendAttempt::Allowance);
        }
        if let Some(unarchive) = authorization.unarchive() {
            host.write_control(unarchive).await?;
            self.recheck_effect(row, WaitReason::HostUnknown).await;
            return Ok(SendAttempt::Deferred);
        }
        let parent = authorization.parent_row().zip(self.acp_provider());
        if let Some((parent, _)) = parent {
            self.check_parent_snooze(row, authorization.binding(), parent)
                .await?;
        }
        let queued_parent = authorization.queued_parent().map(str::to_owned);
        let owned_parent_snoozes = if let Some(thread) = queued_parent.as_deref() {
            self.owned_delivery_snoozes(row, thread).await?
        } else {
            Vec::new()
        };
        let archive = permit.superseded;
        self.storage.database().verify()?;
        let (mut sent, dispatch) = {
            let mut state = self.state.lock().await;
            let run = task.run().ok_or(ServiceError::Input)?;
            if run.last_send_at_ms().is_none()
                && state.store.dependency_blocked(&task.identity().id)?
            {
                return Ok(SendAttempt::Prerequisite);
            }
            if !run.revoked() && state.prepared_pause(run)?.is_some() {
                return Ok(SendAttempt::Deferred);
            }
            let mut task = task.clone();
            let mut dispatch = authorization.record(&mut task)?;
            dispatch.allow_owned_parent_snoozes(owned_parent_snoozes);
            let version = self.commit(&mut state, row, &task, &event("host_send"), None)?;
            (
                TaskRow {
                    task,
                    version,
                    number: row.number,
                },
                dispatch,
            )
        };
        if let Some((_, provider)) = parent
            && run.last_send_at_ms().is_none()
            && let Err(error) = self.reflect_role_admission(&sent, checkout, provider).await
        {
            service_log!("{}: {error}", task.identity().id);
        }
        let result = match host.send(dispatch).await {
            Err(
                error @ (HostError::Deferred { .. }
                | HostError::RetainedBindingChanged
                | HostError::OperatorSnoozed { .. }
                | HostError::RetainedParentSnoozed { .. }),
            ) => {
                let mut audit = event("host_send_not_sent");
                audit.detail = serde_json::json!({"command":run.launch().instance}).to_string();
                let restored = self.save(&sent, row.task.clone(), &audit).await?;
                let (thread, until) = match error {
                    HostError::OperatorSnoozed { until } => (run.launch().thread.clone(), until),
                    HostError::RetainedParentSnoozed { until } => {
                        (queued_parent.ok_or(ServiceError::Input)?, until)
                    }
                    error => return Err(error.into()),
                };
                self.schedule_result(
                    &restored,
                    &Err(ServiceError::OperatorSnoozed { thread, until }),
                    crate::schedule::Priority::Effect,
                )
                .await?;
                return Ok(SendAttempt::Deferred);
            }
            result => result?,
        };
        if archive && result == SendOutcome::Rejected {
            let mut updated = sent.task.clone();
            let instance = &sent
                .task
                .run()
                .ok_or(ServiceError::Input)?
                .launch()
                .instance;
            updated.record_rejected_stop(instance)?;
            sent = self
                .save(&sent, updated, &event("review_rejected_awaiting_archive"))
                .await?;
        }
        Ok(SendAttempt::Sent(Box::new((sent, result, archive))))
    }

    async fn planner_notice_root(
        &self,
        route: &ProjectRoute,
        target: &NoticeTarget,
    ) -> Option<PathBuf> {
        if self.project.is_some() {
            return (target.project_id == route.host_project).then(|| route.checkout.clone());
        }
        let state = self.state.lock().await;
        state
            .live_planner_route(&target.thread)
            .filter(|(id, repo)| {
                Some(*id) == route.project_id.as_deref()
                    && repo.host_project.as_deref() == Some(target.project_id.as_str())
                    && self
                        .host
                        .cached_project(&target.project_id)
                        .is_ok_and(|project| std::path::Path::new(&project.root) == repo.path)
            })
            .map(|(_, repo)| repo.path.clone())
    }

    pub(super) async fn dispatch_gate(
        &self,
        task: &Task,
        target: DispatchTarget<'_>,
    ) -> Result<Option<DispatchPermit<'_>>, ServiceError> {
        let projects = self.project_writes.read().await;
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        match &target {
            DispatchTarget::Run {
                frozen, checkout, ..
            }
            | DispatchTarget::Presentation { frozen, checkout }
                if **frozen != self.checkout_binding(identity, &route, checkout)? =>
            {
                return Err(HostError::Binding.into());
            }
            _ => {}
        }
        if route.slots.is_none()
            && match &target {
                DispatchTarget::Planner(_) => true,
                DispatchTarget::Run { launch, .. } => task
                    .run()
                    .is_none_or(|run| *launch && run.last_send_at_ms().is_none()),
                DispatchTarget::Presentation { .. } => false,
            }
        {
            return Ok(None);
        }
        if !matches!(target, DispatchTarget::Presentation { .. }) {
            self.check_project_route(identity, &route).await?;
        }
        let result = match target {
            DispatchTarget::Presentation { checkout, .. } => {
                // Exact native destination and project came from the synchronized
                // shell. Keep the usual local identity and ownership fence.
                self.verify_route(identity, &route).await?;
                let present = self.observe_checkout(checkout).await? != Workspace::Absent;
                (present || task.phase().is_terminal()).then_some(false)
            }
            DispatchTarget::Run {
                checkout, launch, ..
            } => {
                if launch {
                    let run = task.run().ok_or(ServiceError::Input)?;
                    if let Some(head) = run.launch().review_head.as_ref() {
                        let forge = Observed::Known(self.read_forge(task, checkout).await?.0);
                        let workspace = self.observe_checkout(checkout).await?;
                        if workspace == Workspace::Absent {
                            return Ok(None);
                        }
                        let fresh = Observation {
                            forge,
                            workspace: Observed::Known(workspace),
                            host: Observed::Unknown,
                        };
                        replay_policy(Some(head), &fresh)
                            .filter(|&superseded| !superseded || run.revoked())
                    } else {
                        (self.observe_checkout(checkout).await? != Workspace::Absent)
                            .then_some(false)
                    }
                } else {
                    (self.observe_checkout(checkout).await? != Workspace::Absent).then_some(false)
                }
            }
            DispatchTarget::Planner(authorization) => {
                let target = authorization.target();
                let root = self
                    .planner_notice_root(&route, target)
                    .await
                    .ok_or(HostError::Binding)?;
                if target.project_id != route.host_project {
                    self.host
                        .check_project(
                            &target.project_id,
                            root.to_str().ok_or(ServiceError::Project)?,
                        )
                        .await?;
                }
                self.host.check_notice_target(authorization)?;
                if let Some(path) = &target.worktree_path
                    && !self
                        .verify_linked_checkout(&identity.id, root, PathBuf::from(path))
                        .await?
                {
                    return Err(HostError::Binding.into());
                }
                Some(false)
            }
        };
        self.require_unchanged(task).await?;
        Ok(result.map(|superseded| DispatchPermit {
            _projects: projects,
            superseded,
        }))
    }

    // A report is accepted while an effect waits on the work volume. Such an
    // effect may not send for the row it saw before that wait.
    async fn require_unchanged(&self, task: &Task) -> Result<(), ServiceError> {
        let state = self.state.lock().await;
        let current = state.store.row(&task.identity().id)?;
        if current.is_some_and(|row| row.task != *task) {
            return Err(StoreError::StaleTask.into());
        }
        Ok(())
    }

    pub(super) fn checkout_binding(
        &self,
        identity: &nucleus_core::Identity,
        route: &ProjectRoute,
        checkout: &Checkout<'_>,
    ) -> Result<Binding, ServiceError> {
        let expected = nucleus_work::checkout_path(
            self.storage.work().path(),
            &identity.repository,
            &identity.id,
        );
        if checkout.path() != expected {
            return Err(HostError::Binding.into());
        }
        route.binding(checkout)
    }

    async fn stop_run(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        mut observation: Observation,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let stopped;
        let row = if row.task.run().is_some_and(|run| !run.revoked()) {
            let mut task = row.task.clone();
            task.revoke_run();
            stopped = self.save(row, task, &event("run_stopped")).await?;
            &stopped
        } else {
            row
        };
        let task = &row.task;
        let run = task.run().ok_or(ServiceError::Input)?;
        let head = run.launch().review_head.as_ref();
        let archive = superseded(head, &observation.forge);
        let stopping = Action::Wait(WaitReason::Stopping);
        let route = self.project_for(task.identity()).await?;
        let binding = route.binding(checkout)?;
        let progress = host.stop(run, &binding, now_ms(), archive).await?;
        match progress {
            StopProgress::Waiting => Ok(stopping),
            StopProgress::Write(dispatch) => self.write_stop(row, checkout, host, dispatch).await,
            StopProgress::Settled(host) => {
                if head.is_some()
                    && run.last_send_at_ms().is_some()
                    && !run.rejected_awaiting_archive()
                    && observation.forge == Observed::Unknown
                {
                    return Ok(stopping);
                }
                observation.host = Observed::Known(host);
                let action = decide(task, &observation);
                self.apply(row, &observation, action).await
            }
            StopProgress::ReplayDue => {
                if head.is_some() {
                    observation.forge = Observed::Known(self.read_forge(task, checkout).await?.0);
                    observation.workspace = seen(self.observe_checkout(checkout).await);
                }
                if replay_policy(head, &observation).is_none() {
                    return Ok(stopping);
                }
                if !self.launch_capacity(task.identity(), true).await? {
                    return Ok(Action::Wait(WaitReason::Capacity));
                }
                let SendAttempt::Sent(sent) = self.send(row, checkout, host).await? else {
                    return Ok(stopping);
                };
                let (sent, outcome, archive) = *sent;
                let run = sent.task.run().ok_or(ServiceError::Input)?;
                let observed = if outcome == SendOutcome::Rejected && !archive {
                    StopProgress::Settled(current(&sent.task, RunState::Rejected)?)
                } else {
                    host.stop(run, &binding, now_ms(), archive).await?
                };
                match observed {
                    StopProgress::Write(dispatch) => {
                        self.write_stop(&sent, checkout, host, dispatch).await
                    }
                    StopProgress::Settled(host) => {
                        observation.host = Observed::Known(host);
                        let action = decide(&sent.task, &observation);
                        self.apply(&sent, &observation, action).await
                    }
                    _ => Ok(stopping),
                }
            }
        }
    }

    async fn write_stop(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        host: &impl TaskHost,
        dispatch: ControlDispatch,
    ) -> Result<Action, ServiceError> {
        let _fence = self.effect(row).await?;
        let target = DispatchTarget::Run {
            frozen: dispatch.binding(),
            checkout,
            launch: false,
        };
        if let Some(_permit) = self.dispatch_gate(&row.task, target).await? {
            host.write_control(dispatch).await?;
        }
        Ok(Action::Wait(WaitReason::Stopping))
    }

    async fn merge(
        &self,
        row: &TaskRow,
        target: &PullTarget,
        mut observation: Observation,
        head: &Head,
    ) -> Result<Action, ServiceError> {
        let _fence = self.effect(row).await?;
        let _projects = self.project_writes.read().await;
        let task = &row.task;
        let route = self.project_for(task.identity()).await?;
        if route.slots.is_none() {
            return Ok(Action::Wait(WaitReason::Capacity));
        }
        if self.dependencies_blocked(row).await? {
            return Ok(Action::Wait(WaitReason::Prerequisite));
        }
        self.require_published_approval(row, target).await?;
        let attempt = self
            .forge
            .merge(task, target)
            .await
            .inspect_err(|error| record_forge_failure(self, error))?;
        if let MergeWrite::Deferred { until } = attempt.write {
            defer(self, until);
            return Err(ForgeError::Deferred { until }.into());
        }
        let observed = capture_forge(self, attempt.observed);
        if attempt.write == MergeWrite::HeadMismatch {
            // Persist the refused approval first. The next pass verifies a merged
            // readback against the base and source without that approval.
            observation.forge = match observed {
                Ok(Forge::Merged { .. }) => Observed::Unknown,
                other => seen(other),
            };
            if matches!(
                &observation.forge,
                Observed::Known(Forge::Open {
                    checks: CheckState::Conflict | CheckState::BaseMoved,
                    ..
                })
            ) && decide(task, &observation) == Action::Advance(Phase::Working)
            {
                // Returning to work retires the same approval as the mismatch path.
                return self
                    .apply(row, &observation, Action::Advance(Phase::Working))
                    .await;
            }
            let mut updated = task.clone();
            if updated.merge_head_mismatched(head) {
                let next = updated.reconcile(&observation);
                let mut history = event("merge_head_changed");
                history.detail = serde_json::json!({
                    "refusedHead": head, "priorVerdict": task.verdict()
                })
                .to_string();
                self.save(row, updated, &history).await?;
                return Ok(next);
            }
            return Ok(Action::Wait(WaitReason::ForgeUnknown));
        }
        let observed = observed?;
        self.verify_external_merge(task, target, &observed).await?;
        let observed = Observed::Known(observed);
        if attempt.write == MergeWrite::Unknown
            && !matches!(observed, Observed::Known(Forge::Merged { .. }))
        {
            return Ok(Action::Wait(WaitReason::ForgeUnknown));
        }
        observation.forge = observed;
        if let MergeWrite::Refused { .. } = attempt.write
            && let Observed::Known(Forge::Open {
                checks: checks @ CheckState::Ready,
                ..
            }) = &mut observation.forge
        {
            *checks = CheckState::Blocked;
        }
        let next = decide(task, &observation);
        if matches!(next, Action::Merge { .. }) {
            return Ok(Action::Wait(WaitReason::ForgeUnknown));
        }
        self.apply(row, &observation, next).await
    }

    async fn retirement_roots(
        &self,
        task: &Task,
        checkout: &Checkout<'_>,
    ) -> Result<Vec<PathBuf>, ServiceError> {
        let (task, checkout) = (task.clone(), checkout.path().to_owned());
        let id = task.identity().id.clone();
        self.scratch_job(&id, "finding run scratch", move |root, _| {
            let earlier = task
                .earlier_run_scratch()
                .filter_map(|(instance, recorded)| {
                    retained_scratch_path(root.path(), &task.identity().id, &instance, recorded)
                });
            let roots = std::iter::once(checkout)
                .chain(find_run_scratch(root.path(), &task))
                .chain(earlier)
                .collect();
            root.verify().map_err(WorkError::from)?;
            Ok(roots)
        })
        .await
    }

    // Both callers hold the task and project fences and have inspected this owned checkout.
    async fn stop_checkout_orphans(
        &self,
        host: &impl TaskHost,
        task: &Task,
        checkout: &Checkout<'_>,
    ) -> Result<(), ServiceError> {
        let scratch = self.storage.scratch().path();
        let roots = self.retirement_roots(task, checkout).await?;
        let mut retained = Vec::new();
        let mut found = None;
        for root in roots {
            let scan = host.terminal_orphans(&root, scratch).await?;
            retained.extend(scan.retained);
            if found.is_none() && !scan.targets.is_empty() {
                found = Some((root, scan.targets));
            }
        }
        // A shared service keeps its cwd in the checkout and holds retirement by PID.
        // Identical evidence on a later pass does not add a second record.
        if !retained.is_empty() {
            let mut state = self.state.lock().await;
            let mut record = event("checkout_process_retained");
            record.detail = serde_json::json!({"processes":retained}).to_string();
            state
                .store
                .claim_task_effect(&task.identity().id, &record, false)?;
        }
        let Some((root, mut targets)) = found else {
            return Ok(());
        };
        let parent = nucleus_hosts::parent_thread(checkout.path());
        let roles: Vec<_> = [
            Some(parent.as_str()),
            task.threads().get(Role::Worker),
            task.threads().get(Role::Reviewer),
        ]
        .into_iter()
        .flatten()
        .collect();
        for force in [false, true] {
            if force {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            let mut state = self.state.lock().await;
            if !state
                .settings
                .dispatch
                .as_ref()
                .is_some_and(|d| d.mode == DispatchMode::Running)
            {
                return Err(ServiceError::ArchiveEvidence(
                    "Process cleanup is waiting for Dispatch.".into(),
                ));
            }
            let id = &task.identity().id;
            let mut intent = event("checkout_process_stop");
            intent.detail =
                serde_json::json!({"signal":if force {"KILL"} else {"TERM"},"processes":targets})
                    .to_string();
            state.store.claim_task_effect(id, &intent, false)?;
            drop(state);
            targets = nucleus_hosts::verify_orphans(&targets, &root, scratch, force).await?;
            if targets.is_empty() {
                break;
            }
            // Contended state defers the effect rather than aging the PID verification.
            let mut state = self.state.try_lock().map_err(|_| {
                ServiceError::ArchiveEvidence("Checking checkout processes again.".into())
            })?;
            if !state
                .settings
                .dispatch
                .as_ref()
                .is_some_and(|d| d.mode == DispatchMode::Running)
            {
                return Err(ServiceError::ArchiveEvidence(
                    "Process cleanup is waiting for Dispatch.".into(),
                ));
            }
            let mut results = Vec::new();
            self.host.retire_with_quiet_shell(&parent, &roles, || {
                targets.retain(|p| {
                    let result = p.signal(force);
                    let outcome = match &result {
                        Ok(true) => "sent".to_owned(),
                        Ok(false) => "exited".to_owned(),
                        Err(cause) => cause.to_string(),
                    };
                    results.push(serde_json::json!({"process":p,"outcome":outcome}));
                    matches!(result, Ok(true))
                });
            })?;
            let mut outcome = event("checkout_process_result");
            outcome.detail = serde_json::json!({"signal":if force {"SIGKILL"} else {"SIGTERM"},"results":results}).to_string();
            state.store.claim_task_effect(id, &outcome, false)?;
        }
        // The pass's census still contains the original PIDs. A fresh pass confirms exit.
        Err(ServiceError::ArchiveEvidence(
            "Checking that checkout processes have exited.".into(),
        ))
    }

    // Both callers hold the current task and project fences through Git retirement.
    async fn retire_if_idle(
        &self,
        host: &impl TaskHost,
        task: &Task,
        binding: &Binding,
        checkout: &Checkout<'_>,
        head: Option<&Head>,
    ) -> Result<Option<Retirement>, ServiceError> {
        let parent = nucleus_hosts::parent_thread(Path::new(&binding.worktree_path));
        let threads = [
            task.threads().get(Role::Reviewer),
            task.threads().get(Role::Worker),
            Some(parent.as_str()),
        ];
        let threads: Vec<_> = threads.into_iter().flatten().collect();
        // Each lookup uses the pass's shared process census.
        for root in self.retirement_roots(task, checkout).await? {
            if let Some(blocker) = host.retirement_writer(&root).await? {
                return Err(ServiceError::CheckoutProcess(blocker));
            }
        }
        let observed = match head {
            Some(head) => Some((
                self.observe_checkout_for_retirement(checkout).await?,
                head.clone(),
            )),
            None => None,
        };
        let state = self.state.lock().await;
        if state
            .settings
            .dispatch
            .as_ref()
            .is_some_and(|dispatch| dispatch.mode != DispatchMode::Running)
        {
            return Ok(None);
        }
        self.host
            .retire_with_quiet_shell(&parent, &threads, || ())?;
        drop(state);
        // Recheck Git custody and remove after final writer admission.
        let outcome = self
            .checkout_job(
                checkout,
                "removing the task checkout",
                Limit::Change,
                move |checkout| match observed {
                    Some((initial, head)) => checkout.finish_retirement(initial, &head),
                    None => checkout.retire_prunable_registration(),
                },
            )
            .await?;
        if outcome == Retirement::Removed {
            self.trash_wake.notify_one();
        }
        Ok(Some(outcome))
    }

    async fn close(
        &self,
        host: &impl TaskHost,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        binding: &Binding,
        target: &PullTarget,
        workspace: CloseWorkspace,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        let forge = capture_forge(self, self.forge.observe(target).await)?;
        self.verify_external_merge(task, target, &forge).await?;
        let mut observed = Observation {
            host: Observed::Unknown,
            forge: Observed::Known(forge),
            workspace: seen(self.observe_checkout_for_retirement(checkout).await),
        };
        let action = decide(task, &observed);
        if let Action::Close {
            workspace: CloseWorkspace::RemoveClean { head },
            ..
        } = &action
        {
            let _fence = self.effect(row).await?;
            let _projects = self.project_writes.read().await;
            let route = self.project_for(task.identity()).await?;
            if self.checkout_binding(task.identity(), &route, checkout)? != *binding {
                return Err(HostError::Binding.into());
            }
            self.stop_checkout_orphans(host, task, checkout).await?;
            if self
                .retire_if_idle(host, task, binding, checkout, Some(head))
                .await?
                .is_none()
            {
                return Ok(Action::Wait(WaitReason::Stopping));
            }
            observed.workspace = seen(self.observe_checkout_for_retirement(checkout).await);
        } else if matches!(
            action,
            Action::Close {
                workspace: CloseWorkspace::AlreadyAbsent,
                ..
            }
        ) && self.has_prunable_registration(checkout).await?
        {
            let _fence = self.effect(row).await?;
            let _projects = self.project_writes.read().await;
            let route = self.project_for(task.identity()).await?;
            if self.checkout_binding(task.identity(), &route, checkout)? != *binding {
                return Err(HostError::Binding.into());
            }
            if self
                .retire_if_idle(host, task, binding, checkout, None)
                .await?
                .is_none()
            {
                return Ok(Action::Wait(WaitReason::Stopping));
            }
        }
        let mut updated = task.clone();
        if !updated.finish_close(&observed) {
            return Ok(decide(task, &observed));
        }
        let record = match (&observed.workspace, workspace) {
            (Observed::Known(Workspace::Absent), CloseWorkspace::RemoveClean { .. }) => {
                "closed_checkout_removed"
            }
            (Observed::Known(Workspace::Absent), _) => "closed_checkout_absent",
            _ => "closed_checkout_retained",
        };
        let mut audit = event(record);
        crate::presentation::note_merge(&mut audit, &observed.forge);
        let fallbacks = self
            .state
            .lock()
            .await
            .store
            .critical_review_fallbacks(&task.identity().id)?;
        if !fallbacks.is_empty() {
            let mut detail: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&audit.detail).map_err(nucleus_store::StoreError::from)?;
            detail.insert(
                "criticalReviewFallbacks".into(),
                serde_json::json!(fallbacks),
            );
            audit.detail = serde_json::Value::Object(detail).to_string();
        }
        self.save(row, updated, &audit).await?;
        Ok(action)
    }
}

fn freeze_launch(
    task: &Task,
    observation: &Observation,
    inputs: LaunchInputs,
    selection: Option<&SelectedLaunch>,
    fallback_group: &str,
) -> Result<(Task, CallbackCredential), ServiceError> {
    let mut seed = [0; 32];
    getrandom::fill(&mut seed).map_err(|_| ServiceError::Ticket)?;
    let mut updated = task.clone();
    let group = selection.map_or(fallback_group, |selected| &selected.group);
    let credential = updated.reserve_grouped_launch(
        observation,
        inputs,
        &seed,
        selection.map(|selected| selected.intent.clone()),
        group.into(),
    )?;
    Ok((updated, credential))
}

fn waiting_on_run(
    task: &Task,
    state: &Observed<Host>,
    error: Option<HostError>,
) -> Option<Result<Action, HostError>> {
    match decide(
        task,
        &Observation {
            host: state.clone(),
            forge: Observed::Unknown,
            workspace: Observed::Unknown,
        },
    ) {
        Action::Wait(WaitReason::HostUnknown) => error.map(Err),
        action @ Action::Wait(
            WaitReason::Running
            | WaitReason::Starting
            | WaitReason::IdleWithoutTerminalRun
            | WaitReason::Permission
            | WaitReason::Input
            | WaitReason::Hold,
        ) => Some(Ok(action)),
        _ => None,
    }
}

async fn read_retained(
    host: &impl TaskHost,
    task: &Task,
    binding: &Binding,
) -> Result<Observed<Host>, HostError> {
    let role = match task.phase() {
        Phase::Working => Role::Worker,
        Phase::Reviewing => Role::Reviewer,
        _ => return Ok(Observed::Unknown),
    };
    match task.threads().get(role) {
        Some(thread) => host
            .observe_retained_role(binding, thread)
            .await
            .map(Observed::Known),
        None => Ok(Observed::Unknown),
    }
}

fn current(task: &Task, state: RunState) -> Result<Host, ServiceError> {
    let run = task.run().ok_or(ServiceError::Input)?;
    Ok(Host::Current {
        instance: run.launch().instance.clone(),
        state,
    })
}

fn capture_forge<T>(service: &Service, result: Result<T, ForgeError>) -> Result<T, ForgeError> {
    match &result {
        Ok(_) => {
            service.forge_retry_secs.store(0, Ordering::Relaxed);
            service.forge_until.store(0, Ordering::Relaxed);
        }
        Err(error) => record_forge_failure(service, error),
    }
    result
}

pub(super) fn record_forge_failure(service: &Service, error: &ForgeError) {
    if let ForgeError::Deferred { until } = error {
        defer(service, *until);
    } else if matches!(error, ForgeError::Http(_))
        || matches!(error, ForgeError::Status(status)
            if status.is_server_error() || *status == axum::http::StatusCode::REQUEST_TIMEOUT)
    {
        let seconds = service
            .forge_retry_secs
            .load(Ordering::Relaxed)
            .saturating_mul(2)
            .clamp(
                crate::schedule::FORGE_RETRY.as_secs(),
                MAX_FORGE_RETRY.as_secs(),
            );
        service.forge_retry_secs.store(seconds, Ordering::Relaxed);
        defer(service, SystemTime::now() + Duration::from_secs(seconds));
    }
}

fn defer(service: &Service, until: SystemTime) {
    let millis = until
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    service
        .forge_until
        .fetch_max(u64::try_from(millis).unwrap_or(u64::MAX), Ordering::Relaxed);
}

fn seen<T, E>(value: Result<T, E>) -> Observed<T> {
    seen_from(value.ok())
}

fn seen_from<T>(value: Option<T>) -> Observed<T> {
    value.map_or(Observed::Unknown, Observed::Known)
}

fn recorded_source(task: &Task) -> Option<&nucleus_core::PullRequest> {
    if task.identity().entry != nucleus_core::Entry::ReviewEntry
        && let Some(run) = task.run()
        && !run.revoked()
        && let Some(Report::Work(report)) = run.report()
    {
        return Some(&report.pull_request);
    }
    task.pull_request()
}

fn superseded(head: Option<&Head>, forge: &Observed<Forge>) -> bool {
    let Observed::Known(Forge::Open { pr, .. } | Forge::Closed(pr) | Forge::Merged { pr, .. }) =
        forge
    else {
        return false;
    };
    head.is_some_and(|head| &pr.head != head)
}

/// Check whether a revoked request can replay and whether its thread should
/// be archived after it settles.
fn replay_policy(head: Option<&Head>, observation: &Observation) -> Option<bool> {
    let Some(head) = head else { return Some(false) };
    if superseded(Some(head), &observation.forge) {
        return Some(true);
    }
    let open_at_head =
        matches!(&observation.forge, Observed::Known(Forge::Open { pr, .. }) if &pr.head == head);
    let clean_at_head =
        matches!(&observation.workspace, Observed::Known(Workspace::Clean(clean)) if clean == head);
    (open_at_head && clean_at_head).then_some(false)
}

#[cfg(test)]
mod start_tests;

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use axum::{
        Json, Router,
        http::{StatusCode, header::RETRY_AFTER},
        response::IntoResponse,
        routing::{get, post, put},
    };
    use nucleus_core::{Authority, Command, Entry, PullRequest, Review};
    use nucleus_forge::GitHub;
    use nucleus_hosts::{Dispatch, RunRequest};
    use serde_json::json;

    use super::*;
    use crate::tests::{
        Due, REPOSITORY, code_task_at_merge, fixture, forge_checks, forge_fixture, forge_pull,
        native_fixture, reservation, serve_forge,
    };

    async fn cancelled_cleanup_task(service: &Service) -> TaskRow {
        let task = Task::new(
            nucleus_core::Identity {
                id: "orphan-test".into(),
                reference: "orphan-test".into(),
                repository: REPOSITORY.into(),
                base: "main".into(),
                entry: Entry::Brief,
                origin_thread: None,
            },
            "Synthetic cleanup".into(),
            None,
        );
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .unwrap();
        let id = &task.identity().id;
        service
            .command(
                id,
                &Authority::Operator {
                    actor: "fixture".into(),
                },
                Command::Cancel,
            )
            .await
            .unwrap();
        service.task(id).await.unwrap()
    }

    fn settle_both_reviewers(
        task: &mut Task,
        observation: &mut Observation,
        head: &Head,
        credential: &[u8; 32],
        scratch: &Path,
    ) {
        // A task upgraded during this reviewer carries the old worker path in settled_scratch.
        let mut saved = serde_json::to_value(&*task).unwrap();
        saved["threads"]
            .as_object_mut()
            .unwrap()
            .remove("earlier_scratch");
        saved["threads"]["settled_scratch"] = serde_json::json!(scratch);
        let mut upgraded: Task = serde_json::from_value(saved).unwrap();
        let instance = task.run().unwrap().launch().instance.clone();
        observation.host = Observed::Known(Host::Current {
            instance: instance.clone(),
            state: RunState::Ended,
        });
        for row in [&mut *task, &mut upgraded] {
            row.record_report(
                &instance,
                credential,
                Report::Review {
                    head: head.clone(),
                    decision: nucleus_core::Review::Approve,
                    summary: "Reviewed".into(),
                    finding_titles: vec![],
                },
            )
            .unwrap();
            assert_eq!(row.reconcile(observation), Action::Advance(Phase::Merging));
        }
        assert_eq!(
            upgraded.earlier_run_scratch().collect::<Vec<_>>(),
            task.earlier_run_scratch().collect::<Vec<_>>()
        );
    }

    async fn settled_cleanup_task(
        service: &Service,
        home: &Path,
        legacy: bool,
    ) -> (TaskRow, PathBuf) {
        use std::os::unix::fs::DirBuilderExt as _;

        let scratch = home.canonicalize().unwrap().join("assigned-scratch");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&scratch)
            .unwrap();
        let id = "settled-custody";
        let head = service.fixture().start.clone();
        let (template, _, mut observation) = reservation(id, Entry::Brief, &head);
        let mut task = Task::new(template.identity().clone(), "Scoped fixture".into(), None);
        task.reconcile(&observation);
        let credential = task
            .reserve_launch(
                &observation,
                LaunchInputs {
                    thread: "worker".into(),
                    started_at: 1,
                    input: "fixture".into(),
                    scratch: Some(scratch.clone()),
                },
                &[9; 32],
            )
            .unwrap();
        let instance = task.run().unwrap().launch().instance.clone();
        let pr = PullRequest {
            url: "https://github.com/example/test/pull/1".into(),
            head: head.clone(),
        };
        task.record_report(
            &instance,
            credential.as_bytes(),
            Report::Work(pr.clone().into()),
        )
        .unwrap();
        observation.forge = Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        });
        observation.host = Observed::Known(Host::Current {
            instance,
            state: RunState::Ended,
        });
        assert_eq!(
            task.reconcile(&observation),
            Action::Advance(Phase::Reviewing)
        );
        observation.host = Observed::Unknown;
        let reviewer_scratch = home.canonicalize().unwrap().join("reviewer-scratch");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&reviewer_scratch)
            .unwrap();
        let key = task
            .reserve_launch(
                &observation,
                LaunchInputs {
                    thread: "reviewer".into(),
                    started_at: 2,
                    input: "fixture".into(),
                    scratch: Some(reviewer_scratch),
                },
                &[9; 32],
            )
            .unwrap();
        settle_both_reviewers(&mut task, &mut observation, &head, key.as_bytes(), &scratch);
        task.command(
            Command::Cancel,
            &Authority::Operator {
                actor: "fixture".into(),
            },
            &observation,
        )
        .unwrap();
        let scratch = if legacy {
            legacy_scratch(service, &mut task, &scratch)
        } else {
            scratch
        };
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .unwrap();
        let row = service.task(id).await.unwrap();
        assert!(row.task.run().is_none());
        (row, scratch)
    }

    fn legacy_scratch(service: &Service, task: &mut Task, scratch: &Path) -> PathBuf {
        let instance = task.earlier_run_scratch().next().unwrap().0;
        let derived = service
            .storage
            .scratch()
            .path()
            .join(scratch::relative_path(&instance));
        std::fs::create_dir_all(derived.parent().unwrap()).unwrap();
        std::fs::rename(scratch, &derived).unwrap();
        let mut saved = serde_json::to_value(&*task).unwrap();
        saved["threads"]
            .as_object_mut()
            .unwrap()
            .remove("earlier_scratch");
        saved["threads"]
            .as_object_mut()
            .unwrap()
            .remove("settled_scratch");
        *task = serde_json::from_value(saved).unwrap();
        derived
    }

    #[tokio::test]
    async fn writers_in_all_retirement_roots_hold_checkout() {
        use std::os::unix::fs::PermissionsExt as _;

        for legacy in [false, true] {
            let (home, service) = fixture(GitHub::new("fixture").unwrap());
            let (row, earlier) = settled_cleanup_task(&service, home.path(), legacy).await;
            let id = &row.task.identity().id;
            let head = service.fixture().start.clone();
            let current = service.existing_run_scratch(&row.task).await.unwrap();
            let work = service.worktrees();
            let route = service.project_for(row.task.identity()).await.unwrap();
            let checkout = work.checkout(&route.checkout, REPOSITORY, id).unwrap();
            checkout.allocate(&head).unwrap();
            let binding = service
                .checkout_binding(row.task.identity(), &route, &checkout)
                .unwrap();
            // Legacy rows derive the current path as well as earlier paths.
            let current = current.unwrap_or_else(|| {
                let (instance, _) = row.task.settled_scratch().unwrap();
                let path = service
                    .storage
                    .scratch()
                    .path()
                    .join(scratch::relative_path(&instance));
                std::fs::create_dir_all(&path).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
                path
            });
            for root in [checkout.path(), current.as_path(), earlier.as_path()] {
                let mut child = sleep_in_cwd(root);
                let pid = child.id().unwrap();
                let host = service
                    .host
                    .pass(service.storage.scratch().path())
                    .with_fixture_process_cwd(pid, root)
                    .for_task(
                        &row.task,
                        service.existing_run_scratch(&row.task).await.unwrap(),
                    );
                let result = service
                    .retire_if_idle(&host, &row.task, &binding, &checkout, Some(&head))
                    .await;
                child.kill().await.unwrap();
                assert!(
                    matches!(&result, Err(ServiceError::CheckoutProcess(blocker)) if blocker.pid == pid),
                    "{result:?}"
                );
                assert!(checkout.path().exists());
            }
        }
    }

    fn sleep_in_cwd(cwd: &Path) -> tokio::process::Child {
        tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .current_dir(cwd)
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    #[cfg(target_os = "macos")]
    async fn process_listing(command: &str, args: &[&str]) -> Vec<u8> {
        let listing = tokio::process::Command::new(command)
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .args(args)
            .output()
            .await
            .unwrap();
        assert!(listing.status.success(), "{listing:?}");
        listing.stdout
    }

    #[cfg(target_os = "macos")]
    async fn exit_without_reaping(child: &mut tokio::process::Child) {
        let pid = child.id().unwrap().to_string();
        child.start_kill().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = process_listing("/bin/ps", &["-p", &pid, "-o", "stat="]).await;
                if String::from_utf8_lossy(&state)
                    .trim_start()
                    .starts_with('Z')
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture child exited");
    }

    #[cfg(target_os = "macos")]
    async fn process_rows(pids: &str) -> Vec<u8> {
        process_listing(
            "/bin/ps",
            &[
                "-ww",
                "-p",
                pids,
                "-o",
                "pid=,ppid=,uid=,stat=,lstart=,ucomm=",
            ],
        )
        .await
    }

    #[cfg(target_os = "macos")]
    async fn before_cwd_followup(unrelated: u32, exited: u32, writer: u32) -> (Vec<u8>, Vec<u8>) {
        let ps = process_rows(&format!("{unrelated},{exited},{writer}")).await;
        let lsof = process_listing(
            "/usr/sbin/lsof",
            &[
                "-a",
                "-p",
                &unrelated.to_string(),
                "-d",
                "cwd",
                "-n",
                "-P",
                "-F0pfn",
            ],
        )
        .await;
        assert!(String::from_utf8_lossy(&lsof).contains("elsewhere^A"));
        (lsof, ps)
    }

    #[cfg(target_os = "macos")]
    async fn cwd_fields(pid: u32) -> String {
        let listing = process_listing(
            "/usr/sbin/lsof",
            &[
                "-a",
                "-p",
                &pid.to_string(),
                "-d",
                "cwd",
                "-n",
                "-P",
                "-F0pfDn",
            ],
        )
        .await;
        String::from_utf8(listing).unwrap()
    }

    #[cfg(target_os = "macos")]
    fn cwd_device(lsof: &str) -> &str {
        lsof.split('\0')
            .find(|field| field.starts_with("D0x"))
            .expect("real cwd device")
    }

    #[cfg(target_os = "macos")]
    fn cwd_probe_second() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};

        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        )
        .unwrap()
    }

    #[cfg(target_os = "macos")]
    async fn forked_shell(cwd: &Path) -> (tokio::process::Child, u32) {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut parent = tokio::process::Command::new("/bin/bash")
            .args([
                "-c",
                r#"exec 3<&0; (cd "$1" && IFS= read -r ignored <&3) & printf '%s\n' "$!"; wait "$!""#,
                "bash",
            ])
            .arg(cwd)
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut pid = String::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            BufReader::new(parent.stdout.take().unwrap()).read_line(&mut pid),
        )
        .await
        .unwrap()
        .unwrap();
        (parent, pid.trim().parse().unwrap())
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn real_census_rows_allow_unrelated_closeout_and_name_a_live_writer() {
        let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
        service.fixture_mut().acp_provider = Some("fixture".into());
        let (row, _) = settled_cleanup_task(&service, home.path(), false).await;
        let id = &row.task.identity().id;
        let head = &service.fixture().start;
        let route = service.project_for(row.task.identity()).await.unwrap();
        let work = service.worktrees();
        let checkout = work.checkout(&route.checkout, REPOSITORY, id).unwrap();
        checkout.allocate(head).unwrap();
        let binding = service
            .checkout_binding(row.task.identity(), &route, &checkout)
            .unwrap();
        service.host.fixture_held_shell(&json!({
            "kind":"snapshot","snapshot":{"snapshotSequence":1,"projects":[],"threads":[]}
        }));
        let scratch = service.storage.scratch().path();
        let outside = home.path().join("elsewhere^A");
        std::fs::create_dir(&outside).unwrap();
        let mut unrelated = sleep_in_cwd(&outside);
        let mut exited = sleep_in_cwd(checkout.path());
        let inside = checkout.path().join("writer^A");
        std::fs::create_dir(&inside).unwrap();
        let mut writer = sleep_in_cwd(&inside);
        let (lsof, ps) = before_cwd_followup(
            unrelated.id().unwrap(),
            exited.id().unwrap(),
            writer.id().unwrap(),
        )
        .await;
        // The follow-up identifies a process by its start second.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let capture = || {
            service
                .host
                .pass(scratch)
                .with_fixture_census(&lsof, &ps, scratch)
        };

        // The ps rows still name the exited child, and kill(0) still sees its PID.
        exit_without_reaping(&mut exited).await;
        let fixture = capture().await.unwrap();
        assert_eq!(fixture.unresolved_processes(), Some(vec![]));
        exited.wait().await.unwrap();
        let retirement = service
            .retire_if_idle(&fixture, &row.task, &binding, &checkout, Some(head))
            .await;
        let pid = writer.id().unwrap();
        assert!(
            matches!(&retirement, Err(ServiceError::CheckoutProcess(blocker)) if blocker.pid == pid && !blocker.unverified)
        );
        let result = retirement.map(|_| Action::Nothing);
        service
            .schedule_result(&row, &result, crate::schedule::Priority::Closeout)
            .await
            .unwrap();
        {
            let state = service.state.lock().await;
            assert!(matches!(
                state.wait_detail(id),
                Some(crate::WaitDetail::Archive(message)) if message.contains(&format!("PID {pid} (sleep)")) && message.contains("working directory")
            ));
        }
        assert!(checkout.path().exists());

        writer.kill().await.unwrap();
        let cleared = capture().await.unwrap();
        assert_eq!(
            service
                .retire_if_idle(&cleared, &row.task, &binding, &checkout, Some(head))
                .await
                .unwrap(),
            Some(Retirement::Removed)
        );
        assert!(!checkout.path().exists());
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn cwd_metadata_error_still_holds_a_checkout_with_a_live_writer() {
        let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
        service.fixture_mut().acp_provider = Some("fixture".into());
        let (row, _) = settled_cleanup_task(&service, home.path(), false).await;
        let project = service.fixture();
        let work = service.worktrees();
        let id = &row.task.identity().id;
        let checkout = work.checkout(&project.checkout, REPOSITORY, id).unwrap();
        checkout.allocate(&project.start).unwrap();
        let route = service.project_for(row.task.identity()).await.unwrap();
        let binding = route.binding(&checkout).unwrap();

        let (mut parent, pid) = forked_shell(checkout.path()).await;
        let parent_pid = parent.id().unwrap();
        // ps reports whole seconds and the follow-up must see the same lifetime.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let pids = format!("{pid},{parent_pid}");
        let ps = process_rows(&pids).await;
        let observed = cwd_probe_second();
        let writer_cwd = cwd_fields(pid).await;
        assert!(writer_cwd.contains(&format!("n{}\0", checkout.path().display())));
        let parent_cwd = cwd_fields(parent_pid).await;
        let current_ps = process_rows(&pids).await;
        let scratch = service.storage.scratch().path();
        let capture = |files: &str| {
            service
                .host
                .pass(scratch)
                .with_fixture_cwd_followup(files.as_bytes(), &ps, &current_ps, observed)
                .unwrap()
        };

        // The child is inside the checkout. Its only listed open file is outside.
        let failure = capture(&format!(
            "{parent_cwd}p{pid}\0\nfcwd\0ncwd|rtd info error: No such file or directory\0\nftxt\0{}\0n/bin/bash\0\n",
            cwd_device(&parent_cwd)
        ));
        let retirement = service
            .retire_if_idle(
                &failure,
                &row.task,
                &binding,
                &checkout,
                Some(&project.start),
            )
            .await;
        assert!(
            matches!(&retirement, Err(ServiceError::CheckoutProcess(blocker))
            if blocker.pid == pid && blocker.unverified)
        );
        service
            .schedule_result(
                &row,
                &retirement.map(|_| Action::Nothing),
                crate::schedule::Priority::Closeout,
            )
            .await
            .unwrap();
        assert!(matches!(
            service.state.lock().await.wait_detail(id),
            Some(crate::WaitDetail::Archive(message))
                if message.contains(&format!("PID {pid} (bash)")) && message.contains("could not rule out")
        ));

        // If only the device is readable, a match still holds the checkout.
        let same_device = capture(&format!(
            "{parent_cwd}p{pid}\0\nfcwd\0{}\0\n",
            cwd_device(&writer_cwd)
        ));
        assert!(matches!(
            service.retire_if_idle(&same_device, &row.task, &binding, &checkout, Some(&project.start)).await,
            Err(ServiceError::CheckoutProcess(blocker)) if blocker.pid == pid && blocker.unverified
        ));
        assert!(checkout.path().exists());
        drop(parent.stdin.take());
        parent.wait().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn pathless_cwd_on_another_device_allows_checkout_retirement() {
        let (home, service) = fixture(GitHub::new("fixture").unwrap());
        let (row, _) = settled_cleanup_task(&service, home.path(), false).await;
        let project = service.fixture();
        let work = service.worktrees();
        let checkout = work
            .checkout(&project.checkout, REPOSITORY, &row.task.identity().id)
            .unwrap();
        checkout.allocate(&project.start).unwrap();
        let route = service.project_for(row.task.identity()).await.unwrap();
        let binding = route.binding(&checkout).unwrap();
        service.host.fixture_held_shell(&json!({
            "kind":"snapshot","snapshot":{"snapshotSequence":1,"projects":[],"threads":[]}
        }));

        let mut outside = sleep_in_cwd(Path::new("/"));
        let pid = outside.id().unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        let ps = process_rows(&pid.to_string()).await;
        let observed = cwd_probe_second();
        let outside_cwd = cwd_fields(pid).await;
        let current_ps = process_rows(&pid.to_string()).await;
        // Preserve the real device field and omit the pathname and inode.
        let files = format!("p{pid}\0\nfcwd\0{}\0\n", cwd_device(&outside_cwd));
        let unrelated = service
            .host
            .pass(service.storage.scratch().path())
            .with_fixture_cwd_followup(files.as_bytes(), &ps, &current_ps, observed)
            .unwrap();
        assert_eq!(
            service
                .retire_if_idle(
                    &unrelated,
                    &row.task,
                    &binding,
                    &checkout,
                    Some(&project.start)
                )
                .await
                .unwrap(),
            Some(Retirement::Removed)
        );
        assert!(outside.try_wait().unwrap().is_none());
        outside.kill().await.unwrap();
    }

    struct ProtectedTree(Vec<u32>);

    impl Drop for ProtectedTree {
        fn drop(&mut self) {
            for pid in self.0.iter().rev() {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-KILL", &pid.to_string()])
                    .output();
            }
        }
    }

    async fn protected_host_tree(dir: &Path) -> ProtectedTree {
        // The orphan root contains the described host and its child.
        let script = r#"/bin/sh -c '/bin/sh -c '\''/bin/sleep 60 >/dev/null 2>&1 & echo "$PPID $$ $!"; exec >/dev/null 2>&1; wait'\'' & exec >/dev/null 2>&1; wait' </dev/null &"#;
        let output = tokio::process::Command::new("/bin/sh")
            .args(["-c", script])
            .current_dir(dir)
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let pids: Vec<u32> = std::str::from_utf8(&output.stdout)
            .unwrap()
            .split_whitespace()
            .map(|pid| pid.parse().unwrap())
            .collect();
        assert_eq!(pids.len(), 3);
        let tree = ProtectedTree(pids);
        for (pid, parent) in [
            (tree.0[0], 1),
            (tree.0[1], tree.0[0]),
            (tree.0[2], tree.0[1]),
        ] {
            let output = std::process::Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "ppid="])
                .output()
                .unwrap();
            assert_eq!(
                std::str::from_utf8(&output.stdout).unwrap().trim(),
                parent.to_string()
            );
        }
        tree
    }

    #[tokio::test]
    async fn terminal_cleanup_stops_only_the_checkout_orphan_tree() {
        exercise_terminal_orphan_cleanup(false, false, true).await;
    }

    #[tokio::test]
    async fn terminal_cleanup_stops_only_the_settled_scratch_orphan_tree() {
        exercise_terminal_orphan_cleanup(true, false, false).await;
    }

    #[tokio::test]
    async fn terminal_cleanup_handles_pre_upgrade_scratch() {
        exercise_terminal_orphan_cleanup(true, true, false).await;
    }

    async fn exercise_terminal_orphan_cleanup(in_scratch: bool, legacy: bool, host_tree: bool) {
        let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
        service.fixture_mut().acp_provider = Some("fixture".into());
        service.state.lock().await.settings.dispatch =
            Some(nucleus_store::DispatchSettings::default());
        let (terminal, scratch) = if in_scratch {
            let (row, scratch) = settled_cleanup_task(&service, home.path(), legacy).await;
            (row, Some(scratch))
        } else {
            (cancelled_cleanup_task(&service).await, None)
        };
        let id = &terminal.task.identity().id;
        assert_eq!(terminal.task.phase(), Phase::Cancelled);
        let base = {
            let work = service.worktrees();
            let checkout = work
                .checkout(&service.fixture().checkout, REPOSITORY, id)
                .unwrap();
            checkout.allocate(&service.fixture().start).unwrap();
            checkout.path().to_owned()
        };
        std::fs::write(base.join("unpublished"), "retain").unwrap();
        let spawn = |dir: &Path| {
            tokio::process::Command::new("/bin/sleep")
                .arg("30")
                .current_dir(dir)
                .kill_on_drop(true)
                .spawn()
                .unwrap()
        };
        let orphan_dir = scratch.as_deref().unwrap_or(&base);
        let protected = if host_tree {
            Some(protected_host_tree(orphan_dir).await)
        } else {
            None
        };
        let native = T3::new("http://127.0.0.1:9", "fixture").unwrap();
        service.host = match &protected {
            Some(tree) => crate::tests::described_native_fixture(native, home.path(), tree.0[1]),
            None => crate::tests::verified_native_fixture(native, home.path()),
        };
        service.host.fixture_held_shell(&json!({"kind":"snapshot","snapshot":{"snapshotSequence":1,"projects":[],"threads":[]}}));
        let mut host_child = spawn(orphan_dir);
        let mut outside = spawn(home.path());
        // The orphan runs a script from its root directory, so its argv names the task's own code.
        // The launching shell exits. One child handles TERM and the orphan root and second child ignore it.
        let orphan = orphan_dir.join("orphan.sh");
        std::fs::write(
            &orphan,
            r#"/bin/sleep 60 >/dev/null 2>&1 & soft=$!; trap "" TERM; /bin/sleep 60 >/dev/null 2>&1 & echo "$$ $! $soft"; exec >/dev/null 2>&1; wait"#,
        )
        .unwrap();
        let script = format!("/bin/sh '{}' </dev/null &", orphan.display());
        let output = tokio::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .current_dir(orphan_dir)
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let pids: Vec<u32> = std::str::from_utf8(&output.stdout)
            .unwrap()
            .split_whitespace()
            .map(|pid| pid.parse().unwrap())
            .collect();
        assert_eq!(pids.len(), 3);
        // Orphans must pass the scan's settle margin before closeout reads them.
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let outcome = service.archive_done(&terminal).await;
        assert!(
            matches!(&outcome, Err(ServiceError::ArchiveEvidence(s)) if s.contains("exited")),
            "{outcome:?}"
        );
        assert_cleanup_history(&service, id, &pids, protected.as_ref()).await;
        assert!(base.join("unpublished").exists());
        assert!(host_child.try_wait().unwrap().is_none());
        assert!(outside.try_wait().unwrap().is_none());
        host_child.kill().await.unwrap();
        outside.kill().await.unwrap();
    }

    async fn assert_cleanup_history(
        service: &Service,
        id: &str,
        pids: &[u32],
        protected: Option<&ProtectedTree>,
    ) {
        let history = service.history(id, None, 25).await.unwrap();
        let sent = |pid: u32, signal: &str| {
            history
                .iter()
                .filter(|e| e.content.kind == "checkout_process_result")
                .any(|e| {
                    let detail: serde_json::Value =
                        serde_json::from_str(&e.content.detail).unwrap();
                    detail["signal"] == signal
                        && detail["results"].as_array().unwrap().iter().any(|entry| {
                            entry["process"]["pid"].as_u64() == Some(u64::from(pid))
                                && entry["outcome"] == "sent"
                                && entry["process"]["command"]
                                    .as_str()
                                    .is_some_and(|name| !name.is_empty())
                        })
                })
        };
        for (index, &pid) in pids.iter().enumerate() {
            assert!(sent(pid, "SIGTERM"));
            assert_eq!(sent(pid, "SIGKILL"), index < 2);
            let probe = tokio::process::Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "stat="])
                .output()
                .await
                .unwrap();
            assert!(
                probe.stdout.is_empty()
                    || String::from_utf8_lossy(&probe.stdout)
                        .trim()
                        .starts_with('Z')
            );
        }
        if let Some(tree) = protected {
            for &pid in &tree.0 {
                assert!(!sent(pid, "SIGTERM"));
                assert!(!sent(pid, "SIGKILL"));
                assert!(
                    std::process::Command::new("/bin/kill")
                        .args(["-0", &pid.to_string()])
                        .status()
                        .unwrap()
                        .success()
                );
            }
        }
    }

    /// A forge that reports the checkout's branch as published at `head`, so archive reaches retirement.
    async fn publish_checkout_forge(
        head: nucleus_core::Head,
    ) -> (GitHub, tokio::task::JoinHandle<()>) {
        let (main, branch, single) = (head.clone(), head.clone(), head);
        crate::tests::serve_forge(
            axum::Router::new()
                .route(
                    &format!("/repos/{REPOSITORY}/branches/main"),
                    axum::routing::get(move || {
                        let main = main.clone();
                        async move { axum::Json(json!({"name":"main","commit":{"sha":main}})) }
                    }),
                )
                .route(
                    &format!("/repos/{REPOSITORY}/branches"),
                    axum::routing::get(move || {
                        let branch = branch.clone();
                        async move {
                            axum::Json(vec![
                                json!({"name":"ns-orphan-test","commit":{"sha":branch}}),
                            ])
                        }
                    }),
                )
                .route(
                    &format!("/repos/{REPOSITORY}/branches/ns-orphan-test"),
                    axum::routing::get(move || {
                        let single = single.clone();
                        async move {
                            axum::Json(json!({"name":"ns-orphan-test","commit":{"sha":single}}))
                        }
                    }),
                )
                .route(
                    "/graphql",
                    axum::routing::post(|| async {
                        axum::Json(json!({"data":{"repository":{"pullRequests":{"totalCount":0}}}}))
                    }),
                ),
        )
        .await
    }

    #[tokio::test]
    async fn an_external_orphan_in_the_checkout_is_retained_and_holds_retirement() {
        let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
        let head = service.fixture().start.clone();
        let (forge, _server) = publish_checkout_forge(head).await;
        service.forge = forge;
        service.host = crate::tests::verified_native_fixture(
            T3::new("http://127.0.0.1:9", "fixture").unwrap(),
            home.path(),
        );
        service.host.fixture_held_shell(&json!({"kind":"snapshot","snapshot":{"snapshotSequence":1,"projects":[],"threads":[]}}));
        service.fixture_mut().acp_provider = Some("fixture".into());
        service.state.lock().await.settings.dispatch =
            Some(nucleus_store::DispatchSettings::default());
        let terminal = cancelled_cleanup_task(&service).await;
        let id = &terminal.task.identity().id;
        let work = service.worktrees();
        let checkout = work
            .checkout(&service.fixture().checkout, REPOSITORY, id)
            .unwrap();
        checkout.allocate(&service.fixture().start).unwrap();
        let base = checkout.path();
        // The launching shell exits, so sleep is orphaned with its cwd in the checkout. Its argv names no path.
        let output = tokio::process::Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 60 >/dev/null 2>&1 & echo $!"])
            .current_dir(base)
            .output()
            .await
            .unwrap();
        let pid: u32 = std::str::from_utf8(&output.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Orphans must pass the scan's settle margin before closeout reads them.
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let outcome = service.archive_done(&terminal).await;
        let alive = tokio::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .await
            .unwrap();
        let history = service.history(id, None, 25).await.unwrap();
        tokio::process::Command::new("/bin/kill")
            .arg(pid.to_string())
            .status()
            .await
            .unwrap();
        assert!(
            matches!(&outcome, Err(ServiceError::CheckoutProcess(blocker)) if blocker.pid == pid),
            "{outcome:?}"
        );
        assert!(
            !String::from_utf8_lossy(&alive.stdout).trim().is_empty(),
            "the external service must keep running"
        );
        let retained = history
            .iter()
            .filter(|e| e.content.kind == "checkout_process_retained")
            .any(|e| {
                let detail: serde_json::Value = serde_json::from_str(&e.content.detail).unwrap();
                detail["processes"].as_array().unwrap().iter().any(|entry| {
                    entry["pid"].as_u64() == Some(u64::from(pid))
                        && entry["command"]
                            .as_str()
                            .is_some_and(|name| !name.is_empty())
                })
            });
        assert!(
            retained,
            "the retained process must be recorded with its PID"
        );
        assert!(
            !history
                .iter()
                .any(|e| e.content.kind == "checkout_process_result"),
            "no signal may be sent to a retained service"
        );
        assert!(base.exists());
    }

    #[tokio::test]
    async fn unbound_review_checkout_survives_a_local_writer_and_an_active_child() {
        let (_home, service) = fixture(GitHub::new("fixture").unwrap());
        let project = service.fixture();
        let head = &project.start;
        let task = Task::new(
            nucleus_core::Identity {
                id: "unbound".into(),
                reference: "unbound".into(),
                repository: REPOSITORY.into(),
                base: "main".into(),
                entry: Entry::ReviewEntry,
                origin_thread: None,
            },
            "Review an existing PR".into(),
            Some(PullRequest {
                url: format!("https://github.com/{REPOSITORY}/pull/1"),
                head: head.clone(),
            }),
        );
        let work = service.worktrees();
        let checkout = work
            .checkout(&project.checkout, REPOSITORY, "unbound")
            .unwrap();
        checkout.allocate(head).unwrap();
        let route = service.project_for(task.identity()).await.unwrap();
        let binding = route.binding(&checkout).unwrap();
        let parent = nucleus_hosts::parent_thread(checkout.path());
        let shell = |threads| {
            service.host.fixture_held_shell(&json!({
                "kind":"snapshot","snapshot":{"snapshotSequence":1,"projects":[],"threads":threads}
            }));
        };
        shell(json!([]));
        let mut writer = sleep_in_cwd(checkout.path());
        let writer_host = service
            .host
            .pass(service.storage.scratch().path())
            .with_fixture_process_cwd(writer.id().unwrap(), checkout.path())
            .for_task(&task, None);
        assert!(
            matches!(service.retire_if_idle(&writer_host, &task, &binding, &checkout, Some(head)).await, Err(ServiceError::CheckoutProcess(blocker)) if Some(blocker.pid) == writer.id())
        );
        assert!(checkout.path().exists());
        writer.kill().await.unwrap();
        let quiet_host = service.host.fixture_pass().for_task(&task, None);
        shell(json!([{"id":"active-child","parentThreadId":parent,"status":"running"}]));
        assert!(matches!(
            service
                .retire_if_idle(&quiet_host, &task, &binding, &checkout, Some(head))
                .await,
            Err(ServiceError::Host(HostError::RowChildBusy))
        ));
        assert!(checkout.path().exists());
        shell(json!([]));
        assert_eq!(
            service
                .retire_if_idle(&quiet_host, &task, &binding, &checkout, Some(head))
                .await
                .unwrap(),
            Some(Retirement::Removed)
        );
        assert!(!checkout.path().exists());
        assert!(service.host.host_calls().is_empty());
    }

    #[tokio::test]
    async fn task_add_pins_worker_lane_text_and_resolves_brief_prerequisites() {
        use nucleus_store::planning::{LaneDocument, WriteAt};
        let (_home, service) = fixture(GitHub::new("fixture").unwrap());
        let project = service.fixture();
        let lane_text = "Use the two-project fixture for acceptance.";
        let key = "product";
        {
            let mut state = service.state.lock().await;
            state.settings.projects = Some(serde_json::from_value(json!({"projects": {
                (key): {"name":"Product", "archived":false, "repositories":[
                    {"origin":REPOSITORY, "base":"main", "path":project.checkout, "hostProject":project.host_project}
                ]}
            }})).unwrap());
            state
                .store
                .put_lane(
                    key,
                    "design",
                    0,
                    LaneDocument {
                        title: "Design".into(),
                        aim: "Release slice".into(),
                        document: lane_text.into(),
                    },
                    WriteAt {
                        actor: "planner",
                        at_ms: 1,
                    },
                )
                .unwrap();
        }
        let owner = Authority::Operator {
            actor: "fixture".into(),
        };
        let scope = crate::ControllerScope::default();
        let add = |id: &str, fields: &str| {
            let input = serde_json::from_value(json!({"id":id,
                "brief":format!("---\nqueue:\n  complexity: medium\n  {fields}\n---\nFixture task")
            }))
            .unwrap();
            service.add_planned_task(Some(key), input, &owner, &scope)
        };
        let row = add("pinned", "laneDocuments: [design]").await.unwrap();
        let dependent = add("follows", "dependsOn: ['nucleus-fixture#1']")
            .await
            .unwrap();
        assert!(service.dependencies_blocked(&dependent).await.unwrap());

        let workspace = service.worktrees();
        let checkout = workspace
            .checkout(&project.checkout, REPOSITORY, "pinned")
            .unwrap();
        let observation = Observation {
            host: Observed::Unknown,
            forge: Observed::Known(Forge::Absent),
            workspace: Observed::Known(Workspace::Absent),
        };
        let mut working = row.task.clone();
        assert_eq!(
            working.reconcile(&observation),
            Action::Advance(Phase::Working)
        );
        let working = service
            .save(&row, working, &event("advanced"))
            .await
            .unwrap();
        Box::pin(service.reserve(
            &working,
            &checkout,
            observation,
            Role::Worker,
            Launch::Create,
            &service.host.fixture_pass(),
        ))
        .await
        .unwrap();
        let pinned = service.task("pinned").await.unwrap();
        let launch = pinned.task.run().unwrap().launch();
        let path = launch
            .scratch
            .as_ref()
            .unwrap()
            .join("lane-documents/design.md");
        assert_eq!(std::fs::read_to_string(path).unwrap(), lane_text);
        assert!(launch.input.contains("design version 1"));
        assert!(launch.input.contains(lane_text));
    }

    #[tokio::test]
    async fn scheduler_reservations_share_a_catalog_and_charge_the_selected_group() {
        let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
        let reads = Arc::new(AtomicUsize::new(0));
        let native_reads = Arc::clone(&reads);
        let (host, server) = native_fixture(move |request| {
            assert_eq!(request["tag"], "server.getConfig");
            native_reads.fetch_add(1, Ordering::Relaxed);
            let models: Vec<_> = ["model-first", "model-second"].into_iter().map(|slug| json!({
                "slug": slug, "capabilities": {"optionDescriptors": [
                    {"id":"reasoningEffort","type":"select","options":[{"id":"high"}]}
                ]}
            })).collect();
            json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{
                "environment":{"orchestrationProtocolVersion":2},
                "providers":[
                    {"instanceId":"custom-codex","driver":"codex","enabled":true,"status":"ready","models":models},
                    {"instanceId":"claudeAgent","enabled":false,"status":"disabled","models":[{"slug":"offline"}]}
                ]
            }}})
        }).await;
        service.host = host;
        service.state.lock().await.settings.profiles = Some(Arc::new(serde_json::from_value(json!({
            "profiles": [
                {"name":"First","group":"Shared plan","selection":{"id":"first","capability":"worker","provider":"codex","model":"model-first","effort":"high"}},
                {"name":"Second","group":"Shared plan","selection":{"id":"second","capability":"worker","provider":"codex","model":"model-second","effort":"high"}},
                {"name":"Offline","group":"Other plan","selection":{"id":"offline","capability":"worker","provider":"claude","model":"offline"}}
            ]
        })).expect("profile settings")));
        let pass = service.host.fixture_pass();
        let worktrees = service.worktrees();
        let mut selected = Vec::new();
        for id in ["worker-one", "worker-two"] {
            let mut task = Task::new(
                nucleus_core::Identity {
                    id: id.into(),
                    reference: id.into(),
                    repository: REPOSITORY.into(),
                    base: service.fixture().base.clone(),
                    entry: Entry::Brief,
                    origin_thread: None,
                },
                "Add a synthetic greeting.".into(),
                None,
            );
            let observation = Observation {
                host: Observed::Unknown,
                forge: Observed::Known(Forge::Absent),
                workspace: Observed::Known(Workspace::Absent),
            };
            assert_eq!(
                task.reconcile(&observation),
                Action::Advance(Phase::Working)
            );
            service
                .state
                .lock()
                .await
                .store
                .create(&task, &event("admitted"))
                .expect("seed");
            let row = service.task(id).await.expect("row");
            let checkout = worktrees
                .checkout(&service.fixture().checkout, REPOSITORY, id)
                .expect("checkout");
            Box::pin(service.reserve(
                &row,
                &checkout,
                observation,
                Role::Worker,
                Launch::Create,
                &pass,
            ))
            .await
            .expect("reserve configured worker");
            let frozen = service.task(id).await.expect("frozen row");
            let launch = frozen.task.run().expect("run").launch();
            let profile = launch.profile().expect("canonical choice");
            let wire: serde_json::Value =
                serde_json::from_str(&launch.input).expect("frozen payload");
            assert_eq!(
                wire["payload"]["modelSelection"],
                json!({
                    "instanceId":"custom-codex",
                    "model":profile.model,
                    "options":[{"id":"reasoningEffort","value":"high"}],
                })
            );
            selected.push(profile.id.clone());
        }
        assert_ne!(selected[0], selected[1]);
        assert_eq!(reads.load(Ordering::Relaxed), 1);
        let state = service.state.lock().await;
        for id in selected {
            let counts = state
                .store
                .rotation_counts(Role::Worker, &id, "Shared plan")
                .expect("rotation persisted");
            assert_eq!(counts.profile_lifetime, 1);
            assert_eq!(counts.group_lifetime, 2);
        }
        server.abort();
    }

    #[tokio::test]
    async fn a_running_review_waits_for_its_deadline_without_reading_the_forge() {
        let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
        let head = service.fixture().start.clone();
        let (forge, forge_reads, forge_server) = forge_fixture(&head).await;
        service.forge = forge;
        let worktrees = service.worktrees();
        let checkout = worktrees
            .checkout(
                &service.fixture().checkout,
                &service.fixture().repository,
                "reviewer",
            )
            .expect("checkout");
        let (mut task, _) = frozen_review(&service, &checkout, &head);
        let instance = task.run().expect("run").launch().instance.clone();
        let thread_id = task.run().expect("run").launch().thread.clone();
        task.record_send(&instance, 1).expect("send recorded");
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .expect("seed");
        let binding = service.binding(&checkout).expect("binding");
        let native_reads = Arc::new(AtomicUsize::new(0));
        let calls = Arc::clone(&native_reads);
        let (host, native_server) = native_fixture(move |req| {
            if req["tag"] == "orchestration.subscribeShell" {
                return json!({"_tag":"Chunk","requestId":req["id"],"values":[
                    {"kind":"snapshot","snapshot":{"snapshotSequence":1,"threads":[],"projects":[]}},
                    {"kind":"synchronized"},
                    {"kind":"thread.updated","sequence":2,"location":"active","thread":{
                        "id":thread_id,"status":"running","activeRunId":"native"
                    }}
                ]});
            }
            if req["tag"] == "subscribeServerConfig" {
                return json!({"_tag":"Chunk","requestId":req["id"],"values":[]});
            }
            assert_eq!(req["tag"], "orchestration.subscribeThread");
            calls.fetch_add(1, Ordering::Relaxed);
            json!({"_tag":"Chunk","requestId":req["id"],"values":[
                {"kind":"snapshot","snapshotSequence":1,"projection":{
                    "thread":{"id":req["payload"]["threadId"],"projectId":binding.project_id,
                        "worktreePath":binding.worktree_path,"branch":binding.branch},
                    "runs":[{"id":"native","status":"running","userMessageId":format!("{instance}-message")}],
                    "messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[]
                }},
                {"kind":"synchronized"}
            ]})
        }).await;
        service.host = host;
        let service = Arc::new(service);

        let pass_started = tokio::time::Instant::now();
        let outcomes = service.pass().await.expect("exact run read");
        assert!(matches!(
            outcomes.as_slice(),
            [crate::PassOutcome {
                result: Ok(Action::Wait(WaitReason::Running)),
                ..
            }]
        ));
        assert_eq!(forge_reads.load(Ordering::Relaxed), 0);
        {
            let mut state = service.state.lock().await;
            crate::tests::assert_scheduled_wait(
                &mut state,
                "reviewer",
                WaitReason::Running,
                pass_started,
                crate::schedule::LIVE_CHECK,
            );
            // The watcher must supply the next decision even if the backstop has elapsed.
            state.schedule.park("reviewer");
        }
        let thread = &task.run().expect("reviewer run").launch().thread;
        let watch = prove_running_hint_refresh(&service, thread, &native_reads).await;
        let authority = Authority::Operator {
            actor: "fixture".into(),
        };
        let amended = service
            .command("reviewer", &authority, Command::Amend("next".into()))
            .await
            .unwrap();
        assert_eq!(amended.task.brief().text, "next");
        assert_eq!(forge_reads.load(Ordering::Relaxed), 1);
        watch.abort();
        forge_server.abort();
        native_server.abort();
    }

    async fn prove_running_hint_refresh(
        service: &Arc<Service>,
        thread: &str,
        native_reads: &AtomicUsize,
    ) -> tokio::task::JoinHandle<()> {
        let service_watch = Arc::clone(service);
        let watch = tokio::spawn(async move { service_watch.watch_host().await });
        let hint = loop {
            let changed = service.wake.notified();
            {
                let state = service.state.lock().await;
                if let Some(seen) = state.thread_tasks["reviewer"][thread].seen.as_ref() {
                    assert!(seen.running());
                    assert!(state.schedule.due("reviewer").unwrap() <= tokio::time::Instant::now());
                    break seen.clone();
                }
            }
            changed.await;
        };
        service.pass().await.expect("event pass");
        let reads = native_reads.load(Ordering::Relaxed);
        assert_eq!(reads, 2);
        // Replay the same shell fact as fresh evidence after the exact read completes.
        service.wake_from_host(hint).await;
        service.state.lock().await.schedule.wake(
            "reviewer",
            tokio::time::Instant::now(),
            crate::schedule::Priority::Refresh,
        );
        let outcomes = service.pass().await.expect("running backstop");
        assert!(matches!(
            outcomes[0].result,
            Ok(Action::Wait(WaitReason::Running))
        ));
        assert_eq!(native_reads.load(Ordering::Relaxed), reads);
        watch
    }

    #[tokio::test]
    async fn review_recovers_its_checkout_before_creating_a_reservation() {
        for available in [true, false] {
            let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
            crate::tests::git(
                &service.fixture().checkout,
                &["config", "protocol.https.allow", "never"],
            );
            let head = if available {
                service.fixture().start.clone()
            } else {
                "b".repeat(40).parse().expect("missing local object")
            };
            let (forge, _, server) = forge_fixture(&head).await;
            service.forge = forge;
            let (reserved, _, observation) = reservation("reviewer", Entry::ReviewEntry, &head);
            let mut task = Task::new(
                reserved.identity().clone(),
                reserved.brief().text.clone(),
                reserved.pull_request().cloned(),
            );
            let _ = task.reconcile(&observation);
            service
                .state
                .lock()
                .await
                .store
                .create(&task, &event("fixture"))
                .expect("seed");
            let row = service.task("reviewer").await.expect("reviewing row");
            assert_eq!(row.task.phase(), Phase::Reviewing);
            let host = service.host.pass(service.storage.scratch().path());
            let step = Box::pin(service.advance(&row, &host)).await;
            let next = service.task("reviewer").await.expect("result row");
            if available {
                assert_eq!(
                    step.expect("recover the published checkout"),
                    Action::Launch {
                        role: Role::Reviewer,
                        via: Launch::Create
                    }
                );
                assert!(next.task.run().is_some());
            } else {
                assert!(matches!(
                    step,
                    Err(ServiceError::Workspace(WorkError::Git {
                        operation: nucleus_work::GitOperation::Fetch,
                        ..
                    }))
                ));
                assert_eq!(
                    crate::task_wait(&row, &step).0,
                    Some(WaitReason::WorkspaceUnknown)
                );
                assert!(crate::workspace_cause(&step).starts_with("git fetch "));
                assert_eq!(row, next);
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn an_edit_during_native_authorization_cannot_send_the_review() {
        let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
        let head = service.fixture().start.clone();
        let (forge, reads, forge_server) = forge_fixture(&head).await;
        service.forge = forge;
        let git = service.git.clone();
        let worktrees = crate::Worktrees::new(
            &service.storage,
            &git,
            crate::Redactor::new([], crate::RedactionRules::common()),
        );
        let checkout = worktrees
            .checkout(
                &service.fixture().checkout,
                &service.fixture().repository,
                "reviewer",
            )
            .expect("checkout");
        assert_eq!(
            checkout.allocate(&head).expect("allocate"),
            Workspace::Clean(head.clone())
        );
        let (task, mut observation) = frozen_review(&service, &checkout, &head);
        let id = task.run().expect("run").launch().instance.clone();
        observation.host = Observed::Known(Host::Current {
            instance: id,
            state: RunState::ReadyToSend,
        });
        let edit = checkout.path().join("edit-during-authorization.txt");
        let root = service.fixture().checkout.clone();
        let (host, native_server) = native_fixture(move |req| {
            match req["tag"].as_str() {
                Some("orchestration.subscribeThread") => {
                    std::fs::write(&edit, "local work").expect("edit while T3 is answering");
                    let thread = &req["payload"]["threadId"];
                    json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Failure","cause":[
                        {"_tag":"Fail","error":{"_tag":"OrchestrationV2GetThreadProjectionError","threadId":thread,
                            "cause":{"name":"ProjectionStoreThreadNotFoundError","message":format!("No orchestration projection exists for thread {}.", thread.as_str().expect("thread"))}
                        }}
                    ]}})
                }
                Some("orchestration.subscribeShell") => json!({"_tag":"Chunk","requestId":req["id"],"values":[
                    {"kind":"snapshot","snapshot":{"projects":[{"id":"local-fixture","workspaceRoot":root}]}},
                    {"kind":"synchronized"}
                ]}),
                _ => panic!("must not send a dirty review"),
            }
        }).await;
        service.host = host;
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .expect("seed");
        let row = service.task("reviewer").await.expect("original row");
        let result = service
            .send_prepared(&row, &checkout, observation, &service.host.fixture_pass())
            .await;
        assert_eq!(
            result.expect("dirty gate waits"),
            Action::Wait(WaitReason::HostUnknown)
        );
        assert_eq!(
            reads.load(Ordering::Relaxed),
            2,
            "forge reread after T3 authorization"
        );
        assert_eq!(service.task("reviewer").await.expect("no send marker"), row);
        native_server.abort();
        forge_server.abort();
    }

    #[tokio::test]
    async fn an_interrupt_requires_the_current_fixture_project_root() {
        for retargeted in [false, true] {
            let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
            let head = service.fixture().start.clone();
            let git = service.git.clone();
            let worktrees = crate::Worktrees::new(
                &service.storage,
                &git,
                crate::Redactor::new([], crate::RedactionRules::common()),
            );
            let checkout = worktrees
                .checkout(
                    &service.fixture().checkout,
                    &service.fixture().repository,
                    "reviewer",
                )
                .expect("checkout");
            checkout.allocate(&head).expect("checkout at head");
            let (mut task, observation) = frozen_review(&service, &checkout, &head);
            let launch = task.run().expect("run").launch();
            let instance = launch.instance.clone();
            let thread = launch.thread.clone();
            task.record_send(&instance, 1).expect("possible send");
            task.command(
                Command::Cancel,
                &Authority::Operator {
                    actor: "fixture".into(),
                },
                &observation,
            )
            .expect("revoke");
            let root = if retargeted {
                "/synthetic/unrelated".into()
            } else {
                service.fixture().checkout.clone()
            };
            let owned = checkout.path().to_owned();
            let writes = Arc::new(AtomicUsize::new(0));
            let attempted = Arc::clone(&writes);
            let (host, server) = native_fixture(move |req| {
                let snapshot = match req["tag"].as_str() {
                    Some("orchestration.subscribeThread") => json!({"projection":{
                        "thread":{"id":thread,"projectId":"local-fixture","worktreePath":owned,"branch":"ns-reviewer"},
                        "runs":[{"id":"native-review","status":"running","userMessageId":format!("{instance}-message")}],
                        "messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[]
                    }}),
                    Some("orchestration.subscribeShell") => json!({"snapshot":{
                        "projects":[{"id":"local-fixture","workspaceRoot":root}]
                    }}),
                    Some("orchestration.dispatchCommand") => {
                        assert_eq!(req["payload"]["type"], "run.interrupt");
                        attempted.fetch_add(1, Ordering::Relaxed);
                        return json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Success","value":{"sequence":12}}});
                    }
                    _ => panic!("unexpected native method"),
                };
                let mut snapshot = snapshot;
                snapshot["kind"] = json!("snapshot");
                snapshot["snapshotSequence"] = json!(11);
                json!({"_tag":"Chunk","requestId":req["id"],"values":[snapshot,{"kind":"synchronized"}]})
            }).await;
            service.host = host;
            service
                .state
                .lock()
                .await
                .store
                .create(&task, &event("fixture"))
                .expect("seed");
            let row = service.task("reviewer").await.expect("revoked row");
            let result = Box::pin(service.stop_run(
                &row,
                &checkout,
                observation,
                &service.host.fixture_pass(),
            ))
            .await;
            if retargeted {
                assert!(matches!(
                    result,
                    Err(ServiceError::Host(HostError::Binding))
                ));
            } else {
                assert_eq!(
                    result.expect("authorized interrupt"),
                    Action::Wait(WaitReason::Stopping)
                );
            }
            assert_eq!(writes.load(Ordering::Relaxed), usize::from(!retargeted));
            assert_eq!(
                service.task("reviewer").await.expect("custody retained"),
                row
            );
            server.abort();
        }
    }

    fn frozen_review(
        service: &Service,
        checkout: &Checkout<'_>,
        head: &Head,
    ) -> (Task, Observation) {
        let (task, _, observation) = reservation("reviewer", Entry::ReviewEntry, head);
        let launch = task.run().expect("run").launch();
        let inputs = RunRequest {
            parent: None,
            binding: service.binding(checkout).expect("binding"),
            dispatch: Dispatch::Create {
                title: "Review fixture".into(),
                profile: service.fixture().reviewer.clone(),
            },
            text: "Review the fixture".into(),
        }
        .inputs(&launch.instance, launch.thread.clone(), 1)
        .expect("wire");
        let mut restored = serde_json::to_value(&task).expect("stored reservation");
        restored["run"]["launch"]["input"] = json!(inputs.input);
        (
            serde_json::from_value(restored).expect("typed reservation"),
            observation,
        )
    }

    #[tokio::test]
    #[expect(
        clippy::too_many_lines,
        reason = "one loopback trace crosses forge, native host, callback, and restart"
    )]
    async fn conflict_continues_the_bound_worker_once_across_a_lost_reply_and_restart() {
        let (home, mut service) = fixture(GitHub::new("unused-fixture").unwrap());
        let project = service.fixture().clone();
        let old_head = project.start.clone();
        let (task, _) = code_task_at_merge("worker", &old_head);
        let worktrees = service.worktrees();
        let checkout = worktrees
            .checkout(&project.checkout, REPOSITORY, "worker")
            .unwrap();
        checkout.allocate(&old_head).unwrap();
        let binding = service.binding(&checkout).unwrap();
        let owned = checkout.path().to_owned();
        crate::tests::git(
            &owned,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "Resolve the merge conflict",
            ],
        );
        let new_head: Head = crate::tests::git(&owned, &["rev-parse", "HEAD"])
            .parse()
            .unwrap();
        crate::tests::git(&owned, &["reset", "--hard", old_head.as_str()]);

        let published = Arc::new(AtomicBool::new(false));
        let merge_requests = Arc::new(AtomicUsize::new(0));
        let pull = |head| {
            let mut wire = forge_pull(head);
            wire["head"]["ref"] = json!("ns-worker");
            wire
        };
        let checks = {
            let mut wire = forge_checks(&old_head);
            wire["data"]["repository"]["pullRequest"]["mergeable"] = json!("CONFLICTING");
            wire["data"]["repository"]["pullRequest"]["mergeStateStatus"] = json!("DIRTY");
            wire
        };
        let (old_pull, new_pull, new_checks) =
            (pull(&old_head), pull(&new_head), forge_checks(&new_head));
        let (pull_published, checks_published) = (Arc::clone(&published), Arc::clone(&published));
        let writes = Arc::clone(&merge_requests);
        let api = Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async move {
                    Json(if pull_published.load(Ordering::Relaxed) {
                        new_pull
                    } else {
                        old_pull
                    })
                }),
            )
            .route(
                "/graphql",
                post(move || async move {
                    Json(if checks_published.load(Ordering::Relaxed) {
                        new_checks
                    } else {
                        checks
                    })
                }),
            )
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1/merge"),
                put(move || async move {
                    writes.fetch_add(1, Ordering::Relaxed);
                    StatusCode::FORBIDDEN
                }),
            );
        let (forge, forge_server) = serve_forge(api).await;
        service.forge = forge;

        let selection = json!({"instanceId":"provider","model":"fixture"});
        let native_selection = selection.clone();
        let root = project.checkout.clone();
        let instance = task.next_launch_instance().unwrap();
        let accepted = Arc::new(std::sync::Mutex::new(Vec::new()));
        let returns = Arc::new(AtomicBool::new(false));
        let (native_accepted, native_returns) = (Arc::clone(&accepted), Arc::clone(&returns));
        let (host, native_server) = native_fixture(move |request| {
            let payload = &request["payload"];
            let id = &request["id"];
            let snapshot = match request["tag"].as_str() {
                Some("orchestration.subscribeShell") => json!({"snapshot":{
                    "projects":[{"id":binding.project_id,"workspaceRoot":root}]
                }}),
                Some("orchestration.subscribeThread") => {
                    let payloads = native_accepted.lock().unwrap();
                    let runs = if payloads.is_empty() || payload["threadId"] != "thread:worker" {
                        json!([])
                    } else {
                        let status = if native_returns.load(Ordering::Relaxed) { "completed" } else { "running" };
                        json!([{"id":"native-continuation","status":status,"userMessageId":payloads[0]}])
                    };
                    json!({"projection":{
                        "thread":{"id":payload["threadId"],"projectId":binding.project_id,
                            "worktreePath":binding.worktree_path,"branch":binding.branch,
                            "providerInstanceId":"provider","modelSelection":native_selection},
                        "runs":runs,"messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[]
                    }})
                }
                Some("orchestration.dispatchCommand") => {
                    assert_eq!(payload["type"], "message.dispatch");
                    assert_eq!(payload["threadId"], "thread:worker");
                    assert_eq!(payload["commandId"], instance);
                    assert_eq!(payload["modelSelection"], native_selection);
                    assert!(payload["text"].as_str().unwrap().contains("resolve the conflicts"));
                    native_accepted.lock().unwrap().push(payload["messageId"].clone());
                    return serde_json::Value::Null;
                }
                _ => panic!("unexpected native request {request}"),
            };
            let mut snapshot = snapshot;
            snapshot["kind"] = json!("snapshot");
            snapshot["snapshotSequence"] = json!(12);
            json!({"_tag":"Chunk","requestId":id,"values":[snapshot,{"kind":"synchronized"}]})
        }).await;
        service.host = host;
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .unwrap();
        let advance = async |service: &Service| {
            let row = service.task("worker").await.unwrap();
            Box::pin(service.advance(&row, &service.host.fixture_pass())).await
        };

        assert_eq!(
            advance(&service).await.unwrap(),
            Action::Advance(Phase::Working)
        );
        assert_eq!(
            advance(&service).await.unwrap(),
            Action::Launch {
                via: Launch::Continue {
                    thread: "thread:worker".into()
                },
                role: Role::Worker
            }
        );
        let retained = service.task("worker").await.unwrap();
        let launch = retained.task.run().unwrap().launch();
        let wire: serde_json::Value = serde_json::from_str(&launch.input).unwrap();
        assert_eq!(wire["selection"], selection);
        assert_eq!(wire["payload"]["modelSelection"], selection);
        assert!(
            advance(&service).await.is_err(),
            "the accepted send loses its reply"
        );
        assert_eq!(
            *accepted.lock().unwrap(),
            vec![wire["payload"]["messageId"].clone()]
        );
        let sent = service.task("worker").await.unwrap();
        assert!(sent.task.run().unwrap().last_send_at_ms().is_some());

        let host = nucleus_hosts::T3::new(service.host.endpoint(), "fixture").unwrap();
        let forge = std::mem::replace(&mut service.forge, GitHub::new("unused-fixture").unwrap());
        drop(service);
        let settings =
            nucleus_store::SettingsFile::open(&home.path().canonicalize().unwrap()).unwrap();
        // The continuation is reused under the ACP parent, which is what the recheck guards.
        let mut project = project;
        project.acp_provider = Some("fixture-acp".into());
        let mut service = Service::open(
            &settings,
            project,
            host,
            forge,
            "127.0.0.1:9".parse().unwrap(),
            std::env::current_exe().unwrap(),
        )
        .unwrap();
        assert_eq!(service.task("worker").await.unwrap().task, sent.task);
        assert_eq!(
            advance(&service).await.unwrap(),
            Action::Wait(WaitReason::Running)
        );
        // The continued run is not yet proven on its parent. The next look is a
        // Decision wake, so a fresh running hint cannot defer it past the live check.
        let recheck = service
            .state
            .lock()
            .await
            .schedule
            .due_at("worker", crate::schedule::Priority::Decision);
        assert!(recheck.is_some_and(|due| {
            due <= tokio::time::Instant::now() + crate::schedule::REENTRY_CHECK
        }));
        // The rest of this fixture models the no-ACP path; the probe above was the ACP case.
        service.fixture_mut().acp_provider = None;

        crate::tests::git(&owned, &["reset", "--hard", new_head.as_str()]);
        published.store(true, Ordering::Relaxed);
        returns.store(true, Ordering::Relaxed);
        let file = ticket::path(service.storage.scratch(), &launch.instance);
        let binding: ticket::ReportTicket =
            serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
        let new_pr = PullRequest {
            url: task.pull_request().unwrap().url.clone(),
            head: new_head.clone(),
        };
        service
            .report(
                "worker",
                &launch.instance,
                &binding.credential,
                Report::Work(new_pr.into()),
            )
            .await
            .unwrap();
        assert_eq!(
            advance(&service).await.unwrap(),
            Action::Advance(Phase::Reviewing)
        );
        let review = service.task("worker").await.unwrap();
        assert_eq!(review.task.pull_request().unwrap().head, new_head);
        assert!(review.task.verdict().is_none());
        assert_eq!(
            advance(&service).await.unwrap(),
            Action::Launch {
                via: Launch::Continue {
                    thread: "thread:reviewer".into()
                },
                role: Role::Reviewer
            }
        );
        assert_eq!(accepted.lock().unwrap().len(), 1);
        assert_eq!(merge_requests.load(Ordering::Relaxed), 0);

        native_server.abort();
        forge_server.abort();
    }

    #[tokio::test]
    async fn merge_writes_wait_until_the_forge_confirms_the_next_fact() {
        for status in [StatusCode::CONFLICT, StatusCode::METHOD_NOT_ALLOWED] {
            let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
            let head = service.fixture().start.clone();
            let new_head: Head = "b".repeat(40).parse().expect("changed head");
            let next = Arc::new(AtomicBool::new(false));
            let puts = Arc::new(AtomicUsize::new(0));
            let app = merge_fixture(&head, &new_head, status, &next, &puts);
            let (forge, server) = serve_forge(app).await;
            service.forge = forge;
            let (mut task, credential, mut observation) =
                reservation("reviewer", Entry::ReviewEntry, &head);
            let instance = task.run().expect("run").launch().instance.clone();
            task.record_report(
                &instance,
                credential.as_bytes(),
                Report::Review {
                    head: head.clone(),
                    decision: Review::Approve,
                    summary: "Approved exact head".into(),
                    finding_titles: Vec::new(),
                },
            )
            .expect("report");
            observation.host = Observed::Known(Host::Current {
                instance,
                state: RunState::Ended,
            });
            assert_eq!(
                task.reconcile(&observation),
                Action::Advance(Phase::Merging)
            );
            service
                .state
                .lock()
                .await
                .store
                .create(&task, &event("fixture"))
                .expect("seed merge");
            let host = service.host.pass(service.storage.scratch().path());
            let row = service.task("reviewer").await.expect("old approval");
            let first = Box::pin(service.advance(&row, &host)).await;
            let row = service.task("reviewer").await.expect("waiting task");
            assert_eq!(row.task.phase(), Phase::Merging);
            assert!(row.task.question().is_none());
            let second = Box::pin(service.advance(&row, &host)).await;
            assert_eq!(puts.load(Ordering::Relaxed), 1);
            if status == StatusCode::CONFLICT {
                for result in [first, second] {
                    assert!(matches!(result, Ok(Action::Wait(WaitReason::ForgeUnknown))));
                }
                assert!(row.task.verdict().is_none());
                assert_eq!(
                    row.task.pull_request().expect("keep the bound PR").head,
                    head
                );
                next.store(true, Ordering::Relaxed);
                assert_eq!(
                    Box::pin(service.advance(&row, &host))
                        .await
                        .expect("fresh head"),
                    Action::Advance(Phase::Reviewing)
                );
                let updated = service.task("reviewer").await.expect("new head bound");
                assert_eq!(updated.task.pull_request().expect("PR").head, new_head);
            } else {
                for result in [first, second] {
                    assert!(matches!(
                        result,
                        Err(ServiceError::Forge(ForgeError::Deferred { .. }))
                    ));
                }
                assert!(service.forge_until.load(Ordering::Relaxed) > now_ms());
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn external_merge_at_the_refused_head_requires_verified_source_acceptance() {
        for merged_during_readback in [false, true] {
            let (_home, mut service) = fixture(GitHub::new("unused-fixture").unwrap());
            let head = service.fixture().start.clone();
            let (task, _) = code_task_at_merge("worker", &head);
            service
                .state
                .lock()
                .await
                .store
                .create(&task, &event("fixture"))
                .unwrap();

            let merged = Arc::new(AtomicBool::new(false));
            let published = Arc::new(AtomicBool::new(false));
            let puts = Arc::new(AtomicUsize::new(0));
            let (read_merge, write_merge) = (merged.clone(), merged.clone());
            let (read_base, writes) = (published.clone(), puts.clone());
            let checks = forge_checks(&head);
            let mut pull = forge_pull(&head);
            pull["head"]["ref"] = json!("ns-worker");
            let path = format!("/repos/{REPOSITORY}/pulls/1");
            let commit = "f".repeat(40);
            let tip = "b".repeat(40);
            let comparison = format!("/repos/{REPOSITORY}/compare/{commit}...{tip}");
            let app = Router::new()
                .route(&path, get(move || async move {
                    let mut pull = pull;
                    if read_merge.load(Ordering::Relaxed) {
                        pull["merged"] = json!(true);
                        pull["state"] = json!("closed");
                        pull["merge_commit_sha"] = json!(commit);
                    }
                    Json(pull)
                }))
                .route("/graphql", post(move || async move { Json(checks) }))
                .route(&format!("{path}/merge"), put(move || async move {
                    writes.fetch_add(1, Ordering::Relaxed);
                    write_merge.store(merged_during_readback, Ordering::Relaxed);
                    StatusCode::CONFLICT
                }))
                .route(&format!("/repos/{REPOSITORY}/branches/main"), get(move || async move {
                    Json(json!({"name":"main", "commit":{"sha":tip}}))
                }))
                .route(&comparison, get(move || async move {
                    Json(json!({"status": if read_base.load(Ordering::Relaxed) { "ahead" } else { "diverged" }}))
                }));
            let (forge, server) = serve_forge(app).await;
            service.forge = forge;
            let host = service.host.fixture_pass();
            let approved = service.task("worker").await.unwrap();
            assert!(matches!(
                Box::pin(service.advance(&approved, &host)).await,
                Ok(Action::Wait(WaitReason::ForgeUnknown))
                    | Err(ServiceError::Forge(ForgeError::UnpublishedMerge))
            ));
            let refused = service.task("worker").await.unwrap();
            assert!(refused.task.verdict().is_none());
            assert!(refused.task.question().is_none());

            merged.store(true, Ordering::Relaxed);
            assert!(matches!(
                Box::pin(service.advance(&refused, &host)).await,
                Err(ServiceError::Forge(ForgeError::UnpublishedMerge))
            ));
            assert!(
                service
                    .task("worker")
                    .await
                    .unwrap()
                    .task
                    .question()
                    .is_none()
            );
            published.store(true, Ordering::Relaxed);
            let question = Action::Ask(nucleus_core::Question::Accept { head });
            assert_eq!(
                Box::pin(service.advance(&refused, &host)).await.unwrap(),
                question
            );
            let asked = service.task("worker").await.unwrap();
            assert!(asked.task.verdict().is_none());
            assert!(asked.task.question().is_some());
            assert_eq!(puts.load(Ordering::Relaxed), 1);
            server.abort();
        }
    }

    #[tokio::test]
    async fn a_forge_outage_defers_other_tasks_without_sending_a_request() {
        let requests = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&requests);
        let (forge, server) = serve_forge(Router::new().route(
            &format!("/repos/{}/pulls/1", crate::tests::REPOSITORY),
            get(move || async move {
                count.fetch_add(1, Ordering::Relaxed);
                StatusCode::SERVICE_UNAVAILABLE
            }),
        ))
        .await;
        let (_home, service) = fixture(forge);
        for id in ["first", "second"] {
            let (reserved, _, _) = reservation(id, Entry::ReviewEntry, &service.fixture().start);
            let task = Task::new(
                reserved.identity().clone(),
                reserved.brief().text.clone(),
                reserved.pull_request().cloned(),
            );
            service
                .state
                .lock()
                .await
                .store
                .create(&task, &event("fixture"))
                .expect("seed");
        }
        let started = tokio::time::Instant::now();
        let outcomes = service.pass().await.expect("process both due tasks");
        assert!(matches!(
            outcomes.as_slice(),
            [
                crate::PassOutcome { task: first, result: Err(ServiceError::Forge(ForgeError::Status(StatusCode::SERVICE_UNAVAILABLE))) },
                crate::PassOutcome { task: second, result: Err(ServiceError::Forge(ForgeError::Deferred { .. })) }
            ] if first == "first" && second == "second"
        ));
        assert_eq!(requests.load(Ordering::Relaxed), 1);
        assert_eq!(service.forge_retry_secs.load(Ordering::Relaxed), 30);
        let state = service.state.lock().await;
        for id in ["first", "second"] {
            assert_eq!(state.wait_reason(id), Some(WaitReason::ForgeUnknown));
            assert!(
                state
                    .schedule
                    .due(id)
                    .is_some_and(|due| { due >= started + Duration::from_secs(30) })
            );
            assert_eq!(
                state
                    .store
                    .row(id)
                    .expect("read unchanged row")
                    .expect("task")
                    .version,
                1
            );
        }
        server.abort();
    }

    #[test]
    fn forge_transport_backoff_is_capped_and_a_success_resets_it() {
        let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
        let failure = ForgeError::Status(StatusCode::BAD_GATEWAY);
        for delay in [30, 60, 120, 240, 240] {
            record_forge_failure(&service, &failure);
            assert_eq!(service.forge_retry_secs.load(Ordering::Relaxed), delay);
        }
        capture_forge(&service, Ok(())).expect("successful response");
        assert_eq!(service.forge_backoff(), Duration::ZERO);
        record_forge_failure(&service, &failure);
        assert_eq!(service.forge_retry_secs.load(Ordering::Relaxed), 30);
    }

    fn merge_fixture(
        head: &Head,
        new_head: &Head,
        status: StatusCode,
        new: &Arc<AtomicBool>,
        puts: &Arc<AtomicUsize>,
    ) -> Router {
        let (before, after) = (forge_pull(head), forge_pull(new_head));
        let (old_checks, new_checks) = (forge_checks(head), forge_checks(new_head));
        let (change, changed) = (Arc::clone(new), Arc::clone(new));
        let (count, sent) = (Arc::clone(puts), Arc::clone(puts));
        let pull = format!("/repos/{}/pulls/1", crate::tests::REPOSITORY);
        Router::new()
            .route(
                &pull,
                get(move || async move {
                    if status == StatusCode::METHOD_NOT_ALLOWED && sent.load(Ordering::Relaxed) > 0
                    {
                        return (StatusCode::TOO_MANY_REQUESTS, [(RETRY_AFTER, "60")])
                            .into_response();
                    }
                    Json(if change.load(Ordering::Relaxed) {
                        after
                    } else {
                        before
                    })
                    .into_response()
                }),
            )
            .route(
                "/graphql",
                post(move || async move {
                    Json(if changed.load(Ordering::Relaxed) {
                        new_checks
                    } else {
                        old_checks
                    })
                }),
            )
            .route(
                &format!("{pull}/merge"),
                put(move || async move {
                    count.fetch_add(1, Ordering::Relaxed);
                    status
                }),
            )
    }

    #[tokio::test]
    async fn prepared_and_revoked_reviews_recheck_the_actual_forge_and_checkout() {
        for (revoked, changed_head, dirty, allowed) in [
            (false, false, true, false),
            (true, false, true, false),
            (true, false, false, true),
            (true, true, true, true),
        ] {
            let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
            let head = service.fixture().start.clone();
            let latest = if changed_head {
                "b".repeat(40).parse().expect("new head")
            } else {
                head.clone()
            };
            let (forge, reads, server) = forge_fixture(&latest).await;
            service.forge = forge;
            let worktrees = service.worktrees();
            let checkout = worktrees
                .checkout(
                    &service.fixture().checkout,
                    &service.fixture().repository,
                    "reviewer",
                )
                .expect("checkout");
            assert_eq!(
                checkout.allocate(&head).expect("allocate"),
                Workspace::Clean(head.clone())
            );
            let (mut task, _, mut cached) = reservation("reviewer", Entry::ReviewEntry, &head);
            let instance = task.run().expect("run").launch().instance.clone();
            if revoked {
                task.record_send(&instance, 1).expect("prior delivery");
                task.command(
                    Command::Cancel,
                    &Authority::Operator {
                        actor: "fixture".into(),
                    },
                    &cached,
                )
                .expect("revoke");
            } else {
                cached.host = Observed::Known(Host::Current {
                    instance,
                    state: RunState::ReadyToSend,
                });
            }
            if dirty {
                std::fs::write(checkout.path().join("local-edit.txt"), "local changes")
                    .expect("edit after observation");
            }
            let host = Due(std::sync::atomic::AtomicUsize::new(0), None);
            service
                .state
                .lock()
                .await
                .store
                .create(&task, &event("fixture"))
                .expect("fixture row");
            let row = service
                .task(&task.identity().id)
                .await
                .expect("fixture version");
            let result = if revoked {
                Box::pin(service.stop_run(&row, &checkout, cached, &host)).await
            } else {
                service.send_prepared(&row, &checkout, cached, &host).await
            };
            assert_eq!(reads.load(Ordering::Relaxed), 1, "fresh forge read");
            assert_eq!(host.0.load(Ordering::Relaxed), usize::from(allowed));
            if allowed {
                assert!(matches!(
                    result,
                    Err(ServiceError::Host(nucleus_hosts::HostError::Uncertain))
                ));
            } else if revoked {
                assert_eq!(
                    result.expect("dirty current head waits"),
                    Action::Wait(WaitReason::Stopping)
                );
            } else {
                assert_eq!(
                    result.expect("discard unsent review"),
                    Action::Advance(Phase::Reviewing)
                );
                let row = service.task("reviewer").await.expect("cleared reservation");
                assert!(row.task.run().is_none());
                assert_eq!(row.task.attempts(), 0);
            }
            server.abort();
        }
    }

    #[test]
    fn exact_review_replay_needs_cleanliness_and_superseded_replay_archives() {
        let old: Head = "a".repeat(40).parse().expect("old head");
        let new: Head = "b".repeat(40).parse().expect("new head");
        let open = |head: Head| {
            Observed::Known(Forge::Open {
                pr: PullRequest {
                    url: "https://github.com/example/fixture/pull/1".into(),
                    head,
                },
                checks: CheckState::Ready,
            })
        };
        let mut observation = Observation {
            host: Observed::Unknown,
            workspace: Observed::Unknown,
            forge: Observed::Unknown,
        };
        assert_eq!(replay_policy(Some(&old), &observation), None);
        observation.forge = open(old.clone());
        observation.workspace = Observed::Known(Workspace::Dirty);
        assert_eq!(replay_policy(Some(&old), &observation), None);
        observation.workspace = Observed::Known(Workspace::Clean(old.clone()));
        assert_eq!(replay_policy(Some(&old), &observation), Some(false));
        observation.forge = open(new);
        observation.workspace = Observed::Known(Workspace::Dirty);
        assert_eq!(replay_policy(Some(&old), &observation), Some(true));
    }

    #[tokio::test]
    async fn merge_gate_uses_only_github_required_checks() {
        let (_home, mut service) = fixture(GitHub::new("unused-fixture").unwrap());
        let project = service.fixture().clone();
        let head = project.start.clone();

        let (task, _) = code_task_at_merge("worker", &head);
        {
            let worktrees = service.worktrees();
            worktrees
                .checkout(&project.checkout, REPOSITORY, "worker")
                .unwrap()
                .allocate(&head)
                .unwrap();
        }
        let mut pull = forge_pull(&head);
        pull["head"]["ref"] = json!("ns-worker");

        let check = |name, conclusion, required| json!({"__typename":"CheckRun","name":name,"conclusion":conclusion,"isRequired":required});
        let rollup = |state, has_next, nodes| json!({"state":state,"contexts":{"pageInfo":{"hasNextPage":has_next,"endCursor":null},"nodes":nodes}});
        let cases = [
            (
                "BLOCKED",
                rollup("FAILURE", false, json!([check("CI", "FAILURE", true)])),
                CheckState::FailedRequired(vec!["CI".into()]),
            ),
            (
                "UNSTABLE",
                rollup(
                    "FAILURE",
                    false,
                    json!([
                        check("CI", "SUCCESS", true),
                        check("optional-lint", "FAILURE", false)
                    ]),
                ),
                CheckState::Ready,
            ),
            (
                "CLEAN",
                rollup("SUCCESS", true, json!([])),
                CheckState::Unknown,
            ),
        ];
        for (merge_state, rollup, expected) in cases {
            let mut reply = forge_checks(&head);
            let pr = &mut reply["data"]["repository"]["pullRequest"];
            pr["mergeStateStatus"] = json!(merge_state);
            pr["statusCheckRollup"] = rollup;
            let pr_wire = pull.clone();
            let (forge, server) = serve_forge(
                Router::new()
                    .route(
                        &format!("/repos/{REPOSITORY}/pulls/1"),
                        get(move || async move { Json(pr_wire) }),
                    )
                    .route("/graphql", post(move || async move { Json(reply) })),
            )
            .await;
            service.forge = forge;
            let (observed, _) = {
                let worktrees = service.worktrees();
                let checkout = worktrees
                    .checkout(&project.checkout, REPOSITORY, "worker")
                    .unwrap();
                service.read_forge(&task, &checkout).await.unwrap()
            };
            assert!(
                matches!(observed, Forge::Open { checks, .. } if checks == expected),
                "expected {expected:?} for {merge_state}"
            );
            server.abort();
        }
    }
}
