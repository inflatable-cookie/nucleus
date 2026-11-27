use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use nucleus_core::{
    Action, Authority, CheckState, Command, Entry, Forge, Host, Observed, Phase, Question, Repair,
    Report, Review, RunState, Task, WaitReason,
};
use nucleus_forge::GitHub;
use nucleus_hosts::{Binding, ParentWrite};
use nucleus_store::TaskAdmissionFacts;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::attention::TaskAttention;
use crate::{
    event,
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
    title: Option<String>,
    until: Value,
    message_at: Value,
    settled_at: Value,
    commands: Vec<Value>,
    fail_next: bool,
    child: Option<Value>,
    instant_holds: bool,
    live_holds: bool,
    parent_runs: Vec<Value>,
}

impl NativeRow {
    fn parent_activity(&self) -> Value {
        let Some(run) = self.parent_runs.last() else {
            return json!({"status":"idle","activeRunId":null,
                "pendingRuntimeRequest":null,"pendingBackgroundTasks":[]});
        };
        if self.live_holds {
            return json!({"status":"running","activeRunId":null,
                "latestRunId":run["id"],"pendingRuntimeRequest":null,"pendingBackgroundTasks":[]});
        }
        json!({"status":"waiting","activeRunId":null,"pendingRuntimeRequest":null,
            "latestRunId":run["id"],"latestRunStartedAt":run["startedAt"],
            "latestRunCompletedAt":run["completedAt"],"updatedAt":run["completedAt"],
            "pendingBackgroundTasks":[{"kind":"subagent","taskId":self.child.as_ref().unwrap()["id"]}]})
    }

    fn finish_live_hold(&mut self) {
        let old = self
            .parent_runs
            .iter_mut()
            .find(|run| run["status"] == "running")
            .unwrap();
        old["status"] = json!("completed");
        let queued = self
            .parent_runs
            .iter_mut()
            .find(|run| run["status"] == "queued")
            .unwrap();
        queued["status"] = json!("running");
        queued["startedAt"] = json!("2026-11-27T08:56:20Z");
    }
}

struct Fixture {
    service: Arc<Service>,
    native: Arc<Mutex<NativeRow>>,
    binding: Binding,
    thread: String,
    home: tempfile::TempDir,
    server: tokio::task::JoinHandle<()>,
}

