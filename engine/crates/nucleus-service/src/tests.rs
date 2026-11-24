use std::{
    path::Path,
    process::Command as Process,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Json, Router,
    extract::ws::{Message, WebSocketUpgrade},
    routing::{get, post},
};
use nucleus_core::{
    CallbackCredential, CheckState, Entry, Forge, Head, Host, LaunchInputs, Observation, Observed,
    PullRequest, Run, Workspace,
};
use nucleus_hosts::{
    Binding, ControlDispatch, ReplayAuthorization, RoleProfile, RunDispatch, RunObservation,
    SendOutcome, StopProgress, TaskHost,
};
use nucleus_store::{EngineSettings, PinnedVolume};
use serde_json::{Value, json};
use tokio::net::TcpListener;

use super::*;

pub(super) const REPOSITORY: &str = "inflatable-cookie/nucleus-fixture";
const PR: &str = "https://github.com/inflatable-cookie/nucleus-fixture/pull/1";

pub(super) fn fixture(forge: GitHub) -> (tempfile::TempDir, Service) {
    let home = tempfile::tempdir().expect("fixture volume directory");
    let root = home.path().canonicalize().expect("portable root");
    let checkout = root.join("repo");
    std::fs::create_dir(&checkout).expect("project");
    git(&checkout, &["init", "-b", "main"]);
    git(
        &checkout,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    );
    git(
        &checkout,
        &[
            "remote",
            "add",
            "origin",
            &format!("https://github.com/{REPOSITORY}.git"),
        ],
    );
    let start = git(&checkout, &["rev-parse", "HEAD"])
        .parse()
        .expect("base head");
    let settings = SettingsFile::open(&root).expect("portable settings");
    settings
        .save(&EngineSettings {
            enabled: true,
            work_volume: Some(PinnedVolume::detect(&root).expect("fixture volume")),
            ..EngineSettings::default()
        })
        .expect("enable fixture");
    let profile = RoleProfile {
        instance_id: "provider".into(),
        model: "fixture".into(),
        runtime_mode: "auto".into(),
        options: Vec::new(),
    };
    let project = Project {
        mode: ProjectMode::Fixture,
        repository: REPOSITORY.into(),
        checkout,
        base: "main".into(),
        start,
        host_project: "local-fixture".into(),
        worker: profile.clone(),
        reviewer: profile,
        acp_provider: None,
        launch_budget: LaunchBudget { slots: 1 },
        agents: Vec::new(),
    };
    let host = T3::new("http://127.0.0.1:9", "unused-fixture-key")
        .expect("no native host for the service fixture");
    let service = Service::open(
        &settings,
        project,
        host,
        forge,
        "127.0.0.1:9".parse().expect("callback"),
        std::env::current_exe().expect("test binary"),
    )
    .expect("scoped service");
    (home, service)
}

pub(super) fn git(root: &Path, args: &[&str]) -> String {
    let output = Process::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("run fixture git");
    assert!(
        output.status.success(),
        "fixture Git: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("fixture Git output")
        .trim_end()
        .into()
}

pub(super) fn reservation(
    id: &str,
    entry: Entry,
    head: &Head,
) -> (Task, CallbackCredential, Observation) {
    reservation_at(id, entry, head, 1)
}

pub(super) fn reservation_at(
    id: &str,
    entry: Entry,
    head: &Head,
    started_at: u64,
) -> (Task, CallbackCredential, Observation) {
    let pr = PullRequest {
        url: PR.into(),
        head: head.clone(),
    };
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry,
            origin_thread: None,
        },
        "---\ncomplexity: normal\n---\n\nFixture introduction.\n\n# Synthetic change\n\nFixture details.".into(),
        (entry == Entry::ReviewEntry).then(|| pr.clone()),
    );
    let observation = Observation {
        forge: if entry == Entry::ReviewEntry {
            Observed::Known(Forge::Open {
                pr,
                checks: CheckState::Ready,
            })
        } else {
            Observed::Known(Forge::Absent)
        },
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(head.clone())),
    };
    let _ = task.reconcile(&observation);
    let credential = task
        .reserve_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: format!("thread:{id}"),
                started_at,
                input: "fixture-only wire".into(),
            },
            &[3; 32],
        )
        .expect("reserve exact callback run");
    (task, credential, observation)
}

