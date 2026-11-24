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
use nucleus_forge::GitHub;
use nucleus_hosts::{RunActivity, T3};
use tower::ServiceExt;

use super::*;
use crate::{
    event,
    tests::{REPOSITORY, fixture, forge_pull, reservation, serve_forge},
};

const PR: &str = "https://github.com/inflatable-cookie/nucleus-fixture/pull/1";
const BOARD_KEY: [u8; 32] = [2; 32];
const PLANNER_KEY: [u8; 32] = [5; 32];
const BOUND_KEY: [u8; 32] = [6; 32];
const LOCAL_HOST: &str = "127.0.0.1:9";

#[tokio::test]
async fn acp_credentials_are_scoped_and_rotation_closes_the_old_stream() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    for id in ["task-one", "task-two"] {
        let (task, _, _) = reservation(id, Entry::Brief, &service.project.start);
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
    let path = "/v1/tasks/task-one/acp";
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
    for path in ["/v1/tasks/task-two", "/v1/events", "/v1/settings"] {
        assert_eq!(
            get_as(&api, path, key).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        post_json(&api, path, key, &json!({})).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        get_as(&api, "/v1/tasks/task-one", key).await.status(),
        StatusCode::OK
    );
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
    let response = get_as(&api, "/v1/tasks/task-one/events", key).await;
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
            "/v1/tasks/task-one/commands",
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
            "id":"fixture-admit", "reference":"fixture-admit", "brief":"Implement the brief"
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
    let (task, _, _) = reservation("worker", Entry::Brief, &service.project.start);
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
    assert_eq!(changes.try_recv().expect("invalidate").version, row.version);
    service
        .observe_activity(&row, Some(activity.clone()))
        .await
        .expect("repeat");
    assert!(matches!(
        changes.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
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
    assert_eq!(changes.try_recv().expect("invalidate").version, row.version);
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
    let (task, key, mut observation) = reservation("worker", Entry::Brief, &service.project.start);
    let instance = task.run().expect("run").launch().instance.clone();
    seed_task(&service, &task).await;
    let mut row = service.task("worker").await.expect("row");
    for at in [1, 2] {
        let mut updated = row.task.clone();
        updated.record_send(&instance, at).expect("send marker");
        row = service
            .save(&row, updated, &event("host_send"))
            .await
            .expect("persist send");
    }
    let pr = PullRequest {
        url: PR.into(),
        head: service.project.start.clone(),
    };
    let mut updated = row.task.clone();
    updated
        .record_report(&instance, key.as_bytes(), Report::Work(pr.clone()))
        .expect("stage report");
    row = service
        .save(&row, updated.clone(), &event("reported"))
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
    assert_eq!(
        history[0]["presentation"],
        json!([
            {"kind":"run_ended","instance":instance}, {"kind":"pull_request","url":PR}
        ])
    );
    assert_eq!(history[1]["presentation"], json!([]));
    assert_eq!(history[2]["presentation"], json!([]));
    assert_eq!(
        history[3]["presentation"],
        json!([
            {"kind":"run_started","instance":instance,"role":"worker","purpose":"Synthetic change","reviewHead":null}
        ])
    );
}

#[tokio::test]
async fn reviewer_rounds_follow_applied_verdicts_across_launches() {
    let (_home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let head = service.project.start.clone();
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
            thread: first.thread,
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
    let (worker, worker_key, _) = reservation("worker", Entry::Brief, &service.project.start);
    let (reviewer, reviewer_key, _) =
        reservation("reviewer", Entry::ReviewEntry, &service.project.start);
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
    let work = json!({"work":{"url": PR, "head":service.project.start}});
    let review = json!({"review":{"head": service.project.start, "decision": "approve", "summary": "Tested"}});
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
async fn next_and_commands_share_acceptance_authority_and_forge_requirements() {
    let (_home, mut service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let head = service.project.start.clone();
    seed_held_acceptance(&service, &head).await;
    let (forge, readable, reads, server) = serve_merged_forge(&head).await;
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
                &std::collections::BTreeSet::new()
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
async fn a_head_bound_work_answer_and_amend_wait_for_the_exact_head() {
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls/1"),
        get(|| async { StatusCode::SERVICE_UNAVAILABLE }),
    ))
    .await;
    let (_home, mut service) = fixture(forge);
    let (host, _, _, native) = planner_roster_fixture("planner", "spare-planner").await;
    service.host = host;
    let head = service.project.start.clone();
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
    let amend = json!({"amend":"Use the fixture wording"});
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
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls/1"),
        get(move || async move {
            requests.fetch_add(1, Ordering::Relaxed);
            if forge_ready.load(Ordering::Relaxed) {
                Json(pull).into_response()
            } else {
                StatusCode::SERVICE_UNAVAILABLE.into_response()
            }
        }),
    ))
    .await;
    (forge, readable, reads, server)
}

#[tokio::test]
async fn only_the_bound_planner_can_answer_even_when_the_origin_is_known() {
    let (_home, mut service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (host, replaced, reads, native) = planner_roster_fixture("origin", "responsible").await;
    service.host = host;
    let (reserved, _, _) = reservation("worker", Entry::Brief, &service.project.start);
    let mut identity = reserved.identity().clone();
    identity.origin_thread = Some("origin".into());
    let mut task = Task::new(identity, "Synthetic change".into(), None);
    let head = service.project.start.clone();
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
    let (reserved, _, _) = reservation("worker", Entry::Brief, &service.project.start);
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
        .take_ready(now, &std::collections::BTreeSet::new())
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

async fn json_body(response: Response) -> Value {
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
    let head = service.project.start.clone();
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
async fn later_history_never_reopens_a_confirmed_native_archive() {
    let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    let (host, native) = crate::tests::native_fixture(|_| {
        panic!("an archived task must not read T3 again");
    })
    .await;
    service.host = host;
    service.project.acp_provider = Some("fixture-acp".into());
    let (mut row, _) = fixture_at_done(&service).await;
    assert_eq!(row.task.phase(), Phase::Done);
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
                .archive_due_ids(None, 8)
                .expect("pending archive"),
            ["reviewer"]
        );
        for kind in ["role_threads_archived", "display_note"] {
            row.version = state
                .store
                .save_row(&row, &row.task, &event(kind))
                .expect("append history");
        }
        assert!(
            state
                .store
                .archive_due_ids(None, 8)
                .expect("restart scan")
                .is_empty()
        );
        assert!(
            state
                .store
                .archive_confirmed("reviewer")
                .expect("existing receipt")
        );
    }
    // Consume the already queued Done wake as well as excluding it on restart.
    let outcomes = service.pass().await.expect("queued pass");
    assert_eq!(outcomes.len(), 1);
    assert!(matches!(outcomes[0].result, Ok(Action::Nothing)));
    native.abort();
}

async fn fixture_at_done(service: &Service) -> (nucleus_store::TaskRow, Observed<Forge>) {
    let head = service.project.start.clone();
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
        state.set_wait("awaiting-slot", Some(nucleus_core::WaitReason::Capacity));
        state.schedule.wake(
            "awaiting-slot",
            now + std::time::Duration::from_mins(1),
            crate::schedule::Priority::Refresh,
        );
    }
    let path = "/v1/settings/dispatch";
    let original = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    let mut update = json!({"revision": original["revision"], "value": original["value"]});
    update["value"]["slots"] = json!(0);
    assert_eq!(
        put_settings(&api, path, &BOARD_KEY, &update).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        json_body(get_as(&api, path, &BOARD_KEY).await).await,
        original
    );
    update["value"]["slots"] = json!(3);
    assert_eq!(
        put_settings(&api, path, &PLANNER_KEY, &update)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );

    let saved = json_body(put_settings(&api, path, &BOARD_KEY, &update).await).await;
    assert_eq!(saved["value"]["slots"], 3);
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
            .slots,
        3
    );
    assert!(
        state.schedule.due("awaiting-slot").expect("capacity wake") <= tokio::time::Instant::now()
    );
}

#[tokio::test]
async fn reassign_commits_once_and_invalidates_planner_at_publication() {
    let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    let (host, _, reads, native) = planner_roster_fixture("planner-one", "planner-two").await;
    service.host = host;
    seed_planner_task(&service, "planned", "planner-one").await;
    let service = Arc::new(service);
    let api = settings_api(&service);
    let path = "/v1/settings/projects";
    let starting = json_body(get_as(&api, path, &BOARD_KEY).await).await;
    let update = json!({
        "revision": starting["settings"]["revision"],
        "value": {"projects": {
            "alpha": {"name": "Alpha", "slots": 4, "repositories": [{
                "origin": REPOSITORY, "path": service.project.checkout, "base": service.project.base,
                "requiredChecks": ["CI"]
            }]},
            "beta": {"name": "Beta", "slots": 2},
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
    let state = service.state.lock().await;
    assert_eq!(state.planner_authority_epoch, initial_epoch + 2);
    assert!(state.planner_authority.is_empty());
    assert_eq!(state.settings.fixture_slots(&service.project), Some(2));
    assert_eq!(
        reads.load(Ordering::Relaxed),
        1,
        "reassignment made no host request"
    );
    native.abort();
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
async fn a_reopened_task_archives_its_new_child_after_the_next_done() {
    let (_home, mut service) = fixture(GitHub::new("fixture").expect("client"));
    service.project.acp_provider = Some("fixture-acp".into());
    let (mut first, merged) = fixture_at_done(&service).await;
    {
        let mut state = service.state.lock().await;
        first.version = state
            .store
            .save_row(&first, &first.task, &event("role_threads_archived"))
            .expect("first receipt");
        assert!(
            state
                .store
                .archive_confirmed("reviewer")
                .expect("first Done is archived")
        );
    }
    let second = reopen_and_finish_review(&service, &first, &merged).await;
    {
        let state = service.state.lock().await;
        assert!(
            !state
                .store
                .archive_confirmed("reviewer")
                .expect("awaits new receipt")
        );
        assert_eq!(
            state
                .store
                .archive_due_ids(None, 10)
                .expect("restart archive scan"),
            ["reviewer"]
        );
    }
    let child = second
        .task
        .threads()
        .get(nucleus_core::Role::Reviewer)
        .expect("new child");
    let (host, parent, archived, native) = archive_roster_fixture(&service, child).await;
    service.host = host;
    for _ in 0..2 {
        assert!(matches!(
            service.archive_done(&second).await.expect("archive effect"),
            Action::Wait(WaitReason::Stopping)
        ));
    }
    assert!(matches!(
        service
            .archive_done(&second)
            .await
            .expect("archive readback"),
        Action::Nothing
    ));
    assert_eq!(
        *archived.lock().expect("archive writes"),
        [child, parent.as_str()]
    );
    let state = service.state.lock().await;
    assert!(
        state
            .store
            .archive_confirmed("reviewer")
            .expect("new Done is archived")
    );
    assert!(
        state
            .store
            .archive_due_ids(None, 10)
            .expect("post-close restart")
            .is_empty()
    );
    native.abort();
}

async fn reopen_and_finish_review(
    service: &Service,
    done: &nucleus_store::TaskRow,
    merged: &Observed<Forge>,
) -> nucleus_store::TaskRow {
    let head = service.project.start.clone();
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
    let instance = task.next_launch_instance().expect("new launch");
    let credential = task
        .reserve_launch(
            &observation,
            LaunchInputs {
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

async fn archive_roster_fixture(
    service: &Service,
    new_child: &str,
) -> (
    T3,
    String,
    Arc<std::sync::Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let worktrees = service.worktrees().expect("worktree scope");
    let checkout = worktrees
        .checkout(
            &service.project.checkout,
            &service.project.repository,
            "reviewer",
        )
        .expect("reviewer path");
    let parent_id = nucleus_hosts::parent_thread(checkout.path());
    let parent = parent_id.clone();
    let path = checkout.path().to_owned();
    let branch = checkout.branch().to_owned();
    let project_root = service.project.checkout.clone();
    let child = new_child.to_owned();
    let archived = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let writes = Arc::clone(&archived);
    let (host, native) = crate::tests::native_fixture(move |request| {
        if request["tag"] == "orchestration.dispatchCommand" {
            let payload = &request["payload"];
            assert_eq!(payload["type"], "thread.archive");
            let target = payload["threadId"].as_str().expect("archive destination");
            writes.lock().expect("archive log").push(target.into());
            return json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{}}});
        }
        let mut snapshot = json!({"kind":"snapshot","snapshotSequence":16});
        match request["tag"].as_str() {
            Some("orchestration.subscribeShell") => snapshot["snapshot"] = json!({"projects":[{"id":"local-fixture","workspaceRoot":project_root}]}),
            Some("orchestration.subscribeThread") => {
                let id = request["payload"]["threadId"].as_str().expect("thread ID");
                let is_parent = id == parent;
                let archived = writes.lock().expect("archive log").iter().any(|value| value == id);
                snapshot["projection"] = json!({
                    "thread":{"id":id,"projectId":"local-fixture","worktreePath":path,"branch":branch,
                        "parentThreadId":(!is_parent).then_some(&parent),
                        "providerInstanceId":"fixture-acp","modelSelection":{"instanceId":"fixture-acp","model":"nucleus"},
                        "deletedAt":(id=="thread:reviewer").then_some("2026-11-23T16:00:00Z"),
                        "archivedAt":archived.then_some("2026-11-23T16:10:00Z")},
                    "runs":[],"messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[],
                    "subagents":[{"id":"new-child","childThreadId":child,"origin":"app_owned"}]
                });
            }
            _ => panic!("unexpected archive read"),
        }
        json!({"_tag":"Chunk","requestId":request["id"],"values":[snapshot,{"kind":"synchronized"}]})
    }).await;
    (host, parent_id, archived, native)
}
