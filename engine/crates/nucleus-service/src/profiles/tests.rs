use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Instant,
};

use axum::{
    Json, Router,
    routing::{get, post},
};
use nucleus_core::{
    Authority, CheckState, Command, Entry, Forge, Host, Identity, Launch, LaunchInputs, Observed,
    Phase, PullRequest, Report, RetainedThread, Review, RunState, Workspace, decide,
    profiles::Profile,
};
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::{
    schedule::Priority,
    tests::{
        NativeTraffic, REPOSITORY, create_fixture_commit, fixture, forge_checks, forge_pull, git,
        native_fixture_with_traffic, serve_forge,
    },
};
use nucleus_store::DispatchSettings;

const IDS: [&str; 3] = ["overlap-a", "overlap-b", "overlap-c"];
const RESET_MS: u64 = 4_070_908_800_000;
const LOW_BRIEF: &str = "---\nqueue: {complexity: low}\n---\nFix a typo.";

#[tokio::test]
async fn worker_launches_exclude_disabled_and_unavailable_profiles() {
    let (forge, forge_server) = serve_forge(Router::new()).await;
    let (_home, mut service) = fixture(forge);
    let (host, native_server) = native_fixture_with_traffic(
        |request| {
            native_response(
                request,
                std::path::Path::new("/fixture"),
                &mut NativeRuns::default(),
            )
        },
        None,
    )
    .await;
    service.host = host;
    service.state.lock().await.settings.profiles = Some(Arc::new(serde_json::from_value(json!({
        "profiles": [
            {"name":"Disabled","enabled":false,"selection":{"id":"disabled","provider":"codex","model":"first"}},
            {"name":"Missing instance","providerInstanceId":"unavailable","selection":{"id":"missing-instance","provider":"codex","model":"first"}},
            {"name":"Missing model","providerInstanceId":"codex","selection":{"id":"missing-model","provider":"codex","model":"other"}},
            {"name":"Worker","modeId":"supervised",
             "featureValues":{"speed":"priority"},
             "selection":{"id":"worker","provider":"codex","model":"second"}}
        ]
    })).expect("profile settings")));
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Absent),
    };
    let host = service.host.fixture_pass();
    for request in [
        None,
        Some(("disabled", true)),
        Some(("missing-instance", true)),
        Some(("missing-model", true)),
        Some(("missing-instance", false)),
        Some(("missing-model", false)),
    ] {
        let brief = match request {
            Some((id, required)) => format!(
                "---\nqueue:\n  profileRequests:\n    worker:\n      profileId: {id}\n      reason: fixture\n      required: {required}\n---\nFixture brief"
            ),
            None => "Fixture brief".into(),
        };
        let mut task = Task::new(
            Identity {
                id: "fixture".into(),
                reference: "fixture".into(),
                repository: REPOSITORY.into(),
                base: "main".into(),
                entry: Entry::Brief,
                origin_thread: None,
            },
            brief,
            None,
        );
        assert_eq!(
            task.reconcile(&observation),
            Action::Advance(Phase::Working)
        );
        match (
            request,
            service
                .select_launch(&task, &observation, Role::Worker, &host)
                .await,
        ) {
            (None | Some((_, false)), Ok(LaunchSelection::Profile(selected))) => {
                assert_eq!(selected.intent.profile().id, "worker");
                assert_eq!(selected.native.runtime_mode, "approval-required");
                assert_eq!(
                    json!(selected.native.options),
                    json!([{"id":"serviceTier","value":"priority"}])
                );
            }
            (
                Some((requested, true)),
                Err(ServiceError::Profile(ProfileLaunchError::RequiredProfileUnavailable {
                    id,
                    ..
                })),
            ) => assert_eq!(requested, id),
            _ => panic!("unexpected eligibility result for {request:?}"),
        }
    }
    native_server.abort();
    forge_server.abort();
}

fn configured_profiles() -> Arc<Profiles> {
    Arc::new(serde_json::from_value::<Profiles>(json!({"profiles": [
        {"name":"Sol heavyweight",
         "selection":{"id":"sol","provider":"codex","model":"first","capability":"heavyweight"}},
        {"name":"Sol alternate",
         "selection":{"id":"sol-alternate","provider":"codex","model":"first","capability":"heavyweight"}},
        {"name":"Sonnet heavyweight",
         "selection":{"id":"sonnet","provider":"claude","model":"other","capability":"heavyweight"}},
        {"name":"Astra frontier",
         "selection":{"id":"astra","provider":"codex","model":"second","capability":"frontier"}}
    ]})).unwrap())
}

