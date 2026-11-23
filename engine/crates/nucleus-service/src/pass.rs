use std::{
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};

use nucleus_core::{
    Action, CheckState, CloseWorkspace, Command, Forge, Head, Host, Launch, Observation, Observed,
    Phase, Report, RetainedThread, Role, RunState, Task, WaitReason, Workspace, decide,
};
use nucleus_forge::{Branches, ForgeError, MergeWrite, PullTarget};
use nucleus_hosts::{Binding, LaunchRequest, SendOutcome, StopProgress, TaskHost};
use nucleus_store::TaskRow;
use nucleus_work::Checkout;

use crate::{Service, ServiceError, event, now_ms, ticket};

impl Service {
    pub(super) async fn advance(
        &self,
        row: &TaskRow,
        host: &impl TaskHost,
    ) -> Result<Action, ServiceError> {
        let task = &row.task;
        self.project.scope(task.identity())?;
        let worktrees = self.worktrees()?;
        let checkout = worktrees.checkout(
            &self.project.checkout,
            &self.project.repository,
            &task.identity().id,
        )?;
        let binding = self.binding(&checkout)?;
        let (forge, target) = self.read_forge(task, &checkout).await;
        let mut observation = Observation {
            host: Observed::Unknown,
            forge,
            workspace: seen(checkout.observe()),
        };
        if task.run().is_some_and(nucleus_core::Run::revoked) {
            return self.stop_run(row, &checkout, observation, host).await;
        }
        observation.host = read_host(host, task, &binding).await;

        match decide(task, &observation) {
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
            action => self.apply(row, &observation, action).await,
        }
    }

    async fn read_forge(
        &self,
        task: &Task,
        checkout: &Checkout<'_>,
    ) -> (Observed<Forge>, Option<PullTarget>) {
        if now_ms() < self.forge_until.load(Ordering::Relaxed) {
            return (Observed::Unknown, None);
        }
        let branches = Branches::new(
            &self.project.repository,
            &self.project.base,
            checkout.branch(),
        );
        let Ok(branches) = branches else {
            return (Observed::Unknown, None);
        };
        let reported = task.run().and_then(|run| match run.report() {
            Some(Report::Work(pr)) if !run.revoked() => Some(pr),
            _ => None,
        });
        let result = match reported.or_else(|| task.pull_request()) {
            Some(pr) => branches.target(&pr.url).map(Some),
            None if task.phase() == Phase::Queued => Ok(None),
            None => self.forge.find_open(&branches).await,
        };
        match capture_forge(self, result) {
            Some(Some(target)) => {
                let forge = seen_from(capture_forge(self, self.forge.observe(&target).await));
                (forge, Some(target))
            }
            Some(None) => (Observed::Known(Forge::Absent), None),
            None => (Observed::Unknown, None),
        }
    }