pub(super) fn reserved_reviewer(id: &str, head: &Head) -> (Task, CallbackCredential, Observation) {
    let (mut task, credential, mut observation) = reservation(id, Entry::Brief, head);
    let pr = PullRequest {
        url: PR.into(),
        head: head.clone(),
    };
    let instance = task.run().expect("worker").launch().instance.clone();
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::Work(pr.clone().into()),
    )
    .unwrap();
    observation.forge = Observed::Known(Forge::Open {
        pr,
        checks: CheckState::Ready,
    });
    observation.host = Observed::Known(Host::Current {
        instance,
        state: nucleus_core::RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Reviewing)
    );
    let credential = task
        .reserve_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: "thread:reviewer".into(),
                started_at: 2,
                input: "fixture review".into(),
            },
            &[4; 32],
        )
        .unwrap();
    (task, credential, observation)
}

pub(super) fn code_task_at_merge(id: &str, head: &Head) -> (Task, Observation) {
    let (mut task, credential, mut observation) = reserved_reviewer(id, head);
    let instance = task.run().expect("reviewer").launch().instance.clone();
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::Review {
            head: head.clone(),
            decision: nucleus_core::Review::Approve,
            summary: "Approved the original head".into(),
            finding_titles: Vec::new(),
        },
    )
    .unwrap();
    observation.host = Observed::Known(Host::Current {
        instance,
        state: nucleus_core::RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Merging)
    );
    (task, observation)
}

pub(super) async fn forge_fixture(
    head: &Head,
) -> (GitHub, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    forge_fixture_for_branch(head, "ns-reviewer").await
}

async fn forge_fixture_for_branch(
    head: &Head,
    branch: &str,
) -> (GitHub, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let reads = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&reads);
    let mut pull = forge_pull(head);
    pull["head"]["ref"] = Value::from(branch);
    let checks = forge_checks(head);
    let server = Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1"),
            get(move || async move {
                counter.fetch_add(1, Ordering::Relaxed);
                Json(pull)
            }),
        )
        .route("/graphql", post(move || async move { Json(checks) }));
    let (client, server) = serve_forge(server).await;
    (client, reads, server)
}

pub(super) fn forge_pull(head: &Head) -> Value {
    json!({
        "number":1, "html_url":PR, "merged":false, "state":"open", "merge_commit_sha":null,
        "head":{"ref":"ns-reviewer", "sha":head, "repo":{"full_name":REPOSITORY}},
        "base":{"ref":"main", "sha":head, "repo":{"full_name":REPOSITORY}},
    })
}

pub(super) fn forge_checks(head: &Head) -> Value {
    json!({"data":{"repository":{"pullRequest":{
        "headRefOid":head, "baseRefName":"main", "isDraft":false, "state":"OPEN",
        "mergeable":"MERGEABLE", "mergeStateStatus":"CLEAN", "reviewDecision":null,
        "statusCheckRollup":{"state":"SUCCESS","contexts":{"pageInfo":{"hasNextPage":false},"nodes":[]}},
    }}}})
}

pub(super) async fn serve_forge(app: Router) -> (GitHub, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("fixture endpoint");
    let client = GitHub::loopback_fixture(listener.local_addr().expect("local address"))
        .expect("fixture forge");
    let server = tokio::spawn(async {
        axum::serve(listener, app)
            .await
            .expect("fixture forge server");
    });
    (client, server)
}

pub(super) struct Due(
    pub(super) AtomicUsize,
    pub(super) Option<nucleus_core::RunState>,
);

