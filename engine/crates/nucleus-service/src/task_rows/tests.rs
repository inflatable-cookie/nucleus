use std::sync::{Arc, Mutex};

use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use nucleus_core::{
    Action, Authority, CheckState, Command, Entry, Forge, Host, Observed, Phase, Question, Repair,
    Report, Review, RunState, Task, WaitReason,
};
use nucleus_forge::GitHub;
use nucleus_hosts::Binding;
use nucleus_store::TaskAdmissionFacts;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::{
    schedule::Priority,
    tests::{REPOSITORY, fixture, native_fixture, reservation},
    web::{Controller, router},
};

const ID: &str = "row";
const PROVIDER: &str = "fixture-acp";
const OPERATOR_SNOOZE: &str = "2099-06-01T12:00:00.000Z";

fn pending_task() -> Task {
    Task::new(
        nucleus_core::Identity {
            id: ID.into(),
            reference: ID.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "Synthetic task".into(),
        None,
    )
}

#[derive(Default)]
struct NativeRow {
    until: Value,
    settled_at: Value,
    commands: Vec<Value>,
    fail_next: bool,
    child: Option<Value>,
}

struct Fixture {
    service: Arc<Service>,
    native: Arc<Mutex<NativeRow>>,
    binding: Binding,
    thread: String,
    clear_retries: tokio::sync::Mutex<BTreeMap<String, u64>>,
    _home: tempfile::TempDir,
    server: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new(task: &Task) -> Self {
        let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
        let binding = {
            let work = service.worktrees().unwrap();
            let checkout = work
                .checkout(&service.fixture().checkout, &task.identity().repository, ID)
                .unwrap();
            checkout.allocate(&service.fixture().start).unwrap();
            service.binding(&checkout).unwrap()
        };
        let thread = nucleus_hosts::parent_thread(Path::new(&binding.worktree_path));
        let native = Arc::new(Mutex::new(NativeRow::default()));
        let seen = Arc::clone(&native);
        let destination = binding.clone();
        let expected = thread.clone();
        let (host, server) = native_fixture(move |request| {
            let mut row = seen.lock().unwrap();
            match request["tag"].as_str().unwrap() {
                "orchestration.subscribeThread" => {
                    assert_eq!(request["payload"]["threadId"], expected);
                    json!({"_tag":"Chunk","requestId":request["id"],"values":[
                        {"kind":"snapshot","snapshotSequence":1 + row.commands.len(),"projection":{
                            "thread":{"id":expected,"projectId":destination.project_id,
                                "worktreePath":destination.worktree_path,"branch":destination.branch,
                                "providerInstanceId":PROVIDER,
                                "modelSelection":{"instanceId":PROVIDER,"model":"nucleus"},
                                "snoozedUntil":row.until,"settledAt":row.settled_at},
                            "runs":[],"messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[],"subagents":[]
                        }},
                        {"kind":"synchronized"}
                    ]})
                }
                "orchestration.dispatchCommand" => {
                    let payload = &request["payload"];
                    assert_eq!(payload["threadId"], expected);
                    row.commands.push(payload.clone());
                    if std::mem::take(&mut row.fail_next) {
                        return json!({"_tag":"Exit","requestId":request["id"],
                            "exit":{"_tag":"Failure","cause":[]}});
                    }
                    match payload["type"].as_str().unwrap() {
                        "thread.snooze" => row.until = payload["snoozedUntil"].clone(),
                        "thread.unsnooze" => {
                            assert_eq!(payload["reason"], "user");
                            row.until = Value::Null;
                        }
                        "thread.unsettle" => {
                            assert_eq!(payload["reason"], "user");
                            row.settled_at = Value::Null;
                        }
                        "message.dispatch" => {
                            assert!(row.until.is_null() && row.settled_at.is_null());
                        }
                        other => panic!("unexpected native command {other}"),
                    }
                    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success",
                        "value":{"sequence":1 + row.commands.len()}}})
                }
                other => panic!("unexpected native operation {other}"),
            }
        }).await;
        host.use_held_shell();
        service.host = host;
        service.fixture_mut().acp_provider = Some(PROVIDER.into());
        Self {
            service: Arc::new(service),
            native,
            binding,
            thread,
            clear_retries: tokio::sync::Mutex::default(),
            _home: home,
            server,
        }
    }

    async fn seed_prerequisite(&self, pending: &Task) {
        let dependency = Task::new(
            nucleus_core::Identity {
                id: "prerequisite".into(),
                reference: "prerequisite".into(),
                ..pending.identity().clone()
            },
            "Synthetic prerequisite".into(),
            None,
        );
        {
            let mut state = self.service.state.lock().await;
            state.store.create(&dependency, &event("fixture")).unwrap();
            state
                .store
                .create_with_facts(
                    pending,
                    &event("fixture"),
                    TaskAdmissionFacts {
                        prerequisites: &["prerequisite".into()],
                        ..Default::default()
                    },
                )
                .unwrap();
            self.service.desire_title(&state, pending, None);
        }
    }

    fn publish_shell(&self) {
        let row = self.native.lock().unwrap();
        let shell = json!({
            "projects":[{"id":self.binding.project_id,"workspaceRoot":self.service.fixture().checkout}],
            "threads":[{"id":self.thread,"projectId":self.binding.project_id,"providerInstanceId":PROVIDER,
                "worktreePath":self.binding.worktree_path,"branch":self.binding.branch,
                "title":"Fixture","snoozedUntil":row.until,"settledAt":row.settled_at,
                "modelSelection":{"instanceId":PROVIDER,"model":"nucleus"},
                "status":"idle","activeRunId":null,"pendingRuntimeRequest":null,"pendingBackgroundTasks":[]}]
        });
        let mut shell = shell;
        if let Some(child) = &row.child {
            shell["threads"].as_array_mut().unwrap().push(child.clone());
        }
        self.service.host.fixture_project_shell(&shell, PROVIDER);
    }

    async fn sync(&self) -> nucleus_hosts::HostCalls {
        self.publish_shell();
        let mut clear_retries = self.clear_retries.lock().await;
        let (result, calls) =
            nucleus_hosts::T3::count_pass_calls(Box::pin(self.service.reconcile_task_rows(
                PROVIDER,
                std::slice::from_ref(&self.thread),
                &mut clear_retries,
            )))
            .await;
        result.unwrap();
        assert!(!calls.contains_key("orchestration.subscribeThread"));
        calls
    }

    fn child(&self, id: &str, busy: bool) {
        self.native.lock().unwrap().child = Some(json!({
            "id":id, "projectId":self.binding.project_id, "parentThreadId":self.thread,
            "status":"idle", "activeRunId":null, "pendingRuntimeRequest":null,
            "pendingBackgroundTasks": if busy { json!([{"kind":"tool","taskId":"writer"}]) } else { json!([]) },
        }));
    }

    async fn observed_snooze(&self) -> RowSnooze {
        let state = self.service.state.lock().await;
        let receipt = state.store.row_snooze(ID, &self.thread).unwrap().unwrap();
        assert_eq!(receipt.outcome, SnoozeOutcome::Observed);
        receipt
    }

    async fn attention(&self) -> TaskAttention {
        let state = self.service.state.lock().await;
        state
            .task_attention(&self.service.lookup(&state, ID).unwrap())
            .unwrap()
    }

    // The browser task list uses this same handler and groups cards by attention.
    async fn board_task(&self) -> Value {
        let key = [2; 32];
        let api = router(
            Arc::clone(&self.service),
            [Controller {
                credential: key,
                authority: Authority::Operator {
                    actor: "fixture".into(),
                },
            }],
        );
        let response = api
            .oneshot(
                Request::get("/v1/tasks")
                    .header("host", "127.0.0.1:9")
                    .header("authorization", format!("Bearer {}", hex::encode(key)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let cards: Vec<Value> = serde_json::from_slice(&body).unwrap();
        cards
            .into_iter()
            .find(|card| card["identity"]["id"] == ID)
            .expect("fixture task appears in the board list")
    }

    fn commands(&self) -> Vec<String> {
        self.native
            .lock()
            .unwrap()
            .commands
            .iter()
            .map(|payload| payload["type"].as_str().unwrap().into())
            .collect()
    }

    async fn assert_operator_snooze_receipt(&self, row: &TaskRow) {
        for kind in ["native_turn_intent", "acp_row_refresh_intent"] {
            let write = self
                .service
                .host
                .prepare_parent_refresh(&self.binding, PROVIDER)
                .await
                .unwrap()
                .unwrap();
            let error = self
                .service
                .deliver_parent(row, write, "fixture", Some(kind))
                .await
                .unwrap_err();
            assert!(matches!(error, ServiceError::ParentNotSent { .. }));
            assert!(error.to_string().contains("operator snooze is active"));
        }
        let history = self.service.history(ID, None, 100).await.unwrap();
        assert!(history.iter().all(|event| !matches!(
            event.content.kind.as_str(),
            "native_turn_intent" | "acp_row_refresh_intent" | "native_turn_not_sent"
        )));
    }
}

#[tokio::test]
async fn failed_snooze_waits_for_later_shell_evidence() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    {
        let mut state = fixture.service.state.lock().await;
        state.store.create(&pending, &event("fixture")).unwrap();
        fixture.service.desire_title(&state, &pending, None);
    }
    fixture.native.lock().unwrap().fail_next = true;
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    assert!(
        !fixture
            .service
            .host
            .host_calls()
            .contains_key("orchestration.subscribeThread")
    );
    let receipt = fixture
        .service
        .state
        .lock()
        .await
        .store
        .row_snooze(ID, &fixture.thread)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.outcome, SnoozeOutcome::Unknown);
    {
        let mut native = fixture.native.lock().unwrap();
        assert!(native.until.is_null());
        native.until = native.commands[0]["snoozedUntil"].clone();
    }
    fixture.sync().await;
    assert_eq!(fixture.observed_snooze().await.until_ms, receipt.until_ms);
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    assert!(
        !fixture
            .service
            .host
            .host_calls()
            .contains_key("orchestration.subscribeThread")
    );
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn board_and_native_row_distinguish_a_recheck_from_an_owner_action() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (mut task, _, _) = reservation(ID, Entry::Brief, &service.fixture().start);
    let run = task.run().unwrap().launch().clone();
    task.record_send(&run.instance, 1).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        state.role_observations.insert(
            ID.into(),
            (run.instance.clone(), RunState::IdleWithoutTerminalRun),
        );
        state.store.create(&task, &event("fixture")).unwrap();
        service.desire_title(&state, &task, None);
        service.lookup(&state, ID).unwrap()
    };
    let unknown = Ok(Action::Wait(WaitReason::HostUnknown));
    service
        .schedule_result(&row, &unknown, Priority::Effect)
        .await
        .unwrap();
    let checking = fixture.board_task().await;
    assert_eq!(checking["attention"], "waiting");
    assert_eq!(checking["wait"], "host_unknown");
    assert_eq!(checking["waitDetail"], "Waiting for delivery confirmation.");
    assert!(checking["nextCheckAt"].as_u64().unwrap() > now_ms());

    fixture.child(&run.thread, true);
    fixture.sync().await;
    assert!(fixture.commands().is_empty());
    fixture.child(&run.thread, false);
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    fixture.observed_snooze().await;

    {
        let mut state = service.state.lock().await;
        let due = state.schedule.due(ID).unwrap();
        assert!(state.schedule.recover_host_observation(ID, due, None));
    }
    service
        .schedule_result(&row, &unknown, Priority::Effect)
        .await
        .unwrap();
    let blocked = fixture.board_task().await;
    assert_eq!(blocked["version"], checking["version"]);
    assert_eq!(blocked["attention"], "attention");
    assert_eq!(blocked["wait"], "host_observation_blocked");
    assert_eq!(
        blocked["waitDetail"],
        "Couldn’t confirm delivery. Open the task thread to check."
    );
    assert!(blocked["nextCheckAt"].is_null());
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
}