    pub(super) async fn command_observation(
        &self,
        task: &Task,
        command: &Command,
    ) -> Result<Observation, ServiceError> {
        let forge = if matches!(
            command,
            Command::Move(Phase::Merging | Phase::Closing | Phase::Done) | Command::Answer(_)
        ) {
            let worktrees = self.worktrees()?;
            let checkout = worktrees.checkout(
                &self.project.checkout,
                &self.project.repository,
                &task.identity().id,
            )?;
            self.read_forge(task, &checkout).await.0
        } else {
            Observed::Unknown
        };
        Ok(Observation {
            host: Observed::Unknown,
            workspace: Observed::Unknown,
            forge,
        })
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
        self.save(row, updated, &event(kind)).await?;
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
        if role == Role::Worker && observation.workspace == Observed::Known(Workspace::Absent) {
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
        );
        let inputs = host.prepare_launch(LaunchRequest {
            binding: self.binding(checkout)?,
            title: format!("{} • {role:?}", task.identity().reference),
            profile: self.project.profile(role),
            via: &via,
            instance: &instance,
            started_at: now_ms(),
            text,
        })?;
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).map_err(|_| ServiceError::Ticket)?;
        let mut updated = task.clone();
        let credential = updated.reserve_launch(&observation, inputs, &seed)?;
        let run = updated.run().ok_or(ServiceError::Input)?;
        ticket::prepare(
            self.storage.scratch(),
            task,
            run,
            &credential,
            &self.callback,
        )?;
        self.save(row, updated, &event("run_reserved")).await?;
        Ok(Action::Launch { role, via })
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
            observation.forge = self.read_forge(task, checkout).await.0;
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
        if !self.launch_capacity(&task.identity().id).await? {
            return Ok(Action::Wait(WaitReason::Capacity));
        }
        let (sent, result) = self.send(row, host).await?;
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
        host: &impl TaskHost,
    ) -> Result<(TaskRow, SendOutcome), ServiceError> {
        let task = &row.task;
        let authorization = host
            .authorize_send(task.run().ok_or(ServiceError::Input)?)
            .await?;
        let _fence = self.effect(row).await?;
        let mut sent = task.clone();
        authorization.record(&mut sent)?;
        let sent = self.save(row, sent, &event("host_send")).await?;
        let result = host
            .send(sent.task.run().ok_or(ServiceError::Input)?, authorization)
            .await?;
        Ok((sent, result))
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
        let progress = {
            let _fence = self.effect(row).await?;
            host.stop(run, now_ms(), archive).await?
        };
        match progress {
            StopProgress::Waiting => Ok(stopping),
            StopProgress::Settled(host) => {
                if head.is_some()
                    && run.last_send_at_ms().is_some()
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
                    observation.forge = self.read_forge(task, checkout).await.0;
                    observation.workspace = seen(checkout.observe());
                }
                let Some(archive) = replay_policy(head, &observation) else {
                    return Ok(stopping);
                };
                if !self.launch_capacity(&task.identity().id).await? {
                    return Ok(Action::Wait(WaitReason::Capacity));
                }
                let (sent, outcome) = self.send(row, host).await?;
                let observed = if outcome == SendOutcome::Rejected {
                    StopProgress::Settled(current(&sent.task, RunState::Rejected)?)
                } else {
                    let _fence = self.effect(&sent).await?;
                    host.stop(
                        sent.task.run().ok_or(ServiceError::Input)?,
                        now_ms(),
                        archive,
                    )
                    .await?
                };
                if let StopProgress::Settled(host) = observed {
                    observation.host = Observed::Known(host);
                    let action = decide(&sent.task, &observation);
                    return self.apply(&sent, &observation, action).await;
                }
                Ok(stopping)
            }
        }
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
        let result = self.forge.merge(task, target).await;
        let Some(attempt) = capture_forge(self, result) else {
            return Ok(Action::Wait(WaitReason::ForgeUnknown));
        };
        if let MergeWrite::Deferred { until } = attempt.write {
            defer(self, until);
            return Ok(Action::Wait(WaitReason::ForgeUnknown));
        }
        let observed = seen_from(capture_forge(self, attempt.observed));
        if attempt.write == MergeWrite::HeadMismatch && observed == Observed::Unknown {
            let mut updated = task.clone();
            if updated.merge_head_mismatched(head) {
                self.save(row, updated, &event("merge_head_changed"))
                    .await?;
                return Ok(Action::Advance(Phase::Reviewing));
            }
        }
        if attempt.write == MergeWrite::Unknown
            && !matches!(observed, Observed::Known(Forge::Merged { .. }))
        {
            return Ok(Action::Wait(WaitReason::ForgeUnknown));
        }
        // A definite refusal remains actionable even when the readback failed.
        // The old head scopes the question and grants no merge authority.
        if observed != Observed::Unknown || !matches!(attempt.write, MergeWrite::Refused { .. }) {
            observation.forge = observed;
        }
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
            forge: seen_from(capture_forge(self, self.forge.observe(target).await)),
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
        if let Observed::Known(Forge::Merged { commit, .. }) = &observed.forge {
            audit.detail = serde_json::json!({ "mergeCommit": commit }).to_string();
        }
        self.save(row, updated, &audit).await?;
        Ok(action)
    }
}

async fn read_host(host: &impl TaskHost, task: &Task, binding: &Binding) -> Observed<Host> {
    if let Some(run) = task.run() {
        return seen(host.observe_run(run, now_ms()).await);
    }
    let role = match task.phase() {
        Phase::Working => Role::Worker,
        Phase::Reviewing => Role::Reviewer,
        _ => return Observed::Unknown,
    };
    match task.threads().get(role) {
        Some(thread) => seen(host.observe_retained(binding, thread).await),
        None => Observed::Unknown,
    }
}

fn current(task: &Task, state: RunState) -> Result<Host, ServiceError> {
    let run = task.run().ok_or(ServiceError::Input)?;
    Ok(Host::Current {
        instance: run.launch().instance.clone(),
        state,
    })
}

fn capture_forge<T>(service: &Service, result: Result<T, ForgeError>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(ForgeError::Deferred { until }) => {
            defer(service, until);
            None
        }
        Err(_) => None,
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
    use std::sync::atomic::Ordering;

    use nucleus_core::{Authority, Entry, PullRequest};
    use nucleus_forge::GitHub;

    use super::*;
    use crate::tests::{Due, fixture, forge_fixture, reservation};

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
                service.stop_run(&row, &checkout, cached, &host).await
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
