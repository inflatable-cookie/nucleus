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
    observe_inbox_turn(&service, inbox, "turn");
    let messages = [nucleus_hosts::InboxOperatorMessage {
        id: "synthetic-typed-message".into(),
        run_id: "turn".into(),
        text: "ui".into(),
    }];
    let (control, overlapping) = tokio::join!(
        service.serve_inbox_commands(inbox, &messages),
        service.serve_inbox_commands(inbox, &messages),
    );
    control.unwrap();
    overlapping.unwrap();
    assert!(
        service
            .inbox_snapshot(&inbox.credential)
            .await
            .unwrap()
            .replies_ready
    );
    assert!(service.take_inbox_replies(&[0; 32], Some("turn")).is_err());
    assert_eq!(
        service
            .take_inbox_replies(&inbox.credential, Some("turn"))
            .unwrap(),
        ["The local board is unavailable. Please type ui again to retry."]
    );
    service
        .serve_inbox_commands(inbox, &messages)
        .await
        .unwrap();
    assert!(
        service
            .take_inbox_replies(&inbox.credential, Some("turn"))
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn cancelled_inbox_turn_cannot_drain_into_the_next_ui() {
    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    let inbox = service.native_inbox.as_ref().unwrap();
    observe_inbox_turn(&service, inbox, "cancelled");
    let command = |run: &str| nucleus_hosts::InboxOperatorMessage {
        id: format!("message-{run}"),
        run_id: run.into(),
        text: "ui".into(),
    };
    service
        .serve_inbox_commands(inbox, &[command("cancelled")])
        .await
        .unwrap();

    service
        .host
        .fixture_held_shell(&json!({"kind":"thread.updated","sequence":1,
        "thread":{"id":INBOX_THREAD,"activeRunId":"next","pinnedAt":"2026-11-24T00:00:00Z"}}));
    assert!(
        !service
            .inbox_snapshot(&inbox.credential)
            .await
            .unwrap()
            .replies_ready
    );
    assert!(
        service
            .take_inbox_replies(&inbox.credential, Some("cancelled"))
            .unwrap()
            .is_empty()
    );

    observe_inbox_turn(&service, inbox, "next");
    service
        .serve_inbox_commands(inbox, &[command("next")])
        .await
        .unwrap();
    let snapshot = service.inbox_snapshot(&inbox.credential).await.unwrap();
    assert_eq!(snapshot.reply_run.as_deref(), Some("next"));
    assert!(
        service
            .take_inbox_replies(&inbox.credential, Some("cancelled"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        service
            .take_inbox_replies(&inbox.credential, snapshot.reply_run.as_deref())
            .unwrap(),
        ["The local board is unavailable. Please type ui again to retry."]
    );
    assert!(
        service
            .take_inbox_replies(&inbox.credential, None)
            .unwrap()
            .is_empty()
    );
}

fn observe_inbox_turn(service: &Service, inbox: &NativeInbox, run: &str) {
    service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
        "projects":[],"threads":[{"id":INBOX_THREAD,"activeRunId":run,"pinnedAt":"2026-11-24T00:00:00Z"}]
        }}));
    observe_pinned_inbox(inbox, Some(run));
}

fn observe_pinned_inbox(inbox: &NativeInbox, run: Option<&str>) {
    inbox.set_observation(Observation::Pinned {
        forms: BTreeSet::new(),
        active_run: run.map(str::to_owned),
    });
}

#[tokio::test]
async fn preview_opens_once_per_connection_and_each_claimed_ui_has_one_attempt() {
    let (home, mut service) = fixture(GitHub::new("unused").unwrap());
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    let root = service.native_inbox.as_ref().unwrap().root.clone();
    let board_url = format!("http://{}/", service.callback);
    let message = Arc::new(AtomicUsize::new(0));
    let trace = Arc::new(Mutex::new(PreviewTrace::default()));
    let response = {
        let message = Arc::clone(&message);
        let trace = Arc::clone(&trace);
        let board_url = board_url.clone();
        move |request: &Value| {
            preview_response(request, &trace, &board_url).unwrap_or_else(|| {
                let mut reply = native_response(request, &AtomicUsize::new(7), &root);
                let index = message.load(Ordering::Relaxed);
                if request["tag"] == "orchestration.subscribeThread" && index != 0 {
                    reply["values"][0]["projection"]["messages"] = json!([{
                        "threadId":INBOX_THREAD,"id":format!("fixture-ui-{index}"),"runId":"turn",
                        "role":"user","createdBy":"user","creationSource":"web","text":"ui"
                    }]);
                }
                reply
            })
        }
    };
    let (host, server) = native_fixture(response).await;
    service.host = host;
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "<!doctype html>").unwrap();
    std::fs::write(assets.join("app.js"), "").unwrap();
    let service = Arc::new(service);
    let _board = crate::web::router_with_board(Arc::clone(&service), [], &assets).unwrap();
    let inbox = service.native_inbox.as_ref().unwrap();
    let target = InboxTarget {
        root: &inbox.root,
        provider: PROVIDER,
    };
    let reconcile = || service.reconcile_inbox(inbox, &target);
    let take_replies = || {
        service
            .take_inbox_replies(&inbox.credential, Some("turn"))
            .unwrap()
    };

    reconcile().await.unwrap();
    assert!(trace.lock().unwrap().calls.is_empty());
    synchronize_preview_session(&service).await;
    reconcile().await.unwrap();
    reconcile().await.unwrap();
    assert_eq!(trace.lock().unwrap().links.len(), 1);
    for outcome in [Ok(()), Err(HostError::Uncertain)] {
        inbox.host_stream_ended(outcome);
        assert!(*inbox.observed.borrow() == Observation::Unknown);
        synchronize_preview_session(&service).await;
        reconcile().await.unwrap();
        assert_eq!(trace.lock().unwrap().links.len(), 1);
    }
    assert!(take_replies().is_empty());

    message.store(1, Ordering::Relaxed);
    reconcile().await.unwrap();
    reconcile().await.unwrap();
    assert_eq!(trace.lock().unwrap().links.len(), 2);
    assert!(
        take_replies()
            == [format!(
                "Could not open the board (preview.open: missing preview:operate scope). Please type ui again to retry.\nBoard at {board_url}"
            )],
        "the reply must contain the safe failure kind and plain board address"
    );

    inbox.host_stream_ended(Ok(()));
    inbox.host_stream_ended(Err(HostError::Unavailable));
    synchronize_preview_session(&service).await;
    reconcile().await.unwrap();
    reconcile().await.unwrap();
    assert_eq!(trace.lock().unwrap().links.len(), 3);
    assert!(take_replies().is_empty());

    inbox.host_stream_ended(Ok(()));
    inbox.host_synchronized("replacement runtime".into());
    reconcile().await.unwrap();
    assert_eq!(trace.lock().unwrap().links.len(), 4);

    inbox.host_stream_ended(Err(HostError::Unavailable));
    synchronize_preview_session(&service).await;
    message.store(2, Ordering::Relaxed);
    reconcile().await.unwrap();
    reconcile().await.unwrap();
    let trace = trace.lock().unwrap();
    assert_eq!(trace.links.len(), 5);
    assert_eq!(
        trace.calls,
        ["list", "close-success", "close-failed", "open"].repeat(5)
    );
    assert_eq!(take_replies(), [format!("Board at {board_url}")]);
    server.abort();
}

