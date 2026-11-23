use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use futures_util::StreamExt;
use nucleus_core::Entry;
use nucleus_forge::GitHub;
use tower::ServiceExt;

use super::*;
use crate::{
    event,
    tests::{fixture, reservation},
};

const PR: &str = "https://github.com/inflatable-cookie/nucleus-fixture/pull/1";
const BOARD_KEY: [u8; 32] = [2; 32];

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
        BOARD_KEY,
        Authority::Operator {
            actor: "fixture".into(),
        },
    );
    let worker_id = &worker.run().expect("worker run").launch().instance;
    let reviewer_id = &reviewer.run().expect("reviewer run").launch().instance;
    let work = json!({"work":{"url": PR, "head":service.project.start}});
    let review = json!({"review":{"head": service.project.start, "decision": "approve", "summary": "Tested"}});
    let worker_path = format!("/v1/runs/worker/{worker_id}/report");
    let reviewer_path = format!("/v1/runs/reviewer/{reviewer_id}/report");
    let stream = api
        .clone()
        .oneshot(
            Request::get("/v1/events")
                .header(
                    "authorization",
                    format!("Bearer {}", hex::encode(BOARD_KEY)),
                )
                .body(Body::empty())
                .expect("event request"),
        )
        .await
        .expect("event response");
    let mut events = stream.into_body().into_data_stream();
    let first = events
        .next()
        .await
        .expect("stream reset")
        .expect("first event");
    assert!(String::from_utf8_lossy(&first).contains("event: refresh"));

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
    let changed = tokio::time::timeout(std::time::Duration::from_secs(2), events.next())
        .await
        .expect("report wakes subscribers")
        .expect("version event")
        .expect("event body");
    let changed = String::from_utf8_lossy(&changed);
    assert!(changed.contains("event: invalidate"));
    assert!(changed.contains(r#"{"taskId":"worker","version":2}"#));
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
    let response = api
        .oneshot(
            Request::get("/v1/tasks/reviewer")
                .header(
                    "authorization",
                    format!("Bearer {}", hex::encode(BOARD_KEY)),
                )
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let body = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("details");
    let value: Value = serde_json::from_slice(&body).expect("details JSON");
    assert_eq!(value["run"]["reported"], true);
    assert!(value["run"].get("credential").is_none());
    assert!(value["run"].get("input").is_none());
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
