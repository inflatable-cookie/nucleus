use std::{
    ops::ControlFlow,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use nucleus_core::{
    Action, CallbackCredential, CheckState, CloseWorkspace, Forge, Head, Host, Launch,
    LaunchInputs, Observation, Observed, Phase, Report, RetainedThread, Role, Run, RunState, Task,
    WaitReason, Workspace, decide,
};
use nucleus_forge::{Branches, ForgeError, MergeWrite, PullTarget};
use nucleus_hosts::{
    Binding, ControlDispatch, DoneArchive, HostError, LaunchRequest, NoticeAuthorization,
    NoticeTarget, ParentAttempt, ParentRun, ParentStep, SendOutcome, StopProgress, TaskHost,
    launch_diagnostic,
};
use nucleus_store::{CriticalReviewFallback, DispatchMode, TaskRow};
use nucleus_work::Checkout;
use tokio::sync::RwLockReadGuard;

use crate::{
    Service, ServiceError, active, event, now_ms,
    profiles::{LaunchSelection, SelectedLaunch},
    project::{ProjectRoute, linked_checkout},
    prompt::{Assignment, LaneContext, Prompt, PromptSize},
    scratch, ticket,
};

const MAX_FORGE_RETRY: Duration = Duration::from_mins(4);

struct PromptArtifacts<'a> {
    lanes: &'a LaneContext,
    size: &'a PromptSize,
}

