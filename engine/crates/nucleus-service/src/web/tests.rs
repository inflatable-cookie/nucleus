use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use axum::{
    body::{Body, BodyDataStream, to_bytes},
    http::Request,
};
use futures_util::StreamExt;
use nucleus_core::{
    Action, CheckState, Entry, Forge, Host, LaunchInputs, Observed, RetainedThread, Review,
    RunState,
};
use nucleus_forge::{ForgeError, GitHub};
use nucleus_hosts::{RunActivity, T3, TaskHost};
use nucleus_store::EventDraft;
use tower::ServiceExt;

use super::*;
use crate::{
    event,
    tests::{REPOSITORY, code_task_at_merge, fixture, forge_pull, reservation, serve_forge},
};

#[path = "tests/briefs.rs"]
mod briefs;
#[path = "tests/dependencies.rs"]
mod dependencies;
#[path = "tests/github_accounts.rs"]
mod github_accounts;
#[path = "tests/planning.rs"]
mod planning;
#[path = "tests/projects.rs"]
mod projects;
#[path = "tests/report_only.rs"]
mod report_only;

const PR: &str = "https://github.com/inflatable-cookie/nucleus-fixture/pull/1";
const BOARD_KEY: [u8; 32] = [2; 32];
const PLANNER_KEY: [u8; 32] = [5; 32];
const BOUND_KEY: [u8; 32] = [6; 32];
const LOCAL_HOST: &str = "127.0.0.1:9";

#[tokio::test]
async fn a_committed_reservation_keeps_the_parent_held_before_its_first_send() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let (task, _, _) = crate::tests::reservation_at(
        "worker",
        Entry::Brief,
        &service.fixture().start,
        crate::now_ms(),
    );
    seed_task(&service, &task).await;
    let mut row = service.task("worker").await.expect("reserved row");
    assert!(
        row.task
            .run()
            .expect("reservation")
            .last_send_at_ms()
            .is_none()
    );
    let mut state = service.state.lock().await;
    state
        .observe_wait(&row.task, None)
        .expect("warm reservation");
    assert_eq!(
        state.task_attention(&row).unwrap(),
        crate::attention::TaskAttention::Active
    );
    assert_eq!(
        service.acp_turn_view(&state, &row).expect("reserved view"),
        (None, true)
    );
    state.settings.dispatch = Some(nucleus_store::DispatchSettings {
        mode: nucleus_store::DispatchMode::Paused,
        ..nucleus_store::DispatchSettings::default()
    });
    state.set_wait("worker", Some(WaitReason::Capacity));
    assert_eq!(
        service
            .acp_turn_view(&state, &row)
            .expect("paused reservation"),
        (None, true)
    );
    let instance = row
        .task
        .run()
        .expect("reservation")
        .launch()
        .instance
        .clone();
    row.task.record_send(&instance, 1).expect("send receipt");
    state
        .role_observations
        .insert("worker".into(), (instance.clone(), RunState::Running));
    state.set_wait("worker", Some(WaitReason::HostUnknown));
    assert_eq!(
        state.task_attention(&row).unwrap(),
        crate::attention::TaskAttention::Active
    );
    assert_eq!(
        service.acp_turn_view(&state, &row).expect("deferred view"),
        (None, true)
    );
    for wait in [
        WaitReason::HostObservationBlocked,
        WaitReason::Permission,
        WaitReason::Question,
    ] {
        state.set_wait("worker", Some(wait));
        assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
    }
    state.set_wait("worker", Some(WaitReason::IdleWithoutTerminalRun));
    state.role_observations.insert(
        "worker".into(),
        (instance.clone(), RunState::IdleWithoutTerminalRun),
    );
    assert_eq!(service.acp_turn_view(&state, &row).unwrap(), (None, false));
    state.set_wait("worker", Some(WaitReason::Running));
    state
        .role_observations
        .insert("worker".into(), (instance, RunState::Ended));
    assert_eq!(
        service.acp_turn_view(&state, &row).expect("ended role"),
        (None, false)
    );
}

#[tokio::test]
async fn acp_credentials_are_scoped_and_rotation_closes_the_old_stream() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    for id in ["task-one", "task-two"] {
        let (task, _, _) = reservation(id, Entry::Brief, &service.fixture().start);
        seed_task(&service, &task).await;
    }
    let api = router(
        Arc::new(service),
        [Controller {
            credential: PLANNER_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let path = "/v1/tasks/nucleus-fixture%231/acp";
    let mint = json_body(post_as(&api, path, &PLANNER_KEY, &json!({})).await).await;
    assert!(mint["credential"].is_null());
    let file = std::path::Path::new(mint["bindingPath"].as_str().expect("binding path"));
    let binding: nucleus_core::acp::Binding =
        serde_json::from_slice(&std::fs::read(file).expect("pointer")).expect("binding");
    assert_eq!(
        binding.session_id,
        mint["sessionId"].as_str().expect("session ID")
    );
    assert_eq!(binding.task_id, "task-one");
    let key = &binding.credential;
    let writer = binding.command_credential.as_ref().expect("command key");
    for path in [
        "/v1/tasks/task-two",
        "/v1/tasks/nucleus-fixture%232",
        "/v1/events",
        "/v1/settings",
    ] {
        assert_eq!(
            get_as(&api, path, key).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        post_json(&api, path, key, &json!({})).await,
        StatusCode::UNAUTHORIZED
    );
    let read = json_body(get_as(&api, "/v1/tasks/task-one", key).await).await;
    assert_eq!(read["lifecycle"]["transcript"]["cards"], json!([]));
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/task-two/commands",
            writer,
            &json!("cancel")
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post_json(&api, "/v1/tasks/task-one/commands", key, &json!("cancel")).await,
        StatusCode::UNAUTHORIZED,
        "a read key cannot write"
    );
    let response = get_as(&api, "/v1/tasks/%231/events", key).await;
    let mut events = response.into_body().into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/task-two/commands",
            &PLANNER_KEY,
            &json!("cancel")
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/nucleus-fixture%231/commands",
            writer,
            &json!("cancel")
        )
        .await,
        StatusCode::OK
    );
    assert_event(&mut events, &[r#""taskId":"task-one""#]).await;
    let rotated = json_body(post_as(&api, path, &PLANNER_KEY, &json!({})).await).await;
    assert_eq!(rotated["sessionId"], mint["sessionId"]);
    assert_eq!(
        get_as(&api, "/v1/tasks/task-one", key).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), events.next())
            .await
            .expect("stream closes")
            .is_none()
    );
}

