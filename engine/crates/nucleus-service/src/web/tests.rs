use std::sync::atomic::{AtomicBool, Ordering};

use axum::{
    body::{Body, BodyDataStream, to_bytes},
    http::Request,
};
use futures_util::StreamExt;
use nucleus_core::{Action, Entry, Forge, Host, RunState};
use nucleus_forge::GitHub;
use tower::ServiceExt;

use super::*;
use crate::{
    event,
    tests::{REPOSITORY, fixture, forge_pull, reservation, serve_forge},
};

const PR: &str = "https://github.com/inflatable-cookie/nucleus-fixture/pull/1";
const BOARD_KEY: [u8; 32] = [2; 32];
const PLANNER_KEY: [u8; 32] = [5; 32];

#[tokio::test]
async fn http_reports_bind_the_task_instance_credential_and_role() {
    let (_home, service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let (worker, worker_key, _) = reservation("worker", Entry::Brief, &service.project.start);
    let (reviewer, reviewer_key, _) =
        reservation("reviewer", Entry::ReviewEntry, &service.project.start);
    for task in [&worker, &reviewer] {
        service
            .state
            .lock()
            .await
            .store
            .create(task, &event("fixture"))
            .expect("seed row");
    }
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

#[tokio::test]
async fn next_and_commands_share_acceptance_authority_and_forge_requirements() {
    let (_home, mut service) = fixture(GitHub::new("unused-forge-fixture").expect("client"));
    let head = service.project.start.clone();
    let (mut task, _, mut observation) = reservation("reviewer", Entry::ReviewEntry, &head);
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
    service
        .state
        .lock()
        .await
        .store
        .create(&task, &event("fixture"))
        .expect("seed");
    let mut pull = forge_pull(&head);
    pull["merged"] = json!(true);
    pull["state"] = json!("closed");
    pull["merge_commit_sha"] = json!(head);
    let readable = Arc::new(AtomicBool::new(false));
    let forge_ready = Arc::clone(&readable);
    let (forge, server) = serve_forge(Router::new().route(
        &format!("/repos/{REPOSITORY}/pulls/1"),
        get(move || async move {
            if forge_ready.load(Ordering::Relaxed) {
                Json(pull).into_response()
            } else {
                StatusCode::SERVICE_UNAVAILABLE.into_response()
            }
        }),
    ))
    .await;
    service.forge = forge;
    let api = router(
        Arc::new(service),
        [
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
            Controller {
                credential: PLANNER_KEY,
                authority: Authority::Planner {
                    actor: "planner".into(),
                },
            },
        ],
    );
    for (key, availability) in [
        (&BOARD_KEY, "check_required"),
        (&PLANNER_KEY, "unavailable"),
    ] {
        let view = json_body(get_as(&api, "/v1/tasks/reviewer/next", key).await).await;
        let commands = view["commands"].as_array().expect("commands");
        assert!(
            commands
                .iter()
                .any(|option| option["name"] == "answer" && option["preflight"] == availability),
            "expected answer to be {availability} in {view}"
        );
        assert!(commands.iter().any(|option| option["name"] == "move"
            && option["phase"] == "done"
            && option["preflight"] == "check_required"));
    }
    let path = "/v1/tasks/reviewer/commands";
    let answer = json!({"answer":{"accept":{"head":head, "reason":"accepted exact merge"}}});
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &answer).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &json!({"move":"done"})).await,
        StatusCode::CONFLICT
    );
    readable.store(true, Ordering::Relaxed);
    assert_eq!(
        post_json(&api, path, &PLANNER_KEY, &answer).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &answer).await,
        StatusCode::OK
    );
    assert_eq!(
        post_json(&api, path, &BOARD_KEY, &json!({"move":"done"})).await,
        StatusCode::OK
    );
    server.abort();
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
                .header("authorization", format!("Bearer {}", hex::encode(key)))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response")
}

async fn post_json(api: &Router, target: &str, key: &[u8; 32], body: &Value) -> StatusCode {
    api.clone()
        .oneshot(
            Request::post(target)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {}", hex::encode(key)))
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response")
        .status()
}
