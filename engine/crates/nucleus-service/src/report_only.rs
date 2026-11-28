//! Admission, lane authority and closeout for report-only tasks.

use nucleus_core::{
    Action, Authority, CommandError, Head, Identity, Phase, ReportAcceptance, ReportArtifact, Role,
    Task, WaitReason, Workspace,
};
use nucleus_forge::{Branches, ForgeError};
use nucleus_hosts::{HostError, NoticeOutcome, NoticeState, T3};
use nucleus_store::{
    DispatchMode, EventDraft, StoreError, TaskRow,
    planning::{Lane, WriteAt},
};
use nucleus_work::{Checkout, WorkError};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    ControllerScope, Service, ServiceError, State,
    acp::{self, WriteAccess},
    diagnostics::StateGuard,
    event, now_ms,
    volume::Limit,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatcherSummary {
    pub(crate) count: usize,
    pub(crate) watching: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatcherStatus {
    pub(crate) reference: String,
    pub(crate) title: String,
    pub(crate) phase: Phase,
    pub(crate) watchers: WatcherSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchResponse {
    pub(crate) reference: String,
    pub(crate) title: String,
    pub(crate) phase: Phase,
    pub(crate) watching: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) outcome: Option<String>,
}

#[derive(Clone, Copy)]
pub(super) enum PlannerNotice {
    ReportReady,
    PrerequisiteRelease(i64),
    Completion,
}

struct NoticeOccurrence {
    kind: PlannerNotice,
    effect: &'static str,
    version: i64,
    release_version: Option<i64>,
    prefer_claim: bool,
    intent_event: &'static str,
    not_sent_event: &'static str,
    rejected_event: &'static str,
    propagate_uncertain: bool,
}

enum NoticeClaim {
    ReportReady(Box<TaskRow>),
    PrerequisiteRelease(i64),
    Completion(bool),
}

enum SendOutcome {
    Delivered,
    Reopen {
        rejected: bool,
        error: Option<HostError>,
    },
    RetryRejected,
    Uncertain(HostError),
}

impl PlannerNotice {
    fn occurrence(self, row_version: i64) -> NoticeOccurrence {
        match self {
            Self::ReportReady => NoticeOccurrence {
                kind: self,
                effect: "report-ready",
                version: row_version,
                release_version: None,
                prefer_claim: false,
                intent_event: "report_ready_planner_notice_intent",
                not_sent_event: "report_ready_planner_notice_not_sent",
                rejected_event: "planner_notice_rejected",
                propagate_uncertain: true,
            },
            Self::PrerequisiteRelease(release) => NoticeOccurrence {
                kind: self,
                effect: "prerequisite-release",
                version: release,
                release_version: Some(release),
                prefer_claim: false,
                intent_event: "prerequisite_notice_intent",
                not_sent_event: "prerequisite_notice_not_sent",
                rejected_event: "planner_notice_rejected",
                propagate_uncertain: true,
            },
            Self::Completion => NoticeOccurrence {
                kind: self,
                effect: "completion",
                version: 0,
                release_version: None,
                prefer_claim: true,
                intent_event: "completion_notice_intent",
                not_sent_event: "completion_notice_not_sent",
                rejected_event: "completion_notice_rejected",
                propagate_uncertain: false,
            },
        }
    }
}

impl NoticeOccurrence {
    fn retry(
        &self,
        store: &nucleus_store::Store,
        row: &TaskRow,
    ) -> Result<Option<bool>, StoreError> {
        let task_id = &row.task.identity().id;
        match self.kind {
            PlannerNotice::Completion => store.completion_notice(task_id),
            PlannerNotice::ReportReady => row
                .task
                .report_task()
                .filter(|report| report.delivery.is_some() && !report.notice_attempted)
                .map(|_| store.planner_notice_rejected(task_id, None))
                .transpose(),
            PlannerNotice::PrerequisiteRelease(release) => {
                Ok(Some(store.planner_notice_rejected(task_id, Some(release))?))
            }
        }
    }

    async fn claim(
        &self,
        service: &Service,
        row: &TaskRow,
        retry: bool,
        audit: &EventDraft,
    ) -> Result<Option<NoticeClaim>, ServiceError> {
        let id = &row.task.identity().id;
        match self.kind {
            PlannerNotice::ReportReady => {
                let mut updated = row.task.clone();
                updated.mark_report_notice_attempted();
                Ok(Some(NoticeClaim::ReportReady(Box::new(
                    service.save(row, updated, audit).await?,
                ))))
            }
            PlannerNotice::PrerequisiteRelease(release) => {
                if !service
                    .state
                    .lock()
                    .await
                    .store
                    .claim_prerequisite_notice(id, release, audit)?
                {
                    return Ok(None);
                }
                service.publish(id, row.version);
                Ok(Some(NoticeClaim::PrerequisiteRelease(release)))
            }
            PlannerNotice::Completion => {
                let mut state = service.state.lock().await;
                state
                    .store
                    .set_completion_notice(id, None, Some(retry), None, audit)?;
                state.planner_notice_waiters.remove(id);
                Ok(Some(NoticeClaim::Completion(retry)))
            }
        }
    }
}

impl NoticeClaim {
    async fn reopen(
        self,
        service: &Service,
        row: &TaskRow,
        audit: &EventDraft,
        outcome: &EventDraft,
        rejected: bool,
    ) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        match self {
            Self::ReportReady(recorded) => {
                service.save(&recorded, row.task.clone(), outcome).await?;
            }
            other => {
                let mut state = service.state.lock().await;
                match other {
                    Self::PrerequisiteRelease(release) => {
                        state
                            .store
                            .reopen_prerequisite_notice(id, release, audit, outcome)?;
                    }
                    Self::Completion(retry) => state.store.set_completion_notice(
                        id,
                        None,
                        None,
                        Some(retry || rejected),
                        outcome,
                    )?,
                    Self::ReportReady(_) => unreachable!(),
                }
            }
        }
        Ok(())
    }
}

