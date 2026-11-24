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

pub(super) async fn forge_fixture(
    head: &Head,
) -> (GitHub, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let reads = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&reads);
    let pull = forge_pull(head);
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
        "statusCheckRollup":{"state":"SUCCESS"},
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
async fn old_report_fences_retry_until_child_custody_allows_the_next_decision() {
    for question in [false, true] {
        let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
        let head = service.fixture().start.clone();
        let (forge, _, server) = forge_fixture(&head).await;
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
            nucleus_core::Report::Work(PullRequest {
                url: PR.into(),
                head,
            })
        };
        task.record_report(&instance, credential.as_bytes(), report)
            .unwrap();
        let row = {
            let mut state = service.state.lock().await;
            let version = state.store.create(&task, &event("fixture")).unwrap();
            let mut blocked = event("host_observation_blocked");
            blocked.detail = serde_json::json!({
                "version": version, "deliveryPending": true,
                "session": format!("{}/previous-engine", service.host.runtime_identity().unwrap()),
            })
            .to_string();
            state.store.claim_task_effect("worker", &blocked).unwrap();
            service.lookup(&state, "worker").unwrap()
        };
        let unknown = Due(AtomicUsize::new(0), None);
        let result = service.advance_due_task(&row, &unknown).await;
        assert!(matches!(
            result,
            Err(ServiceError::Host(HostError::Uncertain))
        ));
        service
            .schedule_result(&row, &result, Priority::Effect)
            .await
            .unwrap();
        {
            let state = service.state.lock().await;
            assert_eq!(state.waits["worker"].0, WaitReason::HostUnknown);
            assert!(state.schedule.due("worker").is_some());
            assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
        }
        let ended = Due(AtomicUsize::new(0), Some(nucleus_core::RunState::Ended));
        let result = service.advance_due_task(&row, &ended).await.unwrap();
        let next = service.task("worker").await.unwrap();
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
        assert_eq!(
            unknown.0.load(Ordering::Relaxed) + ended.0.load(Ordering::Relaxed),
            0
        );
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
        state.set_wait("unsent", Some(WaitReason::Capacity));
        row
    };
    let refused = Err(service.parent_not_sent("preflight custody revision no longer matches"));
    for _ in 0..2 {
        service
            .schedule_result(&row, &refused, Priority::Decision)
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
        assert_eq!(state.waits["unsent"].0, WaitReason::Capacity);
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
                state: nucleus_core::RunState::Ended,
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
                            let reply = response(&req).to_string();
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