impl Fixture {
    #[expect(
        clippy::too_many_lines,
        reason = "keep the native fixture protocol together"
    )]
    async fn new(task: &Task) -> Self {
        let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
        let binding = {
            let work = service.worktrees();
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
                    let target = &request["payload"]["threadId"];
                    if row.live_holds && target != &expected {
                        return json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Failure","cause":[
                            {"_tag":"Fail","error":{"_tag":"OrchestrationV2GetThreadProjectionError","threadId":target,
                                "cause":{"name":"ProjectionStoreThreadNotFoundError",
                                    "message":format!("No orchestration projection exists for thread {}.", target.as_str().unwrap())}}}
                        ]}});
                    }
                    assert_eq!(target, &expected);
                    let activity = row.parent_activity();
                    json!({"_tag":"Chunk","requestId":request["id"],"values":[
                        {"kind":"snapshot","snapshotSequence":1 + row.commands.len(),"projection":{
                            "thread":{"id":expected,"projectId":destination.project_id,
                                "worktreePath":destination.worktree_path,"branch":destination.branch,
                                "providerInstanceId":PROVIDER,
                                "modelSelection":{"instanceId":PROVIDER,"model":"nucleus"},
                                "snoozedUntil":row.until,"settledAt":row.settled_at,
                                "updatedAt":activity["updatedAt"]},
                            "runs":row.parent_runs,"messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[],"subagents":[]
                        }},
                        {"kind":"synchronized"}
                    ]})
                }
                "orchestration.dispatchCommand" => {
                    let payload = &request["payload"];
                    if row.live_holds && payload["type"] == "delegated_task.request" {
                        assert_eq!(payload["parentThreadId"], expected);
                        assert!(row.parent_runs.iter().any(|run| {
                            run["id"] == payload["parentRunId"] && run["status"] == "running"
                        }));
                        row.commands.push(payload.clone());
                        return json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{"sequence":9}}});
                    }
                    assert_eq!(payload["threadId"], expected);
                    row.commands.push(payload.clone());
                    let lose_reply = std::mem::take(&mut row.fail_next);
                    if lose_reply && !row.live_holds {
                        return json!({"_tag":"Exit","requestId":request["id"],
                            "exit":{"_tag":"Failure","cause":[]}});
                    }
                    match payload["type"].as_str().unwrap() {
                        "thread.metadata.update" => row.title = Some(payload["title"].as_str().unwrap().into()),
                        "thread.snooze" => row.until = payload["snoozedUntil"].clone(),
                        "thread.unsnooze" => {
                            assert_eq!(payload["reason"], "user");
                            row.until = Value::Null;
                        }
                        "message.dispatch" => {
                            row.settled_at = Value::Null;
                            row.until = Value::Null;
                            row.message_at = json!("2030-01-01T00:00:01Z");
                            if row.instant_holds {
                                let n = row.parent_runs.len();
                                row.parent_runs.push(json!({
                                    "id":format!("parent-run-{n}"),"status":"completed",
                                    "userMessageId":payload["messageId"],"rootNodeId":format!("root-{n}"),
                                    "startedAt":format!("2026-01-01T11:00:{n:02}.000Z"),
                                    "completedAt":format!("2026-01-01T11:00:{n:02}.100Z"),
                                }));
                            } else if row.live_holds && !row.parent_runs.iter().any(|run| run["userMessageId"] == payload["messageId"]) {
                                let n = row.parent_runs.len();
                                let queued = row.parent_runs.iter().any(|run| run["status"] == "running");
                                row.parent_runs.push(json!({
                                    "id":format!("parent-run-{n}"),
                                    "status":if queued {"queued"} else {"running"},
                                    "userMessageId":payload["messageId"],"rootNodeId":format!("root-{n}"),
                                    "startedAt":if queued {Value::Null} else {json!("2026-11-27T08:56:18Z")},
                                }));
                            }
                        }
                        other => panic!("unexpected native command {other}"),
                    }
                    if lose_reply {
                        return json!({"_tag":"Exit","requestId":request["id"],
                            "exit":{"_tag":"Failure","cause":[]}});
                    }
                    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success",
                        "value":{"sequence":1 + row.commands.len()}}})
                }
                other => panic!("unexpected native operation {other}"),
            }
        }).await;
        host.use_held_shell();
        service.host = super::super::tests::verified_native_fixture(host, home.path());
        service.fixture_mut().acp_provider = Some(PROVIDER.into());
        Self {
            service: Arc::new(service),
            native,
            binding,
            thread,
            home,
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
            self.service.desire_title(&mut state, pending, None);
        }
    }

    fn publish_shell(&self) {
        let row = self.native.lock().unwrap();
        let shell = json!({
            "projects":[{"id":self.binding.project_id,"workspaceRoot":self.service.fixture().checkout}],
            "threads":[{"id":self.thread,"projectId":self.binding.project_id,"providerInstanceId":PROVIDER,
                "worktreePath":self.binding.worktree_path,"branch":self.binding.branch,
                "title":row.title.as_deref().unwrap_or("Fixture"),"latestUserMessageAt":row.message_at,"snoozedUntil":row.until,"settledAt":row.settled_at,
                "modelSelection":{"instanceId":PROVIDER,"model":"nucleus"},
                "status":"idle","activeRunId":null,"pendingRuntimeRequest":null,"pendingBackgroundTasks":[]}]
        });
        let mut shell = shell;
        if row.instant_holds || row.live_holds {
            shell["snapshotSequence"] = json!(1 + row.commands.len());
            shell["threads"][0]
                .as_object_mut()
                .unwrap()
                .extend(row.parent_activity().as_object().unwrap().clone());
        }
        if let Some(child) = &row.child {
            shell["threads"].as_array_mut().unwrap().push(child.clone());
        }
        self.service.host.fixture_project_shell(&shell, PROVIDER);
    }

    async fn sync(&self) -> nucleus_hosts::HostCalls {
        self.publish_shell();
        self.sync_held().await
    }

    async fn sync_held(&self) -> nucleus_hosts::HostCalls {
        let (result, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(
            self.service
                .reconcile_task_rows(PROVIDER, std::slice::from_ref(&self.thread)),
        ))
        .await;
        result.unwrap();
        assert!(!calls.contains_key("orchestration.subscribeThread"));
        calls
    }

    async fn record_capacity_wait(&self, row: &TaskRow) {
        self.service
            .schedule_result(
                row,
                &Ok(Action::Wait(WaitReason::Capacity)),
                Priority::Effect,
            )
            .await
            .unwrap();
    }

    fn elapse_visibility_ms(&self, ms: u64) {
        self.service.visibility_time.store(
            self.service.visibility_now() + ms,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    fn restart(&mut self) {
        let service = &self.service;
        let settings = service.settings.clone();
        let project = service.fixture().clone();
        let callback = service.callback;
        let report_command = service.report_command.clone();
        let visibility_time = service
            .visibility_time
            .load(std::sync::atomic::Ordering::Relaxed);
        let host = nucleus_hosts::T3::new(service.host.endpoint(), "fixture").unwrap();
        let host = super::super::tests::verified_native_fixture(host, self.home.path());
        host.use_held_shell();
        let placeholder = fixture(GitHub::new("fixture").unwrap());
        let old = std::mem::replace(&mut self.service, Arc::new(placeholder.1));
        drop(old);
        self.service = Arc::new(
            Service::open(
                &settings,
                project,
                host,
                GitHub::new("fixture").unwrap(),
                callback,
                report_command,
            )
            .unwrap(),
        );
        self.service
            .visibility_time
            .store(visibility_time, std::sync::atomic::Ordering::Relaxed);
    }

    fn child(&self, id: &str, busy: bool) {
        self.native.lock().unwrap().child = Some(json!({
            "id":id, "projectId":self.binding.project_id, "parentThreadId":self.thread,
            "status":if busy {"running"} else {"completed"}, "activeRunId":if busy {json!("run-1")} else {Value::Null}, "pendingRuntimeRequest":null,
            "pendingBackgroundTasks": [],
        }));
    }

    fn waiting_reviewer(&self, background: &str) -> Value {
        let mut native = self.native.lock().unwrap();
        let child = native.child.as_mut().unwrap();
        child["status"] = json!("waiting");
        child["pendingBackgroundTasks"] = json!([
            {"kind":"monitor","taskId":background,"awaited":true},
            {"kind":"monitor","taskId":"other-awaited-monitor","awaited":true}
        ]);
        child.clone()
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

    async fn prepare_hold(&self, prompt: &str, prior: Option<&str>) -> ParentWrite {
        let step = self
            .service
            .host
            .prepare_parent(
                &self.binding,
                PROVIDER,
                "Fixture",
                prompt,
                prior.map(|command| nucleus_hosts::ParentAttempt {
                    command,
                    released: false,
                    replay_launch: false,
                    recorded_failure: false,
                }),
                std::future::pending(),
            )
            .await
            .unwrap();
        let nucleus_hosts::ParentStep::Write(write) = step else {
            panic!("prepare a pinned parent hold")
        };
        write
    }

    async fn parent_record(&self, row: &TaskRow) -> nucleus_store::ParentDelivery {
        let mut records = self
            .service
            .state
            .lock()
            .await
            .store
            .parent_deliveries(ID, row.version, None)
            .unwrap();
        assert_eq!(records.len(), 1);
        records.pop().unwrap()
    }

    async fn assert_operator_snooze_receipt(&self, row: &TaskRow) {
        for refresh in [false, true] {
            let write = self
                .service
                .host
                .prepare_parent_refresh(&self.binding, PROVIDER)
                .await
                .unwrap()
                .unwrap();
            let error = self
                .service
                .deliver_parent(row, write, None, refresh)
                .await
                .unwrap_err();
            let until = self
                .service
                .host
                .row_visibility_hint(&self.thread)
                .unwrap()
                .snoozed_until_ms
                .unwrap();
            assert!(
                matches!(&error, ServiceError::OperatorSnoozed { thread, until: observed } if thread == &self.thread && *observed == until)
            );
            self.service
                .schedule_result(row, &Err(error), Priority::Effect)
                .await
                .unwrap();
            let remaining = self
                .service
                .state
                .lock()
                .await
                .schedule
                .due(ID)
                .unwrap()
                .saturating_duration_since(tokio::time::Instant::now());
            assert!(
                remaining
                    .as_millis()
                    .abs_diff(u128::from(until.saturating_sub(now_ms())))
                    < 1000
            );
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
        fixture.service.desire_title(&mut state, &pending, None);
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

#[tokio::test]
async fn a_delivered_parent_message_supersedes_an_unconfirmed_snooze_once() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    service
        .visibility_time
        .store(1_893_456_000_000, std::sync::atomic::Ordering::Relaxed);
    {
        let mut state = service.state.lock().await;
        state.store.create(&pending, &event("fixture")).unwrap();
        service.desire_title(&mut state, &pending, None);
    }
    fixture.sync().await;
    // Dispatch clears the snooze before the shell publishes its horizon.
    {
        let mut native = fixture.native.lock().unwrap();
        native.until = Value::Null;
        native.message_at = json!("2030-01-01T00:00:01Z");
    }
    fixture.elapse_visibility_ms(2_000);
    fixture.sync().await;
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.snooze"]);
    {
        let native = fixture.native.lock().unwrap();
        assert_ne!(
            native.commands[0]["commandId"],
            native.commands[1]["commandId"]
        );
    }
    fixture.observed_snooze().await;
    assert!(fixture.sync().await.is_empty());
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
        service.desire_title(&mut state, &task, None);
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

    service
        .schedule_result(
            &row,
            &Err(ServiceError::ParentDeliveryHeld),
            Priority::Effect,
        )
        .await
        .unwrap();
    let blocked = fixture.board_task().await;
    assert_eq!(blocked["version"], checking["version"]);
    assert_eq!(blocked["attention"], "attention");
    assert_eq!(blocked["wait"], "host_observation_blocked");
    assert_eq!(
        blocked["waitDetail"],
        "No responsible planner is available. Check the earlier delivery in the task thread, then use Next to review recovery."
    );
    assert!(blocked["nextCheckAt"].is_null());
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
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();
    let error = service
        .deliver_parent(&row, write, None, false)
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
    assert_eq!(board["stateLabel"], "Queued");
    assert!(board["waitDetail"].is_null());
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
                replay_launch: false,
                recorded_failure: false,
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
        .deliver_parent(&row, retry, Some(fixture.parent_record(&row).await), false)
        .await
        .unwrap();
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    assert_eq!(
        fixture.native.lock().unwrap().commands[0]["commandId"],
        command
    );
    assert_eq!(
        fixture.parent_record(&row).await.result,
        nucleus_store::ParentResult::Accepted
    );
    assert!(
        service
            .history(ID, None, 100)
            .await
            .unwrap()
            .iter()
            .all(|entry| !entry.content.kind.starts_with("native_turn_"))
    );
}

#[tokio::test]
async fn lost_pinned_parent_reply_reopens_the_original_intent_and_wire() {
    let mut fixture = Fixture::new(&pending_task()).await;
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
    let write = fixture.prepare_hold("Original task prompt", None).await;
    let command = write.command_id().unwrap().to_owned();
    fixture.native.lock().unwrap().fail_next = true;
    assert!(matches!(
        service.deliver_parent(&row, write, None, false).await,
        Err(ServiceError::ParentDeliveryUnknown { .. })
    ));
    fixture.restart();
    let service = &fixture.service;
    fixture.publish_shell();
    let reopened = nucleus_store::Store::open(&service.storage).unwrap();
    let original = due_frozen_delivery(&reopened, &row);
    assert_eq!(original.command, command);
    let retry = || {
        fixture.prepare_hold(
            "A later render must not change the frozen prompt",
            Some(&command),
        )
    };
    let refused = retry().await;
    service
        .host
        .fixture_project_shell(&json!({"projects":[],"threads":[]}), PROVIDER);
    assert!(matches!(
        service
            .deliver_parent(&row, refused, Some(original), false)
            .await,
        Err(ServiceError::ParentNotSent { .. })
    ));
    assert_eq!(fixture.commands().len(), 1);
    let original = due_frozen_delivery(&reopened, &row);
    fixture.publish_shell();
    let write = retry().await;
    assert!(
        service
            .deliver_parent(&row, write, Some(original), false)
            .await
            .unwrap()
    );
    {
        let native = fixture.native.lock().unwrap();
        assert_eq!(native.commands.len(), 2);
        assert_eq!(native.commands[0], native.commands[1]);
    }
    assert_eq!(
        fixture.parent_record(&row).await.result,
        nucleus_store::ParentResult::Accepted
    );
    assert!(
        service
            .history(ID, None, 100)
            .await
            .unwrap()
            .iter()
            .all(|entry| !entry.content.kind.starts_with("native_turn_"))
    );
}

fn due_frozen_delivery(
    store: &nucleus_store::Store,
    row: &TaskRow,
) -> nucleus_store::ParentDelivery {
    use nucleus_store::ParentResult::Pending;
    let mut original = store
        .parent_deliveries(ID, row.version, None)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(original.result, Pending);
    assert!(original.due_ms > 0);
    store
        .finish_parent_delivery(ID, row.version, &original, Pending, 0)
        .unwrap();
    original.due_ms = 0;
    original
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "exercise ACP, the native queue and reviewer send together"
)]
async fn a_queued_parent_releases_the_live_acp_turn_and_starts_the_reserved_reviewer() {
    let mut fixture = Fixture::new(&pending_task()).await;
    fixture.native.lock().unwrap().live_holds = true;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let head = fixture.service.fixture().start.clone();
    let (forge, _, forge_server) =
        crate::tests::forge_fixture_for_branch(&head, &fixture.binding.branch).await;
    let service = Arc::get_mut(&mut fixture.service).unwrap();
    service.callback = listener.local_addr().unwrap();
    service.forge = forge;
    let (task, _, _) = crate::tests::reserved_reviewer_with(ID, &head, |task| {
        let instance = task.next_launch_instance().unwrap();
        nucleus_core::LaunchInputs {
            thread: format!("thread:delegated-task:{instance}"),
            started_at: crate::now_ms(),
            input: json!({
                "binding":fixture.binding, "parent":fixture.thread, "method":"delegate",
                "payload":{"type":"delegated_task.request","commandId":instance,
                    "parentThreadId":fixture.thread,"parentRunId":"parent-run-1","parentNodeId":"root-1",
                    "completionWake":"settled_only",
                    "task":"Review the fixture.","modelSelection":{"instanceId":"provider","model":"fixture"}}
            })
            .to_string(),
            scratch: None,
        }
    });
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.lookup(&state, ID).unwrap()
    };
    let deadline = crate::acp::run_hold_deadline(&row).unwrap();
    let access = service
        .bind_acp(
            ID,
            [2; 32],
            &Authority::Operator {
                actor: "fixture".into(),
            },
            &crate::ControllerScope::default(),
            true,
        )
        .await
        .unwrap();
    let binding = || -> nucleus_core::acp::Binding {
        serde_json::from_slice(&std::fs::read(&access.binding_path).unwrap()).unwrap()
    };
    let app = router(Arc::clone(service), []);
    let callback = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fixture.publish_shell();
    let label = "Starting reviewer round 1";
    let old = fixture.prepare_hold(label, None).await;
    let old_prompt = old.freeze().prompt().unwrap().to_owned();
    assert!(
        service
            .deliver_parent(&row, old, None, false)
            .await
            .unwrap()
    );

    let (output, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let cwd = PathBuf::from(&fixture.binding.worktree_path);
    let old_binding = binding();
    let old_cwd = cwd.clone();
    let held_prompt = old_prompt.clone();
    let turn = tokio::spawn(async move {
        nucleus_acp::fixture_task_prompt(old_binding, &old_cwd, &held_prompt, &output).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        !turn.is_finished(),
        "the old ACP client is holding its turn"
    );
    fixture.publish_shell();
    let newer = fixture.prepare_hold(label, None).await;
    let command = newer.command_id().unwrap().to_owned();
    let new_prompt = newer.freeze().prompt().unwrap().to_owned();
    assert_ne!(old_prompt, new_prompt);
    fixture.native.lock().unwrap().fail_next = true;
    assert!(matches!(
        service.deliver_parent(&row, newer, None, false).await,
        Err(ServiceError::ParentDeliveryUnknown { .. })
    ));
    fixture.publish_shell();
    {
        let native = fixture.native.lock().unwrap();
        assert_eq!(native.parent_runs[0]["status"], "running");
        assert_eq!(native.parent_runs[1]["status"], "queued");
    }
    let (step, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(service.host.prepare_parent(
        &fixture.binding,
        PROVIDER,
        "Fixture",
        label,
        Some(nucleus_hosts::ParentAttempt {
            command: &command,
            released: false,
            replay_launch: false,
            recorded_failure: false,
        }),
        std::future::pending(),
    )))
    .await;
    assert!(matches!(
        step.unwrap(),
        nucleus_hosts::ParentStep::Delivered
    ));
    assert_eq!(calls, [("orchestration.subscribeThread", 1)].into());
    eprintln!("queued parent receipt T3 calls: {calls:?}");
    let before_release = service.host.host_calls();
    tokio::time::timeout(std::time::Duration::from_secs(5), turn)
        .await
        .expect("the newer hold releases ACP before its deadline")
        .unwrap()
        .unwrap();
    assert_eq!(service.host.host_calls(), before_release);
    fixture.native.lock().unwrap().finish_live_hold();
    fixture.publish_shell();
    let row = {
        let mut state = service.state.lock().await;
        let version = service
            .commit(&mut state, &row, &task, &event("fixture_version"), None)
            .unwrap();
        assert!(version > row.version);
        let reserved = service.lookup(&state, ID).unwrap();
        assert_eq!(
            service.acp_turn_view(&state, &reserved).unwrap(),
            (Some(new_prompt.clone()), false)
        );
        reserved
    };
    let (output, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let new_binding = binding();
    let successor = tokio::spawn(async move {
        nucleus_acp::fixture_task_prompt(new_binding, &cwd, &new_prompt, &output).await
    });
    let before_attach = service.host.host_calls();
    tokio::time::timeout(std::time::Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        !successor.is_finished(),
        "the new parent prompt owns the turn"
    );
    assert_eq!(service.host.host_calls(), before_attach);
    let (result, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(
        service.advance_due_task(&row, &service.host.fixture_pass()),
    ))
    .await;
    assert!(
        matches!(
            result,
            Ok(Action::Launch {
                role: nucleus_core::Role::Reviewer,
                ..
            })
        ),
        "{result:?}"
    );
    assert_eq!(calls.get("orchestration.dispatchCommand"), Some(&1));
    eprintln!("reserved reviewer send T3 calls: {calls:?}");
    assert!(crate::now_ms() < deadline);
    assert_eq!(
        fixture.commands(),
        [
            "message.dispatch",
            "message.dispatch",
            "delegated_task.request"
        ]
    );
    assert!(
        fixture
            .native
            .lock()
            .unwrap()
            .parent_runs
            .iter()
            .all(|run| run["status"] != "queued")
    );
    successor.abort();
    callback.abort();
    forge_server.abort();
    assert!(successor.await.unwrap_err().is_cancelled());
    assert!(callback.await.unwrap_err().is_cancelled());
    assert!(forge_server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn a_reserved_role_waiting_to_send_keeps_the_parent_snoozed() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (mut worker, _, _) = reservation(ID, Entry::Brief, &service.fixture().start);
    let launch = worker.run().unwrap().launch().clone();
    fixture.child(&launch.thread, false);
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&worker, &event("fixture")).unwrap();
        state.set_wait(ID, Some(WaitReason::HostUnknown));
        service.desire_title(&mut state, &worker, None);
        service.lookup(&state, ID).unwrap()
    };
    let board = fixture.board_task().await;
    assert_eq!(board["stateLabel"], "Working · T3");
    assert!(board["waitDetail"].is_null());
    assert!(
        board["lifecycle"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["note"] == "Working · T3")
    );
    let ready = Observed::Known(Host::Current {
        instance: launch.instance.clone(),
        state: RunState::ReadyToSend,
    });
    service.observe_role_state(&row, &ready).await.unwrap();
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);

    worker.record_send(&launch.instance, now_ms()).unwrap();
    let sent = service
        .save(&row, worker, &event("host_send"))
        .await
        .unwrap();
    assert_eq!(
        crate::titles::task_state_label(&sent.task, Some(WaitReason::Starting), None),
        "Working · starting"
    );
    service.observe_role_state(&sent, &ready).await.unwrap();
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
}

#[tokio::test]
async fn restart_preserves_a_prerequisite_snooze_before_the_first_dispatch_decision() {
    let mut fixture = Fixture::new(&pending_task()).await;
    let (worker, _, _) = reservation(ID, Entry::Brief, &fixture.service.fixture().start);
    fixture.seed_prerequisite(&worker).await;
    let row = fixture.service.task(ID).await.unwrap();
    let wait = Ok(Action::Wait(WaitReason::Prerequisite));
    fixture
        .service
        .schedule_result(&row, &wait, Priority::Decision)
        .await
        .unwrap();
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    fixture.sync().await;
    let receipt = fixture.observed_snooze().await;

    fixture.restart();
    assert_eq!(fixture.attention().await, TaskAttention::Waiting);
    assert!(fixture.sync().await.is_empty());
    let row = fixture.service.task(ID).await.unwrap();
    fixture
        .service
        .schedule_result(&row, &wait, Priority::Decision)
        .await
        .unwrap();
    assert!(fixture.sync().await.is_empty());
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    assert_eq!(fixture.observed_snooze().await, receipt);
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
        service.desire_title(&mut state, &task, None);
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
            &Err(service.parent_not_sent("waiting for shell confirmation")),
            Priority::Effect,
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.sync().await.get("orchestration.dispatchCommand"),
        Some(&1)
    );
    assert!(fixture.sync().await.is_empty());
    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(WaitReason::Capacity)),
            Priority::Effect,
        )
        .await
        .unwrap();
    let card = fixture.board_task().await;
    assert_eq!(card["stateLabel"], "Reviewing · capacity");
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
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    fixture.elapse_visibility_ms(HANDOVER_MS);
    fixture.child(worker, false);
    fixture.sync().await;
    assert!(fixture.sync().await.is_empty());
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
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
    fixture.child(&worker.run().unwrap().launch().thread, true);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);

    service
        .observe_role_state(&row, &observed(RunState::Permission))
        .await
        .unwrap();
    assert_eq!(fixture.attention().await, TaskAttention::Attention);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);

    service
        .observe_role_state(&row, &observed(RunState::IdleWithoutTerminalRun))
        .await
        .unwrap();
    assert!(fixture.sync().await.is_empty());
    fixture.child(&worker.run().unwrap().launch().thread, false);
    fixture.sync().await;
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );

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
    assert_eq!(card["stateLabel"], "Working · planner");
    assert_eq!(card["attention"], "waiting");
    fixture.sync().await;
    assert_eq!(
        fixture.commands(),
        [
            "thread.snooze",
            "thread.unsnooze",
            "thread.snooze",
            "thread.unsnooze"
        ]
    );
}

