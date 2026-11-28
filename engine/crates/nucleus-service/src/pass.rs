use std::{
    ops::ControlFlow,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{
    Action, CallbackCredential, CheckState, CloseWorkspace, Forge, Head, Host, Launch,
    LaunchInputs, Observation, Observed, Phase, Report, Role, Run, RunState, Task, Verdict,
    WaitReason, Workspace, decide,
};
use nucleus_forge::{Branches, ForgeError, MergeWrite, PullTarget};
use nucleus_hosts::{
    Binding, ControlDispatch, DoneArchive, FrozenParentWrite, HoldCheckpoint, HostError,
    LaunchRequest, NoticeAuthorization, ParentRun, ParentShell, ParentTurn, QuietCheckout,
    SendOutcome, StopProgress, T3, TaskHost, launch_diagnostic,
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

const SHORT_HOLD_MS: u64 = 1_000;
const HOLD_BACKOFF_BASE_MS: u64 = 3_000;
const HOLD_BACKOFF_CAP_MS: u64 = 5 * 60_000;

enum HoldAction {
    Wait,
    Replay,
    Replace(u8),
}

fn next_parent_hold(
    turn: &ParentTurn,
    prior: Option<&ParentDelivery>,
    checkpoint: Option<&HoldCheckpoint>,
    now: u64,
) -> Result<HoldAction, ServiceError> {
    if turn.busy {
        return Ok(HoldAction::Wait);
    }
    let Some(prior) = prior else {
        return Ok(if turn.queued {
            HoldAction::Wait
        } else {
            HoldAction::Replace(0)
        });
    };
    if let Some(checkpoint) = checkpoint
        && turn.latest_run != checkpoint.after_run
        && let Some(end) = turn
            .finished_ms
            .filter(|&end| end >= checkpoint.recorded_at_ms)
    {
        if turn
            .duration_ms
            .is_none_or(|duration| duration >= SHORT_HOLD_MS)
        {
            return Ok(HoldAction::Replace(0));
        }
        let count = checkpoint.short_turns.saturating_add(1);
        let delay =
            (HOLD_BACKOFF_BASE_MS << count.saturating_sub(1).min(7)).min(HOLD_BACKOFF_CAP_MS);
        let remaining = end.saturating_add(delay).saturating_sub(now);
        if remaining > 0 {
            return Err(ServiceError::ParentHoldBackoff {
                until: tokio::time::Instant::now() + std::time::Duration::from_millis(remaining),
            });
        }
        return Ok(HoldAction::Replace(count));
    }
    if prior.result == ParentResult::Pending {
        crate::acp::parent_due(prior)?;
        return Ok(HoldAction::Replay);
    }
    if crate::acp::ms(now) < prior.due_ms {
        return Err(crate::acp::parent_delivery_retry(
            HostError::Uncertain,
            prior.due_ms,
        ));
    }
    // A visible queued run can already have a new ID. It has no start time.
    // Only an accepted command with an expired start deadline can advance here.
    Ok(HoldAction::Replace(0))
}

fn parent_hold_write(
    binding: &Binding,
    provider: &str,
    title: &str,
    prompt: &str,
    shell: ParentShell,
    prior: Option<&ParentDelivery>,
    preparing_launch: bool,
) -> Result<Option<nucleus_hosts::ParentWrite>, ServiceError> {
    let frozen = prior.map(crate::acp::frozen_parent).transpose()?;
    let checkpoint = frozen.as_ref().and_then(FrozenParentWrite::checkpoint);
    let empty = ParentTurn::default();
    let turn = match &shell {
        ParentShell::Listed(turn) => turn,
        _ => &empty,
    };
    let now = now_ms();
    let planned = |short_turns| HoldCheckpoint {
        after_run: turn.latest_run.clone(),
        recorded_at_ms: now,
        short_turns,
        preparing_launch,
    };
    let (replace, checkpoint) = match next_parent_hold(turn, prior, checkpoint, now)? {
        HoldAction::Wait => return Ok(None),
        HoldAction::Replay => (false, checkpoint.cloned().unwrap_or_else(|| planned(0))),
        HoldAction::Replace(short_turns) => (true, planned(short_turns)),
    };
    Ok(T3::prepare_parent_hold(
        binding,
        provider,
        title,
        prompt,
        shell,
        prior.map(|record| (record.command.as_str(), replace)),
        checkpoint,
    ))
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
        self.scratch_job(
            "terminal process sweep",
            "finding run scratch",
            move |root, _| {
                let found = find_run_scratch(root.path(), &task);
                // Absence counts only while the root it was read under is still there.
                root.verify().map_err(WorkError::from)?;
                Ok(found)
            },
        )
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
                    self.state
                        .try_lock()
                        .is_ok_and(|state| state.dispatch_mode() == DispatchMode::Running)
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
                    .retire_if_idle(task, &binding, &checkout, None)
                    .await
                    .map_err(checkout_retirement_wait)?
                    == Retirement::Deferred
            {
                return Err(ServiceError::CheckoutRetained(
                    "Waiting for running Dispatch before removing the checkout.".into(),
                ));
            }
            return Ok(Action::Nothing);
        }
        self.sweep_terminal_processes(host, task, &binding, &checkout)
            .await;
        let head = self
            .archive_retirement_head(row, &route, &checkout, &workspace)
            .await?;
        let retained = || {
            ServiceError::CheckoutRetained(
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
                return Err(ServiceError::CheckoutRetained(
                    "The merged pull request does not confirm the retained checkout's recorded head.".into(),
                ));
            }
        }
        match self
            .retire_if_idle(task, &binding, &checkout, Some(&head))
            .await
            .map_err(checkout_retirement_wait)?
        {
            Retirement::Retained if task.report_task().is_some() => Err(
                ServiceError::ReportCheckout("the checkout changed after publication was proved"),
            ),
            Retirement::Retained => Err(retained()),
            Retirement::Deferred => Err(ServiceError::CheckoutRetained(
                "Waiting for running Dispatch before removing the checkout.".into(),
            )),
            Retirement::Removed | Retirement::Absent => Ok(Action::Nothing),
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

    pub(super) fn prepare_terminal_archive(
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
            let (state, error, limit) = self.read_current_run(row, run, host).await?;
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
    ) -> Result<(Observed<Host>, Option<HostError>, Option<serde_json::Value>), ServiceError> {
        let _step = Step::enter("observing the T3 run");
        let mut limited = None;
        let mut limit_fact = None;
        let (state, activity, error) = match host.observe_run(run, now_ms()).await {
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
                (Observed::Known(seen.host), seen.activity, None)
            }
            Err(error) => {
                if run.last_send_at_ms().is_none() {
                    service_log!(
                        "{}: before reading T3 launch state for {}: {error}",
                        run.launch().instance,
                        launch_diagnostic(run)
                    );
                }
                (Observed::Unknown, None, Some(error))
            }
        };
        self.observe_role_state(row, &state).await?;
        self.observe_activity(row, activity).await?;
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
        let branches = task_branches(task, checkout)?;
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
        Ok(self
            .fetch_registered(checkout, move |checkout| {
                checkout.published_start(&base, &landings)
            })
            .await?)
    }

    /// Run a fetch in the registered repository, one at a time: concurrent
    /// moves of one tracking ref fail.
    pub(super) async fn fetch_registered(
        &self,
        checkout: &Checkout<'_>,
        operation: impl FnOnce(&Checkout<'_>) -> Result<Head, WorkError> + Send + 'static,
    ) -> Result<Head, WorkError> {
        let fetch = checkout.job(
            self.git.clone(),
            Redactor::new([], RedactionRules::common()),
            operation,
        );
        // The fetch moves a ref every task of the repository reads, so a fetch
        // still running holds back all of them.
        let repository = checkout.repository().to_string_lossy();
        let _one = self.merges.fetching.lock().await;
        self.volume
            .run(
                &repository,
                "fetching the published base",
                Limit::Check,
                fetch,
            )
            .await?
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
        let description = self.revision_description(task, checkout, role, pr).await;
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
            pr_description: description.as_deref(),
            discovered_skill,
            model: &profile.model,
            shared_model: selection.and_then(|selected| selected.intent.shared_model()),
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
            .prepare_run_parent(row, checkout, &binding, continuing_worker)
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

    pub(super) async fn reconcile_live_parent(&self, row: &TaskRow) -> Result<(), ServiceError> {
        let Some(provider) = self.acp_provider() else {
            return Ok(());
        };
        let task = &row.task;
        let identity = task.identity();
        let path = nucleus_work::checkout_path(
            self.storage.work().path(),
            &identity.repository,
            &identity.id,
        );
        if !self.host.projects_synchronized()
            || !crate::acp::wants_parent_hold(
                row,
                self.dispatch_mode().await,
                false,
                self.active_parent_role(task, &path),
                now_ms(),
            )
        {
            return Ok(());
        }

        let _fence = self.effect(row).await?;
        let route = self.project_for(identity).await?;
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, &identity.id)?;
        let binding = self.checkout_binding(identity, &route, &checkout)?;
        self.reconcile_parent_hold(row, &checkout, &binding, provider, false)
            .await?;
        Ok(())
    }

    async fn prepare_run_parent(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        binding: &Binding,
        continuing_worker: bool,
    ) -> Result<ControlFlow<WaitReason, Option<ParentRun>>, ServiceError> {
        let Some(provider) = self.acp_provider().filter(|_| !continuing_worker) else {
            return Ok(ControlFlow::Continue(None));
        };
        if !self.launch_capacity(row.task.identity(), false).await? {
            return Ok(ControlFlow::Break(WaitReason::Capacity));
        }
        match self
            .reconcile_parent_hold(row, checkout, binding, provider, true)
            .await?
        {
            Some(parent) => Ok(ControlFlow::Continue(Some(parent))),
            None => Ok(ControlFlow::Break(WaitReason::Starting)),
        }
    }

    async fn reconcile_parent_hold(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        binding: &Binding,
        provider: &str,
        preparing_launch: bool,
    ) -> Result<Option<ParentRun>, ServiceError> {
        let task = &row.task;
        let id = &task.identity().id;
        let now = now_ms();
        let (prior, prompt) = {
            let state = self.state.lock().await;
            if !crate::acp::wants_parent_hold(
                row,
                state.dispatch_mode(),
                preparing_launch && state.dispatch_mode().allows_launch(task.first_launch()),
                self.active_parent_role(task, checkout.path()),
                now,
            ) {
                return Ok(None);
            }
            (
                state.store.current_parent_hold(id)?,
                crate::presentation::role_start_line(task, &state.store),
            )
        };
        let shell = self
            .host
            .parent_shell(binding, provider)
            .map_err(|error| self.parent_not_sent(error))?;
        if let ParentShell::Listed(turn) = &shell
            && turn.busy
            && preparing_launch
            && let Some(prior) = &prior
        {
            return self
                .live_parent_for_launch(row, binding, provider, prior)
                .await;
        }
        if matches!(shell, ParentShell::Deleted) {
            return Ok(None);
        }
        let launch = format!("{}-launch", nucleus_hosts::parent_thread(checkout.path()));
        let missing_dispatch = matches!(shell, ParentShell::Missing)
            && prior
                .as_ref()
                .is_some_and(|record| !record.command.starts_with(&launch));
        let missing_after_start_deadline = matches!(shell, ParentShell::Missing)
            && prior.as_ref().is_some_and(|record| {
                record.result == ParentResult::Accepted && record.due_ms <= crate::acp::ms(now)
            });
        if matches!(shell, ParentShell::Archived)
            || missing_dispatch
            || missing_after_start_deadline
        {
            if let Some(write) = self
                .host
                .prepare_parent_unarchive(binding, provider)
                .await?
            {
                self.send_run_parent(row, checkout, write, None).await?;
                return Ok(None);
            }
            if !missing_after_start_deadline || missing_dispatch {
                return Ok(None);
            }
        }
        if let Some(write) = parent_hold_write(
            binding,
            provider,
            &task.identity().reference,
            &prompt,
            shell,
            prior.as_ref(),
            preparing_launch,
        )? {
            if write.creates_thread() {
                self.host.check_parent_provider(provider).await?;
            }
            self.send_run_parent(row, checkout, write, prior).await?;
        }
        Ok(None)
    }

    async fn live_parent_for_launch(
        &self,
        row: &TaskRow,
        binding: &Binding,
        provider: &str,
        prior: &ParentDelivery,
    ) -> Result<Option<ParentRun>, ServiceError> {
        let parent = self
            .host
            .live_parent(binding, provider, &prior.command)
            .await?;
        if parent.is_some() && prior.result == ParentResult::Pending {
            let deadline = now_ms().saturating_add(crate::acp::PARENT_START_TIMEOUT_MS);
            self.finish_parent_delivery(
                row,
                prior,
                ParentResult::Accepted,
                crate::acp::ms(deadline),
            )
            .await?;
        }
        Ok(parent)
    }

    async fn send_run_parent(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        write: nucleus_hosts::ParentWrite,
        prior: Option<ParentDelivery>,
    ) -> Result<(), ServiceError> {
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
            return Err(self.parent_not_sent(HostError::Uncertain));
        };
        self.ensure_parent_reader(&row.task.identity().id, checkout.path())
            .await?;
        self.deliver_parent(row, write, prior).await?;
        self.recheck_effect(row, WaitReason::HostUnknown).await;
        Ok(())
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
        let project = &route.project_id;
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
        if let Some(selected) = selection {
            let intent = &selected.intent;
            if let Some(ceiling) = intent.step_up_from() {
                detail.insert(
                    "profileStepUp".into(),
                    serde_json::json!({
                        "ordinaryCeiling": ceiling,
                        "selectedCapability": intent.profile().capability,
                        "reason": "Every eligible profile within the ordinary ceiling is paused."
                    }),
                );
            }
            if let Some(worker) = intent.critical_fallback_worker() {
                let receipt = CriticalReviewFallback {
                    at_ms: run.launch().started_at,
                    run_instance: run.launch().instance.clone(),
                    worker_profile_id: worker.into(),
                    reviewer_profile_id: intent.profile().id.clone(),
                    reason: "The selected reviewer is below the worker's capability bracket."
                        .into(),
                };
                detail.insert("criticalReviewFallback".into(), serde_json::json!(receipt));
            }
            if let Some(message) = intent.shared_model() {
                detail.insert(
                    "sharedModel".into(),
                    serde_json::json!({
                        "runInstance": intent.instance(),
                        "message": message
                    }),
                );
            }
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

    async fn revision_description(
        &self,
        task: &Task,
        checkout: &Checkout<'_>,
        role: Role,
        pr: Option<&nucleus_core::PullRequest>,
    ) -> Option<String> {
        let pr = pr.filter(|_| role == Role::Reviewer)?;
        if !matches!(task.verdict(), Some(Verdict::Reviewed { head, decision: nucleus_core::Review::Changes, .. }) if *head == pr.head)
        {
            return None;
        }
        self.check_forge_ready().ok()?;
        let target = task_branches(task, checkout).ok()?.target(&pr.url).ok()?;
        // The reviewer can fetch the body directly if it cannot travel in the assignment.
        capture_forge(self, self.forge.open_description(&target, &pr.head).await)
            .ok()?
            .filter(|body| body.len() <= 4_096)
            .map(|body| crate::presentation::excerpt(&body, usize::MAX))
    }

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
            let dispatch = authorization.record(&mut task)?;
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
        let mut journal = self.delivery_snooze_journal(Some(&task.identity().id));
        let result = host.send(dispatch, |update| journal.record(update)).await;
        journal.settle().await;
        let result = match result? {
            SendOutcome::NotSent(error) => {
                let mut audit = event("host_send_not_sent");
                audit.detail = serde_json::json!({"command":run.launch().instance}).to_string();
                self.save(&sent, row.task.clone(), &audit).await?;
                return Err(error.into());
            }
            outcome => outcome,
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

    async fn check_planner_notice_route(
        &self,
        identity: &nucleus_core::Identity,
        route: &ProjectRoute,
        authorization: &NoticeAuthorization,
    ) -> Result<(), ServiceError> {
        let target = authorization.target();
        self.host.check_notice_target(authorization)?;
        let root = if self.project.is_some() {
            (target.project_id == route.host_project).then(|| route.checkout.clone())
        } else if identity.origin_thread.as_deref() == Some(&target.thread) {
            // The task's origin is an exact thread address, even in a scratch folder.
            return Ok(());
        } else {
            let state = self.state.lock().await;
            state
                .live_planner_route(&target.thread)
                .filter(|(id, repo)| {
                    *id == route.project_id
                        && repo.host_project.as_deref() == Some(target.project_id.as_str())
                        && state
                            .enrolled_planners
                            .get(&target.thread)
                            .is_some_and(|proof| authorization.matches_planner(&proof.identity))
                        && self
                            .host
                            .cached_project(&target.project_id)
                            .is_ok_and(|project| Path::new(&project.root) == repo.path)
                })
                .map(|(_, repo)| repo.path.clone())
        }
        .ok_or(HostError::Binding)?;
        if target.project_id != route.host_project {
            self.host
                .check_project(
                    &target.project_id,
                    root.to_str().ok_or(ServiceError::Project)?,
                )
                .await?;
        }
        if let Some(path) = &target.worktree_path
            && !self
                .verify_linked_checkout(&identity.id, root, PathBuf::from(path))
                .await?
        {
            return Err(HostError::Binding.into());
        }
        Ok(())
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
                        if identity.entry == nucleus_core::Entry::ReviewEntry
                            && (task.review_author().is_none()
                                || !matches!(self.read_forge(task, checkout).await?.0,
                                    Forge::Open { pr, .. } if task.pull_request() == Some(&pr)))
                        {
                            return Ok(None);
                        }
                        (self.observe_checkout(checkout).await? != Workspace::Absent)
                            .then_some(false)
                    }
                } else {
                    (self.observe_checkout(checkout).await? != Workspace::Absent).then_some(false)
                }
            }
            DispatchTarget::Planner(authorization) => {
                self.check_planner_notice_route(identity, &route, authorization)
                    .await?;
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
    pub(super) async fn require_unchanged(&self, task: &Task) -> Result<(), ServiceError> {
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
        if self.dispatch_mode().await == DispatchMode::Stopped {
            return Err(ServiceError::MergeDispatchStopped);
        }
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
        self.scratch_job(
            "terminal process sweep",
            "finding run scratch",
            move |root, _| {
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
            },
        )
        .await
    }

    // Claim the sweep once, while Dispatch and the held shell permit signalling.
    async fn sweep_terminal_processes(
        &self,
        host: &impl TaskHost,
        task: &Task,
        binding: &Binding,
        checkout: &Checkout<'_>,
    ) {
        let id = &task.identity().id;
        let sweep = async {
            if self.dispatch_mode().await != DispatchMode::Running {
                return Ok(());
            }
            let Ok(quiet) = self.host.prepare_quiet_checkout(binding, task).await else {
                return Ok(());
            };
            let mut state = self.state.lock().await;
            if state.dispatch_mode() != DispatchMode::Running
                || quiet.with_quiet_shell(|| ()).is_err()
            {
                return Ok(());
            }
            let mut claim = event("checkout_process_sweep");
            if let Some((instance, _)) = task.settled_scratch() {
                claim.detail = instance;
            }
            if state.store.claim_task_effect(id, &claim, false)?.is_none() {
                return Ok(());
            }
            drop(state);
            self.stop_checkout_processes(host, task, checkout, &quiet)
                .await
        };
        let error = match tokio::time::timeout(Duration::from_secs(20), sweep).await {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error.to_string(),
            Err(_) => "Process cleanup timed out.".into(),
        };
        self.record_process_result(id, "checkout_process_sweep_failed", &error)
            .await;
    }

    async fn stop_checkout_processes(
        &self,
        host: &impl TaskHost,
        task: &Task,
        checkout: &Checkout<'_>,
        quiet: &QuietCheckout,
    ) -> Result<(), ServiceError> {
        let scratch = self.storage.scratch().path();
        let roots = self.retirement_roots(task, checkout).await?;
        let id = &task.identity().id;
        let mut targets = Vec::new();
        let mut retained = Vec::new();
        for root in &roots {
            match host.terminal_orphans(root, scratch).await {
                Ok(scan) => {
                    targets.extend(scan.targets);
                    retained.extend(scan.retained);
                }
                Err(error) => {
                    self.record_process_result(
                        id,
                        "checkout_process_sweep_failed",
                        &error.to_string(),
                    )
                    .await;
                }
            }
        }
        if !retained.is_empty() {
            self.record_process_result(
                id,
                "checkout_process_retained",
                &serde_json::json!({"processes":retained}).to_string(),
            )
            .await;
        }
        match host.terminal_helpers(&roots, scratch).await {
            Ok(helpers) => targets.extend(helpers),
            Err(error) => {
                self.record_process_result(id, "checkout_process_sweep_failed", &error.to_string())
                    .await;
            }
        }
        for force in [false, true] {
            if targets.is_empty() {
                break;
            }
            if force {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            let signal = if force { "SIGKILL" } else { "SIGTERM" };
            let mut intent = event("checkout_process_stop");
            intent.detail = serde_json::json!({"signal":signal,"processes":targets}).to_string();
            {
                let mut state = self.state.lock().await;
                if state.dispatch_mode() != DispatchMode::Running {
                    break;
                }
                quiet.with_quiet_shell(|| ())?;
                state.store.claim_task_effect(id, &intent, false)?;
            }
            targets = nucleus_hosts::verify_orphans(&targets, &roots, scratch, force).await?;
            if targets.is_empty() {
                break;
            }
            // Skip a contended signal rather than age the process identity evidence.
            let mut state = self.state.try_lock().map_err(|_| HostError::Uncertain)?;
            if state.dispatch_mode() != DispatchMode::Running {
                break;
            }
            let results = quiet.with_quiet_shell(|| {
                let mut results = Vec::new();
                targets.retain(|process| {
                    let result = process.signal(force);
                    let outcome = match &result {
                        Ok(true) => "sent".to_owned(),
                        Ok(false) => "exited".to_owned(),
                        Err(error) => error.to_string(),
                    };
                    results.push(serde_json::json!({"process":process,"outcome":outcome}));
                    matches!(result, Ok(true))
                });
                results
            })?;
            let mut outcome = event("checkout_process_result");
            outcome.detail = serde_json::json!({"signal":signal,"results":results}).to_string();
            state.store.claim_task_effect(id, &outcome, false)?;
        }
        Ok(())
    }

    async fn record_process_result(&self, task: &str, kind: &str, detail: &str) {
        let mut audit = event(kind);
        audit.detail = detail.into();
        if let Err(error) = self
            .state
            .lock()
            .await
            .store
            .claim_task_effect(task, &audit, false)
        {
            service_log!("{task}: recording terminal process cleanup: {error}");
        }
    }

    // Both callers hold the current task and project fences through Git retirement.
    async fn retire_if_idle(
        &self,
        task: &Task,
        binding: &Binding,
        checkout: &Checkout<'_>,
        head: Option<&Head>,
    ) -> Result<Retirement, ServiceError> {
        let initial = if head.is_some() {
            self.observe_checkout_for_retirement(checkout).await?
        } else {
            Workspace::Absent
        };
        if self.dispatch_mode().await != DispatchMode::Running {
            return Ok(Retirement::Deferred);
        }
        let quiet = self.host.prepare_quiet_checkout(binding, task).await?;
        let state = self.state.clone();
        let head = head.cloned();
        let (outcome, host_error) = self
            .checkout_job(
                checkout,
                "removing the task checkout",
                Limit::Change,
                move |checkout| {
                    let mut host_error = None;
                    let outcome =
                        checkout.finish_retirement_guarded(initial, head.as_ref(), |step| {
                            let Ok(state) = state.try_lock() else {
                                return Ok(false);
                            };
                            if state.dispatch_mode() != DispatchMode::Running {
                                return Ok(false);
                            }
                            match quiet.with_quiet_shell(step) {
                                Ok(result) => result.map(|()| true),
                                Err(error) => {
                                    host_error = Some(error);
                                    Ok(false)
                                }
                            }
                        })?;
                    Ok((outcome, host_error))
                },
            )
            .await?;
        if outcome == Retirement::Removed {
            self.trash_wake.notify_one();
        }
        if let Some(error) = host_error {
            return Err(error.into());
        }
        Ok(outcome)
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
            self.sweep_terminal_processes(host, task, binding, checkout)
                .await;
            if self
                .retire_if_idle(task, binding, checkout, Some(head))
                .await?
                == Retirement::Deferred
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
            if self.retire_if_idle(task, binding, checkout, None).await? == Retirement::Deferred {
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

fn task_branches(task: &Task, checkout: &Checkout<'_>) -> Result<Branches, ForgeError> {
    let identity = task.identity();
    if identity.entry == nucleus_core::Entry::ReviewEntry {
        Branches::for_review_entry(&identity.repository, &identity.base)
    } else {
        Branches::new(&identity.repository, &identity.base, checkout.branch())
    }
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

fn checkout_retirement_wait(error: ServiceError) -> ServiceError {
    let cause = match error {
        ServiceError::Host(HostError::RowChildBusy) => {
            "Waiting for T3 to show every task thread is idle."
        }
        ServiceError::Host(HostError::Uncertain) => {
            "Waiting for T3 to confirm the task threads are idle or gone."
        }
        error => return error,
    };
    ServiceError::CheckoutRetained(cause.into())
}

#[cfg(test)]
mod start_tests;

#[cfg(test)]
mod tests;