impl SendOutcome {
    fn classify(send: Result<NoticeOutcome, HostError>, retry: bool) -> Self {
        match send {
            Ok(NoticeOutcome::Accepted) => Self::Delivered,
            Ok(NoticeOutcome::Rejected) if !retry => Self::Reopen {
                rejected: true,
                error: None,
            },
            Ok(NoticeOutcome::Rejected) => Self::RetryRejected,
            Ok(NoticeOutcome::NotSent(error)) => Self::Reopen {
                rejected: false,
                error: Some(error),
            },
            Err(error) => Self::Uncertain(error),
        }
    }
}

pub(super) enum NoticeProgress {
    NoPlanner,
    Pending,
    Spent,
}

impl Service {
    pub(super) async fn capture_report_base(
        &self,
        identity: &Identity,
        expected: Option<&Head>,
    ) -> Result<Head, ServiceError> {
        let route = self.project_for(identity).await?;
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, &identity.id)?;
        let local = self.verify_route(identity, &route).await?;
        let branches = report_branches(identity, &checkout)?;
        let head = self.forge.branch_head(&branches, &identity.base).await?;
        if expected.is_some_and(|pin| *pin != head) {
            return Err(ServiceError::ReportInput(
                "origin integration head changed from the requested planning commit".into(),
            ));
        }
        let step = "reading the integration checkout";
        let pinned = head.clone();
        let present = self
            .checkout_job(&checkout, step, Limit::Check, move |checkout| {
                checkout.require_commit(&pinned)
            })
            .await;
        match present {
            Ok(()) => {}
            Err(error @ WorkError::Storage(_)) => return Err(error.into()),
            Err(_) => {
                return Err(ServiceError::ReportInput(format!(
                    "fetch origin/{} in the registered repository to make the pinned commit {head} available",
                    identity.base
                )));
            }
        }
        let pinned = head.clone();
        let published = self
            .checkout_job(&checkout, step, Limit::Check, move |checkout| {
                Ok(checkout.integration_clean()? && checkout.contains(&local, &pinned)?)
            })
            .await?;
        if !published {
            return Err(ServiceError::ReportInput(
                "report-only admission requires a clean, published integration checkout".into(),
            ));
        }
        if self.forge.branch_head(&branches, &identity.base).await? != head {
            return Err(ServiceError::ReportInput(
                "origin integration head changed during report-only admission; retry".into(),
            ));
        }
        Ok(head)
    }

    /// Use only the run ticket, never a controller credential, for the bound report lane.
    pub(crate) async fn report_lane(
        &self,
        id: &str,
        instance: &str,
        credential: &[u8; 32],
        project: &str,
        key: &str,
        update: Option<(u64, String)>,
    ) -> Result<Lane, ServiceError> {
        let _fence = self.report_fence(id).await;
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        let row = self.lookup(&state, id)?;
        let run = row.task.authenticate_run(instance, credential)?;
        let report = row
            .task
            .report_task()
            .ok_or(CommandError::InvalidReportCredential)?;
        if run.launch().role != Role::Worker
            || run.last_send_at_ms().is_none()
            || run.report().is_some()
            || report.project != project
            || report.lane != key
            || !self.report_project_matches(&state, &row.task)
        {
            return Err(CommandError::InvalidReportCredential.into());
        }
        let mut lane = state
            .store
            .lane(project, key)?
            .ok_or(StoreError::PlanningMissing)?;
        if let Some((version, text)) = update {
            lane.document.document = text;
            lane = state.store.put_lane(
                project,
                key,
                version,
                lane.document,
                WriteAt {
                    actor: &run.launch().thread,
                    at_ms: now_ms(),
                },
            )?;
            self.planning_changes.send_replace(());
        }
        Ok(lane)
    }

    pub(super) fn report_project_matches(&self, state: &State, task: &Task) -> bool {
        let Some(report) = task.report_task() else {
            return false;
        };
        if let Some(project) = &self.project {
            state.settings.planning_project_id(project) == report.project
        } else {
            state
                .settings
                .project_for_origin(&task.identity().repository)
                .is_some_and(|(project, _, repo)| {
                    project == report.project && repo.base == task.identity().base
                })
        }
    }

    pub(super) fn verify_report_artifact(
        &self,
        state: &State,
        task: &Task,
        artifact: &ReportArtifact,
        latest_required: bool,
    ) -> Result<(), ServiceError> {
        let report = task.report_task().ok_or_else(|| {
            ServiceError::ReportInput(
                "report_ready is only allowed when the brief opts into queue.reportOnly: true"
                    .into(),
            )
        })?;
        if !self.report_project_matches(state, task) || artifact.key != report.lane {
            return Err(ServiceError::ReportInput(format!(
                "report_ready artifact must use the task's attached report lane {}",
                report.lane
            )));
        }
        let exact = state
            .store
            .lane_version(&report.project, &artifact.key, artifact.version)?;
        let latest = state.store.lane(&report.project, &artifact.key)?;
        let matches = |lane: &Lane| lane.artifact() == *artifact;
        if exact.as_ref().is_some_and(matches)
            && (!latest_required || latest.as_ref().is_some_and(matches))
        {
            return Ok(());
        }
        let stored = exact.map_or_else(
            || format!("version {} is missing", artifact.version),
            |lane| format!("stored v{} digest {}", lane.version, lane.artifact().digest),
        );
        let latest = latest.map_or_else(
            || "the lane holds no document".into(),
            |lane| format!("latest v{} digest {}", lane.version, lane.artifact().digest),
        );
        Err(ServiceError::ReportInput(format!(
            "lane {} report names v{} digest {}; {stored}; {latest}. Re-read the lane and use its exact artifact",
            artifact.key, artifact.version, artifact.digest
        )))
    }

    pub(super) async fn fence_report_completion<'a>(
        &'a self,
        state: StateGuard<'a>,
        prior: &TaskRow,
        acceptance: &ReportAcceptance,
        authority: &Authority,
        session: Option<&WriteAccess>,
        scope: &ControllerScope,
    ) -> Result<StateGuard<'a>, ServiceError> {
        if prior.version != acceptance.version {
            return Err(StoreError::StaleTask.into());
        }
        self.verify_report_artifact(&state, &prior.task, &acceptance.artifact, false)?;
        drop(state);
        Box::pin(self.verify_report_completion(&prior.task)).await?;
        let state = self.state.lock().await;
        let id = &prior.task.identity().id;
        if self.lookup(&state, id)? != *prior {
            return Err(StoreError::StaleTask.into());
        }
        scope.task(&state, prior.task.identity())?;
        if let Authority::Planner { actor } = authority {
            state.check_planner_authority(&prior.task, actor)?;
        }
        if let Some(session) = session
            && acp::writer_controller(&state, id, &session.credential) != Some(session.controller)
        {
            return Err(ServiceError::AcpUnauthorized);
        }
        self.verify_report_artifact(&state, &prior.task, &acceptance.artifact, false)?;
        if state.store.dependency_blocked(id)? {
            return Err(ServiceError::DependencyEdit(
                "this task has unfinished prerequisites",
            ));
        }
        Ok(state)
    }

    async fn verify_report_completion(&self, task: &Task) -> Result<(), ServiceError> {
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        let worktrees = self.worktrees();
        let checkout = worktrees.registered(&route.checkout, &identity.repository, &identity.id)?;
        let binding = self.checkout_binding(identity, &route, &checkout)?;
        let branches = report_branches(identity, &checkout)?;
        self.verify_route(identity, &route).await?;
        if self.forge.has_open_branch_pr(&branches).await? {
            return Err(ServiceError::ReportOpenPullRequest);
        }
        let thread = task
            .threads()
            .get(Role::Worker)
            .ok_or(ServiceError::ReportWorkerBusy)?;
        if !self.host.report_worker_idle(&binding, thread)? {
            return Err(ServiceError::ReportWorkerBusy);
        }
        Ok(())
    }

    pub(super) async fn notify_report_ready(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let task = &row.task;
        let Some(report) = task.report_task() else {
            return Ok(Action::Nothing);
        };
        let Some(delivery) = report
            .delivery
            .as_ref()
            .filter(|_| !report.notice_attempted)
        else {
            return Ok(Action::Nothing);
        };
        let artifact = &delivery.artifact;
        let text = format!(
            "Nucleus report ready for {}\n{}\nArtifact: {} v{} ({})\nUse complete with the exact artifact and an acceptance reason, or move to work with an instruction.",
            row.reference(),
            delivery.headline.as_deref().unwrap_or(&delivery.summary),
            artifact.key,
            artifact.version,
            artifact.digest
        );
        let pending = self
            .send_planner_notice(row, PlannerNotice::ReportReady, &text)
            .await?;
        Ok(if pending {
            Action::Wait(WaitReason::Question)
        } else {
            Action::Nothing
        })
    }

    pub(crate) async fn watch_for_caller(
        &self,
        caller: &ControllerScope,
        authority: &Authority,
        selector: &str,
        subscribe: bool,
    ) -> Result<WatchResponse, ServiceError> {
        let (actor, default_repo) = self.resolve_watch_caller(caller, authority).await?;
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        let id = self.resolve_watch_reference(&state, selector, default_repo.as_deref())?;
        Self::apply_watch(&mut state, &id, &actor, subscribe)
    }

    pub(crate) async fn watchers_for_caller(
        &self,
        caller: &ControllerScope,
        authority: &Authority,
        selector: &str,
    ) -> Result<WatcherStatus, ServiceError> {
        let (actor, default_repo) = self.resolve_watch_caller(caller, authority).await?;
        self.storage.database().verify()?;
        let state = self.state.lock().await;
        let id = self.resolve_watch_reference(&state, selector, default_repo.as_deref())?;
        self.read_watcher_status(&state, &id, &actor)
    }

    pub(crate) async fn watch_with_ticket(
        &self,
        task_id: &str,
        instance: &str,
        credential: &[u8; 32],
        selector: &str,
        subscribe: bool,
    ) -> Result<WatchResponse, ServiceError> {
        self.storage.database().verify()?;
        let mut state = self.state.lock().await;
        let (id, actor) =
            self.resolve_ticket_watch(&state, task_id, instance, credential, selector)?;
        Self::apply_watch(&mut state, &id, &actor, subscribe)
    }

    pub(crate) async fn watchers_with_ticket(
        &self,
        task_id: &str,
        instance: &str,
        credential: &[u8; 32],
        selector: &str,
    ) -> Result<WatcherStatus, ServiceError> {
        self.storage.database().verify()?;
        let state = self.state.lock().await;
        let (id, actor) =
            self.resolve_ticket_watch(&state, task_id, instance, credential, selector)?;
        self.read_watcher_status(&state, &id, &actor)
    }

    async fn resolve_watch_caller(
        &self,
        caller: &ControllerScope,
        authority: &Authority,
    ) -> Result<(String, Option<String>), ServiceError> {
        let Some(actor) = caller.actor() else {
            return match authority {
                Authority::Planner { actor } => Ok((
                    actor.clone(),
                    self.project
                        .as_ref()
                        .map(|project| project.repository.clone()),
                )),
                Authority::Operator { .. } => Err(ServiceError::WatchAgentRequired),
            };
        };
        let registered = self
            .state
            .lock()
            .await
            .settings
            .planner_route(actor)
            .is_some();
        if registered {
            let default_repo = caller
                .with_enrollment(|| async {
                    let mut state = self.state.lock().await;
                    self.require_controller(&mut state, actor)?;
                    Ok(state
                        .live_planner_project(actor)
                        .and_then(|project| state.settings.only_bound_repository(project))
                        .map(str::to_owned))
                })
                .await?;
            return Ok((actor.to_owned(), default_repo));
        }
        // Any live, unarchived T3 thread in the synchronized shell snapshot may watch/inspect
        // watch status across projects without making request-time host RPC calls (ruling 11).
        let identity = self
            .host
            .cached_thread_identity(actor)?
            .ok_or(ServiceError::WatchAgentRequired)?;
        let state = self.state.lock().await;
        let default_repo = state.settings.projects.as_ref().and_then(|projects| {
            let mut repos = projects.projects.values().filter_map(|project| {
                project
                    .repositories
                    .iter()
                    .any(|repo| repo.host_project.as_deref() == Some(identity.project_id.as_str()))
                    .then(|| match project.repositories.as_slice() {
                        [only] => Some(only.origin.clone()),
                        _ => None,
                    })
                    .flatten()
            });
            let first = repos.next()?;
            repos.next().is_none().then_some(first)
        });
        Ok((actor.to_owned(), default_repo))
    }

    fn resolve_ticket_watch(
        &self,
        state: &State,
        task_id: &str,
        instance: &str,
        credential: &[u8; 32],
        selector: &str,
    ) -> Result<(String, String), ServiceError> {
        let caller_row = self.lookup(state, task_id)?;
        let run = caller_row.task.authenticate_run(instance, credential)?;
        let actor = run.launch().thread.clone();
        let default_repo = &caller_row.task.identity().repository;
        let id = self.resolve_watch_reference(state, selector, Some(default_repo))?;
        Ok((id, actor))
    }

    fn read_watcher_status(
        &self,
        state: &State,
        id: &str,
        actor: &str,
    ) -> Result<WatcherStatus, ServiceError> {
        let row = self.lookup(state, id)?;
        let (count, watching) = state.store.watcher_summary(id, Some(actor))?;
        Ok(WatcherStatus {
            reference: row.reference().into_owned(),
            title: crate::titles::brief(&row.task),
            phase: row.task.phase(),
            watchers: WatcherSummary { count, watching },
        })
    }

    fn apply_watch(
        state: &mut State,
        id: &str,
        actor: &str,
        subscribe: bool,
    ) -> Result<WatchResponse, ServiceError> {
        let (row, watching) = if subscribe {
            let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
            state
                .store
                .watch_task(id, actor, now)?
                .ok_or(ServiceError::Missing)?
        } else {
            (
                state
                    .store
                    .unwatch_task(id, actor)?
                    .ok_or(ServiceError::Missing)?,
                false,
            )
        };
        Ok(WatchResponse {
            reference: row.reference().into_owned(),
            title: crate::titles::brief(&row.task),
            phase: row.task.phase(),
            watching,
            outcome: row
                .task
                .phase()
                .is_terminal()
                .then(|| completion_notice_text(&row)),
        })
    }

    pub(super) async fn notify_completion(&self, row: &TaskRow) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        let pending = self.state.lock().await.store.completion_notices(id)?;
        if pending.is_empty() {
            return Ok(());
        }
        let text = completion_notice_text(row);
        let mut recheck = false;
        for notice in pending {
            let progress = match notice.watcher {
                None => {
                    self.advance_planner_notice(row, PlannerNotice::Completion, &text)
                        .await
                }
                Some(watcher) => {
                    self.advance_watcher_completion_notice(row, &watcher, &text)
                        .await
                }
            };
            match progress {
                Ok(NoticeProgress::Pending) | Err(ServiceError::Host(_)) => recheck = true,
                Ok(NoticeProgress::Spent | NoticeProgress::NoPlanner) => {}
                Err(error) => return Err(error),
            }
        }
        if recheck {
            self.recheck_effect(row, WaitReason::Question).await;
        }
        Ok(())
    }

    async fn advance_watcher_completion_notice(
        &self,
        row: &TaskRow,
        watcher: &str,
        text: &str,
    ) -> Result<NoticeProgress, ServiceError> {
        use NoticeProgress::{Pending, Spent};

        let _fence = self.effect(row).await?;
        let task = &row.task;
        let id = &task.identity().id;
        let Some(retry) = self
            .state
            .lock()
            .await
            .store
            .completion_notice_for(id, Some(watcher))?
        else {
            return Ok(Spent);
        };
        let command = watcher_completion_command(id, watcher, retry);
        let mut attempt = T3::prepare_notice(watcher.to_owned(), command, text)?;
        let observation = self.host.observe_watcher_notice(&attempt).await?;
        match observation.state {
            NoticeState::Gone => {
                let mut audit = event("completion_notice_watcher_dropped");
                audit.detail = serde_json::json!({
                    "recipient": watcher,
                    "reason": "thread_archived_or_gone",
                })
                .to_string();
                self.state.lock().await.store.set_completion_notice(
                    id,
                    Some(watcher),
                    Some(retry),
                    None,
                    &audit,
                )?;
                return Ok(Spent);
            }
            NoticeState::Started | NoticeState::Queued => {
                self.claim_watcher_notice(id, watcher, &attempt.command, retry)
                    .await?;
                return Ok(Spent);
            }
            NoticeState::Absent | NoticeState::Undelivered => {}
        }
        let Some(authorization) = observation.authorization else {
            return Ok(Pending);
        };
        let dispatch = {
            let _projects = self.project_writes.read().await;
            self.host.check_notice_target(&authorization)?;
            self.require_unchanged(task).await?;
            authorization.record(&mut attempt)?
        };
        let audit = self
            .claim_watcher_notice(id, watcher, &attempt.command, retry)
            .await?;
        match SendOutcome::classify(
            self.send_notice_preserving_snooze(Some(id), dispatch).await,
            retry,
        ) {
            SendOutcome::Delivered | SendOutcome::Uncertain(_) => Ok(Spent),
            SendOutcome::RetryRejected => {
                let mut rejected = audit;
                rejected.kind = "planner_notice_retry_rejected".into();
                self.state
                    .lock()
                    .await
                    .store
                    .record_task_effect(id, &rejected)?;
                Ok(Spent)
            }
            SendOutcome::Reopen { rejected, error } => {
                let mut outcome = event(if rejected {
                    "completion_notice_rejected"
                } else {
                    "completion_notice_not_sent"
                });
                outcome.detail = audit.detail;
                self.state.lock().await.store.set_completion_notice(
                    id,
                    Some(watcher),
                    None,
                    Some(retry || rejected),
                    &outcome,
                )?;
                match error {
                    Some(error) => Err(error.into()),
                    None => Ok(Pending),
                }
            }
        }
    }

    async fn claim_watcher_notice(
        &self,
        id: &str,
        watcher: &str,
        command: &str,
        retry: bool,
    ) -> Result<EventDraft, ServiceError> {
        let mut audit = event("completion_notice_intent");
        audit.detail = watcher_notice_detail(command, watcher, retry);
        self.state.lock().await.store.set_completion_notice(
            id,
            Some(watcher),
            Some(retry),
            None,
            &audit,
        )?;
        Ok(audit)
    }

    /// Make one attempt at an informational notice, returning whether it remains pending.
    pub(super) async fn send_planner_notice(
        &self,
        row: &TaskRow,
        notice: PlannerNotice,
        text: &str,
    ) -> Result<bool, ServiceError> {
        Ok(!matches!(
            self.advance_planner_notice(row, notice, text).await?,
            NoticeProgress::Spent
        ))
    }

    pub(super) async fn advance_planner_notice(
        &self,
        row: &TaskRow,
        notice: PlannerNotice,
        text: &str,
    ) -> Result<NoticeProgress, ServiceError> {
        use NoticeProgress::{NoPlanner, Pending, Spent};

        let _fence = self.effect(row).await?;
        let task = &row.task;
        let id = &task.identity().id;
        let occurrence = notice.occurrence(row.version);
        let Some(retry) = occurrence.retry(&self.state.lock().await.store, row)? else {
            return Ok(Spent);
        };
        let Some(thread) = self
            .planner_notice_target(task, occurrence.prefer_claim)
            .await?
        else {
            return Ok(NoPlanner);
        };
        let suffix = if retry { "-retry" } else { "" };
        let command = format!(
            "task-{id}-{}-{}{suffix}",
            occurrence.effect, occurrence.version
        );
        let mut attempt = T3::prepare_notice(thread, command, text)?;
        let Some((authorization, _permit)) = self.prepare_planner_notice(row, &attempt).await?
        else {
            return Ok(Pending);
        };
        let dispatch = authorization.record(&mut attempt)?;
        let mut audit = event(occurrence.intent_event);
        audit.detail = serde_json::json!({
            "command": attempt.command,
            "recipient": attempt.thread,
            "releaseVersion": occurrence.release_version,
            "version": occurrence.version,
            "retry": retry,
        })
        .to_string();
        let Some(claim) = occurrence.claim(self, row, retry, &audit).await? else {
            return Ok(Spent);
        };
        // The intent is durable before the write. Unknown delivery leaves it closed.
        match SendOutcome::classify(
            self.send_notice_preserving_snooze(Some(id), dispatch).await,
            retry,
        ) {
            SendOutcome::Delivered => Ok(Spent),
            SendOutcome::Uncertain(error) => {
                if occurrence.propagate_uncertain {
                    Err(error.into())
                } else {
                    Ok(Spent)
                }
            }
            SendOutcome::RetryRejected => {
                audit.kind = "planner_notice_retry_rejected".into();
                self.state
                    .lock()
                    .await
                    .store
                    .record_task_effect(id, &audit)?;
                Ok(Spent)
            }
            SendOutcome::Reopen { rejected, error } => {
                let mut outcome = event(if rejected {
                    occurrence.rejected_event
                } else {
                    occurrence.not_sent_event
                });
                outcome.detail.clone_from(&audit.detail);
                claim.reopen(self, row, &audit, &outcome, rejected).await?;
                match error {
                    Some(error) => Err(error.into()),
                    None => Ok(Pending),
                }
            }
        }
    }

    pub(super) async fn report_archive_head(
        &self,
        row: &TaskRow,
        checkout: &Checkout<'_>,
    ) -> Result<Option<Head>, ServiceError> {
        let task = &row.task;
        let report = task
            .report_task()
            .filter(|report| report.acceptance.is_some())
            .ok_or(CommandError::ReportOwnerAction)?;
        if task.phase() != Phase::Done
            || task.hold().is_some()
            || self.dispatch_mode().await != DispatchMode::Running
        {
            return Err(ServiceError::ReportCheckout("archival is paused"));
        }
        let head = match self.observe_checkout_for_retirement(checkout).await? {
            Workspace::Absent => return Ok(None),
            Workspace::Dirty => {
                self.deletion_only_head(checkout)
                    .await?
                    .ok_or(ServiceError::ReportCheckout(
                        "the retained checkout contains local changes",
                    ))?
            }
            Workspace::Clean(head) => head,
        };
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        self.checkout_binding(identity, &route, checkout)?;
        self.verify_route(identity, &route).await?;
        let bounds: Vec<_> = std::iter::once(&report.planning_base)
            .chain(&report.reported_heads)
            .cloned()
            .collect();
        let tip = head.clone();
        let contains = self
            .checkout_job(
                checkout,
                "comparing report heads",
                Limit::Check,
                move |checkout| {
                    for bound in &bounds {
                        if !checkout.contains(bound, &tip)? {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                },
            )
            .await?;
        if !contains {
            return Err(ServiceError::ReportCheckout(
                "the checkout does not contain its planning and authenticated report heads",
            ));
        }
        if self
            .is_published_checkout(identity, checkout, &head)
            .await?
        {
            Ok(Some(head))
        } else {
            Err(ServiceError::ReportCheckout(
                "the source is not proved published on origin",
            ))
        }
    }

    pub(super) async fn is_published_checkout(
        &self,
        identity: &Identity,
        checkout: &Checkout<'_>,
        head: &Head,
    ) -> Result<bool, ServiceError> {
        self.check_forge_ready()?;
        let branches = report_branches(identity, checkout)?;
        self.verify_published_head(checkout, head, &branches, &identity.base)
            .await
            .inspect_err(|error| crate::pass::record_forge_failure(self, error))
            .map_err(Into::into)
    }

    async fn verify_published_head(
        &self,
        checkout: &Checkout<'_>,
        head: &Head,
        branches: &Branches,
        base: &str,
    ) -> Result<bool, ForgeError> {
        let mut advertised = self.forge.published_branches(branches).await?;
        advertised.sort_by_key(|(branch, _)| {
            if branch == checkout.branch() {
                0
            } else if branch == base {
                1
            } else {
                2
            }
        });
        for (branch, tip) in advertised {
            let (ancestor, descendant) = (head.clone(), tip.clone());
            let local = self
                .checkout_job(
                    checkout,
                    "comparing published heads",
                    Limit::Check,
                    move |checkout| checkout.contains(&ancestor, &descendant),
                )
                .await;
            let contained = match local {
                Ok(contained) => contained,
                Err(_) => self.forge.contains(branches, head, &tip).await?,
            };
            if contained && self.forge.branch_head(branches, &branch).await? == tip {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn completion_notice_text(row: &TaskRow) -> String {
    let name = row
        .number
        .map_or_else(|| row.reference().into_owned(), |n| format!("#{n}"));
    let title = crate::titles::brief_title(&row.task);
    if row.task.phase() == Phase::Cancelled {
        format!("{name} {title} was cancelled")
    } else {
        let mut text = format!("{name} {title} is done");
        if let Some(pr) = row.task.pull_request() {
            text.push_str(" · ");
            text.push_str(&pr.url);
        }
        text
    }
}

fn watcher_completion_command(id: &str, watcher: &str, retry: bool) -> String {
    let digest = Sha256::digest(watcher.as_bytes());
    let tag = hex::encode(&digest[..8]);
    let suffix = if retry { "-retry" } else { "" };
    format!("task-{id}-watch-{tag}{suffix}")
}

fn watcher_notice_detail(command: &str, watcher: &str, retry: bool) -> String {
    serde_json::json!({
        "command": command,
        "recipient": watcher,
        "watcher": true,
        "retry": retry,
    })
    .to_string()
}

fn report_branches(identity: &Identity, checkout: &Checkout<'_>) -> Result<Branches, ServiceError> {
    Ok(Branches::new(
        &identity.repository,
        &identity.base,
        checkout.branch(),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{native_fixture, native_fixture_with_ticket_gate};
    use nucleus_core::{
        Entry, Forge, Host, LaunchInputs, Observation, Observed, Report, ReportDelivery, RunState,
    };
    use nucleus_forge::GitHub;
    use serde_json::{Value, json};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    async fn seed_report_ready(service: &Service) -> TaskRow {
        let head = service.fixture().start.clone();
        let mut task = Task::new_report_only(
            Identity {
                id: "report-notice".into(),
                reference: "Report notice".into(),
                repository: service.fixture().repository.clone(),
                base: service.fixture().base.clone(),
                entry: Entry::Brief,
                origin_thread: Some("planner-a".into()),
            },
            "Report brief".into(),
            "fixture-product".into(),
            "qa".into(),
            head.clone(),
        );
        let mut observation = Observation {
            host: Observed::Unknown,
            forge: Observed::Known(Forge::Absent),
            workspace: Observed::Known(Workspace::Clean(head.clone())),
        };
        task.reconcile(&observation);
        let credential = task
            .reserve_launch(
                &observation,
                LaunchInputs {
                    scratch: None,
                    thread: "worker-thread".into(),
                    started_at: 1,
                    input: "fixture".into(),
                },
                &[4; 32],
            )
            .unwrap();
        let instance = task.run().unwrap().launch().instance.clone();
        task.record_send(&instance, 2).unwrap();
        task.record_report(
            &instance,
            credential.as_bytes(),
            Report::ReportReady(ReportDelivery {
                artifact: ReportArtifact {
                    key: "qa".into(),
                    version: 1,
                    digest: "0".repeat(64),
                },
                headline: None,
                summary: "Report ready".into(),
                head: Some(head),
            }),
        )
        .unwrap();
        observation.host = Observed::Known(Host::Current {
            instance,
            state: RunState::Ended,
        });
        assert_eq!(
            task.reconcile(&observation),
            Action::Advance(Phase::ReportReady)
        );
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .unwrap();
        service.task("report-notice").await.unwrap()
    }

    async fn prime_report_503(checkout: &std::path::Path) -> (T3, tokio::task::JoinHandle<()>) {
        let reject = Arc::new(AtomicBool::new(false));
        let (host, server) =
            native_fixture_with_ticket_gate(Arc::clone(&reject), move |req| {
                assert_eq!(req["tag"], "orchestration.subscribeThread");
                json!({
                    "_tag":"Chunk","requestId":req["id"],"values":[
                        {"kind":"snapshot","snapshotSequence":2,"projection":{
                            "thread":{"id":"planner-a","projectId":"local-fixture","updatedAt":"2026-11-24T10:00:00Z"},
                            "messages":[],"runs":[]
                        }},
                        {"kind":"synchronized"}
                    ]
                })
            })
            .await;
        host.fixture_held_shell(&json!({
            "kind":"snapshot","snapshot":{
                "snapshotSequence":2,
                "projects":[{"id":"local-fixture","workspaceRoot":checkout}],
                "threads":[{
                    "id":"planner-a","projectId":"local-fixture",
                    "updatedAt":"2026-11-24T10:00:00Z","archivedAt":null,"deletedAt":null
                }]
            }
        }));
        let probe = T3::prepare_notice("planner-a".into(), "probe".into(), "probe").unwrap();
        let _ = host.observe_notice(&probe).await.unwrap();
        reject.store(true, Ordering::Relaxed);
        host.fixture_disconnect();
        (host, server)
    }

    #[tokio::test]
    async fn pre_send_notice_failure_reopens_report_notice_while_post_send_stays_uncertain() {
        // Part 1: pre-send 503 reopens the stored report-ready notice and records not_sent.
        let (_home, mut service) = crate::tests::fixture(GitHub::new("unused-test-forge").unwrap());
        let checkout = service.fixture().checkout.clone();
        let (host, server) = prime_report_503(&checkout).await;
        service.host = host;
        let row = seed_report_ready(&service).await;
        let err = service
            .advance_planner_notice(&row, PlannerNotice::ReportReady, "Report ready")
            .await
            .err()
            .unwrap();
        assert!(matches!(err, ServiceError::Host(HostError::Unavailable)));
        let reopened = service.task("report-notice").await.unwrap();
        assert!(!reopened.task.report_task().unwrap().notice_attempted);
        let history = service.history("report-notice", None, 20).await.unwrap();
        assert!(
            history
                .iter()
                .any(|entry| entry.content.kind == "report_ready_planner_notice_not_sent")
        );
        server.abort();

        // Part 2: post-send drop leaves the stored report-ready notice spent.
        let (_home, mut service) = crate::tests::fixture(GitHub::new("unused-test-forge").unwrap());
        let checkout = service.fixture().checkout.clone();
        let (host, server) = native_fixture(move |request| match request["tag"].as_str() {
            Some("orchestration.subscribeShell") => json!({
                "_tag":"Chunk","requestId":request["id"],"values":[
                    {"kind":"snapshot","snapshotSequence":1,"snapshot":{
                        "projects":[{"id":"local-fixture","workspaceRoot":checkout}],
                        "threads":[{"id":"planner-a","projectId":"local-fixture","updatedAt":"2026-11-24T10:00:00Z"}]
                    }},
                    {"kind":"synchronized"}
                ]
            }),
            Some("orchestration.subscribeThread") => json!({
                "_tag":"Chunk","requestId":request["id"],"values":[
                    {"kind":"snapshot","snapshotSequence":2,"projection":{
                        "thread":{"id":"planner-a","projectId":"local-fixture"},
                        "messages":[],"runs":[]
                    }},
                    {"kind":"synchronized"}
                ]
            }),
            Some("orchestration.dispatchCommand") => Value::Null,
            other => panic!("unexpected request: {other:?}"),
        })
        .await;
        service.host = host;
        service.host.fixture_project_shell(&json!({
            "projects":[{"id":"local-fixture", "workspaceRoot":service.fixture().checkout}],
            "threads":[{"id":"planner-a", "projectId":"local-fixture", "updatedAt":"2026-11-24T10:00:00Z"}]
        }), "fixture-acp");
        let row = seed_report_ready(&service).await;
        let err = service
            .advance_planner_notice(&row, PlannerNotice::ReportReady, "Report ready")
            .await
            .err()
            .unwrap();
        assert!(matches!(err, ServiceError::Host(HostError::Unavailable)));
        let spent = service.task("report-notice").await.unwrap();
        assert!(spent.task.report_task().unwrap().notice_attempted);
        server.abort();
    }
}