#[tokio::test]
async fn a_planner_question_stays_visible_regardless_of_child_activity() {
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
        service.desire_title(&mut state, &task, None);
    }
    let card = fixture.board_task().await;
    assert_eq!(card["phase"], "merging");
    assert_eq!(card["attention"], "waiting");
    assert_eq!(card["stateLabel"], "Merging · planner");
    fixture.child(&run.thread, true);
    fixture.sync().await;
    assert!(fixture.commands().is_empty());
    fixture.child(&run.thread, false);
    fixture.sync().await;
    fixture.sync().await;
    assert!(fixture.commands().is_empty());
}

#[tokio::test]
async fn an_actionable_row_retries_its_claimed_clear_with_the_same_command() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    {
        let mut state = service.state.lock().await;
        state.store.create(&pending, &event("fixture")).unwrap();
        service.desire_title(&mut state, &pending, None);
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
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
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
        service.desire_title(&mut state, &pending, None);
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
    fixture
        .service
        .visibility_time
        .store(1_893_456_002_000, std::sync::atomic::Ordering::Relaxed);
    let mut write = write;
    write.allow_owned_snoozes(
        service
            .owned_delivery_snoozes(&row, &fixture.thread)
            .await
            .unwrap(),
    );
    service
        .check_parent_snooze(&row, write.binding(), write.delivery_row().unwrap())
        .await
        .unwrap();
    service.host.write_parent(write).await.unwrap();
    assert_eq!(fixture.commands(), ["thread.snooze", "message.dispatch"]);
    drop(fence);
    fixture.elapse_visibility_ms(HANDOVER_MS);
    fixture.sync().await;
    assert!(fixture.sync().await.is_empty());
    fixture.observed_snooze().await;
    let fence = service.effect(&row).await.unwrap();
    {
        let mut native = fixture.native.lock().unwrap();
        native.until = json!(OPERATOR_SNOOZE);
        native.settled_at = json!("2026-11-23T18:10:00Z");
    }
    fixture.publish_shell();
    fixture.assert_operator_snooze_receipt(&row).await;
    assert_eq!(fixture.commands().len(), 3);
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);

    fixture.native.lock().unwrap().until = Value::Null;
    fixture.publish_shell();
    let write = prepare().await.unwrap().unwrap();
    service
        .check_parent_snooze(&row, write.binding(), write.delivery_row().unwrap())
        .await
        .unwrap();
    let (sent, calls) =
        nucleus_hosts::T3::count_pass_calls(Box::pin(service.host.write_parent(write))).await;
    sent.unwrap();
    service
        .schedule_result(&row, &Ok(Action::Nothing), Priority::Effect)
        .await
        .unwrap();
    assert!(!calls.contains_key("orchestration.subscribeThread"));
    assert_eq!(calls.get("orchestration.dispatchCommand"), Some(&1));
    assert_eq!(fixture.commands()[3..], ["message.dispatch"]);
    drop(fence);

    assert_terminal_forgets_snooze(&fixture).await;
}