#[tokio::test]
async fn checking_without_a_due_send_snoozes_once_after_a_prior_wake() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        state
            .observe_wait_detail(
                &task,
                Some(WaitReason::HostUnknown),
                Some(WaitDetail::ShowingForDelivery(None)),
            )
            .unwrap();
        state.schedule.wake(
            ID,
            tokio::time::Instant::now() + Duration::from_secs(30),
            Priority::Effect,
        );
        service.desire_title(&state, &task, None);
    }
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
}

#[tokio::test]
async fn late_operator_snooze_resumes_the_same_parent_intent_on_shell_wake() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.track(&mut state, &task);
        service.lookup(&state, ID).unwrap()
    };
    fixture.publish_shell();
    let pending_catalogue = std::future::pending();
    let nucleus_hosts::ParentStep::Write(write) = service
        .host
        .prepare_parent(
            &fixture.binding,
            PROVIDER,
            "Fixture",
            "Preparing the task thread.",
            None,
            pending_catalogue,
        )
        .await
        .unwrap()
    else {
        panic!("the bound shell can prepare a pinned hold");
    };
    let command = write.command_id().unwrap().to_owned();
    let runtime = service.host.runtime_identity().unwrap();
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();
    let error = service
        .deliver_parent(&row, write, &runtime, Some("native_turn_intent"))
        .await
        .unwrap_err();
    assert!(matches!(error, ServiceError::OperatorSnoozed { .. }));
    assert!(fixture.commands().is_empty());
    service
        .schedule_result(&row, &Err(error), Priority::Effect)
        .await
        .unwrap();
    assert!(service.operator_snooze_wait(&row).await.is_some());
    let board = fixture.board_task().await;
    assert_eq!(board["stateLabel"], "You snoozed this thread");
    assert!(board["waitDetail"].as_str().unwrap().contains("until"));
    assert_eq!(fixture.attention().await, TaskAttention::Waiting);
    assert!(service.state.lock().await.schedule.due(ID).unwrap() > tokio::time::Instant::now());

    fixture.native.lock().unwrap().until = Value::Null;
    fixture.publish_shell();
    let hint = nucleus_hosts::ThreadHint::fixture(&json!({"kind":"thread.updated","thread":{
        "id":fixture.thread, "snoozedUntil":null,
    }}))
    .unwrap();
    service.wake_from_host(hint).await;
    assert!(service.operator_snooze_wait(&row).await.is_none());
    assert!(service.state.lock().await.schedule.due(ID).unwrap() <= tokio::time::Instant::now());
    let nucleus_hosts::ParentStep::Write(retry) = service
        .host
        .prepare_parent(
            &fixture.binding,
            PROVIDER,
            "Fixture",
            "Preparing the task thread.",
            Some(nucleus_hosts::ParentAttempt {
                command: &command,
                released: false,
            }),
            std::future::pending(),
        )
        .await
        .unwrap()
    else {
        panic!("operator wake should resume the frozen hold");
    };
    assert_eq!(retry.command_id(), Some(command.as_str()));
    service
        .deliver_parent(&row, retry, &runtime, Some("native_turn_intent"))
        .await
        .unwrap();
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    assert_eq!(
        fixture.native.lock().unwrap().commands[0]["commandId"],
        command
    );
    let history = service.history(ID, None, 100).await.unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|event| event.content.kind == "native_turn_intent")
            .count(),
        1
    );
    assert!(
        history
            .iter()
            .all(|event| event.content.kind != "native_turn_replay")
    );
}