#[tokio::test]
async fn configured_profiles_participate_in_work_review_and_groups() {
    let (forge, forge_server) = serve_forge(Router::new()).await;
    let (_home, mut service) = fixture(forge);
    let (host, native_server) = crate::tests::native_fixture(|request| {
        native_response(
            request,
            std::path::Path::new("/fixture"),
            &mut NativeRuns::default(),
        )
    })
    .await;
    service.host = host;
    let profiles = configured_profiles();
    service.state.lock().await.settings.profiles = Some(Arc::clone(&profiles));
    let host = service.host.fixture_pass();
    let mut observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Absent),
    };
    let mut task = Task::new(
        Identity {
            id: "fixture".into(),
            reference: "fixture".into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "---\nqueue:\n  complexity: very_high\n  profileRequests:\n    worker: {profileId: sol, reason: build, required: true}\n    reviewer: {profileId: sol-alternate, reason: review}\n---\nFixture brief".into(),
        None,
    );
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    let LaunchSelection::Profile(worker) = service
        .select_launch(&task, &observation, Role::Worker, &host)
        .await
        .unwrap()
    else {
        panic!("expected a worker");
    };
    assert_eq!(worker.intent.profile().id, "sol");
    assert_eq!(
        service.effective_profile_groups(&profiles)["astra"],
        "codex"
    );
    let instance = worker.intent.instance().to_owned();
    let bearer = task
        .reserve_profile_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: "worker-fixture".into(),
                input: "fixture wire".into(),
                started_at: 1,
            },
            &[7; 32],
            worker.intent,
        )
        .unwrap();
    task.record_send(&instance, 2).unwrap();
    let pr = PullRequest {
        url: format!("https://github.com/{REPOSITORY}/pull/1"),
        head: service.fixture().start.clone(),
    };
    task.record_report(
        &instance,
        bearer.as_bytes(),
        Report::Work(pr.clone().into()),
    )
    .unwrap();
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    observation.workspace = Observed::Known(Workspace::Clean(pr.head.clone()));
    observation.forge = Observed::Known(Forge::Open {
        pr,
        checks: CheckState::Ready,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Reviewing)
    );
    let LaunchSelection::Profile(reviewer) = service
        .select_launch(&task, &observation, Role::Reviewer, &host)
        .await
        .unwrap()
    else {
        panic!("expected an independent reviewer");
    };
    assert_eq!(reviewer.intent.profile().id, "sonnet");
    native_server.abort();
    forge_server.abort();
}

#[test]
fn an_unknown_reset_pauses_for_a_day_from_the_failure() {
    let mut limit = ProviderLimit {
        instance: "fixture".into(),
        ended_at_ms: 1_000_000,
        reset_at_ms: Some(1_015_000),
    };
    assert_eq!(
        limit_pause(&limit),
        SubscriptionPause {
            until_ms: 1_015_000,
            fallback: false
        }
    );
    limit.reset_at_ms = None;
    assert_eq!(
        limit_pause(&limit),
        SubscriptionPause {
            until_ms: 87_400_000,
            fallback: true
        }
    );
    limit.reset_at_ms = Some(999_999);
    assert_eq!(
        limit_pause(&limit),
        SubscriptionPause {
            until_ms: 87_400_000,
            fallback: true
        }
    );
}

#[derive(Default)]
struct NativeRuns {
    launches: BTreeMap<String, Value>,
    limited: Option<String>,
}

impl NativeRuns {
    fn limit(&mut self, thread: &str) -> Value {
        self.limited = Some(thread.into());
        let launch = &self.launches[thread];
        json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1, "projects":[], "threads":[{
                "id":thread, "projectId":"local-fixture",
                "worktreePath":launch["workspaceStrategy"]["worktreePath"],
                "branch":launch["workspaceStrategy"]["branch"], "status":"failed",
                "latestRunId":"native-run", "activeRunId":null,
                "pendingRuntimeRequest":null, "pendingBackgroundTasks":[],
            }]
        }})
    }
}

fn native_response(request: &Value, root: &std::path::Path, runs: &mut NativeRuns) -> Value {
    let payload = &request["payload"];
    let reply = |value| {
        json!({
            "_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":value}
        })
    };
    let snapshot = |value| {
        json!({
            "_tag":"Chunk","requestId":request["id"],"values":[value,{"kind":"synchronized"}]
        })
    };
    match request["tag"].as_str() {
        Some("server.getConfig") => reply(json!({
            "environment":{"orchestrationProtocolVersion":2},
            "providers":[
                {"instanceId":"codex","enabled":true,"status":"ready",
                 "usageLimits":{"windows":[{"id":"monthly","kind":"monthly","label":"Monthly",
                    "usedPercent":100,"modelIds":["first","second"],"resetsAt":"2099-01-01T00:00:00Z"}]},
                 "models":[{"slug":"first"},{"slug":"second","capabilities":{
                    "optionDescriptors":[{"id":"serviceTier","type":"select",
                                          "options":[{"id":"default"},{"id":"priority"}]}]
                 }}]},
                {"instanceId":"claudeAgent","enabled":true,"status":"ready",
                 "models":[{"slug":"other"}]}
            ]
        })),
        Some("orchestration.subscribeShell") => snapshot(json!({
            "kind":"snapshot","snapshot":{"projects":[{"id":"local-fixture","workspaceRoot":root}]}
        })),
        Some("orchestration.launchThread") => {
            let id = payload["threadId"].as_str().expect("launched thread");
            assert!(runs.launches.insert(id.into(), payload.clone()).is_none());
            reply(json!({"sequence":1}))
        }
        Some("orchestration.subscribeThread") => {
            let id = payload["threadId"].as_str().expect("observed thread");
            let Some(launch) = runs.launches.get(id) else {
                return json!({
                    "_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Failure","cause":[
                        {"_tag":"Fail","error":{
                            "_tag":"OrchestrationV2GetThreadProjectionError","threadId":id,
                            "cause":{"name":"ProjectionStoreThreadNotFoundError",
                                     "message":format!("No orchestration projection exists for thread {id}.")}
                        }}
                    ]}
                });
            };
            let limited = runs.limited.as_deref() == Some(id);
            let completed = limited.then_some("2026-11-24T08:00:00Z");
            let errors = if limited {
                json!([{
                    "id":"usage-limit","runId":"native-run","type":"error","status":"failed",
                    "nodeId":"root","ordinal":1,"updatedAt":completed,
                    "failure":{"class":"provider_error","code":null,
                        "message":r#"402: {"type":"invalid_request_error","message":"Insufficient balance."}"#}
                }])
            } else {
                json!([])
            };
            snapshot(json!({
                "kind":"snapshot","snapshotSequence":1,"projection":{
                    "thread":{"id":id,"projectId":"local-fixture",
                              "worktreePath":launch["workspaceStrategy"]["worktreePath"],
                              "branch":launch["workspaceStrategy"]["branch"]},
                    "runs":[{"id":"native-run","rootNodeId":"root",
                             "status":if limited {"failed"} else {"running"},
                             "userMessageId":launch["initialMessage"]["messageId"],
                             "providerInstanceId":launch["modelSelection"]["instanceId"],
                             "startedAt":"2026-11-24T07:55:00Z","modelSelection":launch["modelSelection"],
                             "completedAt":completed}],
                    "messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":errors
                }
            }))
        }
        _ => panic!("unexpected fixture RPC {}", request["tag"]),
    }
}

