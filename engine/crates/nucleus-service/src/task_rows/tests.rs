#[path = "tests/snooze_cases.rs"]
mod snooze_cases;
#[path = "tests/visibility_cases.rs"]
mod visibility_cases;

use std::{
    path::{Path, PathBuf},
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

fn native_timestamp(ms: u64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

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

#[derive(Default, PartialEq, Eq)]
enum NextReply {
    #[default]
    Accepted,
    Lost,
    Rejected,
}

#[derive(Default)]
struct NativeRow {
    title: Option<String>,
    until: Value,
    message_at: Value,
    wake_at: Value,
    settled_at: Value,
    archived_at: Value,
    commands: Vec<Value>,
    next_reply: NextReply,
    child: Option<Value>,
    instant_holds: bool,
    live_holds: bool,
    parent_runs: Vec<Value>,
    delivered_messages: Vec<Value>,
    peer: Option<Value>,
}

impl NativeRow {
    fn parent_activity(&self) -> Value {
        let Some(run) = self.parent_runs.last() else {
            return json!({"status":"idle","activeRunId":null,
                "pendingRuntimeRequest":null,"pendingBackgroundTasks":[]});
        };
        json!({"status":run["status"],
            "activeRunId":if run["status"] == "running" {&run["id"]} else {&Value::Null},
            "pendingRuntimeRequest":null,"pendingBackgroundTasks":[],
            "latestRunId":run["id"],"latestRunStartedAt":run["startedAt"],
            "latestRunCompletedAt":run["completedAt"],"updatedAt":run["completedAt"]})
    }

    fn finish_live_hold(&mut self) {
        let run = self.parent_runs.last_mut().unwrap();
        let now = crate::now_ms();
        run["status"] = json!("completed");
        run["startedAt"] = json!(native_timestamp(now.saturating_sub(2_000)));
        run["completedAt"] = json!(native_timestamp(now));
    }
}

struct Fixture {
    service: Arc<Service>,
    native: Arc<Mutex<NativeRow>>,
    binding: Binding,
    thread: String,
    _home: tempfile::TempDir,
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
                    if let Some(peer) = row.peer.as_ref().filter(|peer| &peer["id"] == target) {
                        return json!({"_tag":"Chunk","requestId":request["id"],"values":[
                            {"kind":"snapshot","snapshotSequence":1 + row.commands.len(),"projection":{
                                "thread":peer,"runs":[],"messages":[],"runtimeRequests":[],
                                "providerThreads":[],"turnItems":[],"subagents":[]
                            }},
                            {"kind":"synchronized"}
                        ]});
                    }
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
                            "runs":row.parent_runs,"messages":row.delivered_messages,"runtimeRequests":[],"providerThreads":[],"turnItems":[],"subagents":[]
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
                    if let Some(peer) = row.peer.as_mut().filter(|peer| peer["id"] == payload["threadId"]) {
                        peer["snoozedUntil"] = match payload["type"].as_str() {
                            Some("message.dispatch") => Value::Null,
                            Some("thread.snooze") => payload["snoozedUntil"].clone(),
                            other => panic!("unexpected peer command {other:?}"),
                        };
                        row.commands.push(payload.clone());
                        return json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success",
                            "value":{"sequence":1 + row.commands.len()}}});
                    }
                    assert_eq!(payload["threadId"], expected);
                    row.commands.push(payload.clone());
                    let reply = std::mem::take(&mut row.next_reply);
                    if reply == NextReply::Rejected {
                        let id = payload["commandId"].as_str().unwrap();
                        return json!({"_tag":"Exit","requestId":request["id"],"exit":{
                            "_tag":"Failure","cause":[{"_tag":"Fail","error":{
                                "_tag":"OrchestrationV2DispatchCommandError",
                                "commandId":id,"commandType":payload["type"],
                                "cause":{"name":"OrchestratorCommandPreviouslyRejectedError",
                                    "message":format!("Command {id} was previously rejected: fixture.")}
                            }}]
                        }});
                    }
                    let lose_reply = reply == NextReply::Lost;
                    if lose_reply && payload["type"] != "message.dispatch" {
                        return json!({"_tag":"Exit","requestId":request["id"],
                            "exit":{"_tag":"Failure","cause":[]}});
                    }
                    match payload["type"].as_str().unwrap() {
                        "thread.archive" => row.archived_at = json!("2030-01-01T00:05:00Z"),
                        "thread.unarchive" => row.archived_at = Value::Null,
                        "thread.metadata.update" => row.title = Some(payload["title"].as_str().unwrap().into()),
                        "thread.snooze" => row.until = payload["snoozedUntil"].clone(),
                        "thread.unsnooze" => {
                            assert_eq!(payload["reason"], "user");
                            row.until = Value::Null;
                        }
                        "message.dispatch" => {
                            if row.delivered_messages.iter().any(|message| message["id"] == payload["messageId"]) {
                                return json!({"_tag":"Exit","requestId":request["id"],
                                    "exit":{"_tag":"Success","value":{"sequence":1 + row.commands.len()}}});
                            }
                            row.delivered_messages.push(json!({"id":payload["messageId"]}));
                            row.settled_at = Value::Null;
                            if !row.until.is_null() {
                                row.wake_at = json!("2030-01-01T00:00:01Z");
                            }
                            row.until = Value::Null;
                            row.message_at = json!("2030-01-01T00:00:01Z");
                            if row.instant_holds {
                                let n = row.parent_runs.len();
                                let now = crate::now_ms();
                                row.parent_runs.push(json!({
                                    "id":format!("parent-run-{n}"),"status":"completed",
                                    "userMessageId":payload["messageId"],"rootNodeId":format!("root-{n}"),
                                    "startedAt":native_timestamp(now.saturating_sub(100)),
                                    "completedAt":native_timestamp(now),
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
        service.host = host;
        service.set_fixture_acp_provider(PROVIDER);
        Self {
            service: Arc::new(service),
            native,
            binding,
            thread,
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
            state
                .store
                .create_with_facts(
                    &dependency,
                    &event("fixture"),
                    nucleus_store::TaskAdmissionFacts::default(),
                )
                .unwrap();
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
        self.publish_shell_at(None);
    }

    fn publish_shell_at(&self, revision: Option<usize>) {
        let row = self.native.lock().unwrap();
        let mut shell = json!({
            "projects":[{"id":self.binding.project_id,"workspaceRoot":self.service.fixture().checkout}],
            "threads":[{"id":self.thread,"projectId":self.binding.project_id,"providerInstanceId":PROVIDER,
                "worktreePath":self.binding.worktree_path,"branch":self.binding.branch,
                "title":row.title.as_deref().unwrap_or("Fixture"),"latestUserMessageAt":row.message_at,
                "lastSnoozeWakeAt":row.wake_at,"snoozedUntil":row.until,"settledAt":row.settled_at,
                "archivedAt":row.archived_at,"deletedAt":null,"updatedAt":"2030-01-01T00:00:00Z",
                "modelSelection":{"instanceId":PROVIDER,"model":"nucleus"},
                "status":"idle","activeRunId":null,"pendingRuntimeRequest":null,"pendingBackgroundTasks":[]}]
        });
        shell["snapshotSequence"] = json!(revision.unwrap_or(1 + row.commands.len()));
        if row.instant_holds || row.live_holds {
            shell["threads"][0]
                .as_object_mut()
                .unwrap()
                .extend(row.parent_activity().as_object().unwrap().clone());
        }
        if let Some(child) = &row.child {
            shell["threads"].as_array_mut().unwrap().push(child.clone());
        }
        if let Some(peer) = &row.peer {
            shell["threads"].as_array_mut().unwrap().push(peer.clone());
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
        let callback = service.callback;
        let report_command = service.report_command.clone();
        let visibility_time = service
            .visibility_time
            .load(std::sync::atomic::Ordering::Relaxed);
        let host = nucleus_hosts::T3::new(service.host.endpoint(), "fixture").unwrap();
        host.use_held_shell();
        let placeholder = fixture(GitHub::new("fixture").unwrap());
        let old = std::mem::replace(&mut self.service, Arc::new(placeholder.1));
        drop(old);
        self.service = Arc::new(
            Service::open_projects(
                settings.lock_profile().unwrap(),
                "fixture-acp".into(),
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

    fn snoozed_peer(&self, thread: &str, provider: &str, parent: Option<&str>) {
        let mut peer = json!({
            "id":thread, "projectId":self.binding.project_id,
            "worktreePath":self.binding.worktree_path,"branch":self.binding.branch,
            "providerInstanceId":provider,"status":"idle","activeRunId":null,
            "pendingRuntimeRequest":null,"pendingBackgroundTasks":[],
            "snoozedUntil":OPERATOR_SNOOZE,"snoozedAt":"2026-01-01T00:00:00Z",
        });
        if let Some(parent) = parent {
            peer["lineage"] = json!({
                "parentThreadId":parent,"rootThreadId":parent,"relationshipToParent":"subagent",
            });
        }
        self.native.lock().unwrap().peer = Some(peer);
        self.publish_shell();
    }

    async fn restore_operator_horizons(&self, threads: &[&str]) {
        let (result, calls) = nucleus_hosts::T3::count_pass_calls(Box::pin(
            self.service.reconcile_delivery_snoozes(),
        ))
        .await;
        result.unwrap();
        let count = u64::try_from(threads.len()).unwrap();
        assert_eq!(calls, [("orchestration.dispatchCommand", count)].into());
        {
            let native = self.native.lock().unwrap();
            let writes = &native.commands[native.commands.len() - threads.len()..];
            for (payload, thread) in writes.iter().zip(threads) {
                assert_eq!(payload["type"], "thread.snooze");
                assert_eq!(payload["threadId"], *thread);
                assert_eq!(payload["snoozedUntil"], OPERATOR_SNOOZE);
            }
        }
        observe_restored_delivery_snooze(self).await;
    }

    fn child(&self, id: &str, busy: bool) {
        self.native.lock().unwrap().child = Some(json!({
            "id":id, "projectId":self.binding.project_id, "parentThreadId":self.thread,
            "worktreePath":self.binding.worktree_path, "branch":self.binding.branch,
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

    fn prepare_hold(&self, prompt: &str, prior: Option<&str>) -> ParentWrite {
        nucleus_hosts::T3::prepare_parent_hold(
            &self.binding,
            PROVIDER,
            "Fixture",
            prompt,
            self.service
                .host
                .parent_shell(&self.binding, PROVIDER)
                .unwrap(),
            prior.map(|command| (command, false)),
            nucleus_hosts::HoldCheckpoint {
                after_run: None,
                recorded_at_ms: now_ms(),
                short_turns: 0,
                preparing_launch: true,
            },
        )
        .expect("prepare a pinned parent hold")
    }

    async fn parent_record(&self, row: &TaskRow) -> nucleus_store::ParentDelivery {
        let record = self
            .service
            .state
            .lock()
            .await
            .store
            .current_parent_hold(ID)
            .unwrap()
            .unwrap();
        assert_eq!(record.version, row.version);
        record
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn pending_delivery_snooze(service: &Service) -> nucleus_store::StoredDeliverySnooze {
    let state = service.state.lock().await;
    let due = state.store.next_delivery_snooze().unwrap().unwrap();
    let mut records = state.store.due_delivery_snoozes(due).unwrap();
    assert_eq!(records.len(), 1);
    records.pop().unwrap()
}

async fn allow_delivery_snooze_retry(service: &Service) {
    let state = service.state.lock().await;
    let records = state.store.due_delivery_snoozes(u64::MAX).unwrap();
    assert!(!records.is_empty());
    for record in records {
        state
            .store
            .finish_delivery_snooze(&record.command, Some((record.attempt, 0)))
            .unwrap();
    }
}

async fn observe_restored_delivery_snooze(fixture: &Fixture) {
    let service = &fixture.service;
    fixture.publish_shell();
    allow_delivery_snooze_retry(service).await;
    service.reconcile_delivery_snoozes().await.unwrap();
    assert!(
        service
            .state
            .lock()
            .await
            .store
            .next_delivery_snooze()
            .unwrap()
            .is_none()
    );
}

async fn send_snoozed_hold(fixture: &Fixture, task: &Task) -> TaskRow {
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        service.lookup(&state, ID).unwrap()
    };
    fixture.native.lock().unwrap().until = json!(OPERATOR_SNOOZE);
    fixture.publish_shell();
    let write = fixture.prepare_hold("Preparing the task thread.", None);
    assert!(service.deliver_parent(&row, write, None).await.unwrap());
    assert_eq!(fixture.commands(), ["message.dispatch"]);
    row
}

fn due_frozen_delivery(
    store: &nucleus_store::Store,
    row: &TaskRow,
) -> nucleus_store::ParentDelivery {
    use nucleus_store::ParentResult::Pending;
    let mut original = store.current_parent_hold(ID).unwrap().unwrap();
    assert_eq!(original.result, Pending);
    assert!(original.due_ms > 0);
    store
        .finish_parent_delivery(ID, row.version, &original, Pending, 0)
        .unwrap();
    original.due_ms = 0;
    original
}

async fn instant_parent_fixture() -> (Fixture, TaskRow) {
    let head: nucleus_core::Head = "1".repeat(40).parse().unwrap();
    let (mut task, credential, mut observation) = crate::tests::reserved_reviewer(ID, &head);
    let launch = task.run().unwrap().launch().clone();
    let fixture = Fixture::new(&task).await;
    let service = &fixture.service;
    let row = {
        let mut state = service.state.lock().await;
        state
            .store
            .create_with_facts(
                &task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
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

async fn create_visibility_row(fixture: &Fixture, task: &Task) -> TaskRow {
    let row = {
        let mut state = fixture.service.state.lock().await;
        state
            .store
            .create_with_facts(
                task,
                &event("fixture"),
                nucleus_store::TaskAdmissionFacts::default(),
            )
            .unwrap();
        fixture.service.desire_title(&mut state, task, None);
        fixture.service.lookup(&state, ID).unwrap()
    };
    fixture.sync().await;
    fixture.sync().await;
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);
    row
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
    let calls = fixture.sync().await;
    assert_eq!(calls, [("orchestration.dispatchCommand", 1)].into());
    let mut expected = before;
    expected.push("thread.archive".into());
    assert_eq!(fixture.commands(), expected);
    assert!(fixture.sync().await.is_empty());
}

fn plan_row(
    attention: TaskAttention,
    row: RowVisibility,
    receipt: Option<RowSnooze>,
    now: u64,
) -> Plan {
    super::plan_row(attention != TaskAttention::Waiting, row, receipt, now, None)
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
        plan_row(
            TaskAttention::Waiting,
            manual,
            Some(renewal.clone()),
            boundary + 1
        ),
        Plan::Idle(manual.snoozed_until_ms)
    );
    let mut ended_unknown = renewal;
    ended_unknown.ended = true;
    assert!(matches!(
        plan_row(
            TaskAttention::Waiting,
            awake,
            Some(ended_unknown),
            boundary + 1
        ),
        Plan::Write(RowChange::SnoozeUntil(_), _)
    ));
}
