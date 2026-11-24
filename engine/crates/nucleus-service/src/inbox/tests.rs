use std::sync::{Arc, Mutex};

use axum::{Json, Router, http::HeaderMap, routing::post};
use nucleus_core::{
    Entry, Forge, Identity, Observation, Observed, OperatorDecline, PullRequest, Task,
};
use nucleus_forge::GitHub;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use super::*;
use crate::tests::{fixture, native_fixture};

async fn seed(service: &Service, id: &str) -> (TaskRow, Observed<Forge>) {
    let head = service.project.start.clone();
    let pr = PullRequest {
        url: format!("https://github.com/{}/pull/1", service.project.repository),
        head: head.clone(),
    };
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: "fixture#1".into(),
            repository: service.project.repository.clone(),
            base: service.project.base.clone(),
            entry: Entry::ReviewEntry,
            origin_thread: Some("planner".into()),
        },
        "Review the fixture".into(),
        Some(pr.clone()),
    );
    let forge = Observed::Known(Forge::Merged { pr, commit: head });
    assert!(matches!(
        task.reconcile(&Observation {
            forge: forge.clone(),
            host: Observed::Unknown,
            workspace: Observed::Unknown,
        }),
        Action::Ask(_)
    ));
    service
        .state
        .lock()
        .await
        .store
        .create(&task, &event("admitted"))
        .unwrap();
    (service.task(id).await.unwrap(), forge)
}

async fn bridge_fixture(
    answer: Value,
) -> (Inbox, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let observed = Arc::clone(&requests);
    let app = Router::new().route(
        "/api/internal/rust-inbox",
        post(
            move |headers: HeaderMap, Json(input): Json<Value>| async move {
                assert_eq!(
                    headers["authorization"],
                    format!("Bearer {}", "a".repeat(64))
                );
                let result = if input["operation"] == "withdraw" {
                    json!({"state":"withdrawn"})
                } else {
                    answer
                };
                observed.lock().unwrap().push(input);
                Json(result)
            },
        ),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        Inbox::new(&endpoint, "test-engine".into(), "a".repeat(64)).unwrap(),
        requests,
        server,
    )
}

#[tokio::test]
async fn acceptance_waits_for_forge_evidence_and_withdraws_its_old_binding() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    let (inbox, requests, bridge) = bridge_fixture(json!({
        "state":"accepted","actor":"operator (t3code:fixture)","reason":"Checked the merge."
    }))
    .await;
    service.inbox = Some(inbox);
    let (row, forge) = seed(&service, "accepted").await;
    service.operator_decision(&row).await.unwrap();
    assert_eq!(service.task("accepted").await.unwrap(), row);
    service.observe_commands(&row, &forge).await.unwrap();
    service.operator_decision(&row).await.unwrap();
    let revised = service.task("accepted").await.unwrap();
    assert!(revised.task.question().is_none());
    assert!(revised.task.verdict().is_some());
    service.clear_stale_inbox(&revised).await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(requests[2]["operation"], "withdraw");
    assert_eq!(requests[2]["id"], requests[0]["id"]);
    bridge.abort();
}

#[tokio::test]
async fn decline_delivers_one_planner_notice_and_parks_without_a_due_time() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    let (inbox, requests, bridge) = bridge_fixture(json!({"state":"declined"})).await;
    service.inbox = Some(inbox);
    let root = service.project.checkout.clone();
    let notices = Arc::new(Mutex::new(Vec::<Value>::new()));
    let delivered = Arc::clone(&notices);
    let (host, native) = native_fixture(move |request| {
        let response = match request["tag"].as_str() {
            Some("orchestration.subscribeShell") => json!({
                "kind":"snapshot","snapshot":{"projects":[{"id":"local-fixture","workspaceRoot":root}]},
            }),
            Some("orchestration.subscribeThread") => {
                let notices = delivered.lock().unwrap();
                let runs: Vec<_> = notices.iter().map(|notice| json!({
                    "id":"run","userMessageId":notice["messageId"],"status":"running","startedAt":"2026-11-23T00:00:00Z",
                })).collect();
                json!({"kind":"snapshot","snapshotSequence":4,"projection":{
                    "thread":{"id":"planner","projectId":"local-fixture"},"messages":[],"runs":runs,
                }})
            }
            Some("orchestration.dispatchCommand") => {
                delivered.lock().unwrap().push(request["payload"].clone());
                return json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":{}}});
            }
            _ => panic!("unexpected T3 request"),
        };
        json!({"_tag":"Chunk","requestId":request["id"],"values":[response,{"kind":"synchronized"}]})
    }).await;
    service.host = host;
    let (row, forge) = seed(&service, "declined").await;
    service.observe_commands(&row, &forge).await.unwrap();
    service.notify_question(&row).await.unwrap();
    let declined = service.task("declined").await.unwrap();
    assert_eq!(
        declined.task.operator_decline(),
        Some(OperatorDecline::NoticePending)
    );
    service.clear_stale_inbox(&declined).await.unwrap();
    service.notify_question(&declined).await.unwrap();
    let sent = service.task("declined").await.unwrap();
    service.notify_question(&sent).await.unwrap();
    let parked = service.task("declined").await.unwrap();
    assert_eq!(
        parked.task.operator_decline(),
        Some(OperatorDecline::Notified)
    );
    assert!(!crate::active(&parked.task));
    service.notify_question(&parked).await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
    let notices = notices.lock().unwrap();
    assert_eq!(notices.len(), 1);
    assert!(
        notices[0]["text"]
            .as_str()
            .unwrap()
            .contains("Move or cancel")
    );
    native.abort();
    bridge.abort();
}