async fn pass(service: &Service) -> Vec<crate::PassOutcome> {
    let host = service.host.fixture_pass();
    let outcomes = service.pass_with_host(&host).await.expect("scheduler pass");
    for outcome in &outcomes {
        assert!(
            outcome.result.is_ok(),
            "{}: {:?}",
            outcome.task,
            outcome.result
        );
    }
    outcomes
}

async fn wake(service: &Service, ids: &[&str]) {
    let mut state = service.state.lock().await;
    for id in ids {
        state
            .schedule
            .wake(id, tokio::time::Instant::now(), Priority::Wake);
    }
}

async fn launch_three(service: &Service, native: &Mutex<NativeRuns>) -> Vec<String> {
    {
        let mut state = service.state.lock().await;
        state.settings.dispatch = Some(DispatchSettings {
            global_slots: 3,
            ..DispatchSettings::default()
        });
        state.settings.profiles = Some(Arc::new(serde_json::from_value(json!({
            "pausedGroups":["claudeAgent"],
            "profiles":[
                {"name":"First","group":"shared","selection":{"id":"first","provider":"codex","model":"first"}},
                {"name":"Second","group":"shared","selection":{"id":"second","provider":"codex","model":"second"}},
                {"name":"Other","selection":{"id":"other","provider":"claude","model":"other"}}
            ]
        })).expect("profiles and an operator pause")));
    }
    let mut threads = Vec::new();
    for id in IDS {
        service
            .admit(
                id.into(),
                id.into(),
                "---\nqueue:\n  complexity: medium\n---\nFixture café".into(),
                &Authority::Operator {
                    actor: "fixture".into(),
                },
            )
            .await
            .expect("admit task");
        for expected in [
            Action::Advance(Phase::Working),
            Action::Launch {
                role: Role::Worker,
                via: Launch::Create,
            },
            Action::Launch {
                role: Role::Worker,
                via: Launch::SendPrepared,
            },
        ] {
            let outcomes = pass(service).await;
            assert_eq!(outcomes.len(), 1);
            assert_eq!(outcomes[0].task, id);
            assert!(matches!(&outcomes[0].result, Ok(actual) if *actual == expected));
        }
        // Hold the running tasks at the same observation point until the measured pass.
        service.state.lock().await.schedule.park(id);
        let row = service.task(id).await.expect("admitted task");
        let run = row.task.run().expect("overlapping run");
        assert!(run.last_send_at_ms().is_some());
        assert_eq!(run.launch().subscription_group(), Some("shared"));
        threads.push(run.launch().thread.clone());
    }
    assert_eq!(native.lock().expect("native runs").launches.len(), 3);

    threads
}

async fn measure_overlap(service: &Service, traffic: &NativeTraffic) {
    // The last launch reply follows the warm-up traffic on this socket.
    let bytes = || {
        (
            traffic.received.load(Ordering::Relaxed),
            traffic.sent.load(Ordering::Relaxed),
        )
    };
    let (received_before, sent_before) = bytes();
    let frames_before = traffic.received_frames.load(Ordering::Relaxed);
    let started = Instant::now();
    wake(service, &IDS).await;
    let active = pass(service).await;
    assert_eq!(active.len(), 3);
    assert!(
        active
            .iter()
            .all(|outcome| matches!(outcome.result, Ok(Action::Wait(WaitReason::Running))))
    );
    // Each exact read sends a request, acknowledgement and stream interrupt.
    let expected = frames_before + IDS.len() * 3;
    while traffic.received_frames.load(Ordering::Relaxed) < expected {
        traffic.frame_received.notified().await;
    }
    assert_eq!(traffic.received_frames.load(Ordering::Relaxed), expected);
    let (received, sent) = bytes();
    let elapsed = started.elapsed().as_secs_f64();
    let received = received - received_before;
    let sent = sent - sent_before;
    assert!(received > 0 && sent > 0 && elapsed > 0.0);
    let total = u32::try_from(received + sent).expect("bounded fixture traffic");
    let steady = f64::from(total) * 60.0 / crate::schedule::LIVE_CHECK.as_secs_f64();
    eprintln!(
        "One exact-read pass for three concurrent runs measured {received} outbound + {sent} inbound T3 WebSocket text bytes in {elapsed:.6} s. At the scheduler's 45-second refresh interval, that is {steady:.0} bytes/min.",
    );
}

