use std::cmp::Reverse;

use nucleus_core::{Action, OperatorDecline, Question, QuestionDelivery, Task, WaitReason};
use nucleus_hosts::{
    HostError, NoticeAuthorization, NoticeOutcome, NoticeState, PlannerIdentity, PlannerThread, T3,
    ThreadHint,
};
use nucleus_store::{TaskRow, ThreadProvenance};
use tokio::time::Instant;

use crate::pass::{DispatchPermit, DispatchTarget};
use crate::{Service, ServiceError, State, event, project::ProjectRoute, schedule::Priority};

pub(super) struct PlannerAuthority {
    thread: String,
    project_id: Option<String>,
    identity: Option<PlannerIdentity>,
    checked_at: Instant,
}

impl PlannerAuthority {
    pub(crate) fn project_id(&self) -> Option<&str> {
        self.project_id.as_deref()
    }

    pub(crate) fn resolved(&self) -> Option<(Instant, &str)> {
        self.identity
            .as_ref()
            .map(|identity| (self.checked_at, identity.id.as_str()))
    }
}

fn bound_planner(task: &Task) -> Option<&str> {
    if task.phase().is_terminal() {
        return None;
    }
    task.question_delivery()
        .map(|delivery| delivery.thread.as_str())
        .or(task.identity().origin_thread.as_deref())
}

impl State {
    pub(super) fn invalidate_planner_authority(&mut self) {
        self.planner_authority_epoch += 1;
        self.planner_authority.clear();
    }

    pub(super) fn planner_thread_changed(&mut self, hint: &ThreadHint) {
        let count = self.planner_authority.len();
        self.planner_authority.retain(|_, authority| {
            authority.thread != hint.thread || !hint.is_identity_change(authority.identity.as_ref())
        });
        if self.planner_authority.len() != count
            || self.planner_check.as_ref() == Some(&hint.thread)
        {
            // A read started before an identity event cannot publish stale authority.
            self.planner_authority_epoch += 1;
        }
    }

    pub(super) fn check_planner_authority(
        &self,
        task: &Task,
        actor: &str,
    ) -> Result<(), ServiceError> {
        if self.registry_mode {
            return self
                .verified_controller(actor)
                .then_some(())
                .ok_or(ServiceError::PlannerAuthorityRefused);
        }
        if bound_planner(task) != Some(actor) {
            return Err(ServiceError::PlannerAuthorityRefused);
        }
        let authority = self
            .planner_authority
            .get(&task.identity().id)
            .filter(|authority| authority.thread == actor)
            .ok_or(ServiceError::PlannerAuthorityUnknown)?;
        authority
            .identity
            .as_ref()
            .map(|_| ())
            .ok_or(ServiceError::PlannerAuthorityRefused)
    }
}

impl Service {
    pub(super) fn planner_routes_changed(&self, state: &mut State) {
        let now = Instant::now();
        for id in &state.planner_notice_waiters {
            state.schedule.wake(id, now, Priority::Wake);
        }
        self.wake.notify_one();
        self.tell_wake.notify_one();
        self.project_changes.send_replace(());
    }

    pub(super) async fn planner_notice_target(
        &self,
        task: &Task,
        prefer_claim: bool,
    ) -> Result<Option<String>, ServiceError> {
        self.state
            .lock()
            .await
            .planner_notice_waiters
            .insert(task.identity().id.clone());
        self.responsible_planner(task, prefer_claim).await
    }

    /// Check the recipient and dispatch gate before recording a send intent.
    pub(super) async fn prepare_planner_notice(
        &self,
        row: &TaskRow,
        attempt: &QuestionDelivery,
    ) -> Result<Option<(NoticeAuthorization, DispatchPermit<'_>)>, ServiceError> {
        let Some(authorization) = self.host.authorize_notice(attempt).await? else {
            return Ok(None);
        };
        let target = DispatchTarget::Planner(&authorization);
        let Some(permit) = self.dispatch_gate(&row.task, target).await? else {
            return Ok(None);
        };
        Ok(Some((authorization, permit)))
    }