#[tokio::test]
async fn lost_pinned_parent_reply_reopens_the_original_intent_and_wire() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create(&pending_task(), &event("fixture"))
            .unwrap();
        service.lookup(&state, ID).unwrap()
    };
    fixture.publish_shell();
    let prepare = |prompt, prior| {
        service.host.prepare_parent(
            &fixture.binding,
            PROVIDER,
            "Fixture",
            prompt,
            prior,
            std::future::pending(),
        )
    };
    let nucleus_hosts::ParentStep::Write(write) =
        prepare("Original task prompt", None).await.unwrap()
    else {
        panic!("prepare a pinned parent hold");
    };
    let command = write.command_id().unwrap().to_owned();
    let session = service.host.runtime_identity().unwrap();
    fixture.native.lock().unwrap().fail_next = true;
    assert!(matches!(
        service
            .deliver_parent(&row, write, &session, Some("native_turn_intent"))
            .await,
        Err(ServiceError::ParentDeliveryUnknown(_))
    ));
    let reopened = nucleus_store::Store::open(&service.storage).unwrap();
    let original = reopened
        .task_turn_command(ID, "native_turn_intent", row.version, &session)
        .unwrap()
        .unwrap();
    assert_eq!(original, command);
    let retry = || {
        prepare(
            "A later render must not change the frozen prompt",
            Some(nucleus_hosts::ParentAttempt {
                command: &command,
                released: false,
            }),
        )
    };
    let nucleus_hosts::ParentStep::Write(refused) = retry().await.unwrap() else {
        panic!("retry the known command after a lost reply");
    };
    service
        .host
        .fixture_project_shell(&json!({"projects":[],"threads":[]}), PROVIDER);
    assert!(matches!(
        service
            .deliver_parent(&row, refused, &session, Some("native_turn_intent"))
            .await,
        Err(ServiceError::ParentNotSent { .. })
    ));
    assert_eq!(fixture.commands().len(), 1);
    assert!(matches!(
        reopened.task_turn_attempt(ID, "native_turn_intent", row.version, &session, &command),
        Ok(Some((_, false)))
    ));
    fixture.publish_shell();
    let nucleus_hosts::ParentStep::Write(write) = retry().await.unwrap() else {
        panic!("retry the known command after a lost reply");
    };
    assert!(
        service
            .deliver_parent(&row, write, &session, Some("native_turn_intent"))
            .await
            .unwrap()
    );
    {
        let native = fixture.native.lock().unwrap();
        assert_eq!(native.commands.len(), 2);
        assert_eq!(native.commands[0], native.commands[1]);
    }
    let history = service.history(ID, None, 100).await.unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|event| event.content.kind == "native_turn_intent")
            .count(),
        1
    );
    assert!(
        history
            .iter()
            .all(|event| event.content.kind != "native_turn_replay")
    );
}