impl TaskHost for Due {
    async fn profile_catalog(&self) -> Result<&nucleus_hosts::ProfileCatalog, HostError> {
        unreachable!("only revoked runs are exercised")
    }

    fn prepare_launch(
        &self,
        _: nucleus_hosts::LaunchRequest<'_>,
    ) -> Result<LaunchInputs, HostError> {
        unreachable!("no new reservation in the replay fixture")
    }

    async fn observe_retained(&self, _: &Binding, _: &str) -> Result<Host, HostError> {
        unreachable!("only replay gate is exercised")
    }
    async fn observe_run(&self, run: &Run, _: u64) -> Result<RunObservation, HostError> {
        Ok(RunObservation {
            host: Host::Current {
                instance: run.launch().instance.clone(),
                state: self.1.ok_or(HostError::Uncertain)?,
            },
            activity: None,
            provider_limit: None,
            routing: None,
            active_child: None,
        })
    }

    async fn authorize_send(&self, _: &Run) -> Result<ReplayAuthorization, HostError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err(HostError::Uncertain)
    }

    async fn send(&self, _: RunDispatch) -> Result<SendOutcome, HostError> {
        unreachable!("fixture probes the decision before the send marker")
    }

    async fn write_control(&self, _: ControlDispatch) -> Result<(), HostError> {
        unreachable!("fixture probes the decision before any native write")
    }

    async fn stop(&self, _: &Run, _: &Binding, _: u64, _: bool) -> Result<StopProgress, HostError> {
        Ok(StopProgress::ReplayDue)
    }
}

#[tokio::test]
async fn a_move_during_the_forge_read_prevents_stale_launch() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let source = {
        let (entered, release) = (Arc::clone(&entered), Arc::clone(&release));
        Router::new().route(
            &format!("/repos/{REPOSITORY}/pulls"),
            get(move || async move {
                entered.notify_one();
                release.notified().await;
                Json(Vec::<Value>::new())
            }),
        )
    };
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("fixture forge");
    let forge =
        GitHub::loopback_fixture(listener.local_addr().expect("forge address")).expect("client");
    let server = tokio::spawn(async move {
        axum::serve(listener, source).await.expect("server");
    });
    let (_home, service) = fixture(forge);
    let id = "stale-read";
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "Synthetic task".into(),
        None,
    );
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Unknown,
        workspace: Observed::Unknown,
    };
    let _ = task.reconcile(&observation);
    service
        .state
        .lock()
        .await
        .store
        .create(&task, &event("fixture"))
        .expect("seed");
    let stale = service.task(id).await.expect("old version");
    let (result, moved) = tokio::join!(service.pass(), async {
        entered.notified().await;
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            service.command(
                id,
                &Authority::Operator {
                    actor: "fixture".into(),
                },
                Command::Move(nucleus_core::Phase::Queued),
            ),
        )
        .await;
        release.notify_one();
        outcome
            .expect("the command is independent of the pending read")
            .expect("move")
    },);
    let results = result.expect("pass outcome");
    assert!(matches!(
        results.as_slice(),
        [PassOutcome { task, result: Err(ServiceError::Store(StoreError::StaleTask)) }] if task == id
    ));
    let CommandOutcome::Applied(moved) = moved else {
        panic!("move must commit");
    };
    assert_eq!(moved.version, stale.version + 1);
    assert_eq!(service.task(id).await.expect("current row"), *moved);
    assert_eq!(
        service
            .state
            .lock()
            .await
            .schedule
            .take_ready(Instant::now(), &BTreeSet::new())
            .map(|task| task.id),
        Some(id.into())
    );
    let worktrees = service.worktrees().expect("worktree root");
    let checkout = worktrees
        .checkout(&service.fixture().checkout, REPOSITORY, id)
        .expect("checkout");
    assert_eq!(
        checkout.observe().expect("worktree state"),
        Workspace::Absent
    );
    server.abort();
}