    pub(super) async fn notify_question(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let wait = Action::Wait(WaitReason::Question);
        let route = self.project_for(row.task.identity()).await?;
        if route.slots.is_none() {
            return Ok(wait);
        }
        match (row.task.operator_question(), row.task.operator_decline()) {
            (Some(_), None) => return Box::pin(self.operator_decision(row)).await,
            (_, Some(OperatorDecline::Notified)) => return Ok(wait),
            _ => {}
        }
        Box::pin(self.notify_planner(row)).await
    }

    async fn notify_planner(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let wait = Action::Wait(WaitReason::Question);
        let mut pending_attempt = None;
        if let Some(delivery) = row.task.question_delivery() {
            let observation = self.host.observe_notice(delivery).await?;
            match observation.state {
                NoticeState::Started => {
                    let mut updated = row.task.clone();
                    if updated.notify_operator_decline() {
                        let _fence = self.effect(row).await?;
                        self.save(row, updated, &event("operator_decline_notified"))
                            .await?;
                    }
                    return Ok(wait);
                }
                NoticeState::Undelivered | NoticeState::Gone => {}
                NoticeState::Absent if delivery.last_send_at_ms.is_none() => {
                    if self.project.is_some()
                        || self.check_registered_planner(&delivery.thread).await?
                    {
                        pending_attempt = Some(delivery.clone());
                    }
                }
                // None of these states authorizes another write for the recorded send.
                NoticeState::Absent | NoticeState::Queued => return Ok(wait),
            }
        }
        let mut attempt = if let Some(attempt) = pending_attempt {
            attempt
        } else {
            let Some(thread) = self.planner_notice_target(&row.task, false).await? else {
                return Ok(wait);
            };
            let question = row.task.question().ok_or(ServiceError::Input)?;
            let command = format!("task-{}-question-{}", row.task.identity().id, row.version);
            let text = if row.task.operator_decline().is_some() {
                format!(
                    "The operator declined to accept the external merge for {}. Move or cancel the task.",
                    row.reference()
                )
            } else {
                notice_text(
                    row.reference().as_ref(),
                    question,
                    row.task.threads().last_provider_limit.as_deref(),
                )
            };
            T3::prepare_notice(thread, command, &text)?
        };
        let _fence = self.effect(row).await?;
        let Some((authorization, _permit)) = self.prepare_planner_notice(row, &attempt).await?
        else {
            return Ok(wait);
        };
        let dispatch = authorization.record(&mut attempt)?;
        let command = attempt.command.clone();
        let mut updated = row.task.clone();
        if !updated.bind_question_delivery(attempt) {
            return Err(ServiceError::Input);
        }
        let sent = self.save(row, updated, &event("question_delivery")).await?;
        let result = self.host.send_notice(dispatch).await;
        let not_sent = match &result {
            Ok(NoticeOutcome::NotSent(error)) => Some(*error),
            _ => None,
        };
        if not_sent.is_some() || matches!(result, Ok(NoticeOutcome::Rejected)) {
            let mut pending = sent.task.clone();
            if !pending.clear_question_delivery(&command) {
                return Err(ServiceError::Input);
            }
            let mut audit = event(if not_sent.is_some() {
                "question_delivery_not_sent"
            } else {
                "question_delivery_rejected"
            });
            audit.detail = serde_json::json!({"command":command}).to_string();
            self.save(&sent, pending, &audit).await?;
        }
        if let Some(error) = not_sent {
            return Err(error.into());
        }
        result?;
        Ok(wait)
    }

    pub(super) async fn watch_planner_authority(&self) {
        loop {
            self.planner_wake.notified().await;
            while let Some(id) = self.take_planner_check().await {
                let _ = self.refresh_planner_authority(&id).await;
            }
        }
    }

    async fn take_planner_check(&self) -> Option<String> {
        self.host.wait_for_requests().await;
        self.state.lock().await.planner_requests.pop_first()
    }

    pub(super) fn request_planner_check(&self, state: &mut State, task: &Task) {
        if bound_planner(task).is_none() {
            return;
        }
        state.planner_requests.insert(task.identity().id.clone());
        self.planner_wake.notify_one();
    }