#[tokio::test]
async fn an_active_role_publishes_its_frozen_parent_prompt() {
    let head: nucleus_core::Head = "1".repeat(40).parse().unwrap();
    let (mut task, _, _) = reservation(ID, Entry::Brief, &head);
    let launch = task.run().unwrap().launch().clone();
    task.record_send(&launch.instance, 1).unwrap();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    fixture.child(&launch.thread, true);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["worktreePath"] =
        json!(fixture.binding.worktree_path);
    fixture.publish_shell();
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.lookup(&state, ID).unwrap()
    };

    let mut changes = service.changes();
    let prompt = "Continue the active worker.";
    let write = fixture.prepare_hold(prompt, None).await;
    let frozen = write.freeze().prompt().unwrap().to_owned();
    let _fence = service.effect(&row).await.unwrap();
    assert!(
        service
            .deliver_parent(&row, write, None, false)
            .await
            .unwrap()
    );
    let change = changes.try_recv().unwrap();
    assert_eq!(change.task_id, ID);
    assert_eq!(change.version, row.version);
    assert!(change.detail_only);
    let state = service.state.lock().await;
    assert_eq!(
        service.acp_turn_view(&state, &row).unwrap(),
        (Some(frozen), false)
    );
}

#[tokio::test]
async fn the_held_parent_follows_the_child_across_an_authenticated_report() {
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
    assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, true));
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
    assert_eq!(service.acp_turn_view(&state, &next).unwrap(), (None, true));
    assert!(fixture.commands().is_empty());
}