#[tokio::test]
async fn no_new_snooze_from_reservation_through_send() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (mut worker, _, _) = reservation(ID, Entry::Brief, &service.fixture().start);
    let launch = worker.run().unwrap().launch().clone();
    fixture.child(&launch.thread, false);
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&worker, &event("fixture")).unwrap();
        state.set_wait(ID, Some(WaitReason::HostUnknown));
        service.desire_title(&state, &worker, None);
        service.lookup(&state, ID).unwrap()
    };
    let board = fixture.board_task().await;
    assert_eq!(board["stateLabel"], "Starting");
    assert!(board["waitDetail"].is_null());
    assert!(
        board["lifecycle"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["note"] == "Starting")
    );
    let ready = Observed::Known(Host::Current {
        instance: launch.instance.clone(),
        state: RunState::ReadyToSend,
    });
    service.observe_role_state(&row, &ready).await.unwrap();
    fixture.sync().await;
    assert!(fixture.commands().is_empty());

    worker.record_send(&launch.instance, now_ms()).unwrap();
    let sent = service
        .save(&row, worker, &event("host_send"))
        .await
        .unwrap();
    service.observe_role_state(&sent, &ready).await.unwrap();
    fixture.sync().await;
    assert!(
        fixture.commands().is_empty(),
        "native visibility cannot snooze between reservation and send"
    );
}

#[tokio::test]
async fn a_reserved_reviewer_without_a_native_thread_allows_the_capacity_snooze() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (task, _, _) = crate::tests::reserved_reviewer(ID, &service.fixture().start);
    let run = task.run().unwrap().launch();
    let worker = task.threads().get(Role::Worker).unwrap();
    assert_ne!(worker, run.thread);
    fixture.child(worker, false);
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("run_reserved")).unwrap();
        service.desire_title(&state, &task, None);
        service.lookup(&state, ID).unwrap()
    };
    service
        .observe_role_state(
            &row,
            &Observed::Known(Host::Current {
                instance: run.instance.clone(),
                state: RunState::ReadyToSend,
            }),
        )
        .await
        .unwrap();
    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(WaitReason::Capacity)),
            Priority::Effect,
        )
        .await
        .unwrap();
    let card = fixture.board_task().await;
    assert_eq!(card["stateLabel"], "Waiting for capacity");
    assert_eq!(card["attention"], "waiting");
    fixture
        .native
        .lock()
        .unwrap()
        .child
        .as_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("pendingBackgroundTasks");
    assert!(fixture.sync().await.is_empty());
    fixture.child(worker, true);
    assert!(fixture.sync().await.is_empty());
    fixture.child(worker, false);
    fixture.publish_shell();
    let mut sent = task.clone();
    sent.record_send(&run.instance, 3).unwrap();
    assert_eq!(
        service
            .host
            .row_children(&fixture.thread, &visibility_roles(&sent)),
        RowChildren::Unknown
    );
    let first = fixture.sync().await;
    assert_eq!(first.get("orchestration.dispatchCommand"), Some(&1));
    assert!(fixture.sync().await.is_empty());
    assert!(fixture.sync().await.is_empty());
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    fixture.observed_snooze().await;
}