    pub(super) async fn refresh_planner_authority(&self, id: &str) -> Result<(), ServiceError> {
        if self.project.is_none() {
            return Ok(());
        }
        let (epoch, thread, route) = {
            let mut state = self.state.lock().await;
            let row = self.lookup(&state, id)?;
            let Some(thread) = bound_planner(&row.task).map(str::to_owned) else {
                return Ok(());
            };
            let route = self.resolve_project(&state, row.task.identity())?;
            if route.slots.is_none() {
                return Ok(());
            }
            if state
                .planner_authority
                .get(id)
                .is_some_and(|authority| authority.thread == thread)
            {
                return Ok(());
            }
            state.planner_check = Some(thread.clone());
            (state.planner_authority_epoch, thread, route)
        };
        let result = self.host.planner_identity(&thread).await;
        let mut state = self.state.lock().await;
        state.planner_check = None;
        let row = self.lookup(&state, id)?;
        if state.planner_authority_epoch != epoch || bound_planner(&row.task) != Some(&thread) {
            return Err(HostError::Uncertain.into());
        }
        let host = match &result {
            Ok(_) => crate::web::CachedHost::Reachable,
            Err(HostError::Deferred { .. } | HostError::Unavailable | HostError::Timeout) => {
                crate::web::CachedHost::Unavailable
            }
            Err(_) => crate::web::CachedHost::Unknown,
        };
        self.set_cached_host(&mut state, host);
        let identity = result?.filter(|identity| {
            identity.project_id == route.host_project
                && !identity.is_child()
                && self.acp_provider().is_none_or(|provider| {
                    identity.provider_instance_id.as_deref() != Some(provider)
                })
        });
        state.planner_authority.insert(
            id.into(),
            PlannerAuthority {
                thread,
                project_id: route.project_id,
                identity,
                checked_at: Instant::now(),
            },
        );
        self.settings_changes.send_replace(());
        self.publish(id, row.version);
        Ok(())
    }

    pub(super) async fn responsible_planner(
        &self,
        task: &Task,
        prefer_claim: bool,
    ) -> Result<Option<String>, ServiceError> {
        let route = self.project_for(task.identity()).await?;
        if let Some(origin) = &task.identity().origin_thread
            && self.host.planner_routable(origin).await?
        {
            return Ok(Some(origin.clone()));
        }
        if self.project.is_none() {
            return self.registered_planner(&route, prefer_claim).await;
        }
        for (rank, _, thread) in self.planner_candidates(task, &route).await? {
            if self
                .planner_workspace(&route, rank, thread.worktree_path)
                .await?
                && self.host.planner_routable(&thread.id).await?
            {
                return Ok(Some(thread.id));
            }
        }
        Ok(None)
    }

    async fn registered_planner(
        &self,
        route: &ProjectRoute,
        prefer_claim: bool,
    ) -> Result<Option<String>, ServiceError> {
        let Some(project) = route.project_id.as_deref() else {
            return Ok(None);
        };
        let candidates = {
            let state = self.state.lock().await;
            let mut candidates = state.planner_candidates_for(project);
            if prefer_claim {
                let claimed = state
                    .settings
                    .projects
                    .as_ref()
                    .and_then(|registry| registry.projects.get(project))
                    .and_then(|project| project.planner_claim.as_ref());
                candidates.sort_by_key(|id| claimed.is_none_or(|claim| claim.thread != *id));
            }
            candidates
        };
        for actor in candidates {
            if self.check_registered_planner(&actor).await?
                && self.state.lock().await.live_planner_project(&actor) == Some(project)
            {
                return Ok(Some(actor));
            }
        }
        Ok(None)
    }