async fn instant_parent_fixture() -> (Fixture, TaskRow) {
    let head: nucleus_core::Head = "1".repeat(40).parse().unwrap();
    let (mut task, credential, mut observation) = crate::tests::reserved_reviewer(ID, &head);
    let launch = task.run().unwrap().launch().clone();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.lookup(&state, ID).unwrap()
    };
    task.record_send(&launch.instance, 2).unwrap();
    service
        .save(&row, task.clone(), &event("host_send"))
        .await
        .unwrap();
    service
        .report(
            ID,
            &launch.instance,
            credential.as_bytes(),
            Report::Review {
                head,
                decision: Review::Approve,
                summary: "Fixture reviewer approved.".into(),
                finding_titles: Vec::new(),
            },
        )
        .await
        .unwrap();
    let row = service.task(ID).await.unwrap();
    task = row.task.clone();
    observation.host = Observed::Known(Host::Current {
        instance: launch.instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Merging)
    );
    assert!(task.run().is_none());
    service
        .save(&row, task, &event("phase_reconciled"))
        .await
        .unwrap();
    let row = service.task(ID).await.unwrap();

    fixture.child(&launch.thread, false);
    {
        let mut native = fixture.native.lock().unwrap();
        native.instant_holds = true;
        let child = native.child.as_mut().unwrap();
        child["worktreePath"] = json!(fixture.binding.worktree_path);
        child["branch"] = json!(fixture.binding.branch);
        child["latestRunId"] = json!("reviewer-run-5");
    }
    fixture.waiting_reviewer("awaited-monitor-1");
    fixture.publish_shell();
    (fixture, row)
}

