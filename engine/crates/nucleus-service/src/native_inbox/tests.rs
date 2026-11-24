use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use nucleus_forge::GitHub;
use nucleus_hosts::{InboxLifecycle, InboxStatus};
use nucleus_store::{DispatchSettings, ProjectSettings, Projects, planning::USAGE_APPROVE};
use serde_json::{Value, json};

use super::*;
use crate::tests::{fixture, native_fixture};

const LEGACY: &str = "thread:legacy-fixture";
const PROJECT: &str = "project:nucleus-rust-inbox";
const PROVIDER: &str = "fixture-acp";

#[tokio::test]
async fn an_inbox_ui_attempt_is_claimed_once_and_the_reply_is_consumed() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    let inbox = service.native_inbox.as_ref().unwrap();
    inbox.set_observation(Observation::Pinned(BTreeSet::new()));
    let messages = [nucleus_hosts::InboxOperatorMessage {
        id: "synthetic-typed-message".into(),
        text: "ui".into(),
    }];
    service
        .serve_inbox_commands(inbox, &messages)
        .await
        .unwrap();
    assert!(
        service
            .inbox_snapshot(&inbox.credential)
            .await
            .unwrap()
            .replies_ready
    );
    assert!(service.take_inbox_replies(&[0; 32]).is_err());
    assert_eq!(
        service.take_inbox_replies(&inbox.credential).unwrap(),
        ["The local board is unavailable."]
    );
    service
        .serve_inbox_commands(inbox, &messages)
        .await
        .unwrap();
    assert!(
        service
            .take_inbox_replies(&inbox.credential)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn low_usage_permission_survives_task_edits_and_preserves_independent_holds() {
    use nucleus_core::{Command, profiles::UsageLevel};

    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    let inbox = service.native_inbox.as_ref().unwrap();
    inbox.set_observation(Observation::Pinned(BTreeSet::new()));
    let planner = Authority::Planner {
        actor: "planner".into(),
    };
    let operator = Authority::Operator {
        actor: "fixture operator".into(),
    };
    let brief = "---\nqueue:\n  complexity: high\n---\nFixture task.";
    {
        let mut state = service.state.lock().await;
        let mut dispatch = DispatchSettings::default();
        dispatch.usage = UsageLevel::Low;
        state.settings.dispatch = Some(dispatch);
    }
    for id in ["approved", "declined", "amended"] {
        service
            .admit(id.into(), id.into(), brief.into(), &planner)
            .await
            .unwrap();
    }
    service
        .command(
            "approved",
            &operator,
            Command::Hold("Keep the operator hold".into()),
        )
        .await
        .unwrap();

    let batch = service.pass().await.unwrap();
    for id in ["approved", "declined", "amended"] {
        assert!(batch.iter().any(|outcome| outcome.task == id
            && matches!(
                outcome.result,
                Ok(Action::Wait(WaitReason::UsagePermission))
            )));
    }
    answer_low_usage_permissions(&service, &inbox.credential).await;

    service
        .command(
            "amended",
            &operator,
            Command::Amend(brief.replace("high", "medium")),
        )
        .await
        .unwrap();
    let mut state = service.state.lock().await;
    let approved = service.lookup(&state, "approved").unwrap();
    assert!(approved.task.hold().is_some());
    assert_eq!(
        service
            .usage_permission_wait(&mut state, &approved)
            .unwrap(),
        None
    );
    let declined = service.lookup(&state, "declined").unwrap();
    assert_eq!(
        service
            .usage_permission_wait(&mut state, &declined)
            .unwrap(),
        Some(WaitReason::UsagePermission)
    );
    let amended = service.lookup(&state, "amended").unwrap();
    assert_eq!(
        service.usage_permission_wait(&mut state, &amended).unwrap(),
        None
    );
    assert!(
        state
            .store
            .usage_permission("amended")
            .unwrap()
            .unwrap()
            .withdrawn
    );
    state.settings.dispatch.as_mut().unwrap().usage = UsageLevel::Normal;
    assert_eq!(
        service
            .usage_permission_wait(&mut state, &declined)
            .unwrap(),
        None
    );
    drop(state);
    service
        .admit("earlier".into(), "earlier".into(), brief.into(), &planner)
        .await
        .unwrap();
    let mut state = service.state.lock().await;
    state.settings.dispatch.as_mut().unwrap().usage = UsageLevel::Low;
    assert_eq!(
        service
            .usage_permission_wait(&mut state, &declined)
            .unwrap(),
        None
    );
    assert!(state.store.usage_permission("earlier").unwrap().is_none());
}

async fn answer_low_usage_permissions(service: &Service, credential: &[u8; 32]) {
    let snapshot = service.inbox_snapshot(credential).await.unwrap();
    assert_eq!(snapshot.pending.len(), 3);
    for (id, option) in [("approved", USAGE_APPROVE), ("declined", "decline")] {
        service
            .answer_inbox(
                credential,
                InboxAnswer {
                    field: inbox_field("local-fixture", &format!("usage-permission-{id}")),
                    option_id: option.into(),
                },
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn the_inbox_projects_the_configured_hosts_entire_planning_registry() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    let inbox = service.native_inbox.as_ref().unwrap();
    let revision = service.settings.read::<Projects>().unwrap().revision;
    service
        .settings
        .edit::<Projects>(&revision, |registry| {
            for project in ["first", "second"] {
                registry.projects.insert(
                    project.into(),
                    ProjectSettings {
                        name: project.into(),
                        archived: false,
                        repositories: vec![],
                    },
                );
            }
            Ok(())
        })
        .unwrap();
    service.state.lock().await.settings =
        crate::web::RuntimeSettings::open(&service.settings).unwrap();
    let author = Authority::Planner {
        actor: "fixture-planner".into(),
    };
    for project in ["first", "second"] {
        service
            .add_decision(
                project,
                DecisionInput {
                    question: format!("Continue {project}?"),
                    options: vec![
                        DecisionOption {
                            id: "continue".into(),
                            label: "Continue".into(),
                        },
                        DecisionOption {
                            id: "pause".into(),
                            label: "Pause".into(),
                        },
                    ],
                },
                &author,
            )
            .await
            .unwrap();
    }
    inbox.set_observation(Observation::Pinned(BTreeSet::new()));
    let snapshot = service.inbox_snapshot(&inbox.credential).await.unwrap();
    let offered: Vec<_> = snapshot
        .pending
        .iter()
        .filter(|form| form.offer)
        .map(|form| form.question.as_str())
        .collect();
    assert_eq!(offered, ["Continue first?", "Continue second?"]);
}

#[tokio::test]
async fn rust_inbox_installs_beside_the_legacy_pin_and_forms_use_the_shared_answer() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    service.project.as_mut().unwrap().acp_provider = Some(PROVIDER.into());
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    let inbox = service.native_inbox.as_ref().unwrap();
    let root = inbox.root.clone();
    let stage = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&stage);
    let (host, server) = native_fixture(move |req| native_response(req, &seen, &root)).await;
    service.host = host;
    let inbox = service.native_inbox.as_ref().unwrap();
    let mut updates = inbox.changes();
    let target = InboxTarget {
        root: &inbox.root,
        provider: PROVIDER,
    };
    let planner = Authority::Planner {
        actor: "fixture-planner".into(),
    };
    let decision = service
        .add_decision(
            "local-fixture",
            DecisionInput {
                question: "Continue the fixture?".into(),
                options: vec![
                    DecisionOption {
                        id: "continue".into(),
                        label: "Continue".into(),
                    },
                    DecisionOption {
                        id: "pause".into(),
                        label: "Pause".into(),
                    },
                ],
            },
            &planner,
        )
        .await
        .unwrap();
    assert!(updates.has_changed().unwrap());
    let _ = updates.borrow_and_update();
    let key = inbox.credential;
    assert!(matches!(
        service.inbox_snapshot(&[0; 32]).await,
        Err(ServiceError::AcpUnauthorized)
    ));
    service.reconcile_inbox(inbox, &target).await.unwrap();
    assert_eq!(stage.load(Ordering::Relaxed), 0);
    let snapshot = service.inbox_snapshot(&key).await.unwrap();
    assert!(snapshot.pending.is_empty());
    install(&service, &target, &stage).await;
    service.reconcile_inbox(inbox, &target).await.unwrap();
    assert_eq!(stage.load(Ordering::Relaxed), 7);
    let [form]: [InboxForm; 1] = service
        .inbox_snapshot(&key)
        .await
        .unwrap()
        .pending
        .try_into()
        .ok()
        .unwrap();
    assert!(form.offer);
    let answer = || InboxAnswer {
        field: form.field.clone(),
        option_id: "continue".into(),
    };
    service.answer_inbox(&key, answer()).await.unwrap();
    assert!(matches!(
        service.answer_inbox(&key, answer()).await,
        Err(ServiceError::Store(StoreError::PlanningConflict))
    ));
    assert!(updates.has_changed().unwrap());
    let snapshot = service.inbox_snapshot(&key).await.unwrap();
    assert!(snapshot.pending.is_empty());
    let [record]: [Decision; 1] = service
        .decisions("local-fixture", false)
        .await
        .unwrap()
        .try_into()
        .ok()
        .unwrap();
    assert_eq!(record.id, decision.id);
    let answer = record.answer.unwrap();
    assert_eq!(answer.input.option_id, "continue");
    assert_eq!(answer.author, "operator via T3 Inbox (unattested)");
    retire(&service, &target).await;
    assert_eq!(stage.load(Ordering::Relaxed), 6);
    server.abort();
}

async fn retire(service: &Service, target: &InboxTarget<'_>) {
    for _ in 0..2 {
        let InboxLifecycle::Write(write) = service.host.prepare_inbox_retire(target).await.unwrap()
        else {
            panic!("fixture retirement step was not prepared");
        };
        service.host.write_inbox(write).await.unwrap();
    }
    assert_eq!(
        service.host.inbox_status(target).await.unwrap(),
        InboxStatus::Archived
    );
    service
        .reconcile_inbox(service.native_inbox.as_ref().unwrap(), target)
        .await
        .unwrap();
    assert_eq!(service.inbox_health()["observed"], false);
}

async fn install(service: &Service, target: &InboxTarget<'_>, stage: &AtomicUsize) {
    stage.store(1, Ordering::Relaxed);
    for _ in 0..3 {
        let InboxLifecycle::Write(write) =
            service.host.prepare_inbox_install(target).await.unwrap()
        else {
            panic!("fixture install step was not prepared");
        };
        service.host.write_inbox(write).await.unwrap();
    }
}

fn native_response(req: &Value, seen: &AtomicUsize, root: &str) -> Value {
    let step = seen.load(Ordering::Relaxed);
    let payload = &req["payload"];
    let snapshot = match req["tag"].as_str().unwrap() {
        "orchestration.subscribeThread" if payload["threadId"] == INBOX_THREAD && step < 3 => {
            return json!({"_tag":"Exit","requestId":req["id"],"exit":{"_tag":"Failure","cause":[{
                "_tag":"Fail","error":{"_tag":"OrchestrationV2GetThreadProjectionError",
                "threadId":INBOX_THREAD,"cause":{"_tag":"ProjectionStoreThreadNotFoundError","threadId":INBOX_THREAD}}
            }]}});
        }
        "orchestration.subscribeThread" if payload["threadId"] == INBOX_THREAD => {
            let pinned = matches!(step, 4 | 7).then_some("2026-11-24T00:00:00Z");
            let archived = (step == 6).then_some("2026-11-24T01:00:00Z");
            let runs = if step == 4 {
                json!([])
            } else {
                json!([{"id":"turn","status":"running"}])
            };
            let mut thread = json!({"id":INBOX_THREAD,"projectId":PROJECT,"providerInstanceId":PROVIDER,
                "modelSelection":{"instanceId":PROVIDER,"model":"nucleus"},"archivedAt":archived});
            if let Some(at) = pinned {
                thread["pinnedAt"] = json!(at);
            }
            json!({"kind":"snapshot","snapshotSequence":step,"projection":{
                "thread":thread,
                "runs":runs,
                "runtimeRequests":[],"turnItems":[]
            }})
        }
        "orchestration.subscribeShell" if step >= 1 => {
            let mut projects = vec![
                json!({"id":"legacy-project","title":"Nucleus Inbox","workspaceRoot":"/synthetic/ts-inbox"}),
            ];
            if step > 1 {
                projects.push(json!({"id":PROJECT,"workspaceRoot":root}));
            }
            json!({"kind":"snapshot","snapshot":{"projects":projects,"threads":[{
                "id":LEGACY,"projectId":"legacy-project","providerInstanceId":"nucleus",
                "pinnedAt":"2026-11-24T00:00:00Z"
            }]}})
        }
        "server.getConfig" if step == 2 => {
            return success(
                req,
                &json!({"environment":{"orchestrationProtocolVersion":2},
                "providers":[{"driver":"acpRegistry","instanceId":PROVIDER,"enabled":true,
                    "status":"ready","models":[{"slug":"nucleus"}]}]}),
            );
        }
        "projects.mutate" if step == 1 => {
            assert_eq!(payload["workspaceRoot"], root);
            assert_eq!(payload["projectId"], PROJECT);
            seen.store(2, Ordering::Relaxed);
            return success(req, &json!({}));
        }
        "orchestration.launchThread" if step == 2 => {
            assert_eq!(payload["threadId"], INBOX_THREAD);
            assert_eq!(payload["workspaceStrategy"]["type"], "root");
            seen.store(3, Ordering::Relaxed);
            return success(req, &json!({}));
        }
        "orchestration.dispatchCommand" if step == 3 => {
            assert_eq!(payload["type"], "thread.pin");
            assert_eq!(payload["threadId"], INBOX_THREAD);
            seen.store(4, Ordering::Relaxed);
            return success(req, &json!({}));
        }
        "orchestration.dispatchCommand" if step == 4 => {
            assert_eq!(payload["type"], "message.dispatch");
            assert_eq!(payload["threadId"], INBOX_THREAD);
            seen.store(7, Ordering::Relaxed);
            return success(req, &json!({}));
        }
        "orchestration.dispatchCommand" if step == 7 || step == 5 => {
            let kind = if step == 7 {
                "thread.unpin"
            } else {
                "thread.archive"
            };
            assert_eq!(payload["type"], kind);
            assert_eq!(payload["threadId"], INBOX_THREAD);
            seen.store(if step == 7 { 5 } else { 6 }, Ordering::Relaxed);
            return success(req, &json!({}));
        }
        _ => panic!("unexpected fixture request {req}"),
    };
    json!({"_tag":"Chunk","requestId":req["id"],"values":[snapshot,{"kind":"synchronized"}]})
}

fn success(request: &Value, value: &Value) -> Value {
    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":value}})
}
