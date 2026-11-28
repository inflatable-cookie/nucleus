use crate::tests::registry_fixture;
use std::sync::{Arc, Mutex};

use nucleus_core::{
    Entry, Forge, Identity, Observation, Observed, OperatorDecline, PullRequest, Task,
};
use nucleus_forge::GitHub;
use nucleus_store::InboxBinding;
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
        .create(&task, &event("admitted"))
        .unwrap();
    (service.task(id).await.unwrap(), forge)
}

#[tokio::test]
async fn acceptance_waits_for_evidence_of_the_exact_external_merge() {
    let (_home, service) = registry_fixture(GitHub::new("unused").unwrap());
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

#[tokio::test]
async fn restored_bridge_binding_keeps_the_native_offer_fenced() {
    let (_home, mut service) = registry_fixture(GitHub::new("unused").unwrap());
    let (row, _) = seed(&service, "handoff").await;
    let binding = InboxBinding {
        task_version: row.version,
        decision_id: "rust-inbox:fixture:handoff:1".into(),
        head: row.task.operator_question().unwrap().as_str().into(),
    };
    service
        .state
        .lock()
        .await
        .store
        .bind_inbox("handoff", &binding)
        .unwrap();
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    assert!(matches!(
        service.operator_decision(&row).await,
        Err(ServiceError::InboxUnavailable { .. })
    ));
    let state = service.state.lock().await;
    assert!(state.store.inbox_binding("handoff").unwrap().is_some());
    assert!(
        state
            .store
            .decisions("local-fixture", true)
            .unwrap()
            .is_empty()
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