#[tokio::test]
async fn admission_commits_when_t3_is_unreachable() {
    let (_home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let response = post_as(
        &api,
        "/v1/tasks",
        &PLANNER_KEY,
        &json!({
            "id":"fixture-admit", "reference":"fixture-admit", "brief":"---\nqueue:\n  complexity: low\n---\nImplement the brief"
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(json_body(response).await["phase"], "queued");
    let pass = service.pass().await.expect("scheduled profile check");
    assert!(matches!(
        pass.as_slice(),
        [crate::PassOutcome {
            result: Err(ServiceError::Host(nucleus_hosts::HostError::Unavailable)),
            ..
        }]
    ));
    assert_eq!(
        service
            .task("fixture-admit")
            .await
            .expect("committed row")
            .version,
        1
    );
}

#[tokio::test]
async fn activity_invalidates_only_on_a_change_and_cannot_cross_a_revision() {
    let (_home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (task, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    seed_task(&service, &task).await;
    let row = service.task("worker").await.expect("row");
    let authority = Authority::Operator {
        actor: "fixture".into(),
    };
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: authority.clone(),
        }],
    );
    let mut changes = service.changes();
    let activity = RunActivity {
        label: "Running Rust tests".into(),
        started_at: Some(1000),
    };
    service
        .observe_activity(&row, Some(activity.clone()))
        .await
        .expect("observe");
    let change = changes.try_recv().expect("invalidate");
    assert_eq!(change.version, row.version);
    assert!(change.detail_only);
    service
        .observe_activity(&row, Some(activity.clone()))
        .await
        .expect("repeat");
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    let running = Ok(Action::Wait(nucleus_core::WaitReason::Running));
    for _ in 0..3 {
        service
            .schedule_result(&row, &running, crate::schedule::Priority::Refresh)
            .await
            .unwrap();
    }
    let state_change = changes.try_recv().expect("first wait changes the card");
    assert!(!state_change.detail_only);
    assert!(
        changes.try_recv().is_err(),
        "repeating a pass with the same facts is quiet"
    );
    let path = "/v1/tasks/worker";
    let view = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(
        view["run"]["activity"],
        json!({"label":"Running Rust tests","startedAt":1000})
    );

    service
        .observe_activity(&row, None)
        .await
        .expect("unavailable activity");
    let change = changes.try_recv().expect("invalidate");
    assert_eq!(change.version, row.version);
    assert!(change.detail_only);
    let view = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert!(view["run"]["activity"].is_null());

    service
        .command("worker", &authority, Command::Cancel)
        .await
        .expect("cancel");
    assert!(matches!(
        service.observe_activity(&row, Some(activity)).await,
        Err(ServiceError::Store(nucleus_store::StoreError::StaleTask))
    ));
    let view = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(view["run"]["revoked"], true);
    assert!(view["run"]["activity"].is_null());
}

#[tokio::test]
async fn history_rebuilds_run_and_pr_presentation_without_replay_or_report_noise() {
    let (_home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (task, key, mut observation) =
        reservation("worker", Entry::Brief, &service.fixture().start);
    let instance = task.run().expect("run").launch().instance.clone();
    seed_task(&service, &task).await;
    let mut row = service.task("worker").await.expect("row");
    let sent_at_ms = 1_790_000_000_000;
    let reported_at_ms = sent_at_ms + 831_000;
    let at = |kind, time| EventDraft {
        at: i64::try_from(time).unwrap(),
        ..event(kind)
    };
    for time in [sent_at_ms - 2_000, sent_at_ms] {
        let mut updated = row.task.clone();
        updated.record_send(&instance, time).expect("send marker");
        row = service
            .save(&row, updated, &at("host_send", time))
            .await
            .expect("persist send");
    }
    let pr = PullRequest {
        url: PR.into(),
        head: service.fixture().start.clone(),
    };
    let mut updated = row.task.clone();
    updated
        .record_report(
            &instance,
            key.as_bytes(),
            Report::Work(nucleus_core::WorkReport {
                pull_request: pr.clone(),
                summary: Some(
                    "Fixed the synthetic change.

"
                    .into(),
                ),
            }),
        )
        .expect("stage report");
    row = service
        .save(&row, updated.clone(), &at("reported", reported_at_ms))
        .await
        .expect("persist report");
    observation.host = Observed::Known(Host::Current {
        instance: instance.clone(),
        state: RunState::Ended,
    });
    observation.forge = Observed::Known(Forge::Open {
        pr,
        checks: CheckState::Ready,
    });
    assert_eq!(
        updated.reconcile(&observation),
        Action::Advance(Phase::Reviewing)
    );
    service
        .save(&row, updated, &event("phase_reconciled"))
        .await
        .expect("apply report");
    service
        .state
        .lock()
        .await
        .set_wait("worker", Some(WaitReason::Capacity));
    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let history = json_body(get_as(&api, "/v1/tasks/worker/history", &BOARD_KEY).await).await;
    let thread = &task.run().unwrap().launch().thread;
    assert_worker_history(&history, &instance, thread, sent_at_ms);
    let detail = json_body(get_as(&api, "/v1/tasks/worker", &BOARD_KEY).await).await;
    let list = json_body(get_as(&api, "/v1/tasks", &BOARD_KEY).await).await;
    let lifecycle = &detail["lifecycle"];
    assert_eq!(list[0]["lifecycle"], *lifecycle);
    assert!(lifecycle.get("transcript").is_none());
    assert_eq!(lifecycle["steps"][1]["elapsedMs"], 831_000);
    assert!(lifecycle["steps"][1]["activeSinceMs"].is_null());
    assert_eq!(lifecycle["steps"][2]["roundLabel"], "Round 1");
    assert_eq!(detail["stateLabel"], "Reviewing · capacity");
    assert_eq!(lifecycle["steps"][2]["note"], detail["stateLabel"]);
    assert_eq!(lifecycle["admittedAtMs"], detail["createdAtMs"]);
    assert!(lifecycle["steps"][2]["activeSinceMs"].is_null());
    assert_eq!(
        lifecycle["worker"]["thread"],
        task.run().unwrap().launch().thread
    );
    assert!(lifecycle["reviewer"].is_null());
}

fn assert_worker_history(history: &Value, instance: &str, thread: &str, sent_at_ms: u64) {
    assert_eq!(
        history[0]["presentation"],
        json!([
            {"kind":"run_ended","instance":instance}, {"kind":"pull_request","url":PR}
        ])
    );
    assert_eq!(
        history[1]["presentation"],
        json!([{"kind":"run_reported","instance":instance,"sentAtMs":sent_at_ms,
            "outcome":{"kind":"work","url":PR,"summary":"Fixed the synthetic change.","revision":false}}])
    );
    assert_eq!(history[2]["presentation"], json!([]));
    assert_eq!(
        history[3]["presentation"],
        json!([
            {"kind":"run_started","instance":instance,"role":"worker","purpose":"Synthetic change","reviewHead":null,
                "thread":thread,
                "startedAtMs":sent_at_ms - 2_000}
        ])
    );
}

#[tokio::test]
async fn reviewer_rounds_follow_applied_verdicts_across_launches() {
    let (_home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let head = service.fixture().start.clone();
    let (task, key, mut observation) = reservation("reviewer", Entry::ReviewEntry, &head);
    let first = task.run().expect("first review").launch().clone();
    seed_task(&service, &task).await;
    let mut row = service.task("reviewer").await.expect("row");
    for at in [1, 2] {
        let mut task = row.task.clone();
        task.record_send(&first.instance, at).expect("send marker");
        row = service
            .save(&row, task, &event("host_send"))
            .await
            .expect("persist send");
    }
    let mut task = row.task.clone();
    task.record_report(
        &first.instance,
        key.as_bytes(),
        Report::Review {
            head,
            decision: Review::Changes,
            summary: "Add a regression".into(),
            finding_titles: Vec::new(),
        },
    )
    .expect("stage verdict");
    row = service
        .save(&row, task.clone(), &event("reported"))
        .await
        .expect("persist report");
    observation.host = Observed::Known(Host::Current {
        instance: first.instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    row = service
        .save(&row, task, &event("phase_reconciled"))
        .await
        .expect("apply verdict");

    let authority = Authority::Operator {
        actor: "fixture".into(),
    };
    let mut task = row.task.clone();
    task.command(Command::Move(Phase::Reviewing), &authority, &observation)
        .expect("reopen review");
    row = service
        .save(&row, task.clone(), &event("command"))
        .await
        .expect("persist move");
    observation.host = Observed::Known(Host::Retained {
        thread: first.thread.clone(),
        state: RetainedThread::Idle,
    });
    task.reserve_launch(
        &observation,
        LaunchInputs {
            scratch: None,
            thread: first.thread.clone(),
            input: "fixture-only wire".into(),
            started_at: 3,
        },
        &[4; 32],
    )
    .expect("reserve second review");
    row = service
        .save(&row, task.clone(), &event("run_reserved"))
        .await
        .expect("persist reservation");
    let instance = task.run().expect("second review").launch().instance.clone();
    task.record_send(&instance, 4).expect("second send");
    service
        .save(&row, task, &event("host_send"))
        .await
        .expect("persist send");

    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority,
        }],
    );
    let detail = json_body(get_as(&api, "/v1/tasks/reviewer", &BOARD_KEY).await).await;
    assert_eq!(detail["run"]["purpose"], "Checking round 2");
    assert_eq!(detail["lifecycle"]["reviewRound"], 2);
    assert_eq!(detail["lifecycle"]["reviewer"]["thread"], first.thread);
    assert_eq!(detail["lifecycle"]["steps"][2]["roundLabel"], "Round 2");
    assert_eq!(detail["lifecycle"]["steps"][2]["activeSinceMs"], 4);
    let history = json_body(get_as(&api, "/v1/tasks/reviewer/history", &BOARD_KEY).await).await;
    assert_eq!(history[0]["presentation"][0]["purpose"], "Checking round 2");
    assert_eq!(
        history[5]["presentation"],
        json!([]),
        "replaying adds no run"
    );
    assert_eq!(history[6]["presentation"][0]["purpose"], "Checking round 1");
}

#[tokio::test]
async fn http_reports_bind_the_task_instance_credential_and_role() {
    let (_home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (worker, worker_key, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    let (reviewer, reviewer_key, _) =
        reservation("reviewer", Entry::ReviewEntry, &service.fixture().start);
    for task in [&worker, &reviewer] {
        seed_task(&service, task).await;
    }
    service
        .state
        .lock()
        .await
        .set_wait("worker", Some(nucleus_core::WaitReason::HostUnknown));
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let worker_id = &worker.run().expect("worker run").launch().instance;
    let reviewer_id = &reviewer.run().expect("reviewer run").launch().instance;
    let work = json!({"work":{"url": PR, "head":service.fixture().start}});
    let review = json!({"review":{"head": service.fixture().start, "decision": "approve", "summary": "Tested"}});
    let worker_path = format!("/v1/runs/worker/{worker_id}/report");
    let reviewer_path = format!("/v1/runs/reviewer/{reviewer_id}/report");
    let stream = get_as(&api, "/v1/events", &BOARD_KEY).await;
    let mut events = stream.into_body().into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;

    reject_foreign_addresses(&api, &worker_path, worker_key.as_bytes(), &work).await;

    assert_eq!(
        post_json(&api, &worker_path, &BOARD_KEY, &work).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post_json(
            &api,
            &format!("/v1/runs/reviewer/{worker_id}/report"),
            worker_key.as_bytes(),
            &work
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post_json(&api, &worker_path, worker_key.as_bytes(), &review).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_json(&api, &reviewer_path, reviewer_key.as_bytes(), &work).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_json(&api, &worker_path, worker_key.as_bytes(), &work).await,
        StatusCode::NO_CONTENT
    );
    assert_event(
        &mut events,
        &["event: invalidate", r#"{"taskId":"worker","version":2}"#],
    )
    .await;
    let observed = service.task("worker").await.expect("accepted work report");
    assert_eq!(observed.task.attempts(), worker.attempts());
    let run = observed.task.run().expect("same run");
    assert_eq!(&run.launch().instance, worker_id);
    assert!(run.report().is_some());
    assert_eq!(
        post_json(&api, &worker_path, worker_key.as_bytes(), &work).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post_json(&api, &reviewer_path, reviewer_key.as_bytes(), &review).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/worker/commands",
            &BOARD_KEY,
            &json!("cancel")
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(&api, &worker_path, worker_key.as_bytes(), &work).await,
        StatusCode::UNAUTHORIZED
    );
    let value = json_body(get_as(&api, "/v1/tasks/reviewer", &BOARD_KEY).await).await;
    assert_eq!(value["run"]["reported"], true);
    assert!(value["run"].get("credential").is_none());
    assert!(value["run"].get("input").is_none());
}

async fn reject_foreign_addresses(api: &Router, worker_path: &str, key: &[u8; 32], work: &Value) {
    for (method, path, key, payload) in [
        ("GET", "/v1/tasks", &BOARD_KEY, None),
        ("GET", "/v1/events", &BOARD_KEY, None),
        (
            "POST",
            "/v1/tasks/worker/commands",
            &BOARD_KEY,
            Some(json!("cancel")),
        ),
        ("POST", worker_path, key, Some(work.clone())),
    ] {
        for (host, origin) in [
            (
                "engine.example.invalid:9",
                "http://engine.example.invalid:9",
            ),
            (LOCAL_HOST, "http://engine.example.invalid"),
            (LOCAL_HOST, "http://localhost:9"),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .header("host", host)
                .header("origin", origin)
                .header("authorization", format!("Bearer {}", hex::encode(key)))
                .header("content-type", "application/json")
                .body(
                    payload
                        .as_ref()
                        .map_or_else(Body::empty, |json| Body::from(json.to_string())),
                )
                .expect("address probe");
            let response = api.clone().oneshot(request).await.expect("response");
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {path}");
        }
    }
    let local_alias = Request::get("/v1/settings")
        .header("host", "localhost:9")
        .header("origin", "http://localhost:9")
        .header(
            "authorization",
            format!("Bearer {}", hex::encode(BOARD_KEY)),
        )
        .body(Body::empty())
        .expect("same origin");
    assert_eq!(
        api.clone()
            .oneshot(local_alias)
            .await
            .expect("response")
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn next_shows_the_settled_reviewers_provider_reset() {
    let (_home, service) = fixture(GitHub::new("unused-fixture").unwrap());
    let (mut task, _, mut observation) =
        reservation("reviewer", Entry::ReviewEntry, &service.fixture().start);
    let cause =
        "Provider usage limit for subscription group shared. Reset at 2099-01-01 00:00 UTC.";
    observation.host = Observed::Known(Host::ProviderLimited {
        instance: task.run().unwrap().launch().instance.clone(),
        cause: cause.into(),
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Relaunch(nucleus_core::Role::Reviewer)
    );
    seed_task(&service, &task).await;
    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
    );
    let next = json_body(get_as(&api, "/v1/tasks/reviewer/next", &BOARD_KEY).await).await;
    assert_eq!(next["lastProviderLimit"], cause);
}

#[tokio::test]
async fn next_and_owner_commands_agree_on_code_recovery() {
    let (_home, service) = fixture(GitHub::new("unused-fixture").unwrap());
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
    );
    let head = &service.fixture().start;
    for (id, answer) in [("owner-move", false), ("legacy-answer", true)] {
        let (mut task, mut observation) = code_task_at_merge(id, head);
        observation.forge = Observed::Known(Forge::Open {
            pr: task.pull_request().unwrap().clone(),
            checks: CheckState::Blocked,
        });
        if answer {
            assert_eq!(
                task.reconcile(&observation),
                Action::Ask(nucleus_core::Question::Repair(
                    nucleus_core::Repair::MergeBlocked
                ))
            );
        }
        seed_task(&service, &task).await;
        let prior = service.task(id).await.unwrap();
        service
            .observe_commands(&prior, &observation.forge)
            .await
            .unwrap();
        let view = json_body(get_as(&api, &format!("/v1/tasks/{id}/next"), &BOARD_KEY).await).await;
        expect_command(&view, "move", Some("working"), "ready");
        let instruction = "Rebase the same PR branch";
        let command = if answer {
            expect_command(&view, "answer", None, "ready");
            assert_eq!(view["answerForm"], "work TEXT");
            let refused = post_as(
                &api,
                &format!("/v1/tasks/{id}/commands"),
                &BOARD_KEY,
                &json!({"answer": "retry"}),
            )
            .await;
            assert_eq!(refused.status(), StatusCode::CONFLICT);
            assert_eq!(
                json_body(refused).await["error"],
                "the answer does not match the current question. Use nucleus answer REF work TEXT"
            );
            json!({"answer":{"work":instruction}})
        } else {
            json!({"move_work":{"instruction":instruction}})
        };
        assert_eq!(
            post_json(
                &api,
                &format!("/v1/tasks/{id}/commands"),
                &BOARD_KEY,
                &command
            )
            .await,
            StatusCode::OK
        );
        let row = service.task(id).await.unwrap();
        assert_eq!(row.task.phase(), Phase::Working);
        assert_eq!(row.task.work_instruction(), Some(instruction));
        assert!(row.task.question().is_none());
        assert!(row.task.verdict().is_none());
    }
}

#[tokio::test]
async fn next_and_commands_share_acceptance_authority_and_forge_requirements() {
    let (_home, mut service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let head = service.fixture().start.clone();
    seed_held_acceptance(&service, &head).await;
    let (forge, readable, _published, reads, server) = serve_merged_forge(&head).await;
    service.forge = forge;
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
            planner_controller(PLANNER_KEY, "planner"),
        ],
    );
    let next_path = "/v1/tasks/reviewer/next";
    let view = json_body(get_as(&api, next_path, &BOARD_KEY).await).await;
    assert_eq!(view["version"], 1);
    expect_command(&view, "answer", None, "pending");
    expect_command(&view, "move", Some("merging"), "pending");
    expect_command(&view, "move", Some("done"), "pending");
    let path = "/v1/tasks/reviewer/commands";
    let answer = json!({"answer":{"accept":{"head":head, "reason":"accepted exact merge"}}});
    let pending = post_as(&api, path, &BOARD_KEY, &answer).await;
    assert_eq!(pending.status(), StatusCode::ACCEPTED);
    assert_eq!(
        json_body(pending).await,
        json!({"status":"pending","version":1})
    );
    assert_eq!(reads.load(Ordering::Relaxed), 0);
    let _ = service
        .pass()
        .await
        .expect("read while forge is unavailable");
    let merge = post_json(&api, path, &BOARD_KEY, &json!({"move":"merging"})).await;
    assert_eq!(merge, StatusCode::ACCEPTED);
    let view = json_body(get_as(&api, next_path, &BOARD_KEY).await).await;
    expect_command(&view, "answer", None, "pending");
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &json!({"move":"done"})).await,
        StatusCode::ACCEPTED
    );
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    readable.store(true, Ordering::Relaxed);
    assert!(service.forge_until.load(Ordering::Relaxed) > now_ms());
    assert!(
        service
            .state
            .lock()
            .await
            .schedule
            .take_ready(
                tokio::time::Instant::now(),
                &std::collections::BTreeSet::new(),
                None
            )
            .is_none()
    );
    // Move past the synthetic outage without making the test wait on the clock.
    service.forge_until.store(0, Ordering::Relaxed);
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &answer).await,
        StatusCode::ACCEPTED
    );
    let _ = service.pass().await.expect("refresh on pending wake");
    let planner = json_body(get_as(&api, next_path, &PLANNER_KEY).await).await;
    expect_command(&planner, "answer", None, "unavailable");
    let view = json_body(get_as(&api, next_path, &BOARD_KEY).await).await;
    assert_eq!(view["version"], 1);
    expect_command(&view, "answer", None, "ready");
    expect_command(&view, "move", Some("done"), "unavailable");
    let planner_answer = post_json(&api, path, &PLANNER_KEY, &answer).await;
    assert_eq!(planner_answer, StatusCode::CONFLICT);
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &answer).await,
        StatusCode::OK
    );
    let view = json_body(get_as(&api, next_path, &BOARD_KEY).await).await;
    assert_eq!(view["version"], 2);
    expect_command(&view, "move", Some("done"), "pending");
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &json!({"move":"done"})).await,
        StatusCode::ACCEPTED
    );
    assert_eq!(reads.load(Ordering::Relaxed), 2);
    let _ = service.pass().await.expect("refresh on the new revision");
    let view = json_body(get_as(&api, next_path, &BOARD_KEY).await).await;
    expect_command(&view, "move", Some("merging"), "ready");
    expect_command(&view, "move", Some("done"), "ready");
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &json!({"move":"done"})).await,
        StatusCode::OK
    );
    server.abort();
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "exercise the actual deadline, detail, and existing repair commands together"
)]
async fn persistent_workspace_error_parks_and_owner_recheck_observes_one_repair() {
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls"),
        get(|| async { Json(Vec::<serde_json::Value>::new()) }),
    ))
    .await;
    let (_home, service) = fixture(forge);
    let head = &service.fixture().start;
    let worktrees = service.worktrees().unwrap();
    let checkout = worktrees
        .checkout(&service.fixture().checkout, REPOSITORY, "unreadable")
        .unwrap();
    checkout.allocate(head).unwrap();
    let path = checkout.path().to_owned();
    let admin = std::path::PathBuf::from(crate::tests::git(
        &path,
        &["rev-parse", "--absolute-git-dir"],
    ));
    let index = admin.join("index");
    let valid_index = std::fs::read(&index).unwrap();
    std::fs::write(&index, b"invalid-index").unwrap();
    std::fs::write(path.join("keep.txt"), b"local work").unwrap();

    let (shape, _, observation) = reservation("unreadable", Entry::Brief, head);
    let mut task = Task::new(shape.identity().clone(), shape.brief().text.clone(), None);
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    seed_task(&service, &task).await;
    let service = Arc::new(service);
    let operator = Authority::Operator {
        actor: "operator".into(),
    };
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: operator.clone(),
        }],
    );
    let card = "/v1/tasks/unreadable";
    let first = service.pass().await.unwrap();
    assert!(matches!(
        &first[0].result,
        Err(ServiceError::Workspace(nucleus_work::WorkError::Git { .. }))
    ));
    let checking = json_body(get_as(&api, card, &BOARD_KEY).await).await;
    assert_eq!(checking["wait"], "workspace_unknown");
    assert!(checking["nextCheckAt"].is_u64());
    {
        let mut state = service.state.lock().await;
        let now = tokio::time::Instant::now();
        let due = state.schedule.due("unreadable").unwrap();
        state
            .schedule
            .wake("unreadable", now, crate::schedule::Priority::Wake);
        assert_eq!(state.schedule.due("unreadable"), Some(due));
    }
    let second = tokio::time::timeout(
        nucleus_hosts::T3_RETRY_DELAY + std::time::Duration::from_secs(8),
        service.pass(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(
        &second[0].result,
        Err(ServiceError::Workspace(nucleus_work::WorkError::Git { .. }))
    ));
    let blocked = json_body(get_as(&api, card, &BOARD_KEY).await).await;
    assert_eq!(blocked["wait"], "workspace_blocked");
    assert_eq!(blocked["attention"], "attention");
    assert!(blocked["nextCheckAt"].is_null());
    assert!(
        blocked["waitDetail"]
            .as_str()
            .unwrap()
            .contains("git status failed")
    );
    {
        let mut state = service.state.lock().await;
        state.schedule.wake(
            "unreadable",
            tokio::time::Instant::now(),
            crate::schedule::Priority::Effect,
        );
        assert!(state.schedule.due("unreadable").is_none());
    }
    assert_eq!(std::fs::read(&index).unwrap(), b"invalid-index");
    assert_eq!(std::fs::read(path.join("keep.txt")).unwrap(), b"local work");
    assert!(
        service
            .task("unreadable")
            .await
            .unwrap()
            .task
            .run()
            .is_none()
    );
    assert!(service.host.host_calls().is_empty());

    let request = json!({"recheck": blocked["version"]});
    let command_path = format!("{card}/commands");
    let recheck = || post_json(&api, &command_path, &BOARD_KEY, &request);
    assert_eq!(recheck().await, StatusCode::OK);
    assert_eq!(recheck().await, StatusCode::OK);
    assert!(service.pass().await.unwrap()[0].result.is_err());
    assert!(
        service
            .state
            .lock()
            .await
            .schedule
            .due("unreadable")
            .is_none()
    );

    std::fs::write(&index, valid_index).unwrap();
    assert_eq!(recheck().await, StatusCode::OK);
    assert!(matches!(
        service.pass().await.unwrap()[0].result,
        Ok(Action::Launch { .. })
    ));
    assert_eq!(std::fs::read(path.join("keep.txt")).unwrap(), b"local work");
    assert!(service.host.host_calls().is_empty());
    service
        .command("unreadable", &operator, Command::Hold("Owner hold".into()))
        .await
        .unwrap();
    assert_eq!(recheck().await, StatusCode::CONFLICT);
    let after = json_body(get_as(&api, card, &BOARD_KEY).await).await;
    assert_eq!(after["hold"]["reason"], "Owner hold");
    server.abort();
}