#[tokio::test]
async fn native_rows_follow_dependency_wait_run_and_question() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    let (mut worker, credential, mut observation) =
        reservation(ID, Entry::Brief, &service.fixture().start);
    fixture.seed_prerequisite(&pending).await;
    assert_eq!(fixture.attention().await, TaskAttention::Waiting);
    fixture.sync().await;
    fixture.sync().await;
    assert!(fixture.observed_snooze().await.until_ms > now_ms() + RENEW_BEFORE_MS);
    assert_eq!(fixture.commands(), ["thread.snooze"]);

    let instance = worker.run().unwrap().launch().instance.clone();
    worker.record_send(&instance, 1).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        let prior = service.lookup(&state, ID).unwrap();
        state
            .store
            .save_brief_with_dependencies(
                &prior,
                &pending,
                &event("dependency_released"),
                &[],
                None,
            )
            .unwrap();
        let released = service.lookup(&state, ID).unwrap();
        service
            .commit(&mut state, &released, &worker, &event("run_reserved"), None)
            .unwrap();
        service.lookup(&state, ID).unwrap()
    };
    let observed = |state| {
        Observed::Known(Host::Current {
            instance: instance.clone(),
            state,
        })
    };
    service
        .observe_role_state(&row, &observed(RunState::Running))
        .await
        .unwrap();
    assert_eq!(fixture.attention().await, TaskAttention::Active);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);

    service
        .observe_role_state(&row, &observed(RunState::Permission))
        .await
        .unwrap();
    assert_eq!(fixture.attention().await, TaskAttention::Attention);

    service
        .observe_role_state(&row, &observed(RunState::IdleWithoutTerminalRun))
        .await
        .unwrap();
    fixture.child(&worker.run().unwrap().launch().thread, true);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    fixture.child(&worker.run().unwrap().launch().thread, false);
    fixture.sync().await;
    worker
        .record_report(
            &instance,
            credential.as_bytes(),
            Report::Question {
                prompt: "Which copy?".into(),
                options: vec!["Short".into(), "Long".into()],
            },
        )
        .unwrap();
    observation.host = observed(RunState::Ended);
    worker.reconcile(&observation);
    {
        let mut state = service.state.lock().await;
        service
            .commit(&mut state, &row, &worker, &event("question_asked"), None)
            .unwrap();
        state
            .observe_wait(&worker, Some(WaitReason::Question))
            .unwrap();
    }
    let card = fixture.board_task().await;
    assert_eq!(card["stateLabel"], "Waiting for the planner");
    assert_eq!(card["attention"], "waiting");
    fixture.sync().await;
    fixture.observed_snooze().await;
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
}

#[tokio::test]
async fn a_merge_block_waits_for_the_planner_and_snoozes_only_when_quiet() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let head = &service.fixture().start;
    let (mut task, credential, mut observation) = reservation(ID, Entry::ReviewEntry, head);
    let run = task.run().unwrap().launch().clone();
    task.record_send(&run.instance, 1).unwrap();
    task.record_report(
        &run.instance,
        credential.as_bytes(),
        Report::Review {
            head: head.clone(),
            decision: Review::Approve,
            summary: "Approve the exact head".into(),
            finding_titles: Vec::new(),
        },
    )
    .unwrap();
    observation.host = Observed::Known(Host::Current {
        instance: run.instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Merging)
    );
    let Observed::Known(Forge::Open { checks, .. }) = &mut observation.forge else {
        panic!("open fixture PR");
    };
    *checks = CheckState::Blocked;
    assert_eq!(
        task.reconcile(&observation),
        Action::Ask(Question::Repair(Repair::MergeBlocked))
    );
    {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        state
            .observe_wait(&task, Some(WaitReason::Question))
            .unwrap();
        service.desire_title(&state, &task, None);
    }
    let card = fixture.board_task().await;
    assert_eq!(card["phase"], "merging");
    assert_eq!(card["attention"], "waiting");
    assert_eq!(card["stateLabel"], "Waiting for the planner");
    fixture.child(&run.thread, true);
    fixture.sync().await;
    assert!(fixture.commands().is_empty());
    fixture.child(&run.thread, false);
    fixture.sync().await;
    fixture.sync().await;
    fixture.observed_snooze().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
}

#[tokio::test]
async fn an_actionable_row_retries_its_claimed_clear_on_the_visibility_deadline() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    {
        let mut state = service.state.lock().await;
        state.store.create(&pending, &event("fixture")).unwrap();
        service.desire_title(&state, &pending, None);
    }
    fixture.sync().await;
    fixture.sync().await;
    let mut claim = fixture.observed_snooze().await;
    claim.clear_attempted_for = Some(claim.until_ms);
    let old_horizon = fixture.native.lock().unwrap().until.clone();
    let frozen = snooze_command(ID, &fixture.thread, RowChange::Unsnooze, &claim);
    service
        .restore_row_snooze(ID, &fixture.thread, Some(&claim))
        .await
        .unwrap();
    {
        let mut state = service.state.lock().await;
        state
            .observe_wait(&pending, Some(WaitReason::Permission))
            .unwrap();
    }
    assert_eq!(fixture.attention().await, TaskAttention::Attention);

    fixture.native.lock().unwrap().fail_next = true;
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    assert!(fixture.clear_retries.lock().await[ID] > now_ms());
    fixture
        .clear_retries
        .lock()
        .await
        .insert(ID.into(), now_ms());
    fixture.sync().await;

    // An operator restores the identical horizon before the next shell observation.
    fixture.native.lock().unwrap().until = old_horizon.clone();
    fixture.sync().await;
    fixture.sync().await;
    let native = fixture.native.lock().unwrap();
    assert_eq!(native.commands.len(), 3);
    assert_eq!(native.commands[1]["commandId"], frozen);
    assert_eq!(native.commands[2]["commandId"], frozen);
    assert_eq!(native.until, old_horizon);
}