    async fn planner_candidates(
        &self,
        task: &Task,
        route: &ProjectRoute,
    ) -> Result<Vec<(u8, Reverse<String>, PlannerThread)>, ServiceError> {
        let threads = self.host.planner_threads().await?;
        let ids: Vec<_> = threads.iter().map(|thread| thread.id.as_str()).collect();
        let provenance = {
            let state = self.state.lock().await;
            state
                .store
                .routing_provenance(Some(&task.identity().repository), &ids)?
        };
        let mut ranked = Vec::new();
        for thread in threads {
            if thread.archived_at.is_some()
                || thread.deleted_at.is_some()
                || thread.parent_thread_id.is_some()
                || self.acp_provider().is_some_and(|instance| {
                    thread.provider_instance_id.as_deref() == Some(instance)
                })
                || provenance.get(&thread.id) == Some(&ThreadProvenance::TaskRole)
            {
                continue;
            }
            // Titles carry no authority. Registered roles and task provenance set
            // rank, with project membership as the last candidate source.
            let rank = (provenance.get(&thread.id) == Some(&ThreadProvenance::Dispatcher))
                .then_some(0)
                .or_else(|| (thread.project_id == route.host_project).then_some(1));
            if let Some(rank) = rank {
                let interaction = thread.latest_user_message_at.clone().map_or_else(
                    || thread.updated_at.clone(),
                    |last| last.max(thread.updated_at.clone()),
                );
                ranked.push((rank, Reverse(interaction), thread));
            }
        }
        ranked.sort_unstable_by(|left, right| {
            (left.0, &left.1, &left.2.id).cmp(&(right.0, &right.1, &right.2.id))
        });
        Ok(ranked)
    }

    async fn planner_workspace(
        &self,
        route: &ProjectRoute,
        rank: u8,
        worktree: Option<String>,
    ) -> Result<bool, ServiceError> {
        if rank == 3
            && let Some(worktree) = worktree
        {
            return Ok(self
                .verify_linked_checkout(&worktree, route.checkout.clone(), (&worktree).into())
                .await?);
        }
        Ok(true)
    }
}