#[tokio::test]
async fn a_waiting_reviewer_keeps_its_hold_and_one_command_covers_unchanged_activity() {
    let (mut fixture, row) = instant_parent_fixture().await;
    fixture.service.reenter_retained_parent(&row).await.unwrap();
    let first = {
        let native = fixture.native.lock().unwrap();
        assert_eq!(native.commands.len(), 1);
        native.commands[0].clone()
    };
    fixture.publish_shell();
    {
        let state = fixture.service.state.lock().await;
        assert_eq!(
            fixture.service.acp_turn_view(&state, &row).unwrap(),
            (Some(first["text"].as_str().unwrap().to_owned()), false)
        );
    }
    fixture.restart();
    fixture.publish_shell();
    let ((), calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(async {
        for _ in 0..4 {
            fixture.service.reenter_retained_parent(&row).await.unwrap();
        }
    }))
    .await;
    assert_eq!(calls.get("orchestration.subscribeThread"), Some(&1));
    assert_eq!(fixture.commands(), ["message.dispatch"]);

    // Reordering the same background set and editing the display row are not progress.
    let mut child = fixture.waiting_reviewer("awaited-monitor-1");
    child["pendingBackgroundTasks"]
        .as_array_mut()
        .unwrap()
        .reverse();
    child["title"] = json!("Edited display title");
    fixture
        .service
        .host
        .fixture_shell_delta(&json!({"kind":"thread.updated","sequence":3,"thread":child}));
    fixture.service.reenter_retained_parent(&row).await.unwrap();
    assert_eq!(fixture.commands(), ["message.dispatch"]);

    let child = fixture.waiting_reviewer("awaited-monitor-2");
    fixture
        .service
        .host
        .fixture_shell_delta(&json!({"kind":"thread.updated","sequence":4,"thread":child}));
    fixture.service.reenter_retained_parent(&row).await.unwrap();
    fixture.publish_shell();
    fixture.service.reenter_retained_parent(&row).await.unwrap();
    assert_eq!(fixture.commands(), ["message.dispatch"; 2]);
    let native = fixture.native.lock().unwrap();
    assert_ne!(native.commands[1]["commandId"], first["commandId"]);
}

#[tokio::test]
async fn three_instant_parent_holds_surface_an_owner_action_until_the_role_changes() {
    let (fixture, row) = instant_parent_fixture().await;
    let service = &fixture.service;
    for background in [
        "awaited-monitor-1",
        "awaited-monitor-2",
        "awaited-monitor-3",
    ] {
        fixture.waiting_reviewer(background);
        fixture.publish_shell();
        service.reenter_retained_parent(&row).await.unwrap();
    }

    // New evidence already present when the third instant turn is observed
    // cannot authorise a fourth dispatch.
    let child = fixture.waiting_reviewer("awaited-monitor-4");
    fixture.publish_shell();
    let hint =
        |sequence, child| json!({"kind":"thread.updated","sequence":sequence,"thread":child});
    service
        .wake_from_host(nucleus_hosts::ThreadHint::fixture(&hint(4, child)).unwrap())
        .await;
    for _ in 0..4 {
        let result = service
            .reenter_retained_parent(&row)
            .await
            .map(|()| Action::Nothing);
        assert!(matches!(result, Err(ServiceError::ParentHoldLoop)));
        service
            .schedule_result(&row, &result, Priority::Decision)
            .await
            .unwrap();
    }
    assert_eq!(fixture.commands(), ["message.dispatch"; 3]);
    assert_eq!(fixture.attention().await, TaskAttention::Attention);
    {
        let state = service.state.lock().await;
        assert!(state.recheckable(&row.task));
        assert!(matches!(
            state.wait_detail(ID),
            Some(crate::WaitDetail::Blocked(message)) if message.contains("ended immediately three times")
        ));
        assert!(state.schedule.due(ID).is_none());
    }

    let child = fixture.waiting_reviewer("awaited-monitor-5");
    let delta = hint(5, child);
    service.host.fixture_shell_delta(&delta);
    service
        .wake_from_host(nucleus_hosts::ThreadHint::fixture(&delta).unwrap())
        .await;
    assert!(service.state.lock().await.schedule.due(ID).is_some());
    service.reenter_retained_parent(&row).await.unwrap();
    assert_eq!(fixture.commands(), ["message.dispatch"; 4]);
}

async fn create_visibility_row(fixture: &Fixture, task: &Task) -> TaskRow {
    let row = {
        let mut state = fixture.service.state.lock().await;
        state.store.create(task, &event("fixture")).unwrap();
        fixture.service.desire_title(&mut state, task, None);
        fixture.service.lookup(&state, ID).unwrap()
    };
    fixture.sync().await;
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    row
}