#[tokio::test]
async fn workspace_timeout_card_names_the_operation_without_raw_git_diagnostics() {
    use longhorn_git_workspace::{GitFailure, GitFailureCode};
    use nucleus_work::{GitOperation, WorkError};
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let (shape, _, _) = reservation("timeout", Entry::Brief, &service.fixture().start);
    let task = Task::new(shape.identity().clone(), shape.brief().text.clone(), None);
    seed_task(&service, &task).await;
    let row = service.task("timeout").await.unwrap();
    let previous = crate::schedule::Priority::Decision;
    let error = Err(ServiceError::Workspace(WorkError::Git {
        operation: GitOperation::Add,
        command: "git worktree add synthetic-private-path".into(),
        directory: "synthetic-private-path".into(),
        repository: "synthetic-repository".into(),
        source: GitFailure::TimedOut {
            code: GitFailureCode::CommandUnavailable,
            after: std::time::Duration::from_mins(10),
        },
    }));
    let elapsed = tokio::time::Instant::now() - nucleus_hosts::T3_RETRY_DELAY;
    service
        .state
        .lock()
        .await
        .schedule
        .recover_workspace("timeout", elapsed);
    service
        .schedule_result(&row, &error, previous)
        .await
        .unwrap();
    let api = router(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
    );
    let card = json_body(get_as(&api, "/v1/tasks/timeout", &BOARD_KEY).await).await;
    assert_eq!(card["wait"], "workspace_blocked");
    assert_eq!(
        card["waitDetail"],
        "git worktree add timed out. Check the checkout. Use Recheck after the repair."
    );
    assert!(card["nextCheckAt"].is_null());
}

#[tokio::test]
async fn queued_external_merge_acceptance_bypasses_saturation() {
    let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let head = service.fixture().start.clone();
    let (forge, readable, published, reads, server) = serve_merged_forge(&head).await;
    readable.store(true, Ordering::Relaxed);
    service.forge = forge;
    let (mut holder, _, _) = reservation("holder", Entry::Brief, &head);
    let instance = holder.run().unwrap().launch().instance.clone();
    holder.record_send(&instance, 2).unwrap();
    seed_task(&service, &holder).await;
    service.state.lock().await.schedule.park("holder");
    let (shape, _, _) = reservation("reviewer", Entry::Brief, &head);
    let task = Task::new(
        shape.identity().clone(),
        "Fixture external merge".into(),
        Some(nucleus_core::PullRequest {
            url: PR.into(),
            head: head.clone(),
        }),
    );
    seed_task(&service, &task).await;
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };
    assert!(matches!(
        service
            .command("reviewer", &operator, Command::Move(Phase::Done))
            .await
            .unwrap(),
        crate::CommandOutcome::Pending { .. }
    ));
    service.pass().await.unwrap();
    let waiting = service.task("reviewer").await.unwrap();
    assert_eq!(waiting.task.phase(), Phase::Queued);
    assert!(matches!(
        waiting.task.question(),
        Some(Question::Accept { head: asked }) if asked == &head
    ));
    let answer = Command::Answer(nucleus_core::Answer::Accept {
        head,
        reason: "Reviewed the exact external merge".into(),
    });
    assert!(matches!(
        service
            .command("reviewer", &operator, answer.clone())
            .await
            .unwrap(),
        crate::CommandOutcome::Pending { .. }
    ));
    published.store(false, Ordering::Relaxed);
    service.pass().await.unwrap();
    assert!(matches!(
        service
            .command("reviewer", &operator, answer.clone())
            .await
            .unwrap(),
        crate::CommandOutcome::Pending { .. }
    ));
    assert!(
        service
            .task("reviewer")
            .await
            .unwrap()
            .task
            .verdict()
            .is_none()
    );
    published.store(true, Ordering::Relaxed);
    service.pass().await.unwrap();
    assert!(matches!(
        service
            .command("reviewer", &operator, answer)
            .await
            .unwrap(),
        crate::CommandOutcome::Applied(_)
    ));
    service.state.lock().await.schedule.park("reviewer");
    assert!(matches!(
        service
            .command("reviewer", &operator, Command::Move(Phase::Done))
            .await
            .unwrap(),
        crate::CommandOutcome::Pending { .. }
    ));
    service.pass().await.unwrap();
    let row = service.task("reviewer").await.unwrap();
    assert_eq!(row.task.phase(), Phase::Closing);
    assert!(row.task.run().is_none());
    assert_eq!(reads.load(Ordering::Relaxed), 4);
    assert_eq!(
        service.state.lock().await.store.occupied_slots("").unwrap(),
        1
    );
    server.abort();
}