#[tokio::test]
async fn a_cold_pass_consumes_an_authenticated_report_despite_an_old_custody_block() {
    for question in [false, true] {
        let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
        let head = service.fixture().start.clone();
        let (forge, _, server) = forge_fixture_for_branch(&head, "ns-worker").await;
        service.forge = forge;
        let (mut task, credential, _) = reservation("worker", Entry::Brief, &head);
        let instance = task.run().unwrap().launch().instance.clone();
        task.record_send(&instance, 1).unwrap();
        let report = if question {
            nucleus_core::Report::Question {
                prompt: "Choose the scope".into(),
                options: vec!["Small".into(), "Large".into()],
            }
        } else {
            nucleus_core::Report::Work(
                PullRequest {
                    url: PR.into(),
                    head,
                }
                .into(),
            )
        };
        task.record_report(&instance, credential.as_bytes(), report)
            .unwrap();
        {
            let mut state = service.state.lock().await;
            let version = state.store.create(&task, &event("fixture")).unwrap();
            let mut blocked = event("host_observation_blocked");
            blocked.detail = serde_json::json!({
                "version": version, "deliveryPending": false,
                "reason": "Retained thread lacks idle coverage",
                "session": format!("{}/previous-engine", service.host.runtime_identity().unwrap()),
            })
            .to_string();
            state
                .store
                .claim_task_effect("worker", &blocked, false)
                .unwrap();
        }
        let initial = service.task("worker").await.unwrap();
        let outcomes = service.pass().await.unwrap();
        let [outcome] = outcomes.try_into().ok().expect("one scheduled task");
        let result = outcome.result.unwrap();
        let next = service.task("worker").await.unwrap();
        assert_eq!(next.version, initial.version + 1);
        assert!(service.state.lock().await.last_pass_calls.is_empty());
        assert_eq!(
            next.task.threads().get(nucleus_core::Role::Worker),
            Some("thread:worker")
        );
        if question {
            assert!(matches!(
                result,
                Action::Ask(nucleus_core::Question::Work { .. })
            ));
            assert!(matches!(
                next.task.question(),
                Some(nucleus_core::Question::Work { .. })
            ));
        } else {
            assert_eq!(result, Action::Advance(Phase::Reviewing));
            assert_eq!(next.task.phase(), Phase::Reviewing);
        }
        assert!(next.task.run().is_none());
        server.abort();
    }
}

#[tokio::test]
async fn proven_unsent_preflights_replan_without_fencing_the_task_version() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let row = {
        let (task, _, _) = reservation("unsent", Entry::Brief, &service.fixture().start);
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        let row = service.lookup(&state, "unsent").unwrap();
        state.schedule.block_host_observation("unsent");
        state.set_wait("unsent", Some(WaitReason::HostObservationBlocked));
        row
    };
    let refused = Err(service.parent_not_sent("preflight custody revision no longer matches"));
    let before_role_send = Err(ServiceError::Host(HostError::Uncertain));
    for result in [&refused, &before_role_send, &before_role_send] {
        service
            .schedule_result(&row, result, Priority::Decision)
            .await
            .unwrap();
        let mut state = service.state.lock().await;
        let due = state.schedule.due("unsent").unwrap();
        let scheduled = state.schedule.take_ready(due, &BTreeSet::new()).unwrap();
        assert_eq!(scheduled.id, "unsent");
        assert_eq!(
            service.lookup(&state, "unsent").unwrap().version,
            row.version
        );
        assert_eq!(state.wait_reason("unsent"), Some(WaitReason::HostUnknown));
        assert!(matches!(
            state.wait_detail("unsent"),
            Some(crate::WaitDetail::BeforeSend(_))
        ));
        assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
        assert_eq!(
            state.task_attention(&row).unwrap(),
            crate::attention::TaskAttention::Waiting
        );
    }
    {
        let mut state = service.state.lock().await;
        let board_times = state.store.board_times("unsent").unwrap();
        assert!(board_times.since.is_some());
        let since = state.waits["unsent"].since;
        assert!(
            state
                .observe_wait_detail(
                    &row.task,
                    Some(WaitReason::HostUnknown),
                    Some(crate::WaitDetail::ShowingForDelivery(None)),
                )
                .unwrap()
        );
        assert_eq!(state.store.board_times("unsent").unwrap(), board_times);
        assert_eq!(state.waits["unsent"].since, since);
    }
    assert!(
        !service
            .history("unsent", None, 100)
            .await
            .unwrap()
            .iter()
            .any(|event| event.content.kind == "host_observation_blocked")
    );
}

