use std::{cmp::Reverse, collections::BTreeSet, path::Path, time::Duration};

use nucleus_core::{Action, Question, Task, WaitReason};
use nucleus_hosts::{
    HostError, NoticeHost, NoticeSend, NoticeState, NoticeWrite, PlannerThread, T3, T3_RETRY_DELAY,
};
use nucleus_store::{TaskRow, ThreadProvenance};
use tokio::time::Instant;

use crate::pass::DispatchTarget;
use crate::{RegisteredRole, Service, ServiceError, State, event, project::linked_checkout};

const PLANNER_REFRESH: Duration = Duration::from_secs(45);

pub(super) struct PlannerAuthority {
    live: BTreeSet<String>,
    fallback: Option<String>,
    expires: Instant,
}

struct PlannerCandidates {
    live: BTreeSet<String>,
    ranked: Vec<(u8, Reverse<String>, PlannerThread)>,
}

impl State {
    pub(super) fn invalidate_planner_authority(&mut self) {
        self.planner_authority_epoch += 1;
        self.planner_authority = None;
    }

    pub(super) fn planner_thread_closed(&mut self, thread: &str) {
        // An inventory read that started before the closure cannot publish it.
        self.planner_authority_epoch += 1;
        if self
            .planner_authority
            .as_ref()
            .is_some_and(|authority| authority.live.contains(thread))
        {
            self.planner_authority = None;
        }
    }

    pub(super) fn check_planner_authority(
        &self,
        task: &Task,
        actor: &str,
    ) -> Result<(), ServiceError> {
        let authority = self
            .planner_authority
            .as_ref()
            .filter(|authority| Instant::now() < authority.expires)
            .ok_or(ServiceError::PlannerAuthorityUnknown)?;
        let planner = task
            .identity()
            .origin_thread
            .as_deref()
            .filter(|origin| authority.live.contains(*origin))
            .or(authority.fallback.as_deref());
        if planner != Some(actor) {
            return Err(ServiceError::PlannerAuthorityRefused);
        }
        Ok(())
    }
}

impl Service {
    pub(super) async fn notify_question(&self, row: &TaskRow) -> Result<Action, ServiceError> {
        let wait = Action::Wait(WaitReason::Question);
        let bound = if let Some(delivery) = row.task.question_delivery() {
            match self.host.notice_state(delivery).await? {
                NoticeState::Started => return Ok(wait),
                NoticeState::Gone | NoticeState::Undelivered => None,
                NoticeState::Absent | NoticeState::Queued => Some(delivery),
            }
        } else {
            None
        };
        let mut attempt = if let Some(delivery) = bound {
            delivery.clone()
        } else {
            let Some(thread) = self.responsible_planner(&row.task).await? else {
                return Ok(wait);
            };
            let question = row.task.question().ok_or(ServiceError::Input)?;
            let command = format!("task-{}-question-{}", row.task.identity().id, row.version);
            T3::prepare_notice(thread, command, &notice_text(&row.task, question))?
        };
        let _fence = self.effect(row).await?;
        let Some(authorization) = self.host.authorize_notice(&attempt).await? else {
            return Ok(wait);
        };
        let target = DispatchTarget::Planner(authorization.target());
        if self.dispatch_gate(&row.task, target).await?.is_none() {
            return Ok(wait);
        }
        if authorization.needs_unsettle() {
            self.host
                .deliver_notice(NoticeWrite::Prepare(&authorization))
                .await?;
            self.recheck_effect(row, WaitReason::Question).await;
            return Ok(wait);
        }
        let dispatch = authorization.record(&mut attempt)?;
        let command = attempt.command.clone();
        let mut updated = row.task.clone();
        if !updated.bind_question_delivery(attempt) {
            return Err(ServiceError::Input);
        }
        let sent = self.save(row, updated, &event("question_delivery")).await?;
        if self
            .host
            .deliver_notice(NoticeWrite::Queue(dispatch))
            .await?
            == NoticeSend::Rejected
        {
            let mut pending = sent.task.clone();
            if !pending.clear_question_delivery(&command) {
                return Err(ServiceError::Input);
            }
            self.save(&sent, pending, &event("question_delivery_rejected"))
                .await?;
        }
        Ok(wait)
    }

    pub(super) async fn watch_planner_authority(&self) {
        loop {
            let delay = if self.refresh_planner_authority().await.is_ok() {
                PLANNER_REFRESH
            } else {
                T3_RETRY_DELAY
            };
            tokio::time::sleep(delay).await;
        }
    }

    pub(super) async fn refresh_planner_authority(&self) -> Result<(), ServiceError> {
        let epoch = self.state.lock().await.planner_authority_epoch;
        let result = self.read_planner_authority().await;
        let mut state = self.state.lock().await;
        if state.planner_authority_epoch != epoch {
            return Err(HostError::Uncertain.into());
        }
        state.planner_authority = None;
        state.planner_authority = Some(result?);
        Ok(())
    }