async fn synchronize_preview_session(service: &Service) {
    let (sender, mut receiver) = tokio::sync::mpsc::channel(4);
    let watch = service
        .host
        .watch_threads(&sender, None, Some(INBOX_THREAD));
    let hint = tokio::select! {
        result = watch => panic!("unexpected watch result {result:?}"),
        result = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv()) => {
            result.expect("shell synchronization deadline").expect("Inbox synchronization hint")
        }
    };
    assert!(hint.inbox_synchronized());
    service.wake_from_host(hint).await;
}

#[derive(Default)]
struct PreviewTrace {
    calls: Vec<&'static str>,
    links: BTreeSet<String>,
}

fn preview_response(
    request: &Value,
    trace: &Mutex<PreviewTrace>,
    board_url: &str,
) -> Option<Value> {
    let payload = &request["payload"];
    let tab = |thread, id, status| {
        json!({
            "threadId":thread,"tabId":id,"navStatus":status,"updatedAt":"2026-11-24T00:00:00Z"
        })
    };
    let mut trace = trace.lock().unwrap();
    match request["tag"].as_str()? {
        "preview.list" => {
            assert_eq!(*payload, json!({"threadId":INBOX_THREAD}));
            trace.calls.push("list");
            Some(success(
                request,
                &json!({"serverEpoch":"fixture","revision":1,"sessions":[
                    tab(INBOX_THREAD, "old-success", json!({"_tag":"Success","url":format!("{board_url}settings"),"title":"Board"})),
                    tab(INBOX_THREAD, "old-failed", json!({"_tag":"LoadFailed","url":board_url,"title":"Board","code":-1,"description":"failed"})),
                    tab(INBOX_THREAD, "unrelated", json!({"_tag":"Loading","url":"https://example.test/","title":""})),
                    tab(INBOX_THREAD, "idle", json!({"_tag":"Idle"})),
                    tab(LEGACY, "other-thread", json!({"_tag":"Success","url":board_url,"title":"Board"})),
                ]}),
            ))
        }
        "preview.close" => {
            let event = match payload["tabId"].as_str() {
                Some("old-success") => "close-success",
                Some("old-failed") => "close-failed",
                _ => panic!("preview closed an unrelated tab"),
            };
            assert_eq!(
                *payload,
                json!({"threadId":INBOX_THREAD,"tabId":payload["tabId"]})
            );
            trace.calls.push(event);
            Some(json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success"}}))
        }
        "preview.open" => {
            assert_eq!(payload["threadId"], INBOX_THREAD);
            assert_eq!(payload["runtime"], "server");
            assert_eq!(payload["reveal"], true);
            let url = payload["url"].as_str().expect("one-use link");
            let token = url
                .strip_prefix(board_url)
                .and_then(|path| path.strip_prefix("#token="));
            assert!(token.is_some_and(|token| token.len() == 64));
            trace.calls.push("open");
            assert!(trace.links.insert(url.to_owned()), "the link must be fresh");
            if trace.links.len() <= 3 {
                return Some(json!({"_tag":"Exit","requestId":request["id"],"exit":{
                    "_tag":"Failure","cause":[{"_tag":"Fail","error":{
                        "_tag":"EnvironmentAuthorizationError",
                        "requiredScope":"orchestration:operate","requiredPermission":"preview:operate",
                        "message":format!("could not open {url}")
                    }}]
                }}));
            }
            Some(success(
                request,
                &tab(
                    INBOX_THREAD,
                    "new",
                    json!({"_tag":"Loading","url":url,"title":""}),
                ),
            ))
        }
        _ => None,
    }
}

#[tokio::test]
async fn low_usage_permission_survives_task_edits_and_preserves_independent_holds() {
    use nucleus_core::{Command, profiles::UsageLevel};

    let (_home, mut service) = fixture(GitHub::new("unused").unwrap());
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    let inbox = service.native_inbox.as_ref().unwrap();
    observe_pinned_inbox(inbox, None);
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
    observe_pinned_inbox(inbox, None);
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
            },{"id":INBOX_THREAD,"activeRunId":"turn","pinnedAt":"2026-11-24T00:00:00Z"}]}})
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