#[tokio::test]
async fn an_unconfirmed_hold_gets_readback_only_until_its_exact_message_is_observed() {
    let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let (task, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    let identity = task.identity().clone();
    let task = Task::new(identity.clone(), "Fixture".into(), None);
    let binding = {
        let work = service.worktrees().unwrap();
        let checkout = work
            .checkout(
                &service.fixture().checkout,
                &identity.repository,
                &identity.id,
            )
            .unwrap();
        service.binding(&checkout).unwrap()
    };
    let parent = nucleus_hosts::parent_thread(std::path::Path::new(&binding.worktree_path));
    let command = format!("{parent}-hold-1");
    let message = format!("{command}-message");
    let delivered = Arc::new(AtomicUsize::new(0));
    let wire = Arc::clone(&delivered);
    let (host, native) = native_fixture(move |request| {
        assert_eq!(request["tag"], "orchestration.subscribeThread");
        assert_eq!(request["payload"]["threadId"], parent);
        let messages = if wire.load(Ordering::Relaxed) == 0 { serde_json::json!([]) }
            else { serde_json::json!([{"id":message,"runId":"exact-run"}]) };
        serde_json::json!({"_tag":"Chunk", "requestId":request["id"], "values":[
            {"kind":"snapshot","snapshotSequence":1,"projection":{
                "thread":{"id":parent,"projectId":binding.project_id,
                    "worktreePath":binding.worktree_path,"branch":binding.branch,
                    "providerInstanceId":"fixture-acp",
                    "modelSelection":{"instanceId":"fixture-acp","model":"nucleus"}},
                "runs":[],"messages":messages,"runtimeRequests":[],"providerThreads":[],"turnItems":[],"subagents":[]
            }},
            {"kind":"synchronized"}
        ]})
    }).await;
    service.host = host;
    service.fixture_mut().acp_provider = Some("fixture-acp".into());
    let runtime = service.host.runtime_identity().unwrap();
    let row = {
        let mut state = service.state.lock().await;
        let version = state.store.create(&task, &event("fixture")).unwrap();
        for (kind, scope) in [
            ("native_turn_intent", runtime.clone()),
            ("host_observation_blocked", format!("{runtime}/engine")),
        ] {
            let mut audit = event(kind);
            audit.detail = serde_json::json!({"version":version,"session":scope,"command":command,"deliveryPending":true})
                .to_string();
            state
                .store
                .claim_task_effect(&identity.id, &audit, false)
                .unwrap();
        }
        service.lookup(&state, &identity.id).unwrap()
    };
    assert!(service.parent_delivery_fenced(&row).await.unwrap());
    delivered.store(1, Ordering::Relaxed);
    assert!(!service.parent_delivery_fenced(&row).await.unwrap());
    let calls = service.host.host_calls();
    assert!(!service.parent_delivery_fenced(&row).await.unwrap());
    assert_eq!(service.host.host_calls(), calls);
    assert_eq!(calls["orchestration.subscribeThread"], 2);
    assert_eq!(
        service.task(&identity.id).await.unwrap().version,
        row.version
    );
    native.abort();
}

#[tokio::test]
async fn a_generic_runless_check_cannot_replace_a_proven_refusal_with_a_fence() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let (reserved, _, _) = reservation("runless", Entry::Brief, &service.fixture().start);
    let task = Task::new(reserved.identity().clone(), "Fixture".into(), None);
    let row = {
        let mut state = service.state.lock().await;
        state.store.create(&task, &event("fixture")).unwrap();
        service.lookup(&state, "runless").unwrap()
    };
    let refusal = Err(service.parent_not_sent("parent proof changed"));
    let unknown = Err(ServiceError::Host(HostError::Uncertain));
    let process = Err(ServiceError::Host(HostError::ProcessCoverage(
        nucleus_hosts::ProcessEvidenceFailure::Cwd { pid: 41 },
    )));
    for result in [&refusal, &unknown, &unknown, &process, &process] {
        service
            .schedule_result(&row, result, Priority::Decision)
            .await
            .unwrap();
        let mut state = service.state.lock().await;
        let due = state.schedule.due("runless").expect("still eligible");
        assert_eq!(
            state.schedule.take_ready(due, &BTreeSet::new()).unwrap().id,
            "runless"
        );
        assert_eq!(
            service.lookup(&state, "runless").unwrap().version,
            row.version
        );
    }
    let observations: Vec<_> = service
        .history("runless", None, 20)
        .await
        .unwrap()
        .into_iter()
        .filter(|event| event.content.kind == "host_observation_incomplete")
        .collect();
    assert_eq!(observations.len(), 1);
    let detail: serde_json::Value = serde_json::from_str(&observations[0].content.detail).unwrap();
    assert_eq!(detail["stage"], "cwd_followup");
    assert_eq!(detail["pid"], 41);
    let state = service.state.lock().await;
    assert!(matches!(
        state.wait_detail("runless"),
        Some(crate::WaitDetail::BeforeSend(Some(
            "Checking whether the checkout is idle."
        )))
    ));
}