#[tokio::test]
async fn pre_delivery_wakes_owned_and_settled_rows_and_preserves_operator_snooze() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&pending, &event("fixture")).unwrap();
        service.desire_title(&state, &pending, None);
        service.lookup(&state, ID).unwrap()
    };
    fixture.sync().await;
    fixture.publish_shell();
    let fence = service.effect(&row).await.unwrap();
    let prepare = || async {
        let (write, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(
            service
                .host
                .prepare_parent_refresh(&fixture.binding, PROVIDER),
        ))
        .await;
        assert_eq!(calls.get("orchestration.subscribeThread"), Some(&1));
        write
    };
    let write = prepare().await.unwrap().unwrap();
    let (reused, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(
        service
            .host
            .prepare_parent_refresh(&fixture.binding, PROVIDER),
    ))
    .await;
    assert!(reused.unwrap().is_some());
    assert!(calls.is_empty());
    let (ready, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.wake_parent_delivery(&row, &write)))
            .await;
    assert!(matches!(ready, Err(ServiceError::ParentNotSent { .. })));
    assert!(!calls.contains_key("orchestration.subscribeThread"));
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);

    fixture.publish_shell();
    assert!(matches!(
        service.wake_parent_delivery(&row, &write).await,
        Err(ServiceError::ParentNotSent { .. })
    ));
    assert_eq!(service.task(ID).await.unwrap().version, row.version);
    let write = prepare().await.unwrap().unwrap();
    service.wake_parent_delivery(&row, &write).await.unwrap();
    let (sent, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.host.write_parent(write))).await;
    sent.unwrap();
    service
        .schedule_result(&row, &Ok(Action::Nothing), Priority::Effect)
        .await
        .unwrap();
    assert!(!calls.contains_key("orchestration.subscribeThread"));
    assert_eq!(calls.get("orchestration.dispatchCommand"), Some(&1));
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "message.dispatch"]
    );

    drop(fence);
    fixture.sync().await;
    fixture.sync().await;
    let fence = service.effect(&row).await.unwrap();
    {
        let mut native = fixture.native.lock().unwrap();
        native.until = json!(OPERATOR_SNOOZE);
        native.settled_at = json!("2026-11-23T18:10:00Z");
    }
    fixture.publish_shell();
    fixture.assert_operator_snooze_receipt(&row).await;
    assert_eq!(fixture.commands().len(), 4);
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);

    fixture.native.lock().unwrap().until = Value::Null;
    fixture.publish_shell();
    let write = prepare().await.unwrap().unwrap();
    assert!(matches!(
        service.wake_parent_delivery(&row, &write).await,
        Err(ServiceError::ParentNotSent { .. })
    ));
    assert_eq!(fixture.commands()[4..], ["thread.unsettle"]);
    fixture.publish_shell();
    let write = prepare().await.unwrap().unwrap();
    service.wake_parent_delivery(&row, &write).await.unwrap();
    let (sent, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.host.write_parent(write))).await;
    sent.unwrap();
    service
        .schedule_result(&row, &Ok(Action::Nothing), Priority::Effect)
        .await
        .unwrap();
    assert!(!calls.contains_key("orchestration.subscribeThread"));
    assert_eq!(calls.get("orchestration.dispatchCommand"), Some(&1));
    assert_eq!(
        fixture.commands()[4..],
        ["thread.unsettle", "message.dispatch"]
    );
    drop(fence);

    assert_terminal_forgets_snooze(&fixture).await;
}

#[tokio::test]
async fn an_imminent_delivery_stays_visible_across_checking_and_sends_once() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    let row = create_visibility_row(&fixture, &task).await;
    let session = service.host.runtime_identity().unwrap();
    let prepare = || {
        service
            .host
            .prepare_parent_refresh(&fixture.binding, PROVIDER)
    };
    let fence = service.effect(&row).await.unwrap();
    let result = service
        .deliver_parent(
            &row,
            prepare().await.unwrap().unwrap(),
            &session,
            Some("native_turn_intent"),
        )
        .await
        .map(|_| Action::Nothing);
    assert!(matches!(result, Err(ServiceError::ParentNotSent { .. })));
    drop(fence);

    // A due effect can already be scheduled when the watcher sees the wake.
    service
        .state
        .lock()
        .await
        .schedule
        .wake(ID, tokio::time::Instant::now(), Priority::Effect);
    fixture.sync().await;
    service
        .schedule_result(&row, &result, Priority::Effect)
        .await
        .unwrap();
    service
        .schedule_result(
            &row,
            &Err(ServiceError::Host(nucleus_hosts::HostError::Uncertain)),
            Priority::Effect,
        )
        .await
        .unwrap();
    service
        .state
        .lock()
        .await
        .schedule
        .wake(ID, tokio::time::Instant::now(), Priority::Effect);
    fixture.sync().await;
    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(WaitReason::HostUnknown)),
            Priority::Effect,
        )
        .await
        .unwrap();
    service
        .state
        .lock()
        .await
        .schedule
        .wake(ID, tokio::time::Instant::now(), Priority::Effect);
    fixture.sync().await;
    assert_eq!(fixture.attention().await, TaskAttention::Waiting);
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);

    let _fence = service.effect(&row).await.unwrap();
    let sent = service
        .deliver_parent(
            &row,
            prepare().await.unwrap().unwrap(),
            &session,
            Some("native_turn_intent"),
        )
        .await
        .unwrap();
    assert!(sent);
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "message.dispatch"]
    );
}