    async fn read_planner_authority(&self) -> Result<PlannerAuthority, ServiceError> {
        let PlannerCandidates { live, ranked } = self.planner_candidates().await?;
        let mut fallback = None;
        for (rank, _, thread) in ranked {
            if self.planner_workspace(rank, thread.worktree_path).await? {
                fallback = Some(thread.id);
                break;
            }
        }
        Ok(PlannerAuthority {
            live,
            fallback,
            expires: Instant::now() + PLANNER_REFRESH + T3_RETRY_DELAY,
        })
    }

    async fn responsible_planner(&self, task: &Task) -> Result<Option<String>, ServiceError> {
        if let Some(origin) = &task.identity().origin_thread
            && self.host.planner_routable(origin).await?
        {
            return Ok(Some(origin.clone()));
        }
        for (rank, _, thread) in self.planner_candidates().await?.ranked {
            if self.planner_workspace(rank, thread.worktree_path).await?
                && self.host.planner_routable(&thread.id).await?
            {
                return Ok(Some(thread.id));
            }
        }
        Ok(None)
    }

    async fn planner_candidates(&self) -> Result<PlannerCandidates, ServiceError> {
        let threads = self.host.planner_threads().await?;
        let ids: Vec<_> = threads.iter().map(|thread| thread.id.as_str()).collect();
        let provenance = self
            .state
            .lock()
            .await
            .store
            .routing_provenance(&self.project.repository, &ids)?;
        let mut live = BTreeSet::new();
        let mut ranked = Vec::new();
        for thread in threads {
            if thread.archived_at.is_some()
                || thread.deleted_at.is_some()
                || thread.parent_thread_id.is_some()
                || self
                    .project
                    .acp_provider
                    .as_ref()
                    .is_some_and(|instance| thread.provider_instance_id.as_ref() == Some(instance))
                || provenance.get(&thread.id) == Some(&ThreadProvenance::TaskRole)
            {
                continue;
            }
            // Titles carry no authority. Registered roles and task provenance set
            // rank, with project membership as the last candidate source.
            let registered = self
                .project
                .agents
                .iter()
                .filter(|agent| agent.thread == thread.id)
                .map(|agent| match agent.role {
                    RegisteredRole::Planner => 0,
                    RegisteredRole::Agent => 1,
                })
                .min();
            let rank = registered
                .or_else(|| {
                    (provenance.get(&thread.id) == Some(&ThreadProvenance::Dispatcher)).then_some(2)
                })
                .or_else(|| (thread.project_id == self.project.host_project).then_some(3));
            if let Some(rank) = rank {
                live.insert(thread.id.clone());
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
        Ok(PlannerCandidates { live, ranked })
    }

    async fn planner_workspace(
        &self,
        rank: u8,
        worktree: Option<String>,
    ) -> Result<bool, ServiceError> {
        if rank == 3
            && let Some(worktree) = worktree
        {
            let project = self.project.checkout.clone();
            return Ok(tokio::task::spawn_blocking(move || {
                linked_checkout(&project, Path::new(&worktree))
            })
            .await
            .map_err(|_| HostError::Uncertain)??);
        }
        Ok(true)
    }
}

fn notice_text(task: &Task, question: &Question) -> String {
    let request = match question {
        Question::Work { prompt, options } if !options.is_empty() => {
            format!("{prompt}\n\nOptions\n- {}", options.join("\n- "))
        }
        Question::Work { prompt, .. } => prompt.clone(),
        Question::Retry { role } => {
            format!("The {role:?} stopped three times. Decide whether to retry.")
        }
        Question::Accept { head } => format!(
            "The PR was merged externally. Decide whether to accept closeout at commit {head}."
        ),
        Question::Repair(repair) => {
            format!("The task needs a decision about the PR or checkout ({repair:?}).")
        }
    };
    format!(
        "Task {} needs input.\n\n{request}\n\nAnswer through Nucleus.",
        task.identity().reference
    )
}

#[cfg(test)]
mod tests {
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
        let checkout = service.project.checkout.clone();
        let project = service.project.host_project.clone();
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
            let checkout = service.project.checkout.clone();
            let (host, server) =
                native_fixture(move |request| snapshot_reply(request, strongest, &checkout)).await;
            service.host = host;
            service.project.acp_provider = Some("fixture-acp".into());
            service.project.agents = [
                (strongest, RegisteredRole::Planner),
                ("planner-other", RegisteredRole::Planner),
                ("registered-agent", RegisteredRole::Agent),
                ("task-session", RegisteredRole::Planner),
                ("role-child", RegisteredRole::Planner),
            ]
            .into_iter()
            .map(|(thread, role)| crate::RegisteredAgent {
                thread: thread.into(),
                role,
            })
            .collect();
            let task = Task::new(
                Identity {
                    id: "notice".into(),
                    reference: "fixture".into(),
                    repository: service.project.repository.clone(),
                    base: service.project.base.clone(),
                    entry: Entry::Brief,
                    origin_thread: Some(origin.into()),
                },
                "fixture brief".into(),
                None,
            );
            let result = service.responsible_planner(&task).await;
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
        let checkout = service.project.checkout.clone();
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
        let checkout = service.project.checkout.clone();
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
            crate::tests::reservation("notice", Entry::Brief, &service.project.start);
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
                json!({"hasMoreHistory": id == "unverified", "projection": {"thread": {
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