#[tokio::test]
async fn a_head_bound_work_answer_and_amend_wait_for_the_exact_head() {
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls/1"),
        get(|| async { StatusCode::SERVICE_UNAVAILABLE }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let (host, _, _, native) = planner_roster_fixture("planner", "spare-planner").await;
    service.host = host;
    let head = service.fixture().start.clone();
    let exact = seed_review_work_question(&service, &head).await;
    service
        .refresh_planner_authority("reviewer")
        .await
        .expect("planner roster");
    let prior = service.task("reviewer").await.expect("seeded question");
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let next = "/v1/tasks/reviewer/next";
    let path = "/v1/tasks/reviewer/commands";
    let answer = json!({"answer":{"work":"Use the fixture greeting"}});
    let replacement = briefs::brief_with_bytes(crate::MAX_BRIEF_BYTES);
    let amend = json!({"amend":replacement});
    let changed_forge = changed_open_head(&head);
    service
        .observe_commands(&prior, &changed_forge)
        .await
        .expect("new head");
    let view = json_body(get_as(&api, next, &PLANNER_KEY).await).await;
    for (name, command) in [("answer", &answer), ("amend", &amend)] {
        expect_command(&view, name, None, "unavailable");
        assert_eq!(
            post_json(&api, path, &PLANNER_KEY, command).await,
            StatusCode::CONFLICT
        );
    }
    service
        .observe_commands(&prior, &exact)
        .await
        .expect("same head");
    let _ = service.pass().await.expect("forge outage through loopback");
    let view = json_body(get_as(&api, next, &PLANNER_KEY).await).await;
    for (name, command) in [("answer", &answer), ("amend", &amend)] {
        expect_command(&view, name, None, "pending");
        let response = post_as(&api, path, &PLANNER_KEY, command).await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(
            json_body(response).await,
            json!({"status":"pending","version":1})
        );
    }
    let pending = service.task("reviewer").await.expect("pending question");
    assert_eq!(pending, prior);

    service
        .observe_commands(&prior, &exact)
        .await
        .expect("forge recovered");
    let view = json_body(get_as(&api, next, &PLANNER_KEY).await).await;
    expect_command(&view, "amend", None, "ready");
    assert_eq!(
        post_json(&api, path, &PLANNER_KEY, &amend).await,
        StatusCode::OK
    );
    let revised = service.task("reviewer").await.expect("brief revised");
    assert_eq!(revised.version, 2);
    expect_command(
        &json_body(get_as(&api, next, &PLANNER_KEY).await).await,
        "answer",
        None,
        "pending",
    );
    service
        .observe_commands(&revised, &exact)
        .await
        .expect("same head on new version");
    let view = json_body(get_as(&api, next, &PLANNER_KEY).await).await;
    expect_command(&view, "answer", None, "ready");
    assert_eq!(
        post_json(&api, path, &PLANNER_KEY, &answer).await,
        StatusCode::OK
    );
    let answered = service.task("reviewer").await.expect("question answered");
    assert_eq!(answered.version, 3);
    assert!(answered.task.brief().text.len() > crate::MAX_BRIEF_BYTES);
    assert!(
        answered
            .task
            .brief()
            .text
            .ends_with("Use the fixture greeting")
    );
    assert!(answered.task.question().is_none());
    native.abort();
    server.abort();
}

fn changed_open_head(head: &nucleus_core::Head) -> Observed<Forge> {
    Observed::Known(Forge::Open {
        pr: PullRequest {
            url: PR.into(),
            head: (if head.as_str().starts_with('a') {
                "b"
            } else {
                "a"
            })
            .repeat(40)
            .parse()
            .expect("new head"),
        },
        checks: nucleus_core::CheckState::Ready,
    })
}

async fn seed_review_work_question(
    service: &Service,
    head: &nucleus_core::Head,
) -> Observed<Forge> {
    let (mut task, key, mut observation) = reservation("reviewer", Entry::ReviewEntry, head);
    let instance = task.run().expect("review run").launch().instance.clone();
    task.record_report(
        &instance,
        key.as_bytes(),
        Report::Question {
            prompt: "Which greeting should this revision use?".into(),
            options: Vec::new(),
        },
    )
    .expect("record review question");
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    assert!(matches!(
        task.reconcile(&observation),
        Action::Ask(Question::Work { .. })
    ));
    let notice =
        T3::prepare_notice("planner".into(), "notice".into(), "Choose a greeting").expect("notice");
    assert!(task.bind_question_delivery(notice));
    seed_task(service, &task).await;
    observation.forge
}

async fn serve_merged_forge(
    head: &nucleus_core::Head,
) -> (
    GitHub,
    Arc<AtomicBool>,
    Arc<AtomicBool>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let mut pull = forge_pull(head);
    pull["merged"] = json!(true);
    pull["state"] = json!("closed");
    pull["merge_commit_sha"] = json!(head);
    let readable = Arc::new(AtomicBool::new(false));
    let forge_ready = Arc::clone(&readable);
    let reads = Arc::new(AtomicUsize::new(0));
    let requests = Arc::clone(&reads);
    let published = Arc::new(AtomicBool::new(true));
    let on_base = Arc::clone(&published);
    let tip = "c".repeat(40);
    let descendant = format!("/repos/{REPOSITORY}/compare/{head}...{tip}");
    let other = "b".repeat(40);
    let compare_path = format!("/repos/{REPOSITORY}/compare/{head}...{other}");
    let (forge, server) = serve_forge(
        Router::new()
            .route(
                &format!("/repos/{REPOSITORY}/pulls/1"),
                get(move || async move {
                    requests.fetch_add(1, Ordering::Relaxed);
                    if forge_ready.load(Ordering::Relaxed) {
                        Json(pull).into_response()
                    } else {
                        StatusCode::SERVICE_UNAVAILABLE.into_response()
                    }
                }),
            )
            .route(
                &format!("/repos/{REPOSITORY}/branches/main"),
                get(move || async move {
                    let sha = if on_base.load(Ordering::Relaxed) {
                        tip
                    } else {
                        other
                    };
                    Json(json!({"name":"main","commit":{"sha":sha}}))
                }),
            )
            .route(
                &descendant,
                get(|| async { Json(json!({"status":"ahead"})) }),
            )
            .route(
                &compare_path,
                get(|| async { Json(json!({"status":"diverged"})) }),
            ),
    )
    .await;
    (forge, readable, published, reads, server)
}

#[tokio::test]
async fn only_the_bound_planner_can_answer_even_when_the_origin_is_known() {
    let (_home, mut service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (host, replaced, reads, native) = planner_roster_fixture("origin", "responsible").await;
    service.host = host;
    let (reserved, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    let mut identity = reserved.identity().clone();
    identity.origin_thread = Some("origin".into());
    let mut task = Task::new(identity, "Synthetic change".into(), None);
    let head = service.fixture().start.clone();
    let forge = Observed::Known(Forge::Merged {
        pr: nucleus_core::PullRequest {
            url: PR.into(),
            head: head.clone(),
        },
        commit: head.clone(),
    });
    let mut observation = Observation {
        host: Observed::Unknown,
        workspace: Observed::Unknown,
        forge: Observed::Unknown,
    };
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    observation.forge = forge.clone();
    assert!(matches!(
        task.reconcile(&observation),
        Action::Ask(Question::Accept { .. })
    ));
    let first = T3::prepare_notice("origin".into(), "notice-1".into(), "Accept merge")
        .expect("origin notice");
    assert!(task.bind_question_delivery(first));
    seed_task(&service, &task).await;
    let prior = service.task("worker").await.expect("original binding");
    let replacement = T3::prepare_notice("responsible".into(), "notice-2".into(), "Accept merge")
        .expect("rebound notice");
    assert!(task.bind_question_delivery(replacement));
    let row = service
        .save(&prior, task, &event("fixture_rebound"))
        .await
        .expect("rebind");
    service
        .observe_commands(&row, &forge)
        .await
        .expect("exact merged observation");
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [
            Controller {
                credential: PLANNER_KEY,
                authority: Authority::Planner {
                    actor: "origin".into(),
                },
            },
            Controller {
                credential: BOUND_KEY,
                authority: Authority::Planner {
                    actor: "responsible".into(),
                },
            },
        ],
    );
    let next_path = "/v1/tasks/worker/next";
    let command_path = "/v1/tasks/worker/commands";
    let answer = json!({"answer":{"accept":{"head":head, "reason":"Accepted the observed merge"}}});
    let cold = json_body(get_as(&api, next_path, &BOUND_KEY).await).await;
    expect_command(&cold, "answer", None, "unavailable");
    assert_eq!(
        post_json(&api, command_path, &BOUND_KEY, &answer).await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(reads.load(Ordering::Relaxed), 0);
    replaced.store(true, Ordering::Relaxed);
    service
        .refresh_planner_authority("worker")
        .await
        .expect("published replacement");
    let origin = json_body(get_as(&api, next_path, &PLANNER_KEY).await).await;
    expect_command(&origin, "answer", None, "unavailable");
    assert_eq!(
        post_json(&api, command_path, &PLANNER_KEY, &answer).await,
        StatusCode::FORBIDDEN
    );
    let responsible = json_body(get_as(&api, next_path, &BOUND_KEY).await).await;
    expect_command(&responsible, "answer", None, "ready");
    assert_eq!(
        post_json(&api, command_path, &BOUND_KEY, &answer).await,
        StatusCode::OK
    );
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    native.abort();
}

#[tokio::test]
async fn an_equal_move_commits_a_revision_and_wakes_the_task() {
    let (_home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (reserved, _, _) = reservation("worker", Entry::Brief, &service.fixture().start);
    let task = Task::new(reserved.identity().clone(), "Synthetic change".into(), None);
    seed_task(&service, &task).await;
    let mut changes = service.changes();
    assert!(service.state.lock().await.schedule.due("worker").is_none());
    let result = service
        .command(
            "worker",
            &Authority::Operator {
                actor: "operator".into(),
            },
            Command::Move(Phase::Queued),
        )
        .await
        .expect("equal move");
    assert!(matches!(result, CommandOutcome::Applied(row) if row.version == 2 && row.task == task));
    let change = changes.try_recv().expect("move invalidation");
    assert_eq!(change.version, 2);
    assert_eq!(change.task_id, "worker");
    let now = tokio::time::Instant::now();
    let mut state = service.state.lock().await;
    for id in ["refresh-a", "refresh-b"] {
        state.schedule.wake(
            id,
            now - std::time::Duration::from_secs(1),
            crate::schedule::Priority::Refresh,
        );
    }
    let next = state
        .schedule
        .take_ready(now, &std::collections::BTreeSet::new(), None)
        .expect("move wake");
    assert_eq!(next.id, "worker");
    assert_eq!(next.priority, crate::schedule::Priority::Wake);
}

fn expect_command(view: &Value, name: &str, phase: Option<&str>, readiness: &str) {
    assert!(
        view["commands"]
            .as_array()
            .expect("commands")
            .iter()
            .any(|option| {
                option["name"] == name
                    && option["phase"].as_str() == phase
                    && option["preflight"] == readiness
            }),
        "expected {name} {phase:?} to be {readiness} in {view}"
    );
}

fn planner_controller(credential: [u8; 32], actor: &str) -> Controller {
    Controller {
        credential,
        authority: Authority::Planner {
            actor: actor.into(),
        },
    }
}

async fn seed_held_acceptance(service: &Service, head: &nucleus_core::Head) {
    let (mut task, _, mut observation) = reservation("reviewer", Entry::ReviewEntry, head);
    observation.host = Observed::Known(Host::Current {
        instance: task.run().expect("review").launch().instance.clone(),
        state: RunState::Ended,
    });
    observation.forge = Observed::Known(Forge::Merged {
        pr: task.pull_request().expect("bound pull request").clone(),
        commit: head.clone(),
    });
    assert!(matches!(
        task.reconcile(&observation),
        Action::Ask(Question::Accept { .. })
    ));
    task.command(
        Command::Hold("Test the command independently of automatic close".into()),
        &Authority::Operator {
            actor: "operator".into(),
        },
        &observation,
    )
    .expect("hold fixture");
    seed_task(service, &task).await;
}

async fn seed_task(service: &Service, task: &Task) {
    service
        .state
        .lock()
        .await
        .store
        .create(task, &event("fixture"))
        .expect("seed task");
}

async fn seed_planner_task(service: &Service, id: &str, planner: &str) {
    let task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: Some(planner.into()),
        },
        "Synthetic planner task".into(),
        None,
    );
    seed_task(service, &task).await;
}

pub(crate) async fn json_body(response: Response) -> Value {
    let body = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("response bytes");
    serde_json::from_slice(&body).expect("response JSON")
}

async fn assert_event(events: &mut BodyDataStream, expected: &[&str]) {
    let chunk = tokio::time::timeout(std::time::Duration::from_secs(2), events.next())
        .await
        .expect("event arrived")
        .expect("stream remains open")
        .expect("event body");
    let message = std::str::from_utf8(&chunk).expect("SSE text");
    for part in expected {
        assert!(message.contains(part), "expected {part} in {message}");
    }
}

async fn get_as(api: &Router, path: &str, key: &[u8; 32]) -> Response {
    api.clone()
        .oneshot(
            Request::get(path)
                .header("host", LOCAL_HOST)
                .header("authorization", format!("Bearer {}", hex::encode(key)))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response")
}

async fn post_json(api: &Router, target: &str, key: &[u8; 32], body: &Value) -> StatusCode {
    post_as(api, target, key, body).await.status()
}

async fn post_as(api: &Router, target: &str, key: &[u8; 32], body: &Value) -> Response {
    api.clone()
        .oneshot(
            Request::post(target)
                .header("host", LOCAL_HOST)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {}", hex::encode(key)))
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response")
}

#[tokio::test]
async fn an_acp_planner_command_is_refused_after_handover() {
    let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    let (host, replaced, reads, native) =
        planner_roster_fixture("old-planner", "new-planner").await;
    service.host = host;
    seed_planner_task(&service, "handover", "old-planner").await;
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [
            planner_controller(PLANNER_KEY, "old-planner"),
            planner_controller(BOUND_KEY, "new-planner"),
        ],
    );
    let path = "/v1/tasks/handover/commands";
    let mint_path = "/v1/tasks/handover/acp";
    let hold = json!({"hold":"Keep the first plan"});
    let cold = post_as(&api, mint_path, &PLANNER_KEY, &json!({})).await;
    assert_eq!(cold.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json_body(cold).await["error"],
        "planner authority is not yet known. Retry shortly."
    );
    assert_eq!(reads.load(Ordering::Relaxed), 0);
    assert!(
        service
            .state
            .lock()
            .await
            .planner_requests
            .contains("handover")
    );
    service
        .refresh_planner_authority("handover")
        .await
        .expect("exact planner identity");
    let binding = mint_binding(&api, "handover", &PLANNER_KEY).await;
    let writer = binding.command_credential.expect("scope writer");

    let fence = service.fence("handover").await;
    let busy = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        post_json(&api, path, &writer, &hold),
    )
    .await
    .expect("an effect cannot block the command");
    assert_eq!(busy, StatusCode::CONFLICT);
    drop(fence);
    assert_eq!(post_json(&api, path, &writer, &hold).await, StatusCode::OK);
    assert_eq!(reads.load(Ordering::Relaxed), 1);

    replaced.store(true, Ordering::Relaxed);
    service.state.lock().await.invalidate_planner_authority();
    let release = json!("release");
    assert_eq!(
        post_json(&api, path, &writer, &release).await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    service
        .refresh_planner_authority("handover")
        .await
        .expect("archived identity");
    assert_eq!(
        post_json(&api, path, &writer, &release).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(reads.load(Ordering::Relaxed), 2);
    let row = service.task("handover").await.expect("task");
    assert_eq!(row.version, 2);
    assert!(row.task.hold().is_some());

    let new_api = router(service, [planner_controller(BOUND_KEY, "new-planner")]);
    assert_eq!(
        get_as(&new_api, "/v1/tasks/handover", &binding.credential)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        post_json(&new_api, path, &writer, &release).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post_json(&new_api, mint_path, &BOUND_KEY, &json!({})).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(reads.load(Ordering::Relaxed), 2);
    native.abort();
}

async fn planner_roster_fixture(
    old: &'static str,
    new: &'static str,
) -> (
    nucleus_hosts::T3,
    Arc<AtomicBool>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let replaced = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicUsize::new(0));
    let changed = Arc::clone(&replaced);
    let calls = Arc::clone(&reads);
    let (host, native) = crate::tests::native_fixture(move |request| {
        assert_eq!(request["tag"], "orchestration.subscribeThread");
        assert_eq!(request["payload"]["acceptCompactTurnItems"], true);
        let id = request["payload"]["threadId"].as_str().expect("exact ID");
        assert!(id == old || id == new);
        calls.fetch_add(1, Ordering::Relaxed);
        json!({"_tag":"Chunk","requestId":request["id"],"values":[
            {"kind":"snapshot","hasMoreHistory":true,"historyCursor":"bounded",
                "turnItemsOmitLocalVisible":true,"projection":{"thread":{
                    "id":id,"projectId":"local-fixture",
                    "archivedAt":(id == old && changed.load(Ordering::Relaxed)).then_some("2026-11-23T18:10:00Z")}}},
            {"kind":"synchronized"}
        ]})
    })
    .await;
    (host, replaced, reads, native)
}

async fn mint_binding(api: &Router, task: &str, key: &[u8; 32]) -> nucleus_core::acp::Binding {
    let mint = post_as(api, &format!("/v1/tasks/{task}/acp"), key, &json!({})).await;
    assert_eq!(mint.status(), StatusCode::OK);
    let mint = json_body(mint).await;
    let file = std::path::Path::new(mint["bindingPath"].as_str().expect("binding path"));
    serde_json::from_slice(&std::fs::read(file).expect("binding file")).expect("binding shape")
}

#[tokio::test]
async fn done_permanently_revokes_the_writer_and_keeps_read_access() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let head = service.fixture().start.clone();
    seed_held_acceptance(&service, &head).await;
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "fixture".into(),
            },
        }],
    );
    let binding = mint_binding(&api, "reviewer", &BOARD_KEY).await;
    let writer = binding.command_credential.expect("writer");
    let commands = "/v1/tasks/reviewer/commands";
    let task = service.task("reviewer").await.expect("reviewer");
    let forge = Observed::Known(Forge::Merged {
        pr: task.task.pull_request().expect("PR").clone(),
        commit: head.clone(),
    });
    service
        .observe_commands(&task, &forge)
        .await
        .expect("merge observation");
    assert_eq!(
        post_json(
            &api,
            commands,
            &BOARD_KEY,
            &json!({"answer":{"accept":{"head":head,"reason":"fixture acceptance"}}})
        )
        .await,
        StatusCode::OK
    );
    let task = service.task("reviewer").await.expect("accepted revision");
    service
        .observe_commands(&task, &forge)
        .await
        .expect("exact merge at accepted revision");
    assert_eq!(
        post_json(&api, commands, &BOARD_KEY, &json!({"move":"done"})).await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(&api, commands, &writer, &json!("release")).await,
        StatusCode::UNAUTHORIZED
    );
    let detail = json_body(get_as(&api, "/v1/tasks/reviewer", &binding.credential).await).await;
    assert_eq!(detail["phase"], "done");
    assert_eq!(
        post_json(&api, commands, &BOARD_KEY, &json!({"move":"queued"})).await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(&api, commands, &writer, &json!("release")).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn unlisted_done_threads_make_no_native_reads_after_restart() {
    let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    let (host, native) = crate::tests::native_fixture(|_| {
        panic!("an archived task must not read T3 again");
    })
    .await;
    service.host = host;
    service.fixture_mut().acp_provider = Some("fixture-acp".into());
    let (mut row, _) = fixture_at_done(&service).await;
    assert_eq!(row.task.phase(), Phase::Done);
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[],"threads":[]
        }}));
    let service = Arc::new(service);
    let api = settings_api(&service);
    service
        .state
        .lock()
        .await
        .set_wait("reviewer", Some(WaitReason::Stopping));
    for path in ["/v1/tasks/reviewer", "/v1/tasks/reviewer/next"] {
        let view = json_body(get_as(&api, path, &BOARD_KEY).await).await;
        assert_eq!(view["phase"], "done");
        assert_eq!(view["wait"], Value::Null);
        assert_eq!(view["nextCheckAt"], Value::Null);
    }
    {
        let mut state = service.state.lock().await;
        assert_eq!(
            state
                .store
                .archive_due_ids(None, 8, true)
                .expect("pending archive"),
            ["reviewer"]
        );
        for kind in ["role_threads_archived", "display_note"] {
            row.version = state
                .store
                .save_row(&row, &row.task, &event(kind))
                .expect("append history");
        }
        seed_cancelled_notice(&service, &mut state, &row.task);
    }
    // A cold held shell resolves the already archived or absent threads.
    let outcomes = service.pass().await.expect("queued pass");
    assert_eq!(outcomes.len(), 2);
    assert!(
        outcomes
            .iter()
            .all(|outcome| matches!(outcome.result, Ok(Action::Nothing)))
    );
    assert!(service.state.lock().await.last_pass_calls.is_empty());
    service
        .refresh_planner_authority("cancelled")
        .await
        .unwrap();
    assert!(service.host.host_calls().is_empty());
    native.abort();
}