async fn assert_limit_fact(service: &Service) {
    let state = service.state.lock().await;
    let events = state
        .store
        .lifecycle_events(IDS[0])
        .expect("lifecycle facts");
    let fact = events
        .iter()
        .find(|event| event.content.kind == "provider_limit")
        .expect("limit event");
    let detail: Value = serde_json::from_str(&fact.content.detail).unwrap();
    assert_eq!(detail["providerLimit"]["group"], "shared");
    assert_eq!(detail["providerLimit"]["resetAtMs"], RESET_MS);
    assert!(
        detail["providerLimit"]["instance"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
}

#[tokio::test]
async fn three_overlapping_tasks_share_provider_pauses_and_measure_t3_traffic() {
    let (forge, forge_server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let root = service.fixture().checkout.clone();
    let native = Arc::new(Mutex::new(NativeRuns::default()));
    let fixture_runs = Arc::clone(&native);
    let traffic = Arc::new(NativeTraffic::default());
    let (host, native_server) = native_fixture_with_traffic(
        move |request| {
            native_response(
                request,
                &root,
                &mut fixture_runs.lock().expect("native runs"),
            )
        },
        Some(Arc::clone(&traffic)),
    )
    .await;
    service.host = host;
    let threads = launch_three(&service, &native).await;
    measure_overlap(&service, &traffic).await;

    let shell = native.lock().expect("native runs").limit(&threads[0]);
    service.host.fixture_held_shell(&shell);
    wake(&service, &IDS[..1]).await;
    let ended = pass(&service).await;
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].task, IDS[0]);
    // The exhausted run has settled. Observe the next decision on that row.
    wake(&service, &IDS[..1]).await;
    let result = pass(&service).await;
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].task, IDS[0]);
    assert!(matches!(
        result[0].result,
        Ok(Action::Wait(WaitReason::Capacity))
    ));
    let limited = service.task(IDS[0]).await.expect("settled limit");
    assert_limit_fact(&service).await;
    assert_eq!(limited.task.phase(), Phase::Working);
    assert!(limited.task.run().is_none() && limited.task.question().is_none());
    assert_eq!(limited.task.attempts(), 1);
    assert_eq!(
        limited.task.threads().last_provider_limit.as_deref(),
        Some("Provider usage limit for subscription group shared. Reset at 2099-01-01 00:00 UTC.")
    );
    assert_eq!(
        ended[0].result.as_ref().unwrap(),
        &Action::Relaunch(Role::Worker)
    );
    {
        let mut state = service.state.lock().await;
        assert_eq!(
            state
                .store
                .provider_pause("shared", now_ms())
                .expect("stored pause"),
            Some(RESET_MS)
        );
        assert_eq!(
            state
                .store
                .provider_pause("codex", now_ms())
                .expect("fallback pause"),
            None
        );
        assert!(matches!(
            state.group_waits.get(IDS[0]),
            Some(GroupPause::Until {
                reset: RESET_MS,
                ..
            })
        ));
        assert_eq!(
            state
                .store
                .provider_pause("shared", RESET_MS)
                .expect("expired at deadline"),
            None
        );
        let profiles = Arc::make_mut(state.settings.profiles.as_mut().expect("profiles"));
        profiles.paused_groups.clear();
        service.wake_task(&mut state, IDS[0], limited.version, Priority::Wake);
    }
    let _ = pass(&service).await;
    let next = service.task(IDS[0]).await.expect("selected fallback");
    let run = next.task.run().expect("replacement reservation");
    assert_eq!(run.launch().subscription_group(), Some("claudeAgent"));
    assert_ne!(run.launch().thread, threads[0]);
    assert_eq!(next.task.attempts(), 1);
    native_server.abort();
    forge_server.abort();
}

#[tokio::test]
async fn a_stored_subscription_pause_reserves_the_next_tier_and_records_the_reason() {
    let (forge, forge_server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<Value>::new()) }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let root = service.fixture().checkout.clone();
    let (host, native_server) = native_fixture_with_traffic(
        move |request| native_response(request, &root, &mut NativeRuns::default()),
        None,
    )
    .await;
    service.host = host;
    let id = "paused-mechanic";
    {
        let mut state = service.state.lock().await;
        state.settings.profiles = Some(Arc::new(serde_json::from_value(json!({
            "profiles": [
                {"name":"Mechanic","group":"shared","selection":{"id":"mechanic","provider":"codex","model":"first","capability":"mechanical"}},
                {"name":"Second mechanic","group":"shared","selection":{"id":"second","provider":"codex","model":"second","capability":"mechanical"}},
                {"name":"Worker","group":"other","selection":{"id":"worker","provider":"claude","model":"other","capability":"worker"}}
            ]
        })).expect("profile settings")));
        assert_eq!(
            service
                .record_subscription_pause(&state, "shared", RESET_MS, now_ms())
                .unwrap(),
            Some(RESET_MS)
        );
    }
    service
        .admit(
            id.into(),
            id.into(),
            "---\nqueue: {complexity: low}\n---\nFix a typo.".into(),
            &Authority::Operator {
                actor: "fixture".into(),
            },
        )
        .await
        .expect("admit task");
    assert_eq!(
        pass(&service).await[0].result.as_ref().unwrap(),
        &Action::Advance(Phase::Working)
    );
    assert_eq!(
        pass(&service).await[0].result.as_ref().unwrap(),
        &Action::Launch {
            role: Role::Worker,
            via: Launch::Create
        },
    );
    let row = service.task(id).await.expect("stored task");
    let run = row.task.run().expect("stored reservation");
    assert!(run.last_send_at_ms().is_none());
    assert_eq!(run.launch().profile().unwrap().id, "worker");
    assert_eq!(run.launch().subscription_group(), Some("other"));
    let state = service.state.lock().await;
    let events = state.store.history(id, None, 10).unwrap();
    let reservation = events
        .iter()
        .find(|event| event.content.kind == "run_reserved")
        .unwrap();
    let detail: Value = serde_json::from_str(&reservation.content.detail).unwrap();
    assert_eq!(
        detail["profileStepUp"],
        json!({
            "ordinaryCeiling": "mechanical",
            "selectedCapability": "worker",
            "reason": "Every eligible profile within the ordinary ceiling is paused."
        })
    );
    native_server.abort();
    forge_server.abort();
}