#[tokio::test]
async fn a_pre_wire_refusal_then_capacity_replan_allows_one_new_snooze() {
    let task = pending_task();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    let row = create_visibility_row(&fixture, &task).await;
    let session = service.host.runtime_identity().unwrap();
    let prepare = || {
        service
            .host
            .prepare_parent_refresh(&fixture.binding, PROVIDER)
    };
    let fence = service.effect(&row).await.unwrap();
    let result = service
        .deliver_parent(
            &row,
            prepare().await.unwrap().unwrap(),
            &session,
            Some("native_turn_intent"),
        )
        .await;
    assert!(matches!(result, Err(ServiceError::ParentNotSent { .. })));
    fixture.publish_shell();
    let write = prepare().await.unwrap().unwrap();
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();
    let refusal = service
        .deliver_parent(&row, write, &session, Some("native_turn_intent"))
        .await
        .map(|_| Action::Nothing);
    assert!(matches!(refusal, Err(ServiceError::ParentNotSent { .. })));
    drop(fence);
    service
        .schedule_result(&row, &refusal, Priority::Effect)
        .await
        .unwrap();
    fixture.sync().await;
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);

    // The operator clears their horizon and the next plan genuinely waits.
    fixture.native.lock().unwrap().until = Value::Null;
    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(WaitReason::Capacity)),
            Priority::Effect,
        )
        .await
        .unwrap();
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
}

#[tokio::test]
async fn the_next_engine_change_settles_a_reported_worker_despite_a_stale_shell() {
    use nucleus_core::{Observation, PullRequest, Workspace};

    let head: nucleus_core::Head = "1".repeat(40).parse().unwrap();
    let (mut task, credential, _) = reservation(ID, Entry::Brief, &head);
    let launch = task.run().unwrap().launch().clone();
    task.record_send(&launch.instance, 1).unwrap();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    fixture.child(&launch.thread, true);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["worktreePath"] =
        json!(fixture.binding.worktree_path);
    fixture.publish_shell();
    let mut changes = service.changes();
    {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        let row = service.lookup(&state, ID).unwrap();
        assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, true));
    }
    let pr = PullRequest {
        url: "https://github.com/inflatable-cookie/nucleus-fixture/pull/1".into(),
        head: head.clone(),
    };
    service
        .report(
            ID,
            &launch.instance,
            credential.as_bytes(),
            Report::Work(pr.clone().into()),
        )
        .await
        .unwrap();
    // Drop the report invalidation. No child-completion delta reaches the shell.
    assert_eq!(changes.recv().await.unwrap().task_id, ID);
    let mut state = service.state.lock().await;
    let row = service.lookup(&state, ID).unwrap();
    assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
    let mut next = row.task.clone();
    let action = next.reconcile(&Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        }),
        workspace: Observed::Known(Workspace::Clean(head)),
    });
    assert_eq!(action, Action::Advance(Phase::Reviewing));
    service
        .commit(&mut state, &row, &next, &event("phase_reconciled"), None)
        .unwrap();
    let change = changes.try_recv().unwrap();
    let next = service.lookup(&state, &change.task_id).unwrap();
    assert_eq!(change.version, next.version);
    assert_eq!(service.acp_turn_view(&state, &next).unwrap(), (None, false));
    assert!(fixture.commands().is_empty());
}

async fn create_visibility_row(fixture: &Fixture, task: &Task) -> TaskRow {
    let row = {
        let mut state = fixture.service.state.lock().await;
        state.store.create(task, &event("fixture")).unwrap();
        fixture.service.desire_title(&state, task, None);
        fixture.service.lookup(&state, ID).unwrap()
    };
    fixture.sync().await;
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    row
}

#[tokio::test]
async fn an_owned_clear_reuses_its_id_until_the_shell_observes_the_result() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&pending, &event("fixture")).unwrap();
        service.desire_title(&state, &pending, None);
        service.lookup(&state, ID).unwrap()
    };
    fixture.sync().await;
    fixture.sync().await;
    let mut claim = fixture.observed_snooze().await;
    claim.clear_attempted_for = Some(claim.until_ms);
    service
        .restore_row_snooze(ID, &fixture.thread, Some(&claim))
        .await
        .unwrap();
    let frozen = snooze_command(ID, &fixture.thread, RowChange::Unsnooze, &claim);
    let _fence = service.effect(&row).await.unwrap();
    let prepare = || {
        service
            .host
            .prepare_parent_refresh(&fixture.binding, PROVIDER)
    };
    for _ in 0..2 {
        let write = prepare().await.unwrap().unwrap();
        fixture.native.lock().unwrap().fail_next = true;
        let (ready, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(
            service.wake_parent_delivery(&row, &write),
        ))
        .await;
        assert!(matches!(ready, Err(ServiceError::ParentNotSent { .. })));
        assert!(!calls.contains_key("orchestration.subscribeThread"));
        fixture.publish_shell();
    }
    let write = prepare().await.unwrap().unwrap();
    assert!(matches!(
        service.wake_parent_delivery(&row, &write).await,
        Err(ServiceError::ParentNotSent { .. })
    ));
    {
        let native = fixture.native.lock().unwrap();
        assert_eq!(native.commands.len(), 4);
        assert!(
            native.commands[1..]
                .iter()
                .all(|command| command["commandId"] == frozen)
        );
    }
    fixture.publish_shell();
    let write = prepare().await.unwrap().unwrap();
    service.wake_parent_delivery(&row, &write).await.unwrap();
    assert_eq!(fixture.commands().len(), 4);
    assert!(
        service
            .state
            .lock()
            .await
            .store
            .row_snooze(ID, &fixture.thread)
            .unwrap()
            .is_none()
    );
}