#[tokio::test]
async fn done_archive_wait_flows_into_the_shared_board_lifecycle() {
    let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
    service.fixture_mut().acp_provider = Some("fixture-acp".into());
    let (done, _) = fixture_at_done(&service).await;
    let id = &done.task.identity().id;
    let cause = "The reviewer thread is still active in T3.";
    service
        .schedule_result(
            &done,
            &Err(ServiceError::ArchiveEvidence(cause.into())),
            crate::schedule::Priority::Effect,
        )
        .await
        .unwrap();
    let service = Arc::new(service);
    let api = settings_api(&service);
    let view = json_body(get_as(&api, &format!("/v1/tasks/{id}"), &BOARD_KEY).await).await;
    assert_eq!(view["phase"], "done");
    assert_eq!(view["stateLabel"], "Done");
    assert_eq!(view["wait"], "stopping");
    assert_eq!(view["waitDetail"], cause);
    assert_eq!(
        view["lifecycle"]["steps"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["note"],
        cause
    );
    let next = json_body(get_as(&api, &format!("/v1/tasks/{id}/next"), &BOARD_KEY).await).await;
    assert_eq!(next["waitDetail"], cause);
}

fn seed_cancelled_notice(service: &Service, state: &mut EngineState, done: &Task) {
    let mut cancelled = Task::new(
        nucleus_core::Identity {
            id: "cancelled".into(),
            reference: "cancelled".into(),
            origin_thread: Some("terminal-planner".into()),
            ..done.identity().clone()
        },
        "Synthetic cancelled task".into(),
        None,
    );
    state.store.create(&cancelled, &event("fixture")).unwrap();
    let before = service.lookup(state, "cancelled").unwrap();
    let waiting = state
        .store
        .edit_dependencies(
            "cancelled",
            before.version,
            nucleus_store::DependencyEdit::Wait {
                ids: &["reviewer".into()],
                reason: "Fixture prerequisite",
            },
            &event("fixture_wait"),
            &mut |_| false,
        )
        .unwrap();
    state
        .store
        .edit_dependencies(
            "cancelled",
            waiting,
            nucleus_store::DependencyEdit::ReleaseWait,
            &event("fixture_release"),
            &mut |_| false,
        )
        .unwrap();
    let released = service.lookup(state, "cancelled").unwrap();
    cancelled
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
    service
        .commit(
            state,
            &released,
            &cancelled,
            &event("fixture_cancelled"),
            None,
        )
        .unwrap();
    service.request_planner_check(state, &cancelled);
    assert!(!state.planner_requests.contains("cancelled"));
    assert!(
        state
            .store
            .pending_prerequisite_notice("cancelled")
            .unwrap()
            .is_some()
    );
}

async fn fixture_at_done(service: &Service) -> (nucleus_store::TaskRow, Observed<Forge>) {
    let head = service.fixture().start.clone();
    seed_held_acceptance(service, &head).await;
    let actor = Authority::Operator {
        actor: "fixture".into(),
    };
    let first = service.task("reviewer").await.expect("seeded task");
    let forge = Observed::Known(Forge::Merged {
        pr: first.task.pull_request().expect("bound PR").clone(),
        commit: head.clone(),
    });
    for command in [
        Command::Answer(Answer::Accept {
            head,
            reason: "Fixture acceptance".into(),
        }),
        Command::Move(Phase::Done),
    ] {
        let row = service.task("reviewer").await.expect("current row");
        service
            .observe_commands(&row, &forge)
            .await
            .expect("merge observation");
        assert!(matches!(
            service
                .command("reviewer", &actor, command)
                .await
                .expect("applied command"),
            CommandOutcome::Applied(_)
        ));
    }
    (service.task("reviewer").await.expect("done task"), forge)
}

#[tokio::test]
async fn settings_save_is_local_validated_and_wakes_capacity() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = settings_api(&service);
    let now = tokio::time::Instant::now();
    {
        let mut state = service.state.lock().await;
        state.capacity_waiters.insert((1, "awaiting-slot".into()));
        state.set_wait("awaiting-slot", Some(nucleus_core::WaitReason::Capacity));
        state.schedule.wake(
            "awaiting-slot",
            now + std::time::Duration::from_mins(1),
            crate::schedule::Priority::Refresh,
        );
    }
    let path = "/v1/settings/dispatch";
    let original = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(original["value"]["globalSlots"], 32);
    assert_eq!(original["value"]["projectDefaultSlots"], 5);
    let mut update = json!({"revision": original["revision"], "value": original["value"]});
    update["value"]["globalSlots"] = json!(0);
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        json_body(get_as(&api, path, &BOARD_KEY).await).await,
        original
    );
    update["value"]["globalSlots"] = json!(3);
    assert_eq!(
        put_settings(&api, path, &PLANNER_KEY, &update)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );

    let saved = json_body(put_settings(&api, path, &BOARD_KEY, &update).await).await;
    assert_eq!(saved["value"]["globalSlots"], 3);
    assert_ne!(saved["revision"], original["revision"]);
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(json_body(get_as(&api, path, &BOARD_KEY).await).await, saved);
    let state = service.state.lock().await;
    assert_eq!(
        state
            .settings
            .dispatch
            .as_ref()
            .expect("published dispatch")
            .global_slots,
        3
    );
    assert!(
        state.schedule.due("awaiting-slot").expect("capacity wake") <= tokio::time::Instant::now()
    );
}

#[tokio::test]
async fn operators_can_pause_a_known_subscription_until_its_reset() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = settings_api(&service);
    let profiles = "/v1/settings/profiles";
    let initial = json_body(get_as(&api, profiles, &BOARD_KEY).await).await;
    let input = json!({"revision":initial["revision"], "value":{"profiles":[{
        "name":"Fixture", "selection":{"id":"fixture","provider":"codex","model":"fixture"},
        "group":"shared",
    }]}});
    assert_eq!(
        put_settings(&api, profiles, &BOARD_KEY, &input)
            .await
            .status(),
        StatusCode::OK
    );
    let path = "/v1/settings/profiles/pauses/shared";
    let deadline = now_ms() + 60_000;
    let pause = json!({"untilMs":deadline});
    assert_eq!(
        put_settings(&api, path, &PLANNER_KEY, &pause)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let mut changes = service.profile_usage_changes.subscribe();
    let saved = put_settings(&api, path, &BOARD_KEY, &pause).await;
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(
        json_body(saved).await,
        json!({"group":"shared","untilMs":deadline})
    );
    assert!(changes.has_changed().unwrap());
    changes.mark_unchanged();
    let repeated = put_settings(&api, path, &BOARD_KEY, &pause).await;
    assert_eq!(repeated.status(), StatusCode::OK);
    assert!(
        !changes.has_changed().unwrap(),
        "an identical stored pause is quiet"
    );
    let state = service.state.lock().await;
    assert_eq!(
        state.store.provider_pause("shared", deadline - 1).unwrap(),
        Some(deadline)
    );
    assert_eq!(
        state.store.provider_pause("shared", deadline).unwrap(),
        None
    );
}