fn finish_profile_run(
    task: &mut Task,
    observation: &mut Observation,
    (profile, group, thread): (&Profile, &str, &str),
    report: Report,
    expected: Phase,
) {
    let intent = decide_profile_launch(
        task,
        observation,
        &LaunchPolicy {
            usage: UsageLevel::Normal,
            candidates: &[Candidate {
                profile,
                enabled: true,
                available: true,
                group_available: true,
                supported_efforts: &[],
                counts: RotationCounts::default(),
            }],
            planner_brief: true,
            author_models: &[],
        },
    )
    .unwrap()
    .unwrap();
    let instance = intent.instance().to_owned();
    let credential = task
        .reserve_grouped_launch(
            observation,
            LaunchInputs {
                thread: thread.into(),
                started_at: 1,
                input: "fixture wire".into(),
                scratch: None,
            },
            &[7; 32],
            Some(intent),
            group.into(),
        )
        .unwrap();
    task.record_send(&instance, 2).unwrap();
    if let Report::Work(work) = &report {
        observation.forge = Observed::Known(Forge::Open {
            pr: work.pull_request.clone(),
            checks: CheckState::Ready,
        });
        observation.workspace = Observed::Known(Workspace::Clean(work.pull_request.head.clone()));
    }
    task.record_report(&instance, credential.as_bytes(), report)
        .unwrap();
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    assert_eq!(task.reconcile(observation), Action::Advance(expected));
}

fn retained_role_task(
    service: &Service,
    id: &str,
    author: &Profile,
    reviewer: &Profile,
    role: Role,
    brief: &str,
) -> (Task, nucleus_hosts::Binding) {
    let head = service.fixture().start.clone();
    let pr = PullRequest {
        url: format!("https://github.com/{REPOSITORY}/pull/1"),
        head: head.clone(),
    };
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(&service.fixture().checkout, REPOSITORY, id)
        .unwrap();
    checkout.allocate(&head).unwrap();
    let binding = service.binding(&checkout).unwrap();
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        brief.into(),
        None,
    );
    let mut observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(Workspace::Clean(head.clone())),
    };
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    finish_profile_run(
        &mut task,
        &mut observation,
        (author, "author", "thread:worker"),
        Report::Work(pr.clone().into()),
        Phase::Reviewing,
    );
    finish_profile_run(
        &mut task,
        &mut observation,
        (reviewer, "review", "thread:reviewer"),
        Report::Review {
            head,
            decision: Review::Changes,
            summary: "Fix the spelling.".into(),
            finding_titles: vec![],
        },
        Phase::Working,
    );
    let mut published = pr;
    if role == Role::Reviewer {
        create_fixture_commit(checkout.path(), "revision");
        published.head = git(checkout.path(), &["rev-parse", "HEAD"])
            .parse()
            .unwrap();
        observation.host = Observed::Known(Host::Retained {
            thread: "thread:worker".into(),
            state: RetainedThread::Queueable,
        });
        finish_profile_run(
            &mut task,
            &mut observation,
            (author, "author", "thread:worker"),
            Report::Work(published.clone().into()),
            Phase::Reviewing,
        );
    } else {
        task.command(
            Command::MoveWork {
                instruction: "Rebase before revising.".into(),
            },
            &Authority::Operator {
                actor: "fixture".into(),
            },
            &observation,
        )
        .unwrap();
    }
    let thread = task.threads().get(role).unwrap();
    observation.host = Observed::Known(Host::Retained {
        thread: thread.into(),
        state: RetainedThread::Queueable,
    });
    assert_eq!(
        decide(&task, &observation),
        Action::Launch {
            role,
            via: Launch::Continue {
                thread: thread.into()
            }
        }
    );

    (task, binding)
}

async fn retained_role_endpoints(
    service: &mut Service,
    published: Option<&PullRequest>,
    binding: nucleus_hosts::Binding,
    thread: &'static str,
) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
    let parent = nucleus_hosts::parent_thread(std::path::Path::new(&binding.worktree_path));
    let branch = binding.branch;
    let owned = binding.worktree_path;
    let mut router = Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(json!([])) }),
    );
    if let Some(published) = published {
        let mut pull = forge_pull(&published.head);
        pull["head"]["ref"] = json!(branch);
        let checks = forge_checks(&published.head);
        router = router
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async { Json(pull) }),
            )
            .route("/graphql", post(move || async { Json(checks) }));
    }
    let (forge, forge_server) = serve_forge(router).await;
    service.forge = forge;
    let root = service.fixture().checkout.clone();
    let runs = Arc::new(Mutex::new(NativeRuns::default()));
    let (host, native_server) = native_fixture_with_traffic(move |request| {
        if request["tag"] == "orchestration.subscribeThread" && request["payload"]["threadId"] == thread {
            return json!({"_tag":"Chunk","requestId":request["id"],"values":[
                {"kind":"snapshot","snapshotSequence":1,"projection":{
                    "thread":{"id":thread,"projectId":"local-fixture","worktreePath":owned,"branch":branch,"parentThreadId":parent},
                    "runs":[],"messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[]
                }},{"kind":"synchronized"}
            ]});
        }
        native_response(request, &root, &mut runs.lock().unwrap())
    }, None).await;
    service.host = host;
    (native_server, forge_server)
}

