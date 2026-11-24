use std::sync::{Arc, Mutex};

use nucleus_core::{Authority, Command, Entry, Host, Observed, Report, RunState, Task};
use nucleus_forge::GitHub;
use nucleus_hosts::Binding;
use nucleus_store::TaskAdmissionFacts;
use serde_json::{Value, json};

use super::*;

fn plan_row(
    attention: TaskAttention,
    visibility: RowVisibility,
    receipt: Option<RowSnooze>,
    now: u64,
) -> Plan {
    super::plan_row(attention, visibility, receipt, now, RowChildren::Quiet)
}
use crate::tests::{REPOSITORY, fixture, native_fixture, reservation};

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
}

struct Fixture {
    service: Service,
    native: Arc<Mutex<NativeRow>>,
    binding: Binding,
    thread: String,
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
                    row.commands.push(payload.clone());
                    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success",
                        "value":{"sequence":1 + row.commands.len()}}})
                }
                other => panic!("unexpected native operation {other}"),
            }
        }).await;
        service.host = host;
        service.fixture_mut().acp_provider = Some(PROVIDER.into());
        Self {
            service,
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

    async fn sync(&self) {
        {
            let row = self.native.lock().unwrap();
            let shell = json!({
                "projects":[{"id":self.binding.project_id,"workspaceRoot":self.service.fixture().checkout}],
                "threads":[{"id":self.thread,"projectId":self.binding.project_id,"providerInstanceId":PROVIDER,
                    "worktreePath":self.binding.worktree_path,"branch":self.binding.branch,
                    "title":"Fixture","snoozedUntil":row.until,"settledAt":row.settled_at}]
            });
            self.service.host.fixture_project_shell(&shell, PROVIDER);
        }
        self.service
            .reconcile_task_rows(PROVIDER, std::slice::from_ref(&self.thread))
            .await
            .unwrap();
    }

    fn observe_quiet_child(&self, thread: &str) {
        self.service
            .host
            .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
                "snapshotSequence":1, "projects":[], "threads":[{
                    "id": thread, "status":"idle", "activeRunId":null,
                    "pendingRuntimeRequest":null, "pendingBackgroundTasks":[],
                }]
            }}));
    }

    fn observe_empty_shell(&self) {
        self.service.host.fixture_held_shell(&json!({
            "kind":"snapshot","snapshot":{"snapshotSequence":1,"projects":[],"threads":[]}
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
            assert!(error.to_string().contains("operator snooze is active"));
        }
        let history = self.service.history(ID, None, 100).await.unwrap();
        let [receipt] = history
            .iter()
            .filter(|event| event.content.kind == "native_turn_not_sent")
            .collect::<Vec<_>>()[..]
        else {
            panic!("unchanged launch and ACP reattach refusals should share one receipt");
        };
        let detail: Value = serde_json::from_str(&receipt.content.detail).unwrap();
        assert_eq!(detail["version"], row.version);
        assert!(
            detail["reason"]
                .as_str()
                .unwrap()
                .contains("operator snooze is active")
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn a_reported_child_monitor_keeps_the_parent_visible_until_shell_quiet() {
    let pending = pending_task();
    let fixture = Fixture::new(&pending).await;
    let service = &fixture.service;
    let (mut task, credential, mut observation) =
        reservation(ID, Entry::Brief, &service.fixture().start);
    let run = task.run().unwrap().launch();
    let (child, instance) = (run.thread.clone(), run.instance.clone());
    task.record_send(&instance, 1).unwrap();
    let pr = nucleus_core::PullRequest {
        url: format!("https://github.com/{REPOSITORY}/pull/1"),
        head: service.fixture().start.clone(),
    };
    task.record_report(&instance, credential.as_bytes(), Report::Work(pr.clone()))
        .unwrap();
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    observation.forge = Observed::Known(nucleus_core::Forge::Open {
        pr,
        checks: nucleus_core::CheckState::Ready,
    });
    task.reconcile(&observation);
    assert!(task.run().is_none());
    assert_eq!(task.phase(), nucleus_core::Phase::Reviewing);
    {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.desire_title(&state, &task, None);
        service.track(&mut state, &task);
    }
    let mut row = json!({"id":child, "status":"completed", "activeRunId":null,
        "pendingRuntimeRequest":null, "pendingBackgroundTasks":[{"taskId":"monitor"}]});
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1, "projects":[], "threads":[row]
        }}));
    fixture.sync().await;
    assert!(fixture.commands().is_empty());
    let retired = json!({"parentThreadId":fixture.thread,"rootThreadId":fixture.thread,
        "relationshipToParent":"subagent"});
    for (index, active) in [false, true, false].into_iter().enumerate() {
        row["pendingBackgroundTasks"] = json!([]);
        let retired_delta = json!({"kind":"thread.updated","sequence":4+index*2,"thread":{
            "id":"thread:retired-reviewer", "lineage":retired,"status":"completed","activeRunId":null,
            "pendingRuntimeRequest":null,
            "pendingBackgroundTasks":if active { json!([{"taskId":"monitor"}]) } else { json!([]) },
        }});
        service.host.fixture_held_shell(
            &json!({"kind":"thread.updated","sequence":3+index*2,"thread":row}),
        );
        service.host.fixture_held_shell(&retired_delta);
        service
            .wake_from_host(nucleus_hosts::ThreadHint::fixture(&retired_delta).unwrap())
            .await;
        fixture.sync().await;
    }
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "thread.snooze"]
    );
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
    assert!(fixture.commands().is_empty());
    fixture.observe_empty_shell();
    fixture.sync().await;
    assert!(fixture.observed_snooze().await.until_ms > now_ms() + RENEW_BEFORE_MS);
    fixture.sync().await;
    assert_eq!(fixture.commands(), ["thread.snooze"]);

    let instance = worker.run().unwrap().launch().instance.clone();
    worker.record_send(&instance, 1).unwrap();
    let row = {
        let mut state = service.state.lock().await;
        let prior = service.lookup(&state, ID).unwrap();
        let release = event("dependency_released");
        state
            .store
            .save_brief_with_dependencies(&prior, &pending, &release, &[], None)
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
    fixture.observe_quiet_child(&worker.run().unwrap().launch().thread);
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
    }
    assert_eq!(fixture.attention().await, TaskAttention::Attention);
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
    fixture.observe_empty_shell();
    fixture.sync().await;
    let fence = service.effect(&row).await.unwrap();
    let prepare = || {
        service
            .host
            .prepare_parent_refresh(&fixture.binding, PROVIDER)
    };
    let write = prepare().await.unwrap().unwrap();
    service.wake_parent_delivery(&row, &write).await.unwrap();
    service.host.write_parent(write).await.unwrap();
    assert_eq!(
        fixture.commands(),
        ["thread.snooze", "thread.unsnooze", "message.dispatch"]
    );

    drop(fence);
    fixture.sync().await;
    let fence = service.effect(&row).await.unwrap();
    {
        let mut native = fixture.native.lock().unwrap();
        native.until = json!(OPERATOR_SNOOZE);
        native.settled_at = json!("2026-11-23T18:10:00Z");
    }
    fixture.assert_operator_snooze_receipt(&row).await;
    assert_eq!(fixture.commands().len(), 4);
    assert_eq!(fixture.native.lock().unwrap().until, OPERATOR_SNOOZE);

    fixture.native.lock().unwrap().until = Value::Null;
    let write = prepare().await.unwrap().unwrap();
    service.wake_parent_delivery(&row, &write).await.unwrap();
    service.host.write_parent(write).await.unwrap();
    assert_eq!(
        fixture.commands()[4..],
        ["thread.unsettle", "message.dispatch"]
    );
    drop(fence);

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