#[tokio::test]
async fn snoozed_closing_row_publishes_only_the_stable_title_without_a_visibility_write() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let head = &service.fixture().start;
    let (mut task, mut observation) = crate::tests::code_task_at_merge(ID, head);
    observation.forge = Observed::Known(Forge::Merged {
        pr: task.pull_request().unwrap().clone(),
        commit: head.clone(),
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Closing)
    );
    let row = create_visibility_row(&fixture, &task).await;
    let snooze = fixture.observed_snooze().await;
    let old = "Starting: #1 Synthetic change";
    fixture.native.lock().unwrap().title = Some(old.into());
    let generation = {
        let state = service.state.lock().await;
        state.store.desire_title(ID, &fixture.thread, old).unwrap();
        let prior = state.store.pending_title(&fixture.thread).unwrap().unwrap();
        state.store.confirm_title(&prior).unwrap();
        prior.generation
    };
    for result in [
        Err(service.parent_not_sent("waiting for the host")),
        Ok(Action::Wait(WaitReason::ForgeUnknown)),
    ] {
        fixture.publish_shell();
        service
            .schedule_result(&row, &result, Priority::Effect)
            .await
            .unwrap();
        let state = service.state.lock().await;
        assert!(
            state
                .store
                .pending_title(&fixture.thread)
                .unwrap()
                .is_none()
        );
    }
    {
        let mut state = service.state.lock().await;
        state
            .title_candidates
            .get_mut(&fixture.thread)
            .unwrap()
            .ready = tokio::time::Instant::now();
    }
    let title = "Closing · GitHub: #1 Synthetic change";
    {
        let mut watcher = std::pin::pin!(service.watch_titles());
        tokio::time::timeout(
            Duration::from_secs(30),
            std::future::poll_fn(|cx| {
                assert!(watcher.as_mut().poll(cx).is_pending());
                if fixture.native.lock().unwrap().title.as_deref() == Some(title) {
                    fixture.publish_shell();
                }
                if service.state.try_lock().is_ok_and(|state| {
                    state
                        .store
                        .title_state(&fixture.thread)
                        .unwrap()
                        .is_some_and(|stored| stored.confirmed && stored.receipt.desired == title)
                }) {
                    std::task::Poll::Ready(())
                } else {
                    std::task::Poll::Pending
                }
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            fixture.native.lock().unwrap().commands.last().unwrap(),
            &json!({
                "type":"thread.metadata.update", "threadId":fixture.thread,
                "commandId":format!("task-{ID}-title-{}", generation + 1), "title":title,
            })
        );
        assert!(fixture.sync().await.is_empty());
        assert_eq!(fixture.observed_snooze().await, snooze);
    }
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.metadata.update"]
    );
}

#[tokio::test]
async fn active_child_keeps_ownership_until_the_shell_observes_the_clear() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (task, _, _) = crate::tests::reserved_reviewer(ID, &service.fixture().start);
    let row = create_visibility_row(&fixture, &task).await;
    let owned = fixture.observed_snooze().await;
    fixture.child("reviewer", true);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    let prior = service.host.row_visibility_hint(&fixture.thread).unwrap();
    assert_eq!(prior.snoozed_until_ms, Some(owned.until_ms));
    assert_eq!(fixture.native.lock().unwrap().until, Value::Null);
    let receipt = fixture.observed_snooze().await;
    assert_eq!(receipt.clear_attempted_for, Some(owned.until_ms));
    assert!(receipt.owns(prior.snoozed_until_ms));
    service
        .check_parent_snooze(
            &row,
            &fixture.binding,
            RowObservation {
                sequence: 1,
                visibility: prior,
            },
        )
        .await
        .unwrap();
    {
        let mut state = service.state.lock().await;
        service
            .schedule_operator_snooze(
                &mut state,
                &row,
                &fixture.thread,
                owned.until_ms,
                "stale delivery observation".into(),
            )
            .unwrap();
        assert!(state.wait_detail(ID).is_none());
    }
    service
        .reconcile_task_row(ID, PROVIDER, &fixture.thread)
        .await
        .unwrap();
    assert_eq!(fixture.commands().len(), 2);
    fixture.sync().await;
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
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.sync().await;
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    assert_eq!(fixture.commands().len(), 2);
}