fn write_prompt_artifacts(
    root: &nucleus_store::StorageDirectory,
    run: &Run,
    task: &Task,
    prompt: &PromptArtifacts<'_>,
) -> Result<(), ServiceError> {
    let launch = run.launch();
    scratch::allocate(root, launch)?;
    scratch::materialize_lane_documents(root, launch, &prompt.lanes.pins)?;
    let role = match launch.role {
        Role::Reviewer => "reviewer",
        Role::Worker if task.threads().get(Role::Worker).is_some() => "revision",
        Role::Worker => "worker",
    };
    let directory = launch.scratch.as_deref().ok_or(ServiceError::Ticket)?;
    scratch::write_prompt_size(directory, &launch.instance, role, prompt.size)
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
    pub(super) fn existing_run_scratch(&self, task: &Task) -> Option<PathBuf> {
        let launch = task.run()?.launch();
        Some(scratch::bound_path(
            self.storage.scratch().path(),
            &task.identity().id,
            &launch.instance,
            launch.scratch.as_deref(),
        ))
    }

    pub(super) async fn archive_done(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let task = &row.task;
        let parenting = self.acp_provider().is_some();
        if task.hold().is_some() || (!parenting && task.report_task().is_none()) {
            return Ok(Action::Nothing);
        }
        let identity = task.identity();
        let _fence = self.effect(row).await?;
        let _projects = self.project_writes.read().await;
        let route = self.project_for(identity).await?;
        let worktrees = self.worktrees()?;
        let checkout = worktrees.checkout(&route.checkout, &identity.repository, &identity.id)?;
        let binding = self.checkout_binding(identity, &route, &checkout)?;
        let reviewer = task.threads().get(Role::Reviewer);
        let worker = task.threads().get(Role::Worker);
        if checkout.observe()? != Workspace::Absent {
            if task.report_task().is_none() {
                return Err(ServiceError::ArchiveEvidence(
                    "Waiting for the retained task checkout to be removed.".into(),
                ));
            }
            let head = self.report_archive_head(row, &checkout).await?;
            let parent = nucleus_hosts::parent_thread(checkout.path());
            #[cfg(test)]
            let host = self.host.fixture_pass();
            #[cfg(not(test))]
            let host = self.host.pass(self.storage.scratch().path());
            for (role, thread) in [
                ("reviewer", reviewer),
                ("worker", worker),
                ("task", Some(parent.as_str())),
            ] {
                if let Some(thread) = thread
                    && !host.retirement_idle(&binding, thread).await?
                {
                    return Err(ServiceError::ArchiveEvidence(format!(
                        "Waiting for the {role} thread and checkout to be idle before removal."
                    )));
                }
            }
            let roles: Vec<_> = [reviewer, worker, Some(parent.as_str())]
                .into_iter()
                .flatten()
                .collect();
            let state = self.state.lock().await;
            if state
                .settings
                .dispatch
                .as_ref()
                .is_some_and(|dispatch| dispatch.mode != DispatchMode::Running)
            {
                return Err(ServiceError::ReportCheckout("archival is paused"));
            }
            self.host.retire_with_quiet_shell(&parent, &roles, || {
                Self::retire_report_checkout(&checkout, head.as_ref())
            })??;
        }
        let step = if parenting {
            self.host.prepare_archive(&binding, reviewer, worker)?
        } else {
            DoneArchive::Finished
        };
        match step {
            DoneArchive::Finished => Ok(Action::Nothing),
            DoneArchive::Wait(cause) => Err(ServiceError::ArchiveEvidence(cause)),
            DoneArchive::Write(write) => {
                self.check_project_route(identity, &route).await?;
                if !self.host.write_archive(write).await? {
                    return Err(ServiceError::ArchiveEvidence(
                        "The T3 thread changed before archiving. Checking again.".into(),
                    ));
                }
                self.recheck_effect(row, WaitReason::Stopping).await;
                Ok(Action::Wait(WaitReason::Stopping))
            }
        }
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
        let checkout = worktrees.checkout(&route.checkout, &identity.repository, &identity.id)?;
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
        let mut observation = Observation {
            host: Observed::Unknown,
            forge,
            workspace: seen(checkout.observe()),
        };
        // The operator's global stop settles a live run through stop custody too.
        if task.run().is_some_and(nucleus_core::Run::revoked)
            || (task.run().is_some() && self.dispatch_mode().await == DispatchMode::Stopped)
        {
            return self.stop_run(row, &checkout, observation, host).await;
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
                observation.workspace = workspace;
            }
        }
        let (host_state, mut host_error) = run_host.unwrap_or((Observed::Unknown, None));
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
            Action::Wait(WaitReason::ForgeUnknown) if let Some(error) = forge_error => Err(error),
            Action::Wait(_) if forge_requested && let Some(error) = forge_error => Err(error),
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
            Ok(seen) => {
                if let Some(limit) = &seen.provider_limit {
                    self.record_provider_limit(row, run, limit).await?;
                }
                (Observed::Known(seen.host), seen.activity, None)
            }
            Err(error) => {
                if run.last_send_at_ms().is_none() {
                    eprintln!(
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
        Ok((state, error))
    }

    async fn read_forge(
        &self,
        task: &Task,
        checkout: &Checkout<'_>,
    ) -> Result<(Forge, Option<PullTarget>), ServiceError> {
        let deadline = self.forge_until.load(Ordering::Relaxed);
        if now_ms() < deadline {
            return Err(ForgeError::Deferred {
                until: UNIX_EPOCH + std::time::Duration::from_millis(deadline),
            }
            .into());
        }
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        route.binding(checkout)?;
        let review_entry = task.identity().entry == nucleus_core::Entry::ReviewEntry;
        let (branches, reported) = if review_entry {
            (
                Branches::for_review_entry(&identity.repository, &identity.base)?,
                None,
            )
        } else {
            let reported = task.run().and_then(|run| match run.report() {
                Some(Report::Work(report)) if !run.revoked() => Some(&report.pull_request),
                _ => None,
            });
            (
                Branches::new(&identity.repository, &identity.base, checkout.branch())?,
                reported,
            )
        };
        let target = match reported.or_else(|| task.pull_request()) {
            Some(pr) => Some(branches.target(&pr.url)?),
            None if review_entry => return Err(ForgeError::Identity.into()),
            None if task.phase() == Phase::Queued => None,
            None => capture_forge(self, self.forge.find_open(&branches).await)?,
        };
        match target {
            Some(target) => {
                let target = target.with_required_checks(route.required_checks);
                let observed = if task.phase() == Phase::Merging && task.verdict().is_some() {
                    self.forge.observe_for_merge(&target).await
                } else {
                    self.forge.observe(&target).await
                };
                let forge = capture_forge(self, observed)?;
                Ok((forge, Some(target)))
            }
            None => Ok((Forge::Absent, None)),
        }
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
    ) -> Result<Option<Observed<Workspace>>, ServiceError> {
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
        let workspace = if let Some((head, pull)) = review {
            seen(checkout.allocate_review(head, pull))
        } else {
            let start = task.report_task().map_or_else(
                || {
                    self.project
                        .as_ref()
                        .map_or(&base_head, |project| &project.start)
                },
                |report| &report.planning_base,
            );
            Observed::Known(checkout.allocate(start)?)
        };
        Ok(Some(workspace))
    }

    pub(super) async fn workspace_capacity(
        &self,
        identity: &nucleus_core::Identity,
        route: &ProjectRoute,
        slots: u32,
    ) -> Result<bool, ServiceError> {
        let scope = self
            .host
            .runtime_identity()
            .map(|session| self.turn_failure_scope(&session));
        let candidates = self.state.lock().await.store.project_workspace_candidates(
            &identity.id,
            &route.repositories,
            scope.as_deref(),
        )?;
        self.storage.work().verify()?;
        let mut in_flight = 0;
        for (task, repository) in candidates {
            let path = nucleus_work::checkout_path(self.storage.work().path(), &repository, &task);
            match std::fs::symlink_metadata(path) {
                Ok(_) => in_flight += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(nucleus_work::WorkError::from(error).into()),
            }
        }
        Ok(in_flight < slots.saturating_mul(2))
    }

    async fn apply(
        &self,
        row: &TaskRow,
        observation: &Observation,
        action: Action,
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
            Action::Advance(_)
                if matches!(
                    observation.host,
                    Observed::Known(Host::Current {
                        state: RunState::UsageLimited,
                        ..
                    })
                ) =>
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
            && let Some(delivery) = updated
                .report_task()
                .and_then(|report| report.delivery.as_ref())
        {
            audit.detail =
                serde_json::json!({ "artifact": delivery.artifact, "summary": delivery.summary })
                    .to_string();
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
            observation.workspace = workspace;
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
        let parent = match self
            .prepare_run_parent(row, checkout, &binding, host)
            .await?
        {
            ControlFlow::Continue(parent) => parent,
            ControlFlow::Break(reason) => return Ok(Action::Wait(reason)),
        };
        let mut inputs = host.prepare_launch(LaunchRequest {
            binding,
            parent,
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
        let artifacts = PromptArtifacts {
            lanes: &lanes,
            size: &assignment.size,
        };
        self.persist_reservation(row, &updated, &credential, selection, (via, artifacts))
            .await
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
            eprintln!(
                "{id}: assignment exceeds the T3 message limit: {}",
                audit.detail
            );
        }
        Ok(true)
    }

    async fn prepare_run_parent(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
        binding: &Binding,
        host: &impl TaskHost,
    ) -> Result<ControlFlow<WaitReason, Option<ParentRun>>, ServiceError> {
        let Some(provider) = self.acp_provider() else {
            return Ok(ControlFlow::Continue(None));
        };
        let task = &row.task;
        let identity = task.identity();
        if !self.launch_capacity(identity, false).await? {
            return Ok(ControlFlow::Break(WaitReason::Capacity));
        }
        let session = self.host.runtime_identity().ok_or(HostError::Uncertain)?;
        let failed_scope = self.turn_failure_scope(&session);
        let (prior_turn, released_at, start_line) = {
            let state = self.state.lock().await;
            if state
                .store
                .task_turn_command(
                    &identity.id,
                    "native_turn_failed",
                    row.version,
                    &failed_scope,
                )?
                .is_some()
            {
                return Ok(ControlFlow::Break(WaitReason::HostUnknown));
            }
            (
                prior_preparation_command(&state, row, &session)?,
                state.wait_reason(&identity.id).filter(|reason| {
                    !matches!(reason, WaitReason::Starting | WaitReason::HostUnknown)
                }),
                crate::presentation::role_start_line(task, &state.store),
            )
        };
        match self
            .host
            .prepare_parent(
                binding,
                provider,
                &identity.reference,
                &start_line,
                prior_turn.as_deref().map(|command| ParentAttempt {
                    command,
                    released: released_at.is_some(),
                }),
                host.profile_catalog(),
            )
            .await
            .map_err(|error| {
                if prior_turn.is_some() && !matches!(error, HostError::ParentPreflight { .. }) {
                    ServiceError::ParentDeliveryUnknown(error)
                } else {
                    self.parent_not_sent(error)
                }
            })? {
            ParentStep::Live(parent) => Ok(ControlFlow::Continue(Some(parent))),
            ParentStep::DeliveryUnknown => {
                Err(ServiceError::ParentDeliveryUnknown(HostError::Uncertain))
            }
            ParentStep::Wait => Ok(ControlFlow::Break(
                released_at.unwrap_or(WaitReason::Starting),
            )),
            ParentStep::Failed => {
                if let Some(command) = prior_turn {
                    self.record_failed_parent_turn(row, &session, &command)
                        .await?;
                }
                Ok(ControlFlow::Break(WaitReason::HostObservationBlocked))
            }
            ParentStep::Write(write) => {
                let Some(_permit) = self
                    .dispatch_gate(
                        task,
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
                self.ensure_parent_reader(&identity.id, checkout.path())
                    .await?;
                let command = write.command_id().ok_or(ServiceError::Input)?;
                let (scope, kind) = if prior_turn.as_deref() == Some(command) {
                    (&failed_scope, "native_turn_replay")
                } else {
                    (&session, "native_turn_intent")
                };
                let intent = write.starts_turn().then_some(kind);
                if !self.deliver_parent(row, write, scope, intent).await? {
                    return Err(ServiceError::ParentDeliveryUnknown(HostError::Uncertain));
                }
                self.recheck_effect(row, WaitReason::HostUnknown).await;
                Ok(ControlFlow::Break(WaitReason::Starting))
            }
        }
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
        credential: &CallbackCredential,
        selection: Option<&SelectedLaunch>,
        (via, prompt): (Launch, PromptArtifacts<'_>),
    ) -> Result<Action, ServiceError> {
        let run = updated.run().ok_or(ServiceError::Input)?;
        self.storage.database().verify()?;
        write_prompt_artifacts(self.storage.scratch(), run, &row.task, &prompt)?;
        ticket::prepare(
            self.storage.scratch(),
            updated,
            run,
            credential,
            &format!("http://{}", self.callback),
        )?;
        let mut audit = event("run_reserved");
        let pins: Vec<_> = prompt
            .lanes
            .pins
            .iter()
            .map(nucleus_store::planning::Lane::artifact)
            .collect();
        let mut detail = serde_json::Map::new();
        if !pins.is_empty() {
            detail.insert("laneDocumentPins".into(), serde_json::json!(pins));
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
        let task = &row.task;
        let run = task.run().ok_or(ServiceError::Input)?;
        let _fence = self.effect(row).await?;
        let authorization = host.authorize_send(run).await.inspect_err(|error| {
            eprintln!(
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
        if let Some(wake) = authorization.unsettle() {
            let command = wake.command_id().ok_or(ServiceError::Input)?;
            if self
                .claim_row_unsettle(&task.identity().id, command)
                .await?
            {
                host.write_control(wake).await?;
                self.recheck_effect(row, WaitReason::HostUnknown).await;
            }
            return Ok(SendAttempt::Deferred);
        }
        let parent = authorization.parent_row().zip(self.acp_provider());
        if let Some((parent, provider)) = parent
            && let Err(error) = self
                .wake_task_parent(row, authorization.binding(), provider, parent)
                .await
        {
            if let ServiceError::ParentNotSent { reason, .. } = &error {
                self.record_parent_refusal(row, &run.launch().instance, "role-wake", None, reason)
                    .await?;
            }
            return Err(error);
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
        if let Some((_, provider)) = parent
            && run.last_send_at_ms().is_none()
            && let Err(error) = self.reflect_role_admission(&sent, checkout, provider).await
        {
            eprintln!("{}: {error}", task.identity().id);
        }
        let result = match host.send(dispatch).await {
            Err(error @ HostError::Deferred { .. }) => {
                let mut audit = event("host_send_not_sent");
                audit.detail = serde_json::json!({"command":run.launch().instance}).to_string();
                self.save(&sent, row.task.clone(), &audit).await?;
                return Err(error.into());
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
                let present = checkout.observe()? != Workspace::Absent;
                (present || task.phase().is_terminal()).then_some(false)
            }
            DispatchTarget::Run {
                checkout, launch, ..
            } => {
                if launch {
                    let run = task.run().ok_or(ServiceError::Input)?;
                    if let Some(head) = run.launch().review_head.as_ref() {
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
                        replay_policy(Some(head), &fresh)
                            .filter(|&superseded| !superseded || run.revoked())
                    } else {
                        (checkout.observe()? != Workspace::Absent).then_some(false)
                    }
                } else {
                    (checkout.observe()? != Workspace::Absent).then_some(false)
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
                    && !linked_checkout(&root, Path::new(path), &self.git)?
                {
                    return Err(HostError::Binding.into());
                }
                Some(false)
            }
        };
        Ok(result.map(|superseded| DispatchPermit {
            _projects: projects,
            superseded,
        }))
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
                    observation.workspace = seen(checkout.observe());
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
            let command = dispatch.command_id().map(str::to_owned);
            let written = host.write_control(dispatch).await;
            if matches!(written, Err(HostError::Deferred { .. }))
                && let Some(command) = command
            {
                self.record_native_turn(row, "native_turn_not_sent", "stop", &command)
                    .await?;
            }
            written?;
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
        let target = target.clone().with_required_checks(route.required_checks);
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
            let route = self.project_for(task.identity()).await?;
            let binding = route.binding(checkout)?;
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
            let _projects = self.project_writes.read().await;
            let route = self.project_for(task.identity()).await?;
            if self.checkout_binding(task.identity(), &route, checkout)? != binding {
                return Err(HostError::Binding.into());
            }
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

fn prior_preparation_command(
    state: &crate::State,
    row: &TaskRow,
    session: &str,
) -> Result<Option<String>, ServiceError> {
    let id = &row.task.identity().id;
    let prior = state
        .store
        .task_turn_command(id, "native_turn_intent", row.version, session)?;
    if let Some(command) = &prior
        && (state.store.task_turn_failed(id, command)?
            || state
                .store
                .task_turn_attempt(id, "native_turn_intent", row.version, session, command)?
                .is_some_and(|(_, refused)| refused))
    {
        return Ok(None);
    }
    Ok(prior)
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
        Due, REPOSITORY, fixture, forge_checks, forge_fixture, forge_pull, native_fixture,
        reservation, serve_forge,
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
        let worktrees = service.worktrees().expect("worktrees");
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
        let watch = prove_running_hint_refresh(&service, &native_reads).await;
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
        watch.abort();
        forge_server.abort();
        native_server.abort();
    }

    async fn prove_running_hint_refresh(
        service: &Arc<Service>,
        native_reads: &AtomicUsize,
    ) -> tokio::task::JoinHandle<()> {
        let service_watch = Arc::clone(service);
        let watch = tokio::spawn(async move { service_watch.watch_host().await });
        tokio::time::timeout(Duration::from_secs(5), service.pass())
            .await
            .expect("host event wakes the decision")
            .expect("event pass");
        let reads = native_reads.load(Ordering::Relaxed);
        assert_eq!(reads, 2);
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
        let head = service.fixture().start.clone();
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
            )
            .expect("worktrees");
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
            let worktrees = service.worktrees().expect("worktrees");
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
}
