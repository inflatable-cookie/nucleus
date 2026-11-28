use std::sync::{Arc, Mutex};

use nucleus_core::{
    Entry, Forge, Identity, Observation, Observed, OperatorDecline, PullRequest, Task,
};
use nucleus_forge::GitHub;
use serde_json::{Value, json};

use super::*;
use crate::{
    native_inbox::NativeInbox,
    tests::{fixture, native_fixture},
};

async fn seed(service: &Service, id: &str) -> (TaskRow, Observed<Forge>) {
    let head = service.fixture().start.clone();
    let pr = PullRequest {
        url: format!("https://github.com/{}/pull/1", service.fixture().repository),
        head: head.clone(),
    };
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: "fixture#1".into(),
            repository: service.fixture().repository.clone(),
            base: service.fixture().base.clone(),
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
        .create_with_facts(
            &task,
            &event("admitted"),
            nucleus_store::TaskAdmissionFacts::default(),
        )
        .unwrap();
    (service.task(id).await.unwrap(), forge)
}

#[tokio::test]
async fn acceptance_waits_for_evidence_of_the_exact_external_merge() {
    let (_home, service) = fixture(GitHub::new("unused").unwrap());
    let (row, forge) = seed(&service, "accepted").await;
    for observe in [false, true] {
        if observe {
            service.observe_commands(&row, &forge).await.unwrap();
        }
        service
            .apply_operator_answer(&row, "operator".into(), "Checked the merge.".into(), false)
            .await
            .unwrap();
        let current = service.task("accepted").await.unwrap();
        assert_eq!(current.task.verdict().is_some(), observe);
        assert_eq!(current.task.question().is_none(), observe);
    }
}

/// A row as the retired TypeScript decision bridge stored it. Restored
/// profiles can still hold one in the unread schema 14 table.
fn store_legacy_binding(service: &Service, row: &TaskRow) {
    let database = service.storage.database().path().join("engine.sqlite");
    rusqlite::Connection::open(database)
        .unwrap()
        .execute(
            "INSERT INTO inbox_bindings (task_id, task_version, decision_id, head)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                row.task.identity().id,
                row.version,
                format!("rust-inbox:fixture:{}:1", row.task.identity().id),
                row.task.pull_request().unwrap().head.as_str(),
            ],
        )
        .unwrap();
}

#[tokio::test]
async fn a_legacy_binding_row_does_not_fence_the_native_offer() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    let (row, _) = seed(&service, "handoff").await;
    store_legacy_binding(&service, &row);
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    assert_eq!(
        service.operator_decision(&row).await.unwrap(),
        Action::Wait(WaitReason::Question)
    );
    let state = service.state.lock().await;
    assert_eq!(
        state.store.decisions("local-fixture", true).unwrap().len(),
        1
    );
}

#[tokio::test]
async fn decline_delivers_one_planner_notice_and_parks_without_a_due_time() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    let root = service.fixture().checkout.clone();
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
    {
        let mut state = service.state.lock().await;
        state.set_wait("declined", Some(WaitReason::Question));
        assert_eq!(
            state.task_attention(&row).unwrap(),
            crate::attention::TaskAttention::Attention
        );
    }
    service.observe_commands(&row, &forge).await.unwrap();
    service
        .apply_operator_answer(&row, "operator".into(), String::new(), true)
        .await
        .unwrap();
    let declined = service.task("declined").await.unwrap();
    assert_eq!(
        declined.task.operator_decline(),
        Some(OperatorDecline::NoticePending)
    );
    {
        let mut state = service.state.lock().await;
        state.set_wait("declined", Some(WaitReason::Question));
        assert_eq!(
            state.task_attention(&declined).unwrap(),
            crate::attention::TaskAttention::Waiting
        );
    }
    service.notify_question(&declined).await.unwrap();
    let sent = service.task("declined").await.unwrap();
    service.notify_question(&sent).await.unwrap();
    let parked = service.task("declined").await.unwrap();
    assert_eq!(
        parked.task.operator_decline(),
        Some(OperatorDecline::Notified)
    );
    assert!(!crate::active(&parked.task));
    // A leftover bridge row no longer returns a parked task to the scheduler.
    store_legacy_binding(&service, &parked);
    assert!(
        service
            .state
            .lock()
            .await
            .store
            .active_ids(None, 10)
            .unwrap()
            .is_empty()
    );
    service.notify_question(&parked).await.unwrap();
    let notices = notices.lock().unwrap();
    assert_eq!(notices.len(), 1);
    assert!(
        notices[0]["text"]
            .as_str()
            .unwrap()
            .contains("Move or cancel")
    );
    native.abort();
}