#[tokio::test]
async fn a_settled_run_wakes_the_oldest_slot_waiter() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    for id in ["z-first", "a-second"] {
        let (task, _, _) = reservation(id, Entry::Brief, &service.fixture().start);
        service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("fixture"))
            .expect("seed waiter");
        let row = service.task(id).await.expect("waiter");
        service
            .schedule_result(
                &row,
                &Ok(Action::Wait(WaitReason::Capacity)),
                Priority::Effect,
            )
            .await
            .expect("schedule capacity backstop");
    }
    let (mut holder, _, _) = reservation("holder", Entry::Brief, &service.fixture().start);
    let instance = holder
        .run()
        .expect("reserved run")
        .launch()
        .instance
        .clone();
    holder.record_send(&instance, 1).expect("slot occupied");
    service
        .state
        .lock()
        .await
        .store
        .create(&holder, &event("fixture"))
        .expect("seed holder");
    let actor = Authority::Operator {
        actor: "fixture".into(),
    };
    let CommandOutcome::Applied(revoked) = service
        .command("holder", &actor, Command::Cancel)
        .await
        .expect("cancel")
    else {
        panic!("cancel must commit");
    };
    {
        let now = Instant::now();
        let state = service.state.lock().await;
        assert!(!state.schedule.effect_ready("z-first", now));
        assert!(state.schedule.due("z-first").expect("backstop") > now + Duration::from_secs(55));
    }
    let mut settled = revoked.task.clone();
    settled.reconcile(&Observation {
        host: Observed::Known(Host::Current {
            instance,
            state: nucleus_core::RunState::Ended,
        }),
        forge: Observed::Unknown,
        workspace: Observed::Unknown,
    });
    assert!(settled.run().is_none());
    service
        .save(&revoked, settled, &event("phase_reconciled"))
        .await
        .expect("release slot");
    let state = service.state.lock().await;
    let now = Instant::now();
    assert!(state.schedule.effect_ready("z-first", now));
    assert!(!state.schedule.effect_ready("a-second", now));
}

pub(super) async fn native_fixture(
    response: impl Fn(&Value) -> Value + Clone + Send + Sync + 'static,
) -> (T3, tokio::task::JoinHandle<()>) {
    native_fixture_with_traffic(response, None).await
}