#[tokio::test]
async fn profile_pause_edits_wake_a_parked_capacity_waiter() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = settings_api(&service);
    let path = "/v1/settings/profiles";
    let initial = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(initial["value"]["pausedGroups"], json!([]));
    let mut input = json!({"revision": initial["revision"], "value": initial["value"]});
    input["value"]["pausedGroups"] = json!([" shared"]);
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &input).await.status(),
        StatusCode::BAD_REQUEST
    );
    input["value"]["pausedGroups"] = json!(["shared"]);
    let paused = json_body(put_settings(&api, path, &BOARD_KEY, &input).await).await;
    assert_eq!(paused["value"]["pausedGroups"], json!(["shared"]));
    {
        let mut state = service.state.lock().await;
        state.set_wait("awaiting-group", Some(WaitReason::Capacity));
        state
            .group_waits
            .insert("awaiting-group".into(), crate::profiles::GroupPause::Manual);
        state.schedule.park("awaiting-group");
        assert!(state.schedule.due("awaiting-group").is_none());
    }
    let input =
        json!({"revision": paused["revision"], "value": {"profiles": [], "pausedGroups": []}});
    let unpaused = json_body(put_settings(&api, path, &BOARD_KEY, &input).await).await;
    assert_eq!(unpaused["value"]["pausedGroups"], json!([]));
    let state = service.state.lock().await;
    assert!(
        state.schedule.due("awaiting-group").expect("settings wake") <= tokio::time::Instant::now()
    );
}

#[tokio::test]
async fn board_profiles_use_dispatch_subscription_groups_and_pause_the_same_group() {
    use crate::profiles::LaunchSelection;

    let (home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    let (host, native) = crate::tests::native_fixture(subscription_catalog_reply).await;
    service.host = host;
    let service = Arc::new(service);
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Profiles").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let api = router_with_board(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
        &assets,
    )
    .unwrap();
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let path = "/api/engine/settings/profiles";
    let initial = read_paired_task(&api, path, &cookie).await;
    let mut input = json!({"revision":initial["revision"],"value":{"profiles":[
        {"name":"Team","selection":{"id":"team","provider":"codex","model":"team-only"}},
        {"name":"Explicit","enabled":false,"group":"shared","providerInstanceId":"codex-team",
         "selection":{"id":"explicit","provider":"codex","model":"base"}},
        {"name":"Pinned","enabled":false,"providerInstanceId":"codex-team",
         "selection":{"id":"pinned","provider":"codex","model":"base"}},
        {"name":"Missing","selection":{"id":"missing","provider":"codex","model":"other"}}
    ]}});
    let saved =
        json_body(browser_request(&api, Method::PUT, path, Some(&cookie), Some(&input)).await)
            .await;
    assert_eq!(
        saved["effectiveGroups"],
        json!({"explicit":"shared","pinned":"codex-team"})
    );
    assert!(service.host.host_calls().is_empty());

    let pass = service.host.fixture_pass();
    pass.profile_catalog().await.expect("seed cached catalog");
    let calls = service.host.host_calls();
    let snapshot = read_paired_task(&api, "/api/engine/settings", &cookie).await;
    let groups = json!({"team":"codex-team","explicit":"shared","pinned":"codex-team"});
    assert_eq!(snapshot["profiles"]["effectiveGroups"], groups);
    let profiles = read_paired_task(&api, path, &cookie).await;
    assert_eq!(profiles["effectiveGroups"], groups);
    assert_eq!(service.host.host_calls(), calls);

    let (task, observation) = subscription_launch_task();
    let select = || service.select_launch(&task, &observation, nucleus_core::Role::Worker, &pass);
    let Ok(LaunchSelection::Profile(launch)) = select().await else {
        panic!("eligible team profile")
    };
    assert_eq!(launch.group, groups["team"]);

    input["revision"] = saved["revision"].clone();
    input["value"]["pausedGroups"] = json!([groups["team"]]);
    let manual =
        json_body(browser_request(&api, Method::PUT, path, Some(&cookie), Some(&input)).await)
            .await;
    assert_eq!(manual["value"]["pausedGroups"], json!(["codex-team"]));
    assert!(matches!(select().await, Ok(LaunchSelection::Paused)));

    input["revision"] = manual["revision"].clone();
    input["value"]["pausedGroups"] = json!([]);
    assert_eq!(
        browser_request(&api, Method::PUT, path, Some(&cookie), Some(&input))
            .await
            .status(),
        StatusCode::OK
    );
    let now = now_ms();
    let deadline = now + 60_000;
    {
        let state = service.state.lock().await;
        service
            .record_subscription_pause(&state, &launch.group, deadline, now)
            .unwrap();
    }
    let usage = read_paired_task(&api, "/api/engine/profiles/usage", &cookie).await;
    assert_eq!(usage["limitedGroups"], json!({"codex-team":deadline}));
    assert!(matches!(select().await, Ok(LaunchSelection::Paused)));
    native.abort();
}

fn subscription_catalog_reply(request: &Value) -> Value {
    assert_eq!(request["tag"], "server.getConfig");
    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{
        "environment":{"orchestrationProtocolVersion":2},
        "providers":[
            {"instanceId":"codex","enabled":true,"status":"ready","models":[{"slug":"base"}]},
            {"instanceId":"codex-team","driver":"codex","enabled":true,"status":"ready",
             "models":[{"slug":"base"},{"slug":"team-only"}]}
        ]
    }}})
}

fn subscription_launch_task() -> (Task, Observation) {
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Known(Forge::Absent),
        workspace: Observed::Known(nucleus_core::Workspace::Absent),
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
        "Fixture brief".into(),
        None,
    );
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Working)
    );
    (task, observation)
}

#[tokio::test]
async fn reassign_commits_once_and_invalidates_planner_at_publication() {
    let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    let (host, _, reads, native) = planner_roster_fixture("planner-one", "planner-two").await;
    service.host = host;
    seed_planner_task(&service, "planned", "planner-one").await;
    let service = Arc::new(service);
    let api = settings_api(&service);
    let dispatch = dispatch_with_project_slots(&api, json!({"alpha": 4, "beta": 2})).await;
    let path = "/v1/settings/projects";
    let starting = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    let update = json!({
        "revision": starting["settings"]["revision"],
        "value": {"projects": {
            "alpha": {"name": "Alpha", "repositories": [{
                "origin": REPOSITORY, "path": service.fixture().checkout, "base": service.fixture().base,
                "requiredChecks": ["CI"]
            }]},
            "beta": {"name": "Beta"},
        }},
    });
    let initial_epoch = service.state.lock().await.planner_authority_epoch;
    let planner_wake = service.planner_wake.notified();
    let saved = json_body(put_settings(&api, path, &BOARD_KEY, &update).await).await;
    tokio::time::timeout(std::time::Duration::from_secs(1), planner_wake)
        .await
        .expect("settings requests a local scheduler refresh");
    assert_eq!(
        saved["resolvedPlanners"],
        json!({"alpha": null, "beta": null})
    );
    assert_eq!(
        saved["settings"]["value"]["projects"]["alpha"]["repositories"][0]["hungToolMinutes"],
        30
    );

    assert_eq!(
        reads.load(Ordering::Relaxed),
        0,
        "the save made no host request"
    );
    service
        .refresh_planner_authority("planned")
        .await
        .expect("scheduler publishes authority");
    let resolved = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(resolved["resolvedPlanners"]["alpha"], "planner-one");
    assert_eq!(
        reads.load(Ordering::Relaxed),
        1,
        "the read used cached authority"
    );

    let reassign = json!({
        "revision": saved["settings"]["revision"], "origin": REPOSITORY, "toProject": "beta",
    });
    let moved = json_body(
        post_as(
            &api,
            "/v1/settings/projects/reassign",
            &BOARD_KEY,
            &reassign,
        )
        .await,
    )
    .await;
    let projects = &moved["settings"]["value"]["projects"];
    assert_eq!(projects["alpha"]["repositories"], json!([]));
    assert_eq!(
        projects["beta"]["repositories"][0]["requiredChecks"],
        json!(["CI"])
    );
    assert_eq!(
        post_as(
            &api,
            "/v1/settings/projects/reassign",
            &BOARD_KEY,
            &reassign
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        json_body(get_as(&api, "/v1/settings/dispatch", &BOARD_KEY).await).await,
        dispatch
    );
    let state = service.state.lock().await;
    assert_eq!(state.planner_authority_epoch, initial_epoch + 2);
    assert!(state.planner_authority.is_empty());
    assert_eq!(state.settings.fixture_slots(service.fixture()), Some(2));
    assert_eq!(
        reads.load(Ordering::Relaxed),
        1,
        "reassignment made no host request"
    );
    native.abort();
}

async fn dispatch_with_project_slots(api: &Router, overrides: Value) -> Value {
    let path = "/v1/settings/dispatch";
    let starting = json_body(get_as(api, path, &BOARD_KEY).await).await;
    let mut update = json!({"revision": starting["revision"], "value": starting["value"]});
    update["value"]["projectSlotOverrides"] = overrides;
    let response = put_settings(api, path, &BOARD_KEY, &update).await;
    assert_eq!(response.status(), StatusCode::OK);
    json_body(response).await
}

#[tokio::test]
async fn storage_saves_preference_without_unpinning_a_legacy_profile() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = settings_api(&service);
    let path = "/v1/settings/storage";
    let original = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(original["backups"]["verified"], json!([]));
    assert!(original["configBackups"]["verified"].is_array());
    service.backup_failed.store(true, Ordering::Release);
    let failed = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(failed["backups"]["issues"], 1);
    assert_eq!(failed["configBackups"], original["configBackups"]);
    assert_eq!(original["active"]["placement"], "internal");
    assert_eq!(original["active"]["bargePaths"], json!({}));
    assert!(original["settings"]["value"].get("workVolume").is_none());
    let mut update = json!({
        "revision": original["settings"]["revision"],
        "value": original["settings"]["value"],
    });
    update["value"]["placement"] = json!("barge");
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::BAD_REQUEST
    );
    update["value"]["placement"] = json!("internal");
    update["value"]["retention"]["keepNewest"] = json!(3);
    let saved = json_body(put_settings(&api, path, &BOARD_KEY, &update).await).await;
    assert_eq!(saved["settings"]["value"]["retention"]["keepNewest"], 3);
    assert!(
        service
            .settings
            .load()
            .expect("read on-disk settings")
            .work_volume
            .is_some()
    );
}

#[tokio::test]
async fn host_settings_reject_embedded_credentials_and_stage_the_endpoint() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = settings_api(&service);
    let path = "/v1/settings/hosts";
    let original = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    let mut update = json!({
        "revision": original["settings"]["revision"],
        "value": {"t3": {"endpoint": "http://user:fixture-password@localhost:8000", "credentialRef": "T3_TEST_BEARER"}}
    });
    let failed = put_settings(&api, path, &BOARD_KEY, &update).await;
    assert_eq!(failed.status(), StatusCode::BAD_REQUEST);
    assert!(
        !json_body(failed)
            .await
            .to_string()
            .contains("fixture-password")
    );
    update["value"]["t3"]["endpoint"] = json!("http://localhost:8000");
    update["value"]["t3"]["bearer"] = json!("fixture-not-a-reference");
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::BAD_REQUEST
    );
    update["value"]["t3"]
        .as_object_mut()
        .expect("T3 config")
        .remove("bearer");
    let after = json_body(put_settings(&api, path, &BOARD_KEY, &update).await).await;
    assert_eq!(
        after["settings"]["value"]["t3"]["endpoint"],
        "http://localhost:8000/"
    );
    assert_eq!(after["active"], original["active"]);
}

fn settings_api(service: &Arc<Service>) -> Router {
    router(
        Arc::clone(service),
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "fixture-operator".into(),
                },
            },
            Controller {
                credential: PLANNER_KEY,
                authority: Authority::Planner {
                    actor: "fixture-planner".into(),
                },
            },
        ],
    )
}

async fn put_settings(api: &Router, path: &str, key: &[u8; 32], input: &Value) -> Response {
    api.clone()
        .oneshot(
            Request::put(path)
                .header(HOST, LOCAL_HOST)
                .header(AUTHORIZATION, format!("Bearer {}", hex::encode(key)))
                .header("content-type", "application/json")
                .body(Body::from(input.to_string()))
                .expect("settings request"),
        )
        .await
        .expect("settings response")
}

