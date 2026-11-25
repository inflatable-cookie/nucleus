//! Admission, lane authority and closeout for report-only tasks.

use std::time::Duration;

use nucleus_core::{
    Action, Authority, CommandError, Head, Host, Identity, Phase, ReportAcceptance, ReportArtifact,
    RetainedThread, Role, Task, WaitReason, Workspace,
};
use nucleus_forge::Branches;
use nucleus_hosts::{HostError, NoticeHost, NoticeSend, NoticeWrite, T3, TaskHost};
use nucleus_store::{
    DispatchMode, StoreError, TaskRow,
    planning::{Lane, WriteAt},
};
use nucleus_work::{Checkout, Retirement};
use tokio::sync::MutexGuard;

use crate::{
    ControllerScope, Service, ServiceError, State,
    acp::{self, WriteAccess},
    event, now_ms,
};

#[derive(Clone, Copy)]
pub(super) enum PlannerNotice {
    ReportReady,
    PrerequisiteRelease(i64),
    ParentRecovery,
    Completion,
}

impl PlannerNotice {
    fn retry(
        self,
        store: &nucleus_store::Store,
        task: &str,
        version: i64,
    ) -> Result<Option<bool>, StoreError> {
        match self {
            Self::Completion => store.completion_notice(task),
            Self::ParentRecovery => store.parent_recovery_notice_retry(task, version),
            Self::ReportReady => Ok(Some(store.planner_notice_rejected(task, None)?)),
            Self::PrerequisiteRelease(release) => {
                Ok(Some(store.planner_notice_rejected(task, Some(release))?))
            }
        }
    }
    fn effect(
        self,
        row_version: i64,
    ) -> (&'static str, i64, &'static str, &'static str, Option<i64>) {
        match self {
            Self::Completion => (
                "completion",
                0,
                "completion_notice_intent",
                "completion_notice_not_sent",
                None,
            ),
            Self::ReportReady => (
                "report-ready",
                row_version,
                "report_ready_planner_notice_intent",
                "report_ready_planner_notice_not_sent",
                None,
            ),
            Self::PrerequisiteRelease(version) => (
                "prerequisite-release",
                version,
                "prerequisite_notice_intent",
                "prerequisite_notice_not_sent",
                Some(version),
            ),
            Self::ParentRecovery => (
                "parent-recovery",
                row_version,
                "parent_recovery_notice_intent",
                "parent_recovery_notice_not_sent",
                None,
            ),
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
        let worktrees = self.worktrees()?;
        let checkout = worktrees.checkout(&route.checkout, &identity.repository, &identity.id)?;
        let local = self.verify_route(identity, &route).await?;
        let branches = report_branches(identity, &checkout)?;
        let head = self.forge.branch_head(&branches, &identity.base).await?;
        if expected.is_some_and(|pin| *pin != head) {
            return Err(ServiceError::ReportInput(
                "origin integration head changed from the requested planning commit".into(),
            ));
        }
        if checkout.require_commit(&head).is_err() {
            return Err(ServiceError::ReportInput(format!(
                "fetch origin/{} in the registered repository to make the pinned commit {head} available",
                identity.base
            )));
        }
        if !checkout.integration_clean()? || !checkout.contains(&local, &head)? {
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
        let _fence = self.fence(id).await;
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
        state: MutexGuard<'a, State>,
        prior: &TaskRow,
        acceptance: &ReportAcceptance,
        authority: &Authority,
        session: Option<&WriteAccess>,
        scope: &ControllerScope,
    ) -> Result<MutexGuard<'a, State>, ServiceError> {
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
        let worktrees = self.worktrees()?;
        let checkout = worktrees.checkout(&route.checkout, &identity.repository, &identity.id)?;
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
        // Each observation checks the exact native thread, workspace, turn and tool custody.
        for check in 0..2 {
            if check != 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            #[cfg(test)]
            let host = self.host.fixture_pass();
            #[cfg(not(test))]
            let host = self.host.pass(self.storage.scratch().path());
            if !matches!(
                host.observe_retained(&binding, thread).await?,
                Host::Retained { thread: seen, state: RetainedThread::Idle } if seen == thread
            ) {
                return Err(ServiceError::ReportWorkerBusy);
            }
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

    pub(super) async fn notify_completion(&self, row: &TaskRow) -> Result<(), ServiceError> {
        let id = &row.task.identity().id;
        if self
            .state
            .lock()
            .await
            .store
            .completion_notice(id)?
            .is_none()
        {
            return Ok(());
        }
        let name = row
            .number
            .map_or_else(|| row.reference().into_owned(), |n| format!("#{n}"));
        let title = crate::titles::brief_title(&row.task);
        let text = if row.task.phase() == Phase::Cancelled {
            format!("{name} {title} was cancelled")
        } else {
            let mut text = format!("{name} {title} is done");
            if let Some(pr) = row.task.pull_request() {
                text.push_str(" · ");
                text.push_str(&pr.url);
            }
            text
        };
        match self
            .advance_planner_notice(row, PlannerNotice::Completion, &text)
            .await
        {
            Ok(NoticeProgress::Pending) | Err(ServiceError::Host(_)) => {
                self.recheck_effect(row, WaitReason::Question).await;
            }
            Ok(NoticeProgress::Spent | NoticeProgress::NoPlanner) => {}
            Err(error) => return Err(error),
        }
        Ok(())
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
        let completion = matches!(notice, PlannerNotice::Completion);
        let parent = matches!(notice, PlannerNotice::ParentRecovery);
        let (effect, version, intent, not_sent, release_version) = notice.effect(row.version);
        let Some(retry) = notice.retry(&self.state.lock().await.store, id, version)? else {
            return Ok(Spent);
        };
        let Some(thread) = self.planner_notice_target(task, completion).await? else {
            return Ok(NoPlanner);
        };
        let suffix = if retry { "-retry" } else { "" };
        let command = format!("task-{id}-{effect}-{version}{suffix}");
        let mut attempt = T3::prepare_notice(thread, command, text)?;
        let Some((authorization, _permit)) = self.prepare_planner_notice(row, &attempt).await?
        else {
            return Ok(Pending);
        };
        let dispatch = authorization.record(&mut attempt)?;
        let mut audit = event(intent);
        audit.detail = serde_json::json!({"command": attempt.command, "recipient": attempt.thread,
            "releaseVersion": release_version, "version": version, "retry": retry})
        .to_string();
        let recorded = if parent || completion {
            let mut state = self.state.lock().await;
            if completion {
                state
                    .store
                    .set_completion_notice(id, Some(retry), None, &audit)?;
            } else {
                state.store.record_task_effect(id, &audit)?;
            }
            state.planner_notice_waiters.remove(id);
            None
        } else if let Some(version) = release_version {
            if !self
                .state
                .lock()
                .await
                .store
                .claim_prerequisite_notice(id, version, &audit)?
            {
                return Ok(Spent);
            }
            self.publish(id, row.version);
            None
        } else {
            let mut updated = task.clone();
            updated.mark_report_notice_attempted();
            Some(self.save(row, updated, &audit).await?)
        };
        // The intent is durable before the write. Unknown delivery leaves it closed.
        let send = self.host.deliver_notice(NoticeWrite::Queue(dispatch)).await;
        let kind = match send {
            Err(HostError::Deferred { .. }) => not_sent,
            Ok(NoticeSend::Rejected) if !retry && completion => "completion_notice_rejected",
            Ok(NoticeSend::Rejected) if !retry && parent => "parent_recovery_notice_rejected",
            Ok(NoticeSend::Rejected) if !retry => "planner_notice_rejected",
            Ok(NoticeSend::Rejected) => {
                audit.kind = "planner_notice_retry_rejected".into();
                self.state
                    .lock()
                    .await
                    .store
                    .record_task_effect(id, &audit)?;
                return Ok(Spent);
            }
            Ok(NoticeSend::Accepted | NoticeSend::Prepared) => return Ok(Spent),
            Err(_) if parent || completion => return Ok(Spent),
            Err(error) => return Err(error.into()),
        };
        let mut outcome = event(kind);
        outcome.detail.clone_from(&audit.detail);
        if completion {
            self.state.lock().await.store.set_completion_notice(
                id,
                None,
                Some(retry || kind == "completion_notice_rejected"),
                &outcome,
            )?;
        } else if parent {
            self.state
                .lock()
                .await
                .store
                .record_task_effect(id, &outcome)?;
        } else if let Some(recorded) = recorded {
            self.save(&recorded, task.clone(), &outcome).await?;
        } else if let Some(version) = release_version {
            self.state
                .lock()
                .await
                .store
                .reopen_prerequisite_notice(id, version, &audit, &outcome)?;
        }
        send?;
        Ok(Pending)
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
        let head = match checkout.observe()? {
            Workspace::Absent => return Ok(None),
            Workspace::Dirty => {
                return Err(ServiceError::ReportCheckout(
                    "the checkout has uncommitted files",
                ));
            }
            Workspace::Clean(head) => head,
        };
        let identity = task.identity();
        let route = self.project_for(identity).await?;
        self.checkout_binding(identity, &route, checkout)?;
        self.verify_route(identity, &route).await?;
        for bound in std::iter::once(&report.planning_base).chain(&report.reported_heads) {
            if !checkout.contains(bound, &head)? {
                return Err(ServiceError::ReportCheckout(
                    "the checkout does not contain its planning and authenticated report heads",
                ));
            }
        }
        let branches = report_branches(identity, checkout)?;
        let mut advertised = self.forge.published_branches(&branches).await?;
        advertised.sort_by_key(|(branch, _)| {
            if branch == checkout.branch() {
                0
            } else if branch == &identity.base {
                1
            } else {
                2
            }
        });
        for (branch, tip) in advertised {
            let contained = match checkout.contains(&head, &tip) {
                Ok(contained) => contained,
                Err(_) => self
                    .forge
                    .contains(&branches, &head, &tip)
                    .await
                    .unwrap_or(false),
            };
            if contained && self.forge.branch_head(&branches, &branch).await? == tip {
                return Ok(Some(head));
            }
        }
        Err(ServiceError::ReportCheckout(
            "the source is not proved published on origin",
        ))
    }

    pub(super) fn retire_report_checkout(
        checkout: &Checkout<'_>,
        head: Option<&Head>,
    ) -> Result<(), ServiceError> {
        if let Some(head) = head
            && checkout.retire(head)? == Retirement::Retained
        {
            return Err(ServiceError::ReportCheckout(
                "the checkout changed after publication was proved",
            ));
        }
        Ok(())
    }
}

fn report_branches(identity: &Identity, checkout: &Checkout<'_>) -> Result<Branches, ServiceError> {
    Ok(Branches::new(
        &identity.repository,
        &identity.base,
        checkout.branch(),
    )?)
}