async fn assert_terminal_forgets_snooze(fixture: &Fixture) {
    let service = &fixture.service;
    fixture.sync().await;
    let row = service.task(ID).await.unwrap();
    let mut finished = row.task.clone();
    finished
        .command(
            Command::Cancel,
            &Authority::Operator {
                actor: "fixture".into(),
            },
            &nucleus_core::Observation {
                host: Observed::Unknown,
                forge: Observed::Unknown,
                workspace: Observed::Unknown,
            },
        )
        .unwrap();
    {
        let mut state = service.state.lock().await;
        service
            .commit(&mut state, &row, &finished, &event("finished"), None)
            .unwrap();
        assert!(
            state
                .store
                .row_snooze(ID, &fixture.thread)
                .unwrap()
                .is_none()
        );
    }
    fixture.sync().await;
    assert_eq!(fixture.commands().last().unwrap(), "thread.snooze");
}

fn plan_row(
    attention: TaskAttention,
    row: RowVisibility,
    receipt: Option<RowSnooze>,
    now: u64,
) -> Plan {
    super::plan_row(attention, row, receipt, now, RowChildren::Quiet)
}

#[tokio::test]
async fn wire_veto_uses_child_activity_after_planning() {
    let fixture = Fixture::new(&pending_task()).await;
    fixture.publish_shell();
    let host = &fixture.service.host;
    let target = host
        .title_target(
            &fixture.binding,
            PROVIDER,
            fixture.service.fixture().checkout.to_str().unwrap(),
        )
        .unwrap();
    assert_eq!(host.row_children(&fixture.thread, &[]), RowChildren::Quiet);
    fixture.child("late-writer", true);
    host.fixture_shell_delta(&json!({"kind":"thread.updated","location":"active",
        "sequence":2,"thread":fixture.native.lock().unwrap().child}));
    assert_eq!(host.row_children(&fixture.thread, &[]), RowChildren::Active);
    let (result, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(host.write_row_visibility(
        &fixture.binding,
        "late-snooze",
        RowChange::SnoozeUntil(now_ms() + HORIZON_MS),
        Some(&target),
        &[],
        None,
    )))
    .await;
    assert!(matches!(
        result,
        Err(nucleus_hosts::ParentSendError::NotSent(
            nucleus_hosts::HostError::RowChildBusy
        ))
    ));
    assert!(!calls.contains_key("orchestration.subscribeThread"));
    assert!(!calls.contains_key("orchestration.dispatchCommand"));
}

#[test]
fn renewing_uses_a_new_horizon_and_uncertain_or_refused_writes_stay_observation_only() {
    let awake = RowVisibility {
        settled: false,
        settled_at_ms: None,
        snoozed_until_ms: None,
    };
    let now = 1234;
    let Plan::Write(_, mut attempt) = plan_row(TaskAttention::Waiting, awake, None, now) else {
        panic!("first waiting pass should record an intent");
    };
    let still_awake = plan_row(
        TaskAttention::Waiting,
        awake,
        Some(attempt.clone()),
        now + 1_000,
    );
    assert_eq!(still_awake, Plan::Idle(None));
    let shown = RowVisibility {
        snoozed_until_ms: Some(attempt.until_ms),
        ..awake
    };
    let Plan::Record(confirmed) = plan_row(
        TaskAttention::Waiting,
        shown,
        Some(attempt.clone()),
        now + 1_000,
    ) else {
        panic!("only an exact read confirms the snooze");
    };
    assert_eq!(confirmed.outcome, SnoozeOutcome::Observed);
    let boundary = now + RENEW_BEFORE_MS;
    assert_eq!(
        plan_row(
            TaskAttention::Waiting,
            shown,
            Some(confirmed.clone()),
            boundary
        ),
        Plan::Idle(Some(boundary + 1))
    );
    let Plan::Write(change, renewal) =
        plan_row(TaskAttention::Waiting, shown, Some(confirmed), boundary + 1)
    else {
        panic!("renew with under a day left");
    };
    assert!(matches!(change, RowChange::SnoozeUntil(until) if until > attempt.until_ms));
    assert_eq!(renewal.episode, attempt.episode);
    assert_eq!(renewal.previous_until_ms, Some(attempt.until_ms));

    attempt.outcome = SnoozeOutcome::Refused;
    assert_eq!(
        plan_row(TaskAttention::Waiting, awake, Some(attempt), boundary + 1),
        Plan::Idle(None)
    );
    let manual = RowVisibility {
        snoozed_until_ms: Some(renewal.until_ms + 1),
        ..awake
    };
    assert!(matches!(
        plan_row(
            TaskAttention::Attention,
            manual,
            Some(renewal.clone()),
            boundary + 1
        ),
        Plan::Record(_)
    ));
    assert_eq!(
        plan_row(TaskAttention::Waiting, manual, Some(renewal), boundary + 1),
        Plan::Idle(manual.snoozed_until_ms)
    );
}