#[tokio::test]
async fn paused_passes_leave_twenty_runless_rows_and_native_traffic_unchanged() {
    let (forge, forge_server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let (host, native_server) = native_fixture(|request| {
        panic!(
            "paused idle rows must make no native requests: {}",
            request["tag"]
        );
    })
    .await;
    service.host = host;
    let ids: Vec<_> = (0..20).map(|index| format!("paused-{index:02}")).collect();
    {
        let mut state = service.state.lock().await;
        state
            .settings
            .dispatch
            .get_or_insert_with(Default::default)
            .mode = DispatchMode::Paused;
        for id in &ids {
            let (mut task, _, mut observation) =
                reservation(id, Entry::Brief, &service.fixture().start);
            let instance = task.run().unwrap().launch().instance.clone();
            task.record_send(&instance, 2).unwrap();
            observation.host = Observed::Known(Host::Current {
                instance,
                state: nucleus_core::RunState::Gone,
            });
            assert_eq!(
                task.reconcile(&observation),
                Action::Relaunch(nucleus_core::Role::Worker)
            );
            assert!(task.run().is_none());
            assert!(task.threads().get(nucleus_core::Role::Worker).is_some());
            state.store.create(&task, &event("fixture")).unwrap();
        }
    }
    for _ in 0..2 {
        let mut count = 0;
        while count < ids.len() {
            let pass = service.pass().await.unwrap();
            count += pass.len();
            for outcome in pass {
                assert!(
                    matches!(outcome.result, Ok(Action::Wait(WaitReason::Capacity))),
                    "{}",
                    outcome.task
                );
            }
            assert!(service.state.lock().await.last_pass_calls.is_empty());
        }
        let mut state = service.state.lock().await;
        for id in &ids {
            assert_eq!(state.store.history(id, None, 10).unwrap().len(), 1);
            state.schedule.wake(id, Instant::now(), Priority::Wake);
        }
    }
    assert!(service.host.host_calls().is_empty());
    native_server.abort();
    forge_server.abort();
}

#[derive(Default)]
pub(super) struct NativeTraffic {
    pub(super) received: AtomicUsize,
    pub(super) sent: AtomicUsize,
    pub(super) received_frames: AtomicUsize,
    pub(super) frame_received: Notify,
}

pub(super) async fn native_fixture_with_traffic(
    response: impl Fn(&Value) -> Value + Clone + Send + Sync + 'static,
    traffic: Option<Arc<NativeTraffic>>,
) -> (T3, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route(
            "/api/auth/websocket-ticket/rpc",
            post(|| async { Json(json!({"ticket":"fixture"})) }),
        )
        .route(
            "/ws",
            get(move |upgrade: WebSocketUpgrade| async move {
                upgrade.on_upgrade(move |mut ws| async move {
                    while let Some(Ok(Message::Text(frame))) = ws.recv().await {
                        if let Some(traffic) = &traffic {
                            traffic.received.fetch_add(frame.len(), Ordering::Relaxed);
                            traffic.received_frames.fetch_add(1, Ordering::Relaxed);
                            traffic.frame_received.notify_one();
                        }
                        let req: Value = serde_json::from_str(&frame).expect("Effect request");
                        if req["_tag"] == "Request" {
                            let reply = response(&req);
                            if reply.is_null() {
                                break;
                            }
                            let reply = reply.to_string();
                            let bytes = reply.len();
                            ws.send(Message::Text(reply.into())).await.expect("reply");
                            if let Some(traffic) = &traffic {
                                traffic.sent.fetch_add(bytes, Ordering::Relaxed);
                            }
                        }
                    }
                })
            }),
        );
    let tcp = TcpListener::bind("127.0.0.1:0").await.expect("listen");
    let host = T3::new(
        &format!("http://{}", tcp.local_addr().expect("address")),
        "fixture",
    )
    .expect("native client");
    (
        host,
        tokio::spawn(async {
            axum::serve(tcp, app).await.expect("native server");
        }),
    )
}