#[tokio::test]
async fn background_work_keeps_the_row_visible_and_clears_an_owned_snooze() {
    let fixture = Fixture::new(&pending_task()).await;
    let (task, _, _) = crate::tests::reserved_reviewer(ID, &fixture.service.fixture().start);
    fixture
        .service
        .visibility_time
        .store(1_893_456_000_000, std::sync::atomic::Ordering::Relaxed);
    create_visibility_row(&fixture, &task).await;
    fixture.child("worker", false);
    {
        let mut native = fixture.native.lock().unwrap();
        let child = native.child.as_mut().unwrap();
        // The captured thread.updated shell row is completed despite the thread read waiting.
        child.as_object_mut().unwrap().remove("parentThreadId");
        child["lineage"] = json!({"parentThreadId":fixture.thread,
            "rootThreadId":fixture.thread,"relationshipToParent":"subagent"});
        child["archivedAt"] = Value::Null;
        child["deletedAt"] = Value::Null;
        child["latestRunId"] = json!("worker-run");
        child["latestRunStartedAt"] = json!("2029-12-31T23:59:50Z");
        child["latestRunCompletedAt"] = json!("2030-01-01T00:00:00Z");
        child["pendingBackgroundTasks"] =
            json!([{"kind":"monitor", "taskId":"monitor", "awaited":true}]);
    }
    let child = fixture.native.lock().unwrap().child.clone().unwrap();
    fixture.service.host.fixture_shell_delta(
        &json!({"kind":"thread.updated", "sequence":1, "location":"active", "thread":child}),
    );
    let calls = fixture.sync_held().await;
    assert_eq!(calls, [("orchestration.dispatchCommand", 1)].into());
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    assert!(fixture.sync().await.is_empty());
    fixture.elapse_visibility_ms(120_001);
    assert!(fixture.sync().await.is_empty());
    {
        let state = fixture.service.state.lock().await;
        assert_eq!(fixture.service.working_row_count(&state).unwrap(), 1);
    }

    let child = {
        let mut native = fixture.native.lock().unwrap();
        let child = native.child.as_mut().unwrap();
        child["pendingBackgroundTasks"] = json!([]);
        child.clone()
    };
    fixture.service.host.fixture_shell_delta(
        &json!({"kind":"thread.updated", "sequence":2, "location":"active", "thread":child}),
    );
    let calls = fixture.sync_held().await;
    assert_eq!(calls, [("orchestration.dispatchCommand", 1)].into());
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
    assert!(fixture.sync().await.is_empty());
    fixture.observed_snooze().await;
    {
        let state = fixture.service.state.lock().await;
        assert_eq!(fixture.service.working_row_count(&state).unwrap(), 0);
    }

    let child = {
        let mut native = fixture.native.lock().unwrap();
        let child = native.child.as_mut().unwrap();
        child["pendingBackgroundTasks"] =
            json!([{"kind":"monitor", "taskId":"monitor", "awaited":true}]);
        child.clone()
    };
    fixture.service.host.fixture_shell_delta(
        &json!({"kind":"thread.updated", "sequence":3, "location":"active", "thread":child}),
    );
    let calls = fixture.sync_held().await;
    assert_eq!(calls, [("orchestration.dispatchCommand", 1)].into());
    assert_eq!(
        fixture.commands(),
        [
            "thread.snooze",
            "thread.unsnooze",
            "thread.snooze",
            "thread.unsnooze"
        ]
    );
    assert!(fixture.sync().await.is_empty());
    let state = fixture.service.state.lock().await;
    assert_eq!(fixture.service.working_row_count(&state).unwrap(), 1);
    assert!(
        state
            .store
            .row_snooze(ID, &fixture.thread)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_handover_holds_the_parent_and_uses_the_child_completion_deadline() {
    let mut fixture = Fixture::new(&pending_task()).await;
    let (task, _, _) = crate::tests::reserved_reviewer(ID, &fixture.service.fixture().start);
    let clock = 1_893_456_000_000;
    fixture
        .service
        .visibility_time
        .store(clock, std::sync::atomic::Ordering::Relaxed);
    let row = create_visibility_row(&fixture, &task).await;
    fixture.child("worker", true);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    fixture.child("worker", false);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["latestRunCompletedAt"] =
        json!("2030-01-01T00:00:00Z");
    fixture.sync().await;
    fixture.elapse_visibility_ms(119_999);
    fixture.restart();
    fixture.sync().await;
    {
        let service = &fixture.service;
        let mut state = service.state.lock().await;
        service.desire_phase_title(&mut state, &row.task, row.number);
        let title = state.store.pending_title(&fixture.thread).unwrap().unwrap();
        assert!(title.desired.starts_with("Waiting:"));
        assert!(!service.desire_title(&mut state, &row.task, row.number));
        assert!(!state.title_candidates.contains_key(&fixture.thread));
        assert_eq!(service.working_row_count(&state).unwrap(), 1);
        assert_eq!(
            fixture.service.acp_turn_view(&state, &row).unwrap(),
            (None, true)
        );
    }
    fixture.child("reviewer", true);
    fixture.sync().await;
    fixture
        .service
        .state
        .lock()
        .await
        .title_candidates
        .get_mut(&fixture.thread)
        .unwrap()
        .ready = tokio::time::Instant::now();
    fixture.sync().await;
    {
        let state = fixture.service.state.lock().await;
        assert!(
            state
                .store
                .pending_title(&fixture.thread)
                .unwrap()
                .unwrap()
                .desired
                .starts_with("Reviewing:")
        );
    }
    fixture.child("reviewer", false);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["latestRunCompletedAt"] =
        json!("2030-01-01T00:01:59.999Z");
    fixture.elapse_visibility_ms(119_999);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze", "thread.unsnooze"]);
    fixture.elapse_visibility_ms(1);
    fixture.sync().await;
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.child("reviewer", true);
    fixture.sync().await;
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);
    let state = fixture.service.state.lock().await;
    let title = state.store.pending_title(&fixture.thread).unwrap().unwrap();
    assert_eq!(fixture.service.working_row_count(&state).unwrap(), 0);
    assert!(title.desired.starts_with("Reviewing:"));
    assert_eq!(fixture.commands().len(), 3);
}

#[tokio::test]
async fn a_handover_publishes_permission_and_planner_titles_immediately() {
    let fixture = Fixture::new(&pending_task()).await;
    let service = &fixture.service;
    let (mut task, _, _) = crate::tests::reserved_reviewer(ID, &service.fixture().start);
    service
        .visibility_time
        .store(1_893_456_000_000, std::sync::atomic::Ordering::Relaxed);
    fixture.child("worker", false);
    fixture.native.lock().unwrap().child.as_mut().unwrap()["latestRunCompletedAt"] =
        json!("2030-01-01T00:00:00Z");
    fixture.publish_shell();

    let mut state = service.state.lock().await;
    state.store.create(&task, &event("fixture")).unwrap();
    let row = service.lookup(&state, ID).unwrap();
    assert!(service.role_window(&fixture.thread, &task).2.is_some());
    let pending_title =
        |state: &crate::State| state.store.pending_title(&fixture.thread).unwrap().unwrap();
    service.desire_title(&mut state, &task, row.number);
    assert!(pending_title(&state).desired.starts_with("Waiting:"));

    state.set_wait(ID, Some(WaitReason::Permission));
    service.desire_title(&mut state, &task, row.number);
    assert!(
        pending_title(&state)
            .desired
            .starts_with("Reviewing · permission:")
    );
    assert!(!state.title_candidates.contains_key(&fixture.thread));

    assert!(task.ask_allowance(2, 1));
    service
        .commit(&mut state, &row, &task, &event("fixture_question"), None)
        .unwrap();
    assert!(
        pending_title(&state)
            .desired
            .starts_with("Reviewing · planner:")
    );
    assert!(!state.title_candidates.contains_key(&fixture.thread));
}

async fn assert_terminal_forgets_snooze(fixture: &Fixture) {
    let service = &fixture.service;
    fixture.elapse_visibility_ms(HANDOVER_MS);
    let row = service.task(ID).await.unwrap();
    fixture.record_capacity_wait(&row).await;
    fixture.sync().await;
    assert_eq!(fixture.commands().last().unwrap(), "thread.snooze");
    assert!(fixture.sync().await.is_empty());
    fixture.observed_snooze().await;
    let before = fixture.commands();
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
    assert!(fixture.sync().await.is_empty());
    assert_eq!(fixture.commands(), before);
}

fn plan_row(
    attention: TaskAttention,
    row: RowVisibility,
    receipt: Option<RowSnooze>,
    now: u64,
) -> Plan {
    super::plan_row(attention != TaskAttention::Waiting, row, receipt, now, None)
}

#[tokio::test]
async fn a_child_starting_after_planning_prevents_the_parent_snooze() {
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
    fixture.child("late-writer", true);
    host.fixture_shell_delta(&json!({"kind":"thread.updated","location":"active",
        "sequence":2,"thread":fixture.native.lock().unwrap().child}));
    let (result, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(host.write_row_visibility(
        &fixture.binding,
        "late-snooze",
        RowChange::SnoozeUntil(now_ms() + HORIZON_MS),
        &target,
        (&[], 0),
    )))
    .await;
    assert!(matches!(
        result,
        Err(ParentSendError::NotSent(
            nucleus_hosts::HostError::RowChildBusy
        ))
    ));
    assert!(!calls.contains_key("orchestration.dispatchCommand"));
    assert!(fixture.commands().is_empty());
}

#[test]
fn renewing_uses_a_new_horizon_and_uncertain_or_refused_writes_stay_observation_only() {
    let awake = RowVisibility {
        settled: false,
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