#[tokio::test]
async fn done_archival_follows_the_held_shell_after_a_thread_reopens() {
    let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    service.fixture_mut().acp_provider = Some("fixture-acp".into());
    let (mut first, merged) = fixture_at_done(&service).await;
    {
        let mut state = service.state.lock().await;
        first.version = state
            .store
            .save_row(&first, &first.task, &event("role_threads_archived"))
            .expect("first receipt");
    }
    let second = reopen_and_finish_review(&service, &first, &merged).await;
    let child = second
        .task
        .threads()
        .get(nucleus_core::Role::Reviewer)
        .expect("new child");
    let (host, parent, archived, publish, native) = archive_shell_fixture(&service, child).await;
    service.host = host.with_quiet_fixture_processes();
    let (forge, readable, _, reads, server) = serve_merged_forge(&service.fixture().start).await;
    service.forge = forge;
    let draft = {
        let work = service.worktrees().unwrap();
        let project = service.fixture();
        let identity = second.task.identity();
        let checkout = work
            .checkout(&project.checkout, &identity.repository, &identity.id)
            .unwrap();
        checkout.allocate(&project.start).unwrap();
        let draft = checkout.path().join("unfinished-draft");
        std::fs::write(&draft, "keep this draft").unwrap();
        draft
    };
    for _ in 0..2 {
        publish(&service.host, None);
        assert!(matches!(
            service.archive_done(&second).await.expect("archive effect"),
            Action::Wait(WaitReason::Stopping)
        ));
    }
    publish(&service.host, None);
    assert!(
        matches!(service.archive_done(&second).await,Err(ServiceError::ArchiveEvidence(cause)) if cause.contains("retained"))
    );
    assert_eq!(std::fs::read_to_string(&draft).unwrap(), "keep this draft");
    assert_eq!(
        *archived.lock().expect("archive writes"),
        [child, parent.as_str()]
    );
    publish(&service.host, Some(child));
    assert!(matches!(
        service
            .archive_done(&second)
            .await
            .expect("archive reopened child"),
        Action::Wait(WaitReason::Stopping)
    ));
    assert_eq!(
        *archived.lock().expect("archive writes"),
        [child, parent.as_str(), child]
    );
    publish(&service.host, None);
    assert_eq!(reads.load(Ordering::Relaxed), 0);
    std::fs::remove_file(&draft).unwrap();
    let checkout = draft.parent().unwrap();
    assert!(
        matches!(service.archive_done(&second).await, Err(ServiceError::Forge(ForgeError::Status(status))) if status == StatusCode::SERVICE_UNAVAILABLE)
    );
    assert!(checkout.is_dir());
    assert_eq!(reads.load(Ordering::Relaxed), 1);

    readable.store(true, Ordering::Relaxed);
    service.forge_until.store(0, Ordering::Relaxed);
    assert_eq!(
        service.archive_done(&second).await.unwrap(),
        Action::Nothing
    );
    assert!(!checkout.exists());
    server.abort();
    native.abort();
}

async fn reopen_and_finish_review(
    service: &Service,
    done: &nucleus_store::TaskRow,
    merged: &Observed<Forge>,
) -> nucleus_store::TaskRow {
    let head = service.fixture().start.clone();
    let role = nucleus_core::Role::Reviewer;
    let old_thread = done.task.threads().get(role).expect("prior review");
    let mut observation = Observation {
        forge: Observed::Known(Forge::Open {
            pr: done.task.pull_request().expect("PR").clone(),
            checks: CheckState::Ready,
        }),
        host: Observed::Known(Host::Retained {
            thread: old_thread.into(),
            state: RetainedThread::Gone,
        }),
        workspace: Observed::Known(nucleus_core::Workspace::Clean(head.clone())),
    };
    let mut task = done.task.clone();
    let actor = Authority::Operator {
        actor: "fixture".into(),
    };
    task.command(Command::Move(Phase::Reviewing), &actor, &observation)
        .expect("reopen");
    task.command(Command::Release, &actor, &observation)
        .expect("release hold");
    let reopened = service
        .save(done, task.clone(), &event("command"))
        .await
        .expect("reopened task");
    {
        let state = service.state.lock().await;
        for row in [done, &reopened] {
            let label = crate::titles::task_state_label(&row.task, None, None);
            let lifecycle = crate::presentation::task_lifecycle(
                &row.task,
                &state.store,
                &label,
                None,
                None,
                None,
            )
            .expect("project current finish");
            assert_eq!(
                lifecycle.finished_at_ms.is_some(),
                row.task.phase().is_terminal()
            );
        }
    }
    let instance = task.next_launch_instance().expect("new launch");
    let credential = task
        .reserve_launch(
            &observation,
            LaunchInputs {
                scratch: None,
                thread: format!("thread:delegated-task:{instance}"),
                started_at: 2,
                input: "fixture-only wire".into(),
            },
            &[4; 32],
        )
        .expect("reserve new child");
    task.record_send(&instance, 3).expect("send marker");
    task.record_report(
        &instance,
        credential.as_bytes(),
        Report::Review {
            head,
            decision: Review::Approve,
            summary: "Synthetic review of the reopened task".into(),
            finding_titles: Vec::new(),
        },
    )
    .expect("new review report");
    observation.host = Observed::Known(Host::Current {
        instance,
        state: RunState::Ended,
    });
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Merging)
    );
    observation.forge = merged.clone();
    assert_eq!(
        task.reconcile(&observation),
        Action::Advance(Phase::Closing)
    );
    observation.workspace = Observed::Known(nucleus_core::Workspace::Absent);
    assert!(task.finish_close(&observation));
    service
        .save(&reopened, task, &event("closed_checkout_absent"))
        .await
        .expect("second Done")
}

async fn archive_shell_fixture(
    service: &Service,
    new_child: &str,
) -> (
    T3,
    String,
    Arc<std::sync::Mutex<Vec<String>>>,
    impl Fn(&T3, Option<&str>) + use<>,
    tokio::task::JoinHandle<()>,
) {
    let worktrees = service.worktrees().expect("worktree scope");
    let checkout = worktrees
        .checkout(
            &service.fixture().checkout,
            &service.fixture().repository,
            "reviewer",
        )
        .expect("reviewer path");
    let parent_id = nucleus_hosts::parent_thread(checkout.path());
    let parent = parent_id.clone();
    let path = checkout.path().to_owned();
    let branch = checkout.branch().to_owned();
    let project_root = service.fixture().checkout.clone();
    let child = new_child.to_owned();
    let archived = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let writes = Arc::clone(&archived);
    let publish_row = {
        let writes = Arc::clone(&archived);
        let (path, branch, parent) = (path.clone(), branch.clone(), parent.clone());
        let child = child.clone();
        let root = project_root.clone();
        move |host: &T3, reopened: Option<&str>| {
            let writes = writes.lock().unwrap();
            let threads: Vec<_> = [parent.as_str(), child.as_str(), "thread:reviewer"]
                .into_iter()
                .filter(|id| reopened == Some(id) || !writes.iter().any(|archived| archived == id))
                .map(|id| {
                json!({"id":id,"projectId":"local-fixture","worktreePath":path,"branch":branch,
                    "parentThreadId":(id != parent).then_some(&parent),
                    "providerInstanceId":"fixture-acp","modelSelection":{"instanceId":"fixture-acp","model":"nucleus"},
                    "status":"idle","latestRunId":null,"pendingBackgroundTasks":[],
                    "updatedAt":if reopened == Some(id) {"2026-11-23T15:01:00Z"} else {"2026-11-23T15:00:00Z"},"activeRunId":null,"pendingRuntimeRequest":null,
                    "deletedAt":(id=="thread:reviewer").then_some("2026-11-23T16:00:00Z")})
            }).collect();
            host.fixture_project_shell(
                &json!({"snapshotSequence":16 + writes.len(),
                "projects":[{"id":"local-fixture","workspaceRoot":root}],"threads":threads}),
                "fixture-acp",
            );
        }
    };
    let (host, native) = crate::tests::native_fixture(move |request| {
        if request["tag"] == "orchestration.dispatchCommand" {
            let payload = &request["payload"];
            assert_eq!(payload["type"], "thread.archive");
            let target = payload["threadId"].as_str().expect("archive destination");
            let mut archived = writes.lock().expect("archive log");
            archived.push(target.into());
            return json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{"sequence":16 + archived.len()}}});
        }
        panic!("unexpected archive read: {}", request["tag"]);
    }).await;
    host.use_held_shell();
    (host, parent_id, archived, publish_row, native)
}