#[tokio::test]
async fn retained_roles_launch_on_a_shared_model_and_leave_a_single_reservation_notice() {
    let profiles = configured_profiles();
    let [author, shared, reviewer, _] = profiles.profiles.as_slice() else {
        panic!("expected fixture profiles");
    };
    let authority = Authority::Operator {
        actor: "fixture".into(),
    };
    for (role, thread, author, reviewer, expected) in [
        (
            Role::Worker,
            "thread:worker",
            &reviewer.selection,
            &shared.selection,
            "Worker shares first with the reviewer: required worker profile",
        ),
        (
            Role::Reviewer,
            "thread:reviewer",
            &author.selection,
            &reviewer.selection,
            "Review shares first with the worker: no other usable reviewer",
        ),
    ] {
        let (_home, mut service) = fixture(nucleus_forge::GitHub::new("fixture").unwrap());
        let id = "shared-model-resume";
        let (task, binding) = retained_role_task(
            &service,
            id,
            author,
            reviewer,
            role,
            "---\nqueue: {complexity: very_high}\n---\nFix the typo.",
        );
        let (native_server, forge_server) =
            retained_role_endpoints(&mut service, task.pull_request(), binding, thread).await;
        {
            let mut state = service.state.lock().await;
            state.settings.profiles = Some(Arc::new(Profiles {
                profiles: vec![shared.clone()],
                ..profiles.as_ref().clone()
            }));
            state.store.create(&task, &crate::event("fixture")).unwrap();
        }
        let service = Arc::new(service);
        if role == Role::Worker {
            service.command(id, &authority, Command::Amend(
                "---\nqueue: {complexity: very_high, profileRequests: {worker: {profileId: sol-alternate, reason: fixture, required: true}}}\n---\nFix the typo.".into()
            )).await.unwrap();
        }
        let row = service.task(id).await.unwrap();
        service
            .schedule_result(
                &row,
                &Ok(Action::Wait(WaitReason::Capacity)),
                Priority::Wake,
            )
            .await
            .unwrap();
        assert_eq!(
            read_next(&service, id, &authority).await["wait"],
            "capacity"
        );

        wake(&service, &[id]).await;
        assert_eq!(
            pass(&service).await[0].result.as_ref().unwrap(),
            &Action::Launch {
                role,
                via: Launch::Create
            }
        );
        let stored = service.task(id).await.unwrap();
        let launch = stored.task.run().unwrap().launch();
        assert_eq!(launch.profile(), Some(&shared.selection));
        let next = read_next(&service, id, &authority).await;
        assert_ne!(next["wait"], "capacity");
        assert!(next["question"].is_null());
        assert_eq!(next["sharedModel"], expected);
        assert_eq!(
            read_task_api(&service, &format!("/v1/tasks/{id}"), &authority).await["sharedModel"],
            expected
        );
        if role == Role::Reviewer {
            let wire: Value = serde_json::from_str(&launch.input).unwrap();
            let prompt = wire["payload"]["initialMessage"]["text"].as_str().unwrap();
            assert_eq!(prompt.lines().filter(|line| *line == expected).count(), 1);
        }
        // Subsequent scheduler passes would surface a selection error to the serve log.
        for _ in 0..3 {
            wake(&service, &[id]).await;
            pass(&service).await;
        }
        let running = service.task(id).await.unwrap();
        assert!(running.task.run().unwrap().last_send_at_ms().is_some());
        assert_shared_reservation(&service, id, &launch.instance, expected).await;
        native_server.abort();
        forge_server.abort();
    }
}

async fn assert_shared_reservation(service: &Service, id: &str, instance: &str, expected: &str) {
    let state = service.state.lock().await;
    let history = state.store.history(id, None, 30).unwrap();
    let mut reservations = history
        .iter()
        .filter(|event| event.content.kind == "run_reserved");
    let detail: Value = serde_json::from_str(&reservations.next().unwrap().content.detail).unwrap();
    assert_eq!(
        detail["sharedModel"],
        json!({"runInstance": instance, "message": expected})
    );
    assert!(reservations.next().is_none());
}

#[tokio::test]
async fn paused_retained_roles_reselect_from_stored_rows_and_required_profiles_wait() {
    let profiles: Profiles = serde_json::from_value(json!({
        "profiles": [
            {"name":"Author as reviewer","group":"decoy","selection":{"id":"decoy","provider":"codex","model":"first","capability":"mechanical"}},
            {"name":"Author","group":"author","selection":{"id":"author","provider":"codex","model":"first","capability":"mechanical"}},
            {"name":"Reviewer","group":"review","selection":{"id":"review","provider":"codex","model":"second","capability":"mechanical"}},
            {"name":"Replacement","group":"other","selection":{"id":"replacement","provider":"claude","model":"other","capability":"worker"}}
        ]
    })).unwrap();
    let author = &profiles.profiles[1].selection;
    let reviewer = &profiles.profiles[2].selection;
    for (role, required, manual) in [
        (Role::Reviewer, false, false),
        (Role::Worker, false, false),
        (Role::Worker, false, true),
        (Role::Reviewer, true, false),
    ] {
        let (_home, mut service) = fixture(nucleus_forge::GitHub::new("fixture").unwrap());
        let id = "retained-pause";
        let (thread, groups): (&str, &[&str]) = match role {
            Role::Worker => ("thread:worker", &["author", "decoy", "review"]),
            Role::Reviewer if required => ("thread:reviewer", &["review", "decoy"]),
            Role::Reviewer => ("thread:reviewer", &["review"]),
        };
        let brief = if required {
            "---\nqueue: {complexity: low, profileRequests: {reviewer: {profileId: review, reason: fixture, required: true}}}\n---\nFix a typo."
        } else {
            LOW_BRIEF
        };
        let (task, binding) = retained_role_task(&service, id, author, reviewer, role, brief);
        let (native_server, forge_server) =
            retained_role_endpoints(&mut service, task.pull_request(), binding, thread).await;
        {
            let mut state = service.state.lock().await;
            let mut settings = profiles.clone();
            for &group in groups {
                if manual {
                    settings.paused_groups.insert(group.into());
                } else {
                    service
                        .record_subscription_pause(&state, group, RESET_MS, now_ms())
                        .unwrap();
                }
            }
            state.settings.profiles = Some(Arc::new(settings));
            state.store.create(&task, &crate::event("fixture")).unwrap();
        }
        let row = service.task(id).await.unwrap();
        assert_eq!(row.task.threads().get(role), Some(thread));
        let actual = service
            .advance(&row, &service.host.fixture_pass())
            .await
            .unwrap();
        let next = service.task(id).await.unwrap();
        if required {
            assert_eq!(actual, Action::Wait(WaitReason::Capacity));
            assert!(next.task.run().is_none());
            service
                .schedule_result(&row, &Ok(actual), Priority::Wake)
                .await
                .unwrap();
            let state = service.state.lock().await;
            let wait = &state.waits[id];
            assert_eq!(
                crate::titles::task_state_label(&next.task, wait.reason, wait.detail.as_ref()),
                "Reviewing · paused"
            );
            assert!(matches!(
                &wait.detail,
                Some(crate::WaitDetail::Blocked(cause))
                    if cause == &format!("Paused: subscription group review resets at {}.", snooze_deadline(RESET_MS))
            ));
        } else {
            assert_eq!(
                actual,
                Action::Launch {
                    role,
                    via: Launch::Create
                }
            );
            let launch = next.task.run().unwrap().launch();
            assert_ne!(launch.thread, thread);
            assert_eq!(launch.profile().unwrap().id, "replacement");
            assert_eq!(launch.subscription_group(), Some("other"));
            if role == Role::Worker {
                let wire: Value = serde_json::from_str(&launch.input).unwrap();
                let prompt = wire["payload"]["initialMessage"]["text"].as_str().unwrap();
                assert!(prompt.contains("Rebase before revising."));
                assert!(prompt.contains("Fix the spelling."));
            }
        }
        native_server.abort();
        forge_server.abort();
    }
}

