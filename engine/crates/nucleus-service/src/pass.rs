use std::{
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use nucleus_core::{
    Action, CallbackCredential, CheckState, CloseWorkspace, Forge, Head, Host, Launch, Observation,
    Observed, Phase, Report, RetainedThread, Role, Run, RunState, Task, WaitReason, Workspace,
    decide,
};
use nucleus_forge::{Branches, ForgeError, MergeWrite, PullTarget};
use nucleus_hosts::{
    ArchiveStep, Binding, ControlDispatch, HostError, LaunchRequest, NoticeTarget, ParentStep,
    SendOutcome, StopProgress, TaskHost,
};
use nucleus_store::TaskRow;
use nucleus_work::Checkout;

use crate::{
    Service, ServiceError, active, event, now_ms, profiles::SelectedLaunch,
    project::linked_checkout, ticket,
};

const MAX_FORGE_RETRY: Duration = Duration::from_mins(4);

pub(super) enum DispatchTarget<'a> {
    Run {
        frozen: &'a Binding,
        checkout: &'a Checkout<'a>,
        launch: bool,
    },
    Archive {
        frozen: &'a Binding,
        checkout: &'a Checkout<'a>,
    },
    Planner(&'a NoticeTarget),
}

impl Service {
    pub(super) async fn archive_done(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let Some(provider) = &self.project.acp_provider else {
            return Ok(Action::Nothing);
        };
        let id = &row.task.identity().id;
        if self.state.lock().await.store.archive_confirmed(id)? {
            return Ok(Action::Nothing);
        }
        let worktrees = self.worktrees()?;
        let checkout = worktrees.checkout(&self.project.checkout, &self.project.repository, id)?;
        let scope = self.binding(&checkout)?;
        let retained: Vec<_> = [Role::Worker, Role::Reviewer]
            .into_iter()
            .filter_map(|role| row.task.threads().get(role))
            .collect();
        let archive = self
            .host
            .prepare_parent_archive(&scope, provider, &retained)
            .await?;
        let _fence = self.effect(row).await?;
        match archive {
            ArchiveStep::Finished => {
                let mut state = self.state.lock().await;
                self.commit(
                    &mut state,
                    row,
                    &row.task,
                    &event("role_threads_archived"),
                    None,
                )?;
                Ok(Action::Nothing)
            }
            ArchiveStep::Wait => Ok(Action::Wait(WaitReason::Stopping)),
            ArchiveStep::Write(write) => {
                if self
                    .dispatch_gate(
                        &row.task,
                        DispatchTarget::Archive {
                            frozen: write.binding(),
                            checkout: &checkout,
                        },
                    )
                    .await?
                    .is_none()
                {
                    return Ok(Action::Wait(WaitReason::WorkspaceUnknown));
                }
                self.host.write_parent(write).await?;
                self.recheck_effect(row, WaitReason::Stopping).await;
                Ok(Action::Wait(WaitReason::Stopping))
            }
        }
    }

    pub(super) async fn advance(
        &self,
        row: &TaskRow,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        self.project.scope(task.identity())?;
        let forge_requested = self
            .state
            .lock()
            .await
            .forge_requested
            .contains(&task.identity().id);
        if !active(task) && !forge_requested {
            return Ok(Action::Nothing);
        }
        let run_host = if let Some(run) = task.run().filter(|run| !run.revoked()) {
            let (state, error) = self.read_current_run(row, run, host).await?;
            if !forge_requested
                && run.last_send_at_ms().is_some()
                && task.question().is_none()
                && let Some(wait) = waiting_on_run(task, &state, error)
            {
                self.observe_commands(row, &Observed::Unknown).await?;
                return wait.map_err(ServiceError::Host);
            }
            Some((state, error))
        } else {
            None
        };
        let worktrees = self.worktrees()?;
        let checkout = worktrees.checkout(
            &self.project.checkout,
            &self.project.repository,
            &task.identity().id,
        )?;
        let (forge, target, forge_error) = match self.read_forge(task, &checkout).await {
            Ok((forge, target)) => (Observed::Known(forge), target, None),
            Err(error) => (Observed::Unknown, None, Some(error)),
        };
        self.observe_commands(row, &forge).await?;
        if !active(task) {
            return forge_error.map_or(Ok(Action::Nothing), |error| Err(error.into()));
        }
        let binding = self.binding(&checkout)?;
        let mut observation = Observation {
            host: Observed::Unknown,
            forge,
            workspace: seen(checkout.observe()),
        };
        if task.run().is_some_and(nucleus_core::Run::revoked) {
            return self.stop_run(row, &checkout, observation, host).await;
        }
        if task.phase() == Phase::Reviewing
            && task.run().is_none()
            && task.question().is_none()
            && task.hold().is_none()
            && observation.workspace == Observed::Known(Workspace::Absent)
            && let Observed::Known(Forge::Open { pr, .. }) = &observation.forge
            && task.pull_request() == Some(pr)
        {
            let _fence = self.effect(row).await?;
            self.project.verify(&self.git)?;
            observation.workspace = seen(checkout.allocate(&pr.head));
        }
        let (host_state, host_error) = match run_host {
            Some(read) => read,
            None => match read_retained(host, task, &binding).await {
                Ok(state) => (state, None),
                Err(error) => (Observed::Unknown, Some(error)),
            },
        };
        observation.host = host_state;

        match decide(task, &observation) {
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
            Action::Merge { head } if let Some(target) = target.as_ref() => {
                self.merge(row, target, observation, &head).await
            }
            Action::Close { workspace, .. } if let Some(target) = target.as_ref() => {
                self.close(row, &checkout, target, workspace, host).await
            }
            Action::Wait(WaitReason::ForgeUnknown) if let Some(error) = forge_error => {
                Err(error.into())
            }
            Action::Wait(_) if forge_requested && let Some(error) = forge_error => {
                Err(error.into())
            }
            action => self.apply(row, &observation, action).await,
        }
    }

    async fn read_current_run(
        &self,
        row: &TaskRow,
        run: &Run,
        host: &impl TaskHost,
    ) -> Result<(Observed<Host>, Option<HostError>), ServiceError> {
        let (state, activity, error) = match host.observe_run(run, now_ms()).await {
            Ok(seen) => (Observed::Known(seen.host), seen.activity, None),
            Err(error) => (Observed::Unknown, None, Some(error)),
        };
        self.observe_activity(row, activity).await?;
        Ok((state, error))
    }

    async fn read_forge(
        &self,
        task: &Task,
        checkout: &Checkout<'_>,
    ) -> Result<(Forge, Option<PullTarget>), ForgeError> {
        let deadline = self.forge_until.load(Ordering::Relaxed);
        if now_ms() < deadline {
            return Err(ForgeError::Deferred {
                until: UNIX_EPOCH + std::time::Duration::from_millis(deadline),
            });
        }
        let required = self
            .state
            .lock()
            .await
            .settings
            .fixture_checks(&self.project);
        let branches = Branches::new(
            &self.project.repository,
            &self.project.base,
            checkout.branch(),
        )?;
        let reported = task.run().and_then(|run| match run.report() {
            Some(Report::Work(pr)) if !run.revoked() => Some(pr),
            _ => None,
        });
        let target = match reported.or_else(|| task.pull_request()) {
            Some(pr) => Some(branches.target(&pr.url)?),
            None if task.phase() == Phase::Queued => None,
            None => capture_forge(self, self.forge.find_open(&branches).await)?,
        };
        match target {
            Some(target) => {
                let target = target.with_required_checks(required);
                let forge = capture_forge(self, self.forge.observe(&target).await)?;
                Ok((forge, Some(target)))
            }
            None => Ok((Forge::Absent, None)),
        }
    }

    fn binding(&self, checkout: &Checkout<'_>) -> Result<Binding, ServiceError> {
        Ok(Binding {
            project_id: self.project.host_project.clone(),
            worktree_path: checkout
                .path()
                .to_str()
                .ok_or(ServiceError::Project)?
                .into(),
            branch: checkout.branch().into(),
        })
    }

    async fn apply(
        &self,
        row: &TaskRow,
        observation: &Observation,
        action: Action,
    ) -> Result<Action, ServiceError> {
        let kind = match &action {
            Action::Advance(_) => "phase_reconciled",
            Action::Revoke => "run_revoked",
            Action::Relaunch(_) => "run_failed",
            Action::Ask(_) => "question_asked",
            _ => return Ok(action),
        };
        let mut updated = row.task.clone();
        let _ = updated.reconcile(observation);
        let mut audit = event(kind);
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
        let task = &row.task;
        let selection = self.select_launch(task, &observation, role, host).await?;
        let via = selection
            .as_ref()
            .map_or(via.clone(), |selected| selected.intent.via().clone());
        if role == Role::Worker && observation.workspace == Observed::Known(Workspace::Absent) {
            self.project.verify(&self.git)?;
            observation.workspace = Observed::Known(checkout.allocate(&self.project.start)?);
        }
        let instance = task.next_launch_instance()?;
        let head = if role == Role::Reviewer {
            match &observation.forge {
                Observed::Known(Forge::Open { pr, .. }) => Some(pr.head.as_str()),
                _ => return Ok(Action::Wait(WaitReason::ForgeUnknown)),
            }
        } else {
            None
        };
        let ticket_path = ticket::path(self.storage.scratch(), &instance);
        if ticket_path.starts_with(checkout.path()) {
            return Err(ServiceError::Ticket);
        }
        let text = ticket::prompt(
            task,
            role,
            head,
            checkout.branch(),
            &self.report_command,
            &ticket_path,
            selection.as_ref().map(|selected| &selected.intent),
        );
        let binding = self.binding(checkout)?;
        let parent = if let Some(provider) = &self.project.acp_provider {
            if !self.launch_capacity(&task.identity().id, false).await? {
                return Ok(Action::Wait(WaitReason::Capacity));
            }
            match self
                .host
                .prepare_parent(
                    &binding,
                    provider,
                    &task.identity().reference,
                    host.profile_catalog(),
                )
                .await?
            {
                ParentStep::Live(parent) => Some(parent),
                ParentStep::Wait => return Ok(Action::Wait(WaitReason::Starting)),
                ParentStep::Write(write) => {
                    self.ensure_parent_reader(&task.identity().id, checkout.path())
                        .await?;
                    if self
                        .dispatch_gate(
                            task,
                            DispatchTarget::Run {
                                frozen: write.binding(),
                                checkout,
                                launch: false,
                            },
                        )
                        .await?
                        .is_none()
                    {
                        return Ok(Action::Wait(WaitReason::WorkspaceUnknown));
                    }
                    self.host.write_parent(write).await?;
                    self.recheck_effect(row, WaitReason::HostUnknown).await;
                    return Ok(Action::Wait(WaitReason::Starting));
                }
            }
        } else {
            None
        };
        let inputs = host.prepare_launch(LaunchRequest {
            binding,
            parent,
            title: format!("{} • {role:?}", task.identity().reference),
            profile: selection
                .as_ref()
                .map_or(self.project.profile(role), |selected| &selected.native),
            via: &via,
            instance: &instance,
            started_at: now_ms(),
            text,
        })?;
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).map_err(|_| ServiceError::Ticket)?;
        let mut updated = task.clone();
        let credential = if let Some(selected) = &selection {
            updated.reserve_profile_launch(&observation, inputs, &seed, selected.intent.clone())?
        } else {
            updated.reserve_launch(&observation, inputs, &seed)?
        };
        self.persist_reservation(row, &updated, &credential, selection.as_ref(), via)
            .await
    }

    async fn persist_reservation(
        &self,
        row: &TaskRow,
        updated: &Task,
        credential: &CallbackCredential,
        selection: Option<&SelectedLaunch>,
        via: Launch,
    ) -> Result<Action, ServiceError> {
        let run = updated.run().ok_or(ServiceError::Input)?;
        self.storage.database().verify()?;
        ticket::prepare(
            self.storage.scratch(),
            updated,
            run,
            credential,
            &format!("http://{}", self.callback),
        )?;
        let saved = {
            let mut state = self.state.lock().await;
            if selection.map_or(state.settings.profiles.is_none(), |selected| {
                selected.is_current(&state)
            }) {
                self.commit(
                    &mut state,
                    row,
                    updated,
                    &event("run_reserved"),
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
            ticket::clear(self.storage.scratch(), run);
        }
        saved
    }

    async fn send_prepared(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        mut observation: Observation,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        let role = task.run().ok_or(ServiceError::Input)?.launch().role;
        if role == Role::Reviewer {
            observation.forge = Observed::Known(self.read_forge(task, checkout).await?.0);
            observation.workspace = seen(checkout.observe());
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
        if !self.launch_capacity(&task.identity().id, false).await? {
            return Ok(Action::Wait(WaitReason::Capacity));
        }
        let Some((sent, result, _)) = self.send(row, checkout, host).await? else {
            return Ok(Action::Wait(WaitReason::HostUnknown));
        };
        if result == SendOutcome::Rejected {
            observation.host = Observed::Known(current(&sent.task, RunState::Rejected)?);
            let next = decide(&sent.task, &observation);
            return self.apply(&sent, &observation, next).await;
        }
        Ok(action)
    }

    async fn send(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        host: &impl TaskHost,
    ) -> Result<Option<(TaskRow, SendOutcome, bool)>, ServiceError> {
        let task = &row.task;
        let authorization = host
            .authorize_send(task.run().ok_or(ServiceError::Input)?)
            .await?;
        let _fence = self.effect(row).await?;
        let target = DispatchTarget::Run {
            frozen: authorization.binding(),
            checkout,
            launch: true,
        };
        let Some(archive) = self.dispatch_gate(task, target).await? else {
            return Ok(None);
        };
        if let Some(unarchive) = authorization.unarchive() {
            host.write_control(unarchive).await?;
            self.recheck_effect(row, WaitReason::HostUnknown).await;
            return Ok(None);
        }
        let mut sent = task.clone();
        let dispatch = authorization.record(&mut sent)?;
        let mut sent = self.save(row, sent, &event("host_send")).await?;
        let result = host.send(dispatch).await?;
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
        Ok(Some((sent, result, archive)))
    }

    pub(super) async fn dispatch_gate(
        &self,
        task: &Task,
        target: DispatchTarget<'_>,
    ) -> Result<Option<bool>, ServiceError> {
        self.project.scope(task.identity())?;
        match &target {
            DispatchTarget::Run {
                frozen, checkout, ..
            }
            | DispatchTarget::Archive { frozen, checkout }
                if **frozen != self.binding(checkout)? =>
            {
                return Err(HostError::Binding.into());
            }
            DispatchTarget::Planner(target) if target.project_id != self.project.host_project => {
                return Err(HostError::Binding.into());
            }
            _ => {}
        }
        self.check_project().await?;
        match target {
            DispatchTarget::Archive { checkout, .. } => {
                if task.phase() != Phase::Done {
                    return Err(HostError::Binding.into());
                }
                // Closeout can have already retired the clean checkout. Still
                // verify its derived destination and pinned worktree root.
                checkout.observe()?;
                Ok(Some(false))
            }
            DispatchTarget::Run {
                checkout, launch, ..
            } => {
                if !launch {
                    return Ok((checkout.observe()? != Workspace::Absent).then_some(false));
                }
                let run = task.run().ok_or(ServiceError::Input)?;
                let Some(head) = run.launch().review_head.as_ref() else {
                    return Ok((checkout.observe()? != Workspace::Absent).then_some(false));
                };
                let forge = Observed::Known(self.read_forge(task, checkout).await?.0);
                let workspace = checkout.observe()?;
                if workspace == Workspace::Absent {
                    return Ok(None);
                }
                let fresh = Observation {
                    forge,
                    workspace: Observed::Known(workspace),
                    host: Observed::Unknown,
                };
                Ok(replay_policy(Some(head), &fresh)
                    .filter(|&superseded| !superseded || run.revoked()))
            }
            DispatchTarget::Planner(target) => {
                self.host.check_notice_target(target).await?;
                if let Some(path) = &target.worktree_path
                    && !linked_checkout(&self.project.checkout, Path::new(path), &self.git)?
                {
                    return Err(HostError::Binding.into());
                }
                Ok(Some(false))
            }
        }
    }

    async fn stop_run(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        mut observation: Observation,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        let run = task.run().ok_or(ServiceError::Input)?;
        let head = run.launch().review_head.as_ref();
        let archive = superseded(head, &observation.forge);
        let stopping = Action::Wait(WaitReason::Stopping);
        let binding = self.binding(checkout)?;
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
                    observation.workspace = seen(checkout.observe());
                }
                if replay_policy(head, &observation).is_none() {
                    return Ok(stopping);
                }
                if !self.launch_capacity(&task.identity().id, true).await? {
                    return Ok(Action::Wait(WaitReason::Capacity));
                }
                let Some((sent, outcome, archive)) = self.send(row, checkout, host).await? else {
                    return Ok(stopping);
                };
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
        if self.dispatch_gate(&row.task, target).await?.is_some() {
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
        let task = &row.task;
        let required = {
            let state = self.state.lock().await;
            if state.settings.fixture_slots(&self.project).is_none() {
                return Ok(Action::Wait(WaitReason::Capacity));
            }
            state.settings.fixture_checks(&self.project)
        };
        let target = target.clone().with_required_checks(required);
        let attempt = self
            .forge
            .merge(task, &target)
            .await
            .inspect_err(|error| record_forge_failure(self, error))?;
        if let MergeWrite::Deferred { until } = attempt.write {
            defer(self, until);
            return Err(ForgeError::Deferred { until }.into());
        }
        let observed = capture_forge(self, attempt.observed);
        if attempt.write == MergeWrite::HeadMismatch {
            let mut updated = task.clone();
            if updated.merge_head_mismatched(head) {
                observation.forge = seen(observed);
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
        let observed = Observed::Known(observed?);
        if attempt.write == MergeWrite::Unknown
            && !matches!(observed, Observed::Known(Forge::Merged { .. }))
        {
            return Ok(Action::Wait(WaitReason::ForgeUnknown));
        }
        observation.forge = observed;
        if let MergeWrite::Refused { .. } = attempt.write
            && let Observed::Known(Forge::Open { checks, .. }) = &mut observation.forge
        {
            *checks = CheckState::Blocked;
        }
        let next = decide(task, &observation);
        if matches!(next, Action::Merge { .. }) {
            return Ok(Action::Wait(WaitReason::ForgeUnknown));
        }
        self.apply(row, &observation, next).await
    }

    async fn close(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        target: &PullTarget,
        workspace: CloseWorkspace,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        let mut observed = Observation {
            host: Observed::Unknown,
            forge: Observed::Known(capture_forge(self, self.forge.observe(target).await)?),
            workspace: seen(checkout.observe()),
        };
        let action = decide(task, &observed);
        if let Action::Close {
            workspace: CloseWorkspace::RemoveClean { head },
            ..
        } = &action
        {
            let binding = self.binding(checkout)?;
            for thread in [Role::Worker, Role::Reviewer]
                .into_iter()
                .filter_map(|role| task.threads().get(role))
            {
                if !matches!(
                    host.observe_retained(&binding, thread).await,
                    Ok(Host::Retained {
                        state: RetainedThread::Idle | RetainedThread::Gone,
                        ..
                    })
                ) {
                    return Ok(Action::Wait(WaitReason::Stopping));
                }
            }
            let _fence = self.effect(row).await?;
            let _ = checkout.retire(head)?;
            observed.workspace = seen(checkout.observe());
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
        self.save(row, updated, &audit).await?;
        Ok(action)
    }
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
            .observe_retained(binding, thread)
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

fn record_forge_failure(service: &Service, error: &ForgeError) {
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
        Due, fixture, forge_checks, forge_fixture, forge_pull, native_fixture, reservation,
        serve_forge,
    };

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
        let worktrees = service.worktrees().expect("worktrees");
        let mut selected = Vec::new();
        for id in ["worker-one", "worker-two"] {
            let mut task = Task::new(
                nucleus_core::Identity {
                    id: id.into(),
                    reference: id.into(),
                    repository: service.project.repository.clone(),
                    base: service.project.base.clone(),
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
                .checkout(&service.project.checkout, &service.project.repository, id)
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
        let head = service.project.start.clone();
        let (forge, forge_reads, forge_server) = forge_fixture(&head).await;
        service.forge = forge;
        let worktrees = service.worktrees().expect("worktrees");
        let checkout = worktrees
            .checkout(
                &service.project.checkout,
                &service.project.repository,
                "reviewer",
            )
            .expect("checkout");
        let (mut task, _) = frozen_review(&service, &checkout, &head);
        let instance = task.run().expect("run").launch().instance.clone();
        task.record_send(&instance, 1).expect("send recorded");
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .expect("seed");
        let binding = service.binding(&checkout).expect("binding");
        let (host, native_server) = native_fixture(move |req| {
            assert_eq!(req["tag"], "orchestration.subscribeThread");
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

        let outcomes = service.pass().await.expect("exact run read");
        assert!(matches!(
            outcomes.as_slice(),
            [crate::PassOutcome {
                result: Ok(Action::Wait(WaitReason::Running)),
                ..
            }]
        ));
        assert_eq!(forge_reads.load(Ordering::Relaxed), 0);
        let due = service
            .state
            .lock()
            .await
            .schedule
            .due("reviewer")
            .expect("backstop");
        assert!(due > tokio::time::Instant::now() + Duration::from_secs(40));
        let authority = Authority::Operator {
            actor: "fixture".into(),
        };
        assert!(matches!(
            service
                .command("reviewer", &authority, Command::Amend("next".into()))
                .await,
            Ok(crate::CommandOutcome::Pending { .. })
        ));
        assert_eq!(forge_reads.load(Ordering::Relaxed), 0);
        let _ = service.pass().await.expect("command evidence wake");
        assert_eq!(forge_reads.load(Ordering::Relaxed), 1);
        assert!(matches!(
            service
                .command("reviewer", &authority, Command::Amend("next".into()))
                .await,
            Ok(crate::CommandOutcome::Applied(_))
        ));
        forge_server.abort();
        native_server.abort();
    }

    #[tokio::test]
    async fn review_recovers_its_checkout_before_creating_a_reservation() {
        for available in [true, false] {
            let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
            let head = if available {
                service.project.start.clone()
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
            let step = Box::pin(service.advance(&row, &host)).await.expect("pass");
            let next = service.task("reviewer").await.expect("result row");
            if available {
                assert_eq!(
                    step,
                    Action::Launch {
                        role: Role::Reviewer,
                        via: Launch::Create
                    }
                );
                assert!(next.task.run().is_some());
            } else {
                assert_eq!(step, Action::Wait(WaitReason::WorkspaceUnknown));
                assert_eq!(row, next);
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn an_edit_during_native_authorization_cannot_send_the_review() {
        let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
        let head = service.project.start.clone();
        let (forge, reads, forge_server) = forge_fixture(&head).await;
        service.forge = forge;
        let git = service.git.clone();
        let worktrees = crate::Worktrees::new(
            &service.storage,
            &git,
            crate::Redactor::new([], crate::RedactionRules::common()),
        )
        .expect("worktrees");
        let checkout = worktrees
            .checkout(
                &service.project.checkout,
                &service.project.repository,
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
        let root = service.project.checkout.clone();
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
            let head = service.project.start.clone();
            let git = service.git.clone();
            let worktrees = crate::Worktrees::new(
                &service.storage,
                &git,
                crate::Redactor::new([], crate::RedactionRules::common()),
            )
            .expect("worktrees");
            let checkout = worktrees
                .checkout(
                    &service.project.checkout,
                    &service.project.repository,
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
                service.project.checkout.clone()
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
                profile: service.project.reviewer.clone(),
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
    async fn merge_writes_wait_until_the_forge_confirms_the_next_fact() {
        for status in [StatusCode::CONFLICT, StatusCode::METHOD_NOT_ALLOWED] {
            let (_home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
            let head = service.project.start.clone();
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
            let (reserved, _, _) = reservation(id, Entry::ReviewEntry, &service.project.start);
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
            assert_eq!(
                state.waits.get(id).map(|(reason, _)| *reason),
                Some(WaitReason::ForgeUnknown)
            );
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
            let head = service.project.start.clone();
            let latest = if changed_head {
                "b".repeat(40).parse().expect("new head")
            } else {
                head.clone()
            };
            let (forge, reads, server) = forge_fixture(&latest).await;
            service.forge = forge;
            let worktrees = service.worktrees().expect("worktrees");
            let checkout = worktrees
                .checkout(
                    &service.project.checkout,
                    &service.project.repository,
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
            let host = Due(std::sync::atomic::AtomicUsize::new(0));
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
}