fn notice_text(reference: &str, question: &Question, limit: Option<&str>) -> String {
    let request = match question {
        Question::Work { prompt, options } if !options.is_empty() => {
            format!("{prompt}\n\nOptions\n- {}", options.join("\n- "))
        }
        Question::Work { prompt, .. } => prompt.clone(),
        Question::Retry { role } => limit.map_or_else(
            || format!("The {role:?} stopped three times. Decide whether to retry."),
            |cause| format!("{cause} The role reached its attempt limit. Decide whether to retry."),
        ),
        Question::Accept { head } => format!(
            "The PR was merged externally. Decide whether to accept closeout at commit {head}."
        ),
        Question::Allowance { used_ms, limit_ms } => {
            format!(
                "The task has used {} of {} allowance minutes. Extend its allowance under approve-by-default policy with `nucleus answer {reference} extend`.",
                used_ms / 60_000,
                limit_ms / 60_000
            )
        }
        Question::Repair(repair) => {
            format!("The task needs a decision about the PR or checkout ({repair:?}).")
        }
    };
    format!("Task {reference} needs input.\n\n{request}\n\nAnswer through Nucleus.")
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    use crate::tests::native_fixture;
    use nucleus_core::{Entry, Host, Identity, Observed, Report, RunState};
    use nucleus_forge::GitHub;
    use serde_json::{Value, json};

    use super::*;

    #[tokio::test]
    async fn shell_enrichment_preserves_the_authoritative_native_fixture_binding() {
        let (_home, mut service) =
            crate::tests::fixture(GitHub::new("unused-test-forge").expect("forge"));
        let retargeted = Arc::new(AtomicBool::new(false));
        let changed = Arc::clone(&retargeted);
        let checkout = service.fixture().checkout.clone();
        let project = service.fixture().host_project.clone();
        let (host, server) = native_fixture(move |request| {
            assert_eq!(request["tag"], "orchestration.subscribeShell");
            let root = if changed.load(Ordering::Relaxed) {
                "/synthetic/other-project"
            } else {
                checkout.to_str().expect("fixture root")
            };
            json!([
                {"_tag":"Chunk","requestId":request["id"],"values":[
                    {"kind":"snapshot","snapshot":{"projects":[{"id":project,"workspaceRoot":root}]}},
                    {"kind":"snapshot","resolvedRepositoryIdentityRoots":[checkout],"snapshot":{
                        "projects":[{"id":project,"workspaceRoot":checkout,"repositoryIdentity":null}],"threads":[]
                    }}
                ]},
                {"_tag":"Chunk","requestId":request["id"],"values":[{"kind":"synchronized"}]}
            ])
        })
        .await;
        service.host = host;
        service
            .check_project()
            .await
            .expect("exact fixture binding");
        retargeted.store(true, Ordering::Relaxed);
        assert!(matches!(
            service.check_project().await,
            Err(ServiceError::Host(HostError::Binding))
        ));
        server.abort();
    }

    #[tokio::test]
    async fn exact_origin_wins_and_fallback_respects_rank_and_unknown() {
        for (origin, strongest, expected) in [
            ("origin", "planner-old", Some("origin")),
            ("gone", "planner-old", Some("planner-old")),
            ("gone", "unverified", None),
            ("gone", "mismatch", None),
        ] {
            let (_home, mut service) =
                crate::tests::fixture(GitHub::new("unused-test-forge").expect("forge"));
            let checkout = service.fixture().checkout.clone();
            let (host, server) =
                native_fixture(move |request| snapshot_reply(request, strongest, &checkout)).await;
            service.host = host;
            service.fixture_mut().acp_provider = Some("fixture-acp".into());
            let task = Task::new(
                Identity {
                    id: "notice".into(),
                    reference: "fixture".into(),
                    repository: service.fixture().repository.clone(),
                    base: service.fixture().base.clone(),
                    entry: Entry::Brief,
                    origin_thread: Some(origin.into()),
                },
                "fixture brief".into(),
                None,
            );
            let result = service.responsible_planner(&task, false).await;
            if let Some(expected) = expected {
                assert_eq!(result.expect("exact routing").as_deref(), Some(expected));
            } else {
                assert!(matches!(
                    result,
                    Err(ServiceError::Host(
                        HostError::Uncertain | HostError::Binding
                    ))
                ));
            }
            server.abort();
        }
    }

    #[tokio::test]
    async fn a_rejected_notice_rebinds_and_unknown_delivery_keeps_its_id() {
        let (_home, mut service) =
            crate::tests::fixture(GitHub::new("unused-test-forge").expect("forge"));
        let received = Arc::new(Mutex::new(Vec::new()));
        let native = Arc::clone(&received);
        let checkout = service.fixture().checkout.clone();
        let (host, server) = native_fixture(move |request| {
            if request["tag"] != "orchestration.dispatchCommand" {
                return snapshot_reply(request, "planner", &checkout);
            }
            let command = request["payload"]["commandId"].as_str().expect("command ID");
            let mut sent = native.lock().expect("notice trace");
            sent.push(command.to_owned());
            let name = if sent.len() == 1 { "OrchestratorCommandPreviouslyRejectedError" } else { "UnknownError" };
            json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Failure","cause":[
                {"_tag":"Fail","error":{
                    "_tag":"OrchestrationV2DispatchCommandError", "commandId":command,
                    "commandType":"message.dispatch", "cause":{
                        "name":name, "message":format!("Command {command} was previously rejected: fixture")
                    }
                }}
            ]}})
        }).await;
        service.host = host;
        let first = seed_question(&service).await;
        service
            .notify_question(&first)
            .await
            .expect("durable rejection settles");
        let fresh = service.task("notice").await.expect("question still open");
        assert!(fresh.task.question_delivery().is_none());
        assert!(fresh.task.question().is_some());
        assert!(matches!(
            service.notify_question(&fresh).await,
            Err(ServiceError::Host(HostError::Uncertain))
        ));
        let bound = service.task("notice").await.expect("uncertain delivery");
        let id = &bound
            .task
            .question_delivery()
            .expect("frozen binding")
            .command;
        service
            .notify_question(&bound)
            .await
            .expect("wait for reply window");
        let sent = received.lock().expect("native sends");
        assert_eq!(sent.len(), 2);
        assert_ne!(sent[0], sent[1]);
        assert_eq!(sent[1], *id);
        server.abort();
    }

    #[tokio::test]
    async fn a_notice_cannot_send_or_unsettle_outside_the_fixture_project() {
        let (_home, mut service) =
            crate::tests::fixture(GitHub::new("unused-test-forge").expect("forge"));
        service.fixture_mut().acp_provider = Some("fixture-acp".into());
        let checkout = service.fixture().checkout.clone();
        let (host, server) =
            native_fixture(move |request| snapshot_reply(request, "outside", &checkout)).await;
        service.host = host;
        let row = seed_question(&service).await;
        assert!(matches!(
            service.notify_question(&row).await,
            Err(ServiceError::Host(HostError::Binding))
        ));
        assert_eq!(
            service.task("notice").await.expect("no dispatch recorded"),
            row
        );
        server.abort();
    }

    async fn seed_question(service: &Service) -> TaskRow {
        let (mut task, credential, mut observation) =
            crate::tests::reservation("notice", Entry::Brief, &service.fixture().start);
        let instance = task.run().expect("worker").launch().instance.clone();
        task.record_report(
            &instance,
            credential.as_bytes(),
            Report::Question {
                prompt: "Choose the greeting".into(),
                options: Vec::new(),
            },
        )
        .expect("authenticated question");
        observation.host = Observed::Known(Host::Current {
            instance,
            state: RunState::Ended,
        });
        assert!(matches!(task.reconcile(&observation), Action::Ask(_)));
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .expect("seed question");
        service.task("notice").await.expect("first row")
    }

    #[tokio::test]
    async fn delivered_question_rebinds_when_its_planner_is_gone() {
        let (_home, mut service) = crate::tests::fixture(GitHub::new("unused-test-forge").unwrap());
        let checkout = service.fixture().checkout.clone();
        let gone = Arc::new(AtomicBool::new(false));
        let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
        let gone_flag = Arc::clone(&gone);
        let sent_log = Arc::clone(&sent);
        let (host, server) = native_fixture(move |request| match request["tag"].as_str() {
            Some("orchestration.subscribeShell") => {
                let threads = if gone_flag.load(Ordering::Relaxed) {
                    json!([shell("planner-b", "2026-11-02T00:00:00.000Z")])
                } else {
                    json!([
                        shell("planner-a", "2026-11-02T00:00:00.000Z"),
                        shell("planner-b", "2026-11-01T00:00:00.000Z")
                    ])
                };
                json!({"_tag":"Chunk","requestId":request["id"],"values":[
                    {"kind":"snapshot","snapshotSequence":1,"snapshot":{
                        "projects":[{"id":"local-fixture","workspaceRoot":checkout}],
                        "threads": threads
                    }},
                    {"kind":"synchronized"}
                ]})
            }
            Some("orchestration.subscribeThread") => {
                let id = request["payload"]["threadId"].as_str().unwrap();
                let archived = id == "planner-a" && gone_flag.load(Ordering::Relaxed);
                let delivered = sent_log
                    .lock()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|send| send["threadId"] == id)
                    .cloned();
                let (messages, runs) = match delivered {
                    Some(record) => {
                        let msg = record["messageId"].clone();
                        (
                            json!([{"id": msg, "runId": "run-1"}]),
                            json!([{"id": "run-1", "userMessageId": msg, "status": "running", "startedAt": "2026-11-24T10:00:00Z"}]),
                        )
                    }
                    None => (json!([]), json!([])),
                };
                json!({"_tag":"Chunk","requestId":request["id"],"values":[
                    {"kind":"snapshot","snapshotSequence":2,"projection":{
                        "thread":{
                            "id": id,
                            "projectId": "local-fixture",
                            "archivedAt": archived.then_some("2026-11-24T11:00:00Z")
                        },
                        "messages": messages,
                        "runs": runs
                    }},
                    {"kind":"synchronized"}
                ]})
            }
            Some("orchestration.dispatchCommand") => {
                sent_log.lock().unwrap().push(request["payload"].clone());
                json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{"sequence":3}}})
            }
            other => panic!("unexpected request: {other:?}"),
        })
        .await;
        service.host = host;

        let row = seed_question(&service).await;
        service.notify_question(&row).await.unwrap();
        let bound = service.task("notice").await.unwrap();
        assert_eq!(bound.task.question_delivery().unwrap().thread, "planner-a");

        // While planner-a is alive and started, no second send occurs.
        service.notify_question(&bound).await.unwrap();
        assert_eq!(sent.lock().unwrap().len(), 1);

        // Once planner-a is archived, the question rebinds to planner-b.
        gone.store(true, Ordering::Relaxed);
        service.notify_question(&bound).await.unwrap();
        let rebound = service.task("notice").await.unwrap();
        assert_eq!(
            rebound.task.question_delivery().unwrap().thread,
            "planner-b"
        );
        let sends = sent.lock().unwrap();
        assert_eq!(sends.len(), 2);
        assert_eq!(sends[0]["threadId"], "planner-a");
        assert_eq!(sends[1]["threadId"], "planner-b");
        assert_ne!(sends[0]["commandId"], sends[1]["commandId"]);
        server.abort();
    }

    #[tokio::test]
    async fn unsent_question_delivery_resends_only_when_no_send_was_attempted() {
        for attempted in [false, true] {
            let (_home, mut service) =
                crate::tests::fixture(GitHub::new("unused-test-forge").unwrap());
            let checkout = service.fixture().checkout.clone();
            let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
            let sent_log = Arc::clone(&sent);
            let (host, server) = native_fixture(move |request| match request["tag"].as_str() {
                Some("orchestration.subscribeThread") => {
                    let id = request["payload"]["threadId"].as_str().unwrap();
                    json!({"_tag":"Chunk","requestId":request["id"],"values":[
                        {"kind":"snapshot","snapshotSequence":2,"projection":{
                            "thread":{"id": id, "projectId": "local-fixture"},
                            "messages": [],
                            "runs": []
                        }},
                        {"kind":"synchronized"}
                    ]})
                }
                Some("orchestration.subscribeShell") => {
                    json!({"_tag":"Chunk","requestId":request["id"],"values":[
                        {"kind":"snapshot","snapshotSequence":1,"snapshot":{
                            "projects":[{"id":"local-fixture","workspaceRoot":checkout}],
                            "threads":[shell("planner-a", "2026-11-02T00:00:00.000Z")]
                        }},
                        {"kind":"synchronized"}
                    ]})
                }
                Some("orchestration.dispatchCommand") => {
                    sent_log.lock().unwrap().push(request["payload"].clone());
                    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{"sequence":3}}})
                }
                other => panic!("unexpected request: {other:?}"),
            })
            .await;
            service.host = host;

            let row = seed_question(&service).await;
            let mut delivery = T3::prepare_notice(
                "planner-a".into(),
                "saved-before-send".into(),
                "Please decide",
            )
            .unwrap();
            if attempted {
                delivery.last_send_at_ms = Some(1_000);
            }
            let mut updated = row.task.clone();
            assert!(updated.bind_question_delivery(delivery));
            let saved = service
                .save(&row, updated, &event("seed_delivery"))
                .await
                .unwrap();

            service.notify_question(&saved).await.unwrap();
            let sends = sent.lock().unwrap().clone();
            if attempted {
                // Uncertain delivery (last_send_at_ms set, message absent) must never resend.
                assert!(sends.is_empty());
            } else {
                // Unsent delivery (last_send_at_ms None, message absent) sends the recorded command.
                assert_eq!(sends.len(), 1);
                assert_eq!(sends[0]["commandId"], "saved-before-send");
                let after = service.task("notice").await.unwrap();
                assert!(
                    after
                        .task
                        .question_delivery()
                        .unwrap()
                        .last_send_at_ms
                        .is_some()
                );
            }
            server.abort();
        }
    }

    async fn prime_then_503_host(
        thread: &str,
        checkout: &Path,
    ) -> (T3, tokio::task::JoinHandle<()>) {
        let reject = Arc::new(AtomicBool::new(false));
        let thread_id = thread.to_owned();
        let (host, server) =
            crate::tests::native_fixture_with_ticket_gate(Arc::clone(&reject), move |req| {
                assert_eq!(req["tag"], "orchestration.subscribeThread");
                json!({
                    "_tag":"Chunk","requestId":req["id"],"values":[
                        {"kind":"snapshot","snapshotSequence":2,"projection":{
                            "thread":{"id":thread_id,"projectId":"local-fixture","updatedAt":"2026-11-24T10:00:00Z"},
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
                    "id":thread,"projectId":"local-fixture",
                    "updatedAt":"2026-11-24T10:00:00Z","archivedAt":null,"deletedAt":null
                }]
            }
        }));
        let probe = T3::prepare_notice(thread.into(), "probe".into(), "probe").unwrap();
        let _ = host.observe_notice(&probe).await.unwrap();
        reject.store(true, Ordering::Relaxed);
        host.fixture_disconnect();
        (host, server)
    }

    #[tokio::test]
    async fn uncertain_drop_after_send_keeps_question_bound_while_not_sent_clears_it() {
        // Part 1: pre-send 503 returns NotSent(Unavailable), clears question_delivery and audits it.
        let (_home, mut service) = crate::tests::fixture(GitHub::new("unused-test-forge").unwrap());
        let checkout = service.fixture().checkout.clone();
        let (host, server) = prime_then_503_host("planner-a", &checkout).await;
        service.host = host;

        let row = seed_question(&service).await;
        let err = service.notify_question(&row).await.unwrap_err();
        assert!(matches!(err, ServiceError::Host(HostError::Unavailable)));
        let cleared = service.task("notice").await.unwrap();
        assert_eq!(cleared.task.question_delivery(), None);
        let history = service.history("notice", None, 20).await.unwrap();
        assert!(
            history
                .iter()
                .any(|entry| entry.content.kind == "question_delivery_not_sent")
        );
        server.abort();

        // Part 2: post-send drop after receiving dispatchCommand keeps question_delivery bound.
        let (_home, mut service) = crate::tests::fixture(GitHub::new("unused-test-forge").unwrap());
        let checkout = service.fixture().checkout.clone();
        let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sent_log = Arc::clone(&sent);
        let (host, server) = native_fixture(move |request| match request["tag"].as_str() {
            Some("orchestration.subscribeShell") => json!({
                "_tag":"Chunk","requestId":request["id"],"values":[
                    {"kind":"snapshot","snapshotSequence":1,"snapshot":{
                        "projects":[{"id":"local-fixture","workspaceRoot":checkout}],
                        "threads":[shell("planner-a", "2026-11-02T00:00:00.000Z")]
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
            Some("orchestration.dispatchCommand") => {
                sent_log.lock().unwrap().push(request["payload"].clone());
                Value::Null
            }
            other => panic!("unexpected request: {other:?}"),
        })
        .await;
        service.host = host;

        let row = seed_question(&service).await;
        let err = service.notify_question(&row).await.unwrap_err();
        assert!(matches!(err, ServiceError::Host(HostError::Unavailable)));
        let after = service.task("notice").await.unwrap();
        let delivery = after
            .task
            .question_delivery()
            .expect("uncertain delivery stays bound");
        assert!(delivery.last_send_at_ms.is_some());
        assert_eq!(sent.lock().unwrap().len(), 1);
        server.abort();
    }

    fn snapshot_reply(req: &Value, strongest: &str, checkout: &Path) -> Value {
        let mut projection = match req["tag"].as_str() {
            Some("orchestration.subscribeShell") => json!({"snapshot": {
                "projects": [{"id":"local-fixture", "workspaceRoot": checkout}],
                "threads": [
                shell(strongest, "2026-11-02T00:00:00.000Z"),
                shell("planner-other", "2026-11-01T00:00:00.000Z"),
                {"id":"task-session","projectId":"local-fixture","updatedAt":"2026-11-03T00:00:00.000Z","providerInstanceId":"fixture-acp"},
                {"id":"role-child","projectId":"local-fixture","updatedAt":"2026-11-03T00:00:00.000Z","parentThreadId":"task-session"}
            ]}}),
            Some("orchestration.subscribeThread") => {
                let id = req["payload"]["threadId"].as_str().expect("exact thread");
                if id == "unverified" {
                    return json!({"_tag":"Exit","requestId":req["id"],"exit":{
                        "_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"ReadUnavailable"}}]
                    }});
                }
                json!({"projection": {"thread": {
                                    "id": if id == "mismatch" { "another-thread" } else { id },
                                    "projectId": if id == "outside" { "other-project" } else { "local-fixture" },
                                    "settledAt": (id == "outside").then_some("2026-11-01T00:00:00.000Z"),
                                    "archivedAt": (id == "gone").then_some("2026-11-01T00:00:00.000Z")
                                }, "messages":[], "runs":[]}})
            }
            _ => panic!("unexpected method"),
        };
        projection["kind"] = json!("snapshot");
        projection["snapshotSequence"] = json!(16);
        json!({
            "_tag": "Chunk", "requestId": req["id"],
            "values": [projection, {"kind":"synchronized"}],
        })
    }

    fn shell(id: &str, time: &str) -> Value {
        json!({"id": id, "projectId": "local-fixture", "updatedAt": time})
    }
}