#[tokio::test]
async fn complexity_amendments_route_a_stored_worker_and_explain_reselection_in_next() {
    let profiles: Profiles = serde_json::from_value(json!({
        "profiles": [
            {"name":"Luna","group":"author","selection":{"id":"luna","provider":"codex","model":"first","capability":"mechanical"}},
            {"name":"Reviewer","group":"review","selection":{"id":"review","provider":"codex","model":"second","capability":"mechanical"}},
            {"name":"Sol","group":"heavy","selection":{"id":"sol","provider":"claude","model":"other","capability":"heavyweight"}}
        ]
    }))
    .unwrap();
    let luna = &profiles.profiles[0].selection;
    let reviewer = &profiles.profiles[1].selection;
    let sol = &profiles.profiles[2].selection;
    let high = "---\nqueue: {complexity: very_high}\n---\nFix the typo.";
    let required = "---\nqueue: {complexity: very_high, profileRequests: {worker: {profileId: luna, reason: fixture, required: true}}}\n---\nFix the typo.";
    let authority = Authority::Operator {
        actor: "fixture".into(),
    };
    let thread = "thread:worker";
    for (brief, amended, author, expected, reselect) in [
        (LOW_BRIEF, high, luna, sol, true),
        (LOW_BRIEF, required, luna, luna, false),
        (high, LOW_BRIEF, sol, sol, false),
        (
            LOW_BRIEF,
            "---\nqueue: {complexity: low}\n---\nFix the typo.",
            luna,
            luna,
            false,
        ),
    ] {
        let (_home, mut service) = fixture(nucleus_forge::GitHub::new("fixture").unwrap());
        let id = "retained-amend";
        let (task, binding) =
            retained_role_task(&service, id, author, reviewer, Role::Worker, brief);
        let (native_server, forge_server) =
            retained_role_endpoints(&mut service, task.pull_request(), binding, thread).await;
        {
            let mut state = service.state.lock().await;
            state.settings.profiles = Some(Arc::new(profiles.clone()));
            state.store.create(&task, &crate::event("fixture")).unwrap();
        }
        let service = Arc::new(service);
        service
            .command(id, &authority, Command::Amend(amended.into()))
            .await
            .unwrap();
        if brief == high {
            service
                .command(id, &authority, Command::Move(Phase::Working))
                .await
                .unwrap();
        }
        let row = service.task(id).await.unwrap();
        assert_eq!(row.task.threads().profile(Role::Worker), Some(author));
        assert_eq!(row.task.brief().text, amended);
        let next = read_next(&service, id, &authority).await;
        if reselect {
            assert_eq!(
                next["profileReselections"],
                json!([
                    "The retained worker will be reselected on its next run because its Mechanical profile is below the Heavyweight bracket for the raised complexity."
                ])
            );
        } else {
            assert!(next.get("profileReselections").is_none());
        }
        let actual = service
            .advance(&row, &service.host.fixture_pass())
            .await
            .unwrap();
        let via = if reselect {
            Launch::Create
        } else {
            Launch::Continue {
                thread: thread.into(),
            }
        };
        assert_eq!(
            actual,
            Action::Launch {
                role: Role::Worker,
                via
            }
        );
        let next = service.task(id).await.unwrap();
        let launch = next.task.run().unwrap().launch();
        assert_eq!(launch.profile(), Some(expected));
        assert_eq!(launch.thread != thread, reselect);
        if reselect {
            let wire: Value = serde_json::from_str(&launch.input).unwrap();
            let prompt = wire["payload"]["initialMessage"]["text"].as_str().unwrap();
            assert!(prompt.contains("Rebase before revising."));
            assert!(prompt.contains("Fix the spelling."));
        }
        native_server.abort();
        forge_server.abort();
    }
}

async fn read_next(service: &Arc<Service>, id: &str, authority: &Authority) -> Value {
    read_task_api(service, &format!("/v1/tasks/{id}/next"), authority).await
}

