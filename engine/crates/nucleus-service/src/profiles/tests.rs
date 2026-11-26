use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Instant,
};

use axum::{Json, Router, routing::get};
use nucleus_core::{Authority, Entry, Forge, Identity, Launch, Observed, Phase, Workspace};
use serde_json::{Value, json};

use super::*;
use crate::{
    schedule::Priority,
    tests::{NativeTraffic, REPOSITORY, fixture, native_fixture_with_traffic, serve_forge},
};
use nucleus_store::DispatchSettings;

const IDS: [&str; 3] = ["overlap-a", "overlap-b", "overlap-c"];
const RESET_MS: u64 = 4_070_908_800_000;

#[tokio::test]
async fn worker_launches_exclude_disabled_wrong_role_and_unavailable_profiles() {
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
            {"name":"Review","roles":["reviewer"],"selection":{"id":"review","provider":"codex","model":"first"}},
            {"name":"Coordinator","roles":["coordinator"],"selection":{"id":"coordinator","provider":"codex","model":"first"}},
            {"name":"Missing instance","providerInstanceId":"unavailable","selection":{"id":"missing-instance","provider":"codex","model":"first"}},
            {"name":"Missing model","providerInstanceId":"codex","selection":{"id":"missing-model","provider":"codex","model":"other"}},
            {"name":"Worker","roles":["worker"],"modeId":"supervised",
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
        Some(("review", true)),
        Some(("coordinator", true)),
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

    native.lock().expect("native runs").limited = Some(threads[0].clone());
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
                {"name":"Reviewer","roles":["reviewer"],"selection":{"id":"review","provider":"codex","model":"second","capability":"mechanical"}},
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