#[tokio::test]
async fn standalone_board_serves_assets_and_local_apis_without_a_typescript_service() {
    let (home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).expect("assets directory");
    std::fs::write(assets.join("index.html"), "<script src='/app.js'></script>")
        .expect("board HTML");
    std::fs::write(assets.join("app.js"), "document.title = 'Fixture Board';")
        .expect("board script");
    let api = router_with_board(
        Arc::new(service),
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
            planner_controller(PLANNER_KEY, "planner"),
        ],
        &assets,
    )
    .expect("board router");
    assert_board_assets(&api).await;

    let tasks = "/api/engine/tasks";
    let dispatch = "/api/engine/settings/dispatch";
    assert_eq!(
        get_as(&api, tasks, &BOARD_KEY).await.status(),
        StatusCode::UNAUTHORIZED,
        "the browser route requires a paired session"
    );
    let operator = pair_board(&api, &BOARD_KEY).await;
    let planner = pair_board(&api, &PLANNER_KEY).await;
    let view = json_body(
        browser_request(
            &api,
            Method::GET,
            "/api/engine/session",
            Some(&planner),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(view["canEditSettings"], false);

    assert_browser_origin(&api, &operator).await;

    let response = browser_request(
        &api,
        Method::GET,
        "/api/engine/events",
        Some(&operator),
        None,
    )
    .await;
    let mut events = response.into_body().into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;
    let starting =
        json_body(browser_request(&api, Method::GET, dispatch, Some(&operator), None).await).await;
    assert_eq!(starting["value"]["mode"], "running");
    let mut update = json!({"revision": starting["revision"], "value": starting["value"]});
    update["value"]["globalSlots"] = json!(3);
    update["value"]["mode"] = json!("held");
    assert_eq!(
        browser_request(&api, Method::PUT, dispatch, Some(&planner), Some(&update))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let saved = json_body(
        browser_request(&api, Method::PUT, dispatch, Some(&operator), Some(&update)).await,
    )
    .await;
    assert_eq!(saved["value"]["globalSlots"], 3);
    assert_eq!(saved["value"]["mode"], "held");
    assert_event(&mut events, &["event: settings"]).await;
    let admission = json!({"id":"board-task","reference":"D1","brief":"---\nqueue:\n  complexity: low\n---\n# Standalone task"});
    let response =
        browser_request(&api, Method::POST, tasks, Some(&operator), Some(&admission)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_event(&mut events, &["event: invalidate", "board-task"]).await;
    let listed =
        json_body(browser_request(&api, Method::GET, tasks, Some(&operator), None).await).await;
    assert_eq!(listed[0]["phase"], "queued");
    assert_eq!(listed[0]["title"], "Standalone task");
    let hold = json!({"hold":"Wait for the fixture"});
    let response = browser_request(
        &api,
        Method::POST,
        "/api/engine/tasks/board-task/commands",
        Some(&operator),
        Some(&hold),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["phase"], "queued");
    assert_event(&mut events, &["event: invalidate", "board-task"]).await;
    assert_eq!(
        json_body(get_as(&api, "/v1/tasks/board-task", &BOARD_KEY).await).await["wait"],
        "hold"
    );
    assert_browser_lanes(&api, &operator, &mut events).await;
}

#[tokio::test]
async fn board_age_survives_an_amendment_and_restart_only_baselines_the_wait() {
    let forge = || GitHub::new("unused-fixture-forge").unwrap();
    let (home, service) = fixture(forge());
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Fixture Board").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let settings = service.settings.clone();
    let project = service.fixture().clone();
    let service = Arc::new(service);
    let setup = |service| {
        router_with_board(
            service,
            [Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "fixture".into(),
                },
            }],
            &assets,
        )
        .unwrap()
    };
    let api = setup(Arc::clone(&service));
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let list = "/api/engine/tasks";
    let detail = "/api/engine/tasks/age";
    let next = "/api/engine/tasks/age/next";
    let admitted = json!({"id":"age","reference":"age","brief":"---\nqueue:\n  complexity: low\n---\n# Initial title"});
    let response = browser_request(&api, Method::POST, list, Some(&cookie), Some(&admitted)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let queued = read_paired_task(&api, detail, &cookie).await;
    assert_eq!(queued["stateLabel"], "Queued");
    let created = &queued["createdAtMs"];
    assert!(created.is_u64());
    assert_eq!(&queued["stateSinceMs"], created);

    observe_task_wait(&service, WaitReason::Capacity).await;
    let since = 1_700_000_000_000_i64;
    service
        .state
        .lock()
        .await
        .store
        .record_board_entry("age", since)
        .unwrap();
    let capacity = read_paired_task(&api, list, &cookie).await[0].clone();
    assert_eq!(capacity["stateLabel"], "Queued · capacity");
    assert_eq!(capacity["stateSinceMs"], since);

    let amend = json!({"amend": "---\nqueue:\n  complexity: low\n---\n# Renamed title"});
    let response = browser_request(
        &api,
        Method::POST,
        "/api/engine/tasks/age/commands",
        Some(&cookie),
        Some(&amend),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let changed = json_body(response).await;
    assert_eq!(changed["title"], "Renamed title");
    assert_eq!(changed["stateSinceMs"], since);
    assert!(
        service.host.host_calls().is_empty(),
        "board GETs do not read the host"
    );
    drop(api);
    drop(service);

    let reopened = Arc::new(reopen_fixture(&settings, project, forge()));
    let api = setup(Arc::clone(&reopened));
    observe_task_wait(&reopened, WaitReason::Capacity).await;
    let recorded = reopened
        .state
        .lock()
        .await
        .store
        .board_times("age")
        .unwrap()
        .since;
    assert_eq!(
        recorded,
        u64::try_from(since).ok(),
        "restart did not write a clock"
    );

    for (path, array) in [(list, true), (detail, false), (next, false)] {
        let dto = read_paired_task(&api, path, &cookie).await;
        let view = if array { &dto[0] } else { &dto };
        assert_eq!(view["stateLabel"], capacity["stateLabel"], "{path}");
        assert!(
            view["stateSinceMs"].is_null(),
            "{path} has no verified entry"
        );
    }
    observe_task_wait(&reopened, WaitReason::ForgeUnknown).await;
    let changed = read_paired_task(&api, detail, &cookie).await;
    assert_eq!(changed["stateLabel"], "Queued · GitHub");
    assert_eq!(
        changed["lifecycle"]["steps"][0]["note"],
        changed["stateLabel"]
    );
    assert!(changed["stateSinceMs"].as_i64().unwrap() > since);
    assert_eq!(&changed["createdAtMs"], created);
}

#[tokio::test]
async fn operator_hold_keeps_its_state_entry_across_restart() {
    let forge = || GitHub::new("unused-fixture-forge").unwrap();
    let (_home, service) = fixture(forge());
    let settings = service.settings.clone();
    let project = service.fixture().clone();
    seed_planner_task(&service, "held", "fixture-planner").await;
    let operator = Authority::Operator {
        actor: "fixture".into(),
    };
    service
        .command("held", &operator, Command::Hold("Wait for approval".into()))
        .await
        .unwrap();
    let api = settings_api(&Arc::new(service));
    let path = "/v1/tasks/held";
    let before = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    assert_eq!(before["stateLabel"], "Queued · Tom");
    assert!(before["stateSinceMs"].is_u64());
    assert!(before["latestEventAtMs"].is_u64());
    drop(api);

    let reopened = Arc::new(reopen_fixture(&settings, project, forge()));
    let after = json_body(get_as(&settings_api(&reopened), path, &BOARD_KEY).await).await;
    assert_eq!(after["stateLabel"], before["stateLabel"]);
    assert_eq!(after["stateSinceMs"], before["stateSinceMs"]);
    assert_eq!(after["latestEventAtMs"], before["latestEventAtMs"]);
}

async fn observe_task_wait(service: &Service, wait: WaitReason) {
    let row = service.task("age").await.unwrap();
    service
        .schedule_result(
            &row,
            &Ok(Action::Wait(wait)),
            crate::schedule::Priority::Wake,
        )
        .await
        .unwrap();
}

async fn read_paired_task(api: &Router, path: &str, cookie: &str) -> Value {
    let response = browser_request(api, Method::GET, path, Some(cookie), None).await;
    assert_eq!(response.status(), StatusCode::OK, "{path}");
    json_body(response).await
}

fn reopen_fixture(
    settings: &nucleus_store::SettingsFile,
    project: crate::Project,
    forge: GitHub,
) -> Service {
    Service::open(
        settings,
        project,
        T3::new("http://127.0.0.1:9", "fixture").unwrap(),
        forge,
        LOCAL_HOST.parse().unwrap(),
        std::env::current_exe().unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn board_cookie_survives_a_service_restart_and_operator_revocation() {
    use std::os::unix::fs::PermissionsExt;

    let forge = || GitHub::new("unused-fixture-forge").expect("fixture forge");
    let (home, service) = fixture(forge());
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "Fixture Board").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let controllers = || {
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
            planner_controller(PLANNER_KEY, "planner"),
        ]
    };
    let settings = service.settings.clone();
    let project = service.fixture().clone();
    let file = service.storage.database().path().join("web-sessions.json");
    let setup = |service| router_with_board(Arc::new(service), controllers(), &assets).unwrap();
    let api = setup(service);
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let cookie_secret = cookie.split_once('=').unwrap().1;
    let stored = std::fs::read_to_string(&file).unwrap();
    assert!(!stored.contains(cookie_secret));
    assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    drop(api);

    let reopen = || reopen_fixture(&settings, project.clone(), forge());
    let api = setup(reopen());
    let session_path = "/api/engine/session";
    let session = browser_request(&api, Method::GET, session_path, Some(&cookie), None).await;
    assert_eq!(json_body(session).await["canEditSettings"], true);
    let mut events = browser_request(&api, Method::GET, "/api/engine/events", Some(&cookie), None)
        .await
        .into_body()
        .into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;
    assert_eq!(
        post_as(&api, "/v1/board/revoke", &PLANNER_KEY, &json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        json_body(post_as(&api, "/v1/board/revoke", &BOARD_KEY, &json!({})).await).await["revoked"],
        1
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), events.next())
            .await
            .unwrap()
            .is_none()
    );
    drop(events);
    drop(api);
    let api = setup(reopen());
    let revoked = browser_request(&api, Method::GET, session_path, Some(&cookie), None).await;
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
}

async fn assert_browser_lanes(api: &Router, session: &str, events: &mut BodyDataStream) {
    let plan = "/api/engine/planning/local-fixture/plan";
    let lane = "/api/engine/planning/local-fixture/lanes/board";
    let cookie = Some(session);
    let initial = json_body(browser_request(api, Method::GET, plan, cookie, None).await).await;
    assert_eq!(initial["version"], 0);
    let document =
        json!({"title":"Board","aim":"Finish Settings","document":"## Steps","version":0});
    let saved =
        json_body(browser_request(api, Method::PUT, lane, cookie, Some(&document)).await).await;
    assert_eq!(saved["version"], 1);
    assert_event(events, &["event: planning"]).await;
    assert_eq!(
        browser_request(api, Method::PUT, lane, cookie, Some(&document))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let update = json!({"version":0,"lanes":[{"key":"board","horizon":"now","doneWhen":"Tools work","statusNote":"Ready"}]});
    let saved =
        json_body(browser_request(api, Method::PUT, plan, cookie, Some(&update)).await).await;
    assert_eq!(saved["version"], 1);
    assert_event(events, &["event: planning"]).await;
    let updated = json_body(browser_request(api, Method::GET, plan, cookie, None).await).await;
    assert_eq!(updated["lanes"][0]["key"], "board");
    assert_eq!(updated["documents"][0]["document"], "## Steps");
    // The paired board mounts the same planning handlers as the controller API.
    for path in [
        "/api/engine/planning/local-fixture/decisions",
        "/api/engine/planning/local-fixture/items",
    ] {
        let listed = json_body(browser_request(api, Method::GET, path, cookie, None).await).await;
        assert_eq!(listed, json!([]), "{path}");
    }
    let decision = json!({
        "question": "Use the new layout?",
        "options": [{"id": "yes", "label": "Use it"}, {"id": "no", "label": "Keep the current one"}],
    });
    let added = browser_request(
        api,
        Method::POST,
        "/api/engine/planning/local-fixture/decisions",
        cookie,
        Some(&decision),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_event(events, &["event: decisions"]).await;
    assert_browser_item(api, cookie, events).await;
    // The theme is a cache read; a fixture without a host config stream has none yet.
    let theme =
        json_body(browser_request(api, Method::GET, "/api/engine/theme", cookie, None).await).await;
    assert_eq!(theme, json!({"theme": null}));
    let catalog = browser_request(
        api,
        Method::GET,
        "/api/engine/profiles/catalog",
        cookie,
        None,
    )
    .await;
    assert_eq!(
        json_body(catalog).await,
        json!({"providers":null,"readAtMs":null,"status":"pending"})
    );
    let usage = browser_request(api, Method::GET, "/api/engine/profiles/usage", cookie, None).await;
    let window = json!({"counts":{},"groups":{},"sample":0});
    assert_eq!(
        json_body(usage).await,
        json!({"recent":window,"worker":window,"reviewer":window,"totals":{},"groupTotals":{},"limitedGroups":{}})
    );
    let reassign = browser_request(
        api,
        Method::POST,
        "/api/engine/settings/projects/reassign",
        cookie,
        Some(&json!({})),
    )
    .await;
    assert_ne!(reassign.status(), StatusCode::NOT_FOUND);
}

async fn assert_browser_item(api: &Router, cookie: Option<&str>, events: &mut BodyDataStream) {
    let item = json!({"kind":"papercut","title":"Toast lingers","body":"It stays.","lanes":[]});
    let added = browser_request(
        api,
        Method::POST,
        "/api/engine/planning/local-fixture/items",
        cookie,
        Some(&item),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_eq!(json_body(added).await["kind"], "papercut");
    assert_event(events, &["event: planning"]).await;
    let listed = json_body(
        browser_request(
            api,
            Method::GET,
            "/api/engine/planning/local-fixture/items",
            cookie,
            None,
        )
        .await,
    )
    .await;
    let item = &listed[0];
    assert_eq!(item["title"], "Toast lingers");
    assert!(item["createdAtMs"].is_i64());
    assert_eq!(item["updatedAtMs"], item["createdAtMs"]);

    let id = item["id"].as_str().expect("papercut ID");
    let path = format!("/api/engine/planning/local-fixture/items/{id}");
    let wrong_project = format!("/api/engine/planning/other-project/items/{id}");
    let version = item["version"].as_i64().expect("papercut version");
    let edit =
        json!({"version":version,"title":"Toast has lingered","body":"It still stays.","lanes":[]});
    assert_eq!(
        browser_request(api, Method::PUT, &wrong_project, cookie, Some(&edit))
            .await
            .status(),
        StatusCode::NOT_FOUND,
    );
    let response = browser_request(api, Method::PUT, &path, cookie, Some(&edit)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = json_body(response).await;
    assert_eq!(saved["title"], edit["title"]);
    assert_eq!(saved["body"], edit["body"]);
    assert_eq!(saved["createdAtMs"], item["createdAtMs"]);
    assert!(saved["version"].as_i64().unwrap() > version);
    assert_event(events, &["event: planning"]).await;

    let stale = json!({"version":version,"title":"Stale edit","body":"Old text.","lanes":[]});
    assert_eq!(
        browser_request(api, Method::PUT, &path, cookie, Some(&stale))
            .await
            .status(),
        StatusCode::CONFLICT,
    );
    let listed = json_body(
        browser_request(
            api,
            Method::GET,
            "/api/engine/planning/local-fixture/items",
            cookie,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(listed[0], saved);
}

async fn assert_board_assets(api: &Router) {
    for path in ["/", "/settings", "/app.js"] {
        let response = browser_request(api, Method::GET, path, None, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        let bytes = to_bytes(response.into_body(), 1024).await.expect("asset");
        let expected = if path == "/app.js" {
            "Fixture Board"
        } else {
            "/app.js"
        };
        assert!(
            std::str::from_utf8(&bytes)
                .expect("utf8 asset")
                .contains(expected)
        );
    }
}

async fn assert_browser_origin(api: &Router, session: &str) {
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/engine/tasks")
                .header(HOST, LOCAL_HOST)
                .header(ORIGIN, "http://127.0.0.1:10")
                .header("x-nucleus-board", "1")
                .header("cookie", session)
                .body(Body::empty())
                .expect("cross-origin request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/engine/tasks")
                .header(HOST, LOCAL_HOST)
                .header("cookie", session)
                .body(Body::empty())
                .expect("simple request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

async fn pair_board(api: &Router, key: &[u8; 32]) -> String {
    let link = json_body(post_as(api, "/v1/board/link", key, &json!({})).await).await;
    let url = link["url"].as_str().expect("pairing link");
    assert!(!url.ends_with(&hex::encode(key)));
    pair_board_link(api, url).await
}

pub(crate) async fn pair_board_link(api: &Router, url: &str) -> String {
    let token = url
        .strip_prefix("http://127.0.0.1:9/#token=")
        .expect("token in fragment");
    let pair = || {
        Request::builder()
            .method(Method::POST)
            .uri("/api/engine/pair")
            .header(HOST, LOCAL_HOST)
            .header(ORIGIN, "http://127.0.0.1:9")
            .header("x-nucleus-board", "1")
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .expect("pair request")
    };
    let response = api.clone().oneshot(pair()).await.expect("pair response");
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .expect("session cookie");
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    assert!(cookie.contains("Path=/api/engine") && cookie.contains("Max-Age=2592000"));
    let session = cookie.split(';').next().expect("cookie value").to_owned();
    assert_eq!(
        api.clone()
            .oneshot(pair())
            .await
            .expect("link replay response")
            .status(),
        StatusCode::UNAUTHORIZED
    );
    session
}

pub(crate) async fn browser_request(
    api: &Router,
    method: Method,
    path: &str,
    cookie: Option<&str>,
    body: Option<&Value>,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(HOST, LOCAL_HOST)
        .header(ORIGIN, "http://127.0.0.1:9")
        .header("x-nucleus-board", "1");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let request = if let Some(body) = body {
        request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
    } else {
        request.body(Body::empty())
    }
    .expect("browser request");
    api.clone()
        .oneshot(request)
        .await
        .expect("browser response")
}