async fn read_task_api(service: &Arc<Service>, path: &str, authority: &Authority) -> Value {
    let key = [13; 32];
    let api = crate::web::router(
        Arc::clone(service),
        [crate::web::Controller {
            credential: key,
            authority: authority.clone(),
        }],
    );
    let response = api
        .oneshot(
            axum::http::Request::get(path)
                .header("host", "127.0.0.1:9")
                .header("authorization", format!("Bearer {}", hex::encode(key)))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

const REMINDER_TASK: &str = "reserved-reminder";

fn stored_reminder(
    service: &Service,
    role: Role,
    required: bool,
) -> (Task, nucleus_hosts::Binding, nucleus_core::Head) {
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(&service.fixture().checkout, REPOSITORY, REMINDER_TASK)
        .unwrap();
    checkout.allocate(&service.fixture().start).unwrap();
    create_fixture_commit(checkout.path(), "work already on the branch");
    let head: nucleus_core::Head = git(checkout.path(), &["rev-parse", "HEAD"])
        .parse()
        .unwrap();
    let binding = service.binding(&checkout).unwrap();
    let (key, pr) = match role {
        Role::Worker => ("worker", None),
        Role::Reviewer => (
            "reviewer",
            Some(PullRequest {
                url: format!("https://github.com/{REPOSITORY}/pull/1"),
                head: head.clone(),
            }),
        ),
    };
    let brief = if required {
        format!(
            "---\nqueue: {{complexity: low, profileRequests: {{{key}: {{profileId: paused, reason: fixture, required: true}}}}}}\n---\nFix a typo."
        )
    } else {
        "---\nqueue: {complexity: low}\n---\nFix a typo.".into()
    };
    let task = Task::new(
        Identity {
            id: REMINDER_TASK.into(),
            reference: REMINDER_TASK.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        brief,
        pr,
    );
    let mut task = serde_json::to_value(task).unwrap();
    // Run and thread columns copied from two affected rows, with synthetic bindings.
    let mut stored: Value =
        serde_json::from_str(include_str!("paused-report-reminders.json")).unwrap();
    let stored = &mut stored[key];
    let launch = &mut stored["run"]["launch"];
    let wire = &mut launch["input"];
    wire["binding"] = json!(binding);
    wire["parent"] = json!(nucleus_hosts::parent_thread(checkout.path()));
    *wire = json!(wire.to_string());
    if role == Role::Reviewer {
        launch["review_head"] = json!(head);
    }
    task.as_object_mut()
        .unwrap()
        .append(stored.as_object_mut().unwrap());
    (serde_json::from_value(task).unwrap(), binding, head)
}

#[tokio::test]
async fn paused_reserved_reminders_reselect_from_stored_rows_unless_required() {
    for (role, required, manual) in [
        (Role::Worker, false, false),
        (Role::Reviewer, false, false),
        (Role::Reviewer, false, true),
        (Role::Reviewer, true, false),
    ] {
        let (_home, mut service) = fixture(nucleus_forge::GitHub::new("fixture").unwrap());
        let (task, binding, head) = stored_reminder(&service, role, required);
        let thread = match role {
            Role::Worker => "thread:worker",
            Role::Reviewer => "thread:reviewer",
        };
        let (native, forge) =
            retained_role_endpoints(&mut service, task.pull_request(), binding, thread).await;
        let capacity = if role == Role::Worker {
            "mechanical"
        } else {
            "worker"
        };
        let mut profiles: Profiles = serde_json::from_value(json!({"profiles":[
            {"name":"Paused","group":"opencode-go","selection":{"id":"paused","provider":"codex","model":"second","capability":capacity}},
            {"name":"Replacement","group":"other","selection":{"id":"replacement","provider":"claude","model":"other","capability":"worker"}}
        ]})).unwrap();
        {
            let mut state = service.state.lock().await;
            if manual {
                profiles.paused_groups.insert("opencode-go".into());
            } else {
                service
                    .record_subscription_pause(&state, "opencode-go", RESET_MS, now_ms())
                    .unwrap();
            }
            state.settings.profiles = Some(Arc::new(profiles));
            state.store.create(&task, &crate::event("fixture")).unwrap();
        }
        let run = task.run().unwrap();
        let missing = run.report_reminder_for().unwrap();
        assert!(run.last_send_at_ms().is_none());
        wake(&service, &[REMINDER_TASK]).await;
        let first = pass(&service).await.pop().unwrap().result.unwrap();
        let after = service.task(REMINDER_TASK).await.unwrap();
        if required {
            assert_eq!(first, Action::Wait(WaitReason::Capacity));
            assert_eq!(after.task.run(), Some(run));
            assert!(matches!(
                service.state.lock().await.wait_detail(REMINDER_TASK),
                Some(crate::WaitDetail::Blocked(cause))
                    if cause == &format!("Paused: subscription group opencode-go resets at {}.", snooze_deadline(RESET_MS))
            ));
        } else {
            assert_eq!(first, Action::Advance(task.phase()));
            assert!(after.task.run().is_none());
            let second = pass(&service).await.pop().unwrap().result.unwrap();
            assert_eq!(
                second,
                Action::Launch {
                    role,
                    via: Launch::Create
                }
            );
            let next = service.task(REMINDER_TASK).await.unwrap();
            let launch = next.task.run().unwrap().launch();
            assert_ne!(launch.thread, thread);
            assert_eq!(launch.profile().unwrap().id, "replacement");
            assert_eq!(launch.subscription_group(), Some("other"));
            let wire: Value = serde_json::from_str(&launch.input).unwrap();
            let prompt = wire["payload"]["initialMessage"]["text"].as_str().unwrap();
            assert!(prompt.contains(head.as_str()));
            assert!(prompt.contains(missing));
            assert!(prompt.contains("ended without an authenticated report"));
            assert!(prompt.contains("submit the requested report using this run's binding"));
            assert!(prompt.contains("Fix a typo."));
            assert!(
                !service
                    .state
                    .lock()
                    .await
                    .group_waits
                    .contains_key(REMINDER_TASK)
            );
        }
        native.abort();
        forge.abort();
    }
}
