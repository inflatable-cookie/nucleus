use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::http::Method;
use nucleus_forge::GitHub;
use nucleus_hosts::InboxStatus;
use nucleus_store::{DispatchSettings, ProjectSettings, Projects, planning::USAGE_APPROVE};
use serde_json::{Value, json};

use super::*;
use crate::{
    tests::{fixture, native_fixture},
    web::tests::{browser_request, json_body, pair_board_link},
};

const LEGACY: &str = "thread:legacy-fixture";
const PROJECT: &str = "project:nucleus-rust-inbox";
const PROVIDER: &str = "fixture-acp";

#[tokio::test]
async fn legacy_process_decisions_are_closed_as_superseded_without_a_census() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let mut state = service.state.lock().await;
    let State {
        store, settings, ..
    } = &mut *state;
    let project = "fixture-product";
    let input = DecisionInput {
        question: "Fixture decision".into(),
        options: vec![
            DecisionOption {
                id: "checked".into(),
                label: "Checked".into(),
            },
            DecisionOption {
                id: "wait".into(),
                label: "Wait".into(),
            },
        ],
    };
    // The key an older engine stored for one process lifetime.
    let legacy = "closeout-process-91988-1".to_owned();
    store
        .add_decision(project, legacy.clone(), input.clone(), engine_stamp())
        .unwrap();
    store
        .add_decision(project, "ordinary".into(), input.clone(), engine_stamp())
        .unwrap();
    // An answer now settles a process decision like any other. Nothing reopens it.
    let answered = "closeout-process-91989-1";
    store
        .add_decision(project, answered.into(), input, engine_stamp())
        .unwrap();
    let answer = DecisionAnswerInput {
        option_id: "checked".into(),
        answer: None,
        based_on_option_id: None,
        note: None,
    };
    let recorded = store
        .answer_decision(project, answered, answer, engine_stamp())
        .unwrap();
    assert!(recorded.answer.is_some());
    for _ in 0..2 {
        supersede_process_decisions(store, settings, service.project.as_ref()).unwrap();
    }
    let history = store
        .planning_history(
            project,
            nucleus_store::planning::RecordKind::Decision,
            &legacy,
        )
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[1].action, "supersede");
    let kept = store
        .planning_history(
            project,
            nucleus_store::planning::RecordKind::Decision,
            answered,
        )
        .unwrap();
    let actions: Vec<_> = kept.iter().map(|entry| entry.action.as_str()).collect();
    assert_eq!(actions, ["add", "answer"]);
    assert_eq!(
        history[1].snapshot["note"],
        "Checkout retirement now follows Dispatch, T3, and Git."
    );
    let open = pending(&state, &service).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].id, "ordinary");
    assert!(
        state
            .store
            .decision(project, &legacy)
            .unwrap()
            .unwrap()
            .withdrawn
    );
}

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
#[expect(
    clippy::too_many_lines,
    reason = "exercise one preview across rotation, reconnect and typed requests"
)]
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
                let data = &mut reply["values"][0];
                match request["tag"].as_str() {
                    Some("orchestration.subscribeThread") => {
                        data["projection"]["runs"] = json!([{"id":ui_run(index),"status":"running"}]);
                        if index != 0 {
                            data["projection"]["messages"] = json!([{
                                "threadId":INBOX_THREAD,"id":format!("fixture-ui-{index}"),"runId":ui_run(index),
                                "role":"user","createdBy":"user","creationSource":"web","text":"ui"
                            }]);
                        }
                    }
                    Some("orchestration.subscribeShell") => {
                        data["snapshot"]["threads"][1]["activeRunId"] = json!(ui_run(index));
                    }
                    _ => {}
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
    let board = crate::web::router_with_board(Arc::clone(&service), [], &assets).unwrap();
    let inbox = service.native_inbox.as_ref().unwrap();
    let target = InboxTarget {
        root: &inbox.root,
        provider: PROVIDER,
    };
    let reconcile = || service.reconcile_inbox(inbox, &target);
    let take_replies = || {
        service
            .take_inbox_replies(
                &inbox.credential,
                Some(&ui_run(message.load(Ordering::Relaxed))),
            )
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
    assert_eq!(trace.lock().unwrap().links.len(), 1);
    show_ui_run(&service, 1);
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
    let reopened = trace.lock().unwrap().links[3].clone();
    let cookie = pair_board_link(&board, &reopened).await;
    let session = json_body(
        browser_request(
            &board,
            Method::GET,
            "/api/engine/session",
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(session["canEditSettings"], true);
    assert_eq!(session["planningProjects"], Value::Null);

    inbox.host_stream_ended(Err(HostError::Unavailable));
    synchronize_preview_session(&service).await;
    message.store(2, Ordering::Relaxed);
    show_ui_run(&service, 2);
    reconcile().await.unwrap();
    reconcile().await.unwrap();
    let trace = trace.lock().unwrap();
    assert_eq!(trace.links.len(), 5);
    let automatic = ["list", "close-success", "open"].as_slice();
    let typed = ["list", "close-success", "close-failed", "open"].as_slice();
    assert_eq!(
        trace.calls,
        [automatic, typed, automatic, automatic, typed].concat()
    );
    assert_eq!(take_replies(), [format!("Board at {board_url}")]);
    server.abort();
}

fn ui_run(index: usize) -> String {
    format!("fixture-ui-run-{index}")
}

fn show_ui_run(service: &Service, index: usize) {
    let mut thread = fixture_inbox_thread(7);
    thread["activeRunId"] = json!(ui_run(index));
    service.host.fixture_held_shell(&json!({
        "kind":"thread.updated", "sequence":7 + index, "thread":thread
    }));
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
    links: Vec<String>,
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
            // A successfully loaded board can still have an expired or planner-scoped pairing.
            let mut sessions = vec![
                tab(
                    INBOX_THREAD,
                    "old-success",
                    json!({"_tag":"Success","url":format!("{board_url}settings"),"title":"Board"}),
                ),
                tab(
                    INBOX_THREAD,
                    "unrelated",
                    json!({"_tag":"Loading","url":"https://example.test/","title":""}),
                ),
                tab(INBOX_THREAD, "idle", json!({"_tag":"Idle"})),
                tab(
                    LEGACY,
                    "other-thread",
                    json!({"_tag":"Success","url":board_url,"title":"Board"}),
                ),
            ];
            if matches!(trace.links.len(), 1 | 4) {
                sessions.push(tab(INBOX_THREAD, "old-failed", json!({"_tag":"LoadFailed","url":board_url,"title":"Board","code":-1,"description":"failed"})));
            }
            Some(success(
                request,
                &json!({"serverEpoch":"fixture","revision":1,"sessions":sessions}),
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
            assert!(
                trace.links.iter().all(|prior| prior != url),
                "the link must be fresh"
            );
            trace.links.push(url.to_owned());
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
#[expect(
    clippy::too_many_lines,
    reason = "one fixture trace covers a complete lifecycle"
)]
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
        state.settings.dispatch = Some(DispatchSettings {
            usage: UsageLevel::Low,
            ..DispatchSettings::default()
        });
    }
    for id in ["approved", "declined", "amended"] {
        service
            .admit_to(
                Some(crate::tests::REPOSITORY),
                id.into(),
                id.into(),
                brief.into(),
                &planner,
            )
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
        .admit_to(
            Some(crate::tests::REPOSITORY),
            "earlier".into(),
            "earlier".into(),
            brief.into(),
            &planner,
        )
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
                    field: inbox_field("fixture-product", &format!("usage-permission-{id}")),
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
                        planner_claim: None,
                        claimed_planner_threads: Vec::new(),
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
    service.set_fixture_acp_provider(Some(PROVIDER));
    service.native_inbox = Some(NativeInbox::open(&service).unwrap());
    let inbox = service.native_inbox.as_ref().unwrap();
    let root = inbox.root.clone();
    let stage = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&stage);
    let offered = Arc::new(std::sync::OnceLock::<String>::new());
    let native_form = Arc::clone(&offered);
    let (host, server) = native_fixture(move |req| {
        native_form_response(req, &seen, &root, native_form.get().map(String::as_str))
    })
    .await;
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
            "fixture-product",
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
    offered.set(form.field.clone()).unwrap();
    inbox.unobserved();
    service
        .reconcile_inbox(inbox, &target)
        .await
        .expect("observe the compact pinned form");
    assert!(!service.inbox_snapshot(&key).await.unwrap().pending[0].offer);
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
        .decisions("fixture-product", false)
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

fn native_form_response(req: &Value, seen: &AtomicUsize, root: &str, field: Option<&str>) -> Value {
    let mut reply = native_response(req, seen, root);
    let Some(field) = field else { return reply };
    if req["tag"] != "orchestration.subscribeThread" || seen.load(Ordering::Relaxed) != 7 {
        return reply;
    }
    let snapshot = &mut reply["values"][0];
    snapshot["hasMoreHistory"] = json!(true);
    snapshot["historyCursor"] = json!("previous-page");
    snapshot["turnItemsOmitLocalVisible"] = json!(true);
    let view = &mut snapshot["projection"];
    view["runtimeRequests"] = json!([{
        "kind": "user_input", "id": "req", "status": "pending",
        "responseCapability": {"type": "live"}
    }]);
    let item = json!({
        "id": "form", "threadId": INBOX_THREAD, "runId": "turn",
        "type": "user_input_request", "requestId": "req", "questions": [{"id": field}]
    });
    view["visibleTurnItems"] = json!([{
        "position": 36, "visibility": "local", "sourceThreadId": INBOX_THREAD,
        "sourceItemId": "form", "item": item
    }]);
    reply
}

async fn retire(service: &Service, target: &InboxTarget<'_>) {
    for _ in 0..2 {
        let Some(write) = service
            .host
            .prepare_inbox_setup(target, None)
            .await
            .unwrap()
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
        let Some(write) = service
            .host
            .prepare_inbox_setup(target, Some("fixture.svg"))
            .await
            .unwrap()
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
            let runs = if step == 4 {
                json!([])
            } else {
                json!([{"id":"turn","status":"running"}])
            };
            json!({"kind":"snapshot","snapshotSequence":step,"projection":{
                "thread":fixture_inbox_thread(step),
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
            let mut threads = vec![json!({
                "id":LEGACY,"projectId":"legacy-project","providerInstanceId":"nucleus",
                "pinnedAt":"2026-11-24T00:00:00Z"
            })];
            if matches!(step, 3..=5 | 7) {
                threads.push(fixture_inbox_thread(step));
            }
            json!({"kind":"snapshot","snapshot":{"snapshotSequence":step,"projects":projects,"threads":threads}})
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

fn fixture_inbox_thread(step: usize) -> Value {
    json!({
        "id":INBOX_THREAD,"projectId":PROJECT,"providerInstanceId":PROVIDER,
        "modelSelection":{"instanceId":PROVIDER,"model":"nucleus"},
        "archivedAt":(step == 6).then_some("2026-11-24T01:00:00Z"),
        "pinnedAt":matches!(step, 4 | 7).then_some("2026-11-24T00:00:00Z"),
        "activeRunId":(step == 7).then_some("turn"),
    })
}

fn success(request: &Value, value: &Value) -> Value {
    json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Success","value":value}})
}

struct DecisionNoticeFixture {
    _home: tempfile::TempDir,
    service: Arc<Service>,
    api: axum::Router,
    sends: Arc<Mutex<Vec<Value>>>,
    lost_next: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
    archived: Arc<AtomicBool>,
    server: tokio::task::JoinHandle<()>,
}

const T3_KEY: [u8; 32] = [8; 32];
const OPERATOR_KEY: [u8; 32] = [9; 32];

impl Drop for DecisionNoticeFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[derive(Clone)]
struct NoticeHostState {
    sends: Arc<Mutex<Vec<Value>>>,
    lost_next: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
    archived: Arc<AtomicBool>,
    checkout: std::path::PathBuf,
}

fn decision_notice_host_reply(request: &Value, state: &NoticeHostState) -> Value {
    let value = match request["tag"].as_str() {
        Some("orchestration.subscribeShell") => json!({
            "kind": "snapshot",
            "snapshot": {"projects": [
                {"id": "alpha-native", "workspaceRoot": state.checkout, "title": "Exact T3 Alpha"}
            ], "threads": []}
        }),
        Some("orchestration.subscribeThread") => {
            let id = request["payload"]["threadId"].as_str().unwrap();
            let sends = state.sends.lock().unwrap();
            let latest = sends
                .iter()
                .rev()
                .find(|send| send["threadId"] == id && send["accepted"] == true);
            let (messages, runs) = if state.started.load(Ordering::Relaxed)
                && let Some(msg) = latest
            {
                let mid = &msg["messageId"];
                (
                    json!([{"id": mid, "runId": "notice-run"}]),
                    json!([{"id": "notice-run", "userMessageId": mid, "status": "running", "startedAt": "2026-11-26T11:47:00Z"}]),
                )
            } else {
                (
                    json!(
                        latest
                            .map(|msg| json!({"id": msg["messageId"]}))
                            .into_iter()
                            .collect::<Vec<_>>()
                    ),
                    json!([]),
                )
            };
            json!({
                "kind": "snapshot", "snapshotSequence": 16,
                "projection": {
                    "thread": {
                        "id": id,
                        "projectId": "alpha-native",
                        "archivedAt": (id == "alpha-planner" && state.archived.load(Ordering::Relaxed))
                            .then_some("2026-11-26T11:45:00Z"),
                    },
                    "messages": messages,
                    "runs": runs,
                }
            })
        }
        Some("orchestration.dispatchCommand") => {
            let mut payload = request["payload"].clone();
            assert_eq!(payload["type"], "message.dispatch");
            let is_uncertain = state.lost_next.swap(false, Ordering::Relaxed);
            payload["accepted"] = json!(true);
            let command = payload["commandId"].clone();
            state.sends.lock().unwrap().push(payload);
            if is_uncertain {
                return json!({"_tag":"Exit","requestId":request["id"],"exit":{"_tag":"Failure","cause":[
                    {"_tag":"Fail","error":{
                        "_tag":"OrchestrationV2DispatchCommandError",
                        "commandId": command, "commandType": "message.dispatch",
                        "cause":{"name":"UnknownError","commandId":command,"commandType":"message.dispatch","message":"fixture"}
                    }}
                ]}});
            }
            return success(request, &json!({"sequence": 17}));
        }
        _ => panic!("unexpected T3 request {request}"),
    };
    json!({"_tag":"Chunk","requestId":request["id"],"values":[value,{"kind":"synchronized"}]})
}

impl DecisionNoticeFixture {
    async fn open() -> Self {
        let (home, legacy) = fixture(GitHub::new("unused").unwrap());
        let checkout = legacy.fixture().checkout.clone();
        crate::tests::git(
            &checkout,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        let settings = legacy.settings.clone();
        drop(legacy);
        crate::tests::clear_fixture_projects(&settings);

        let sends = Arc::new(Mutex::new(Vec::<Value>::new()));
        let lost_next = Arc::new(AtomicBool::new(false));
        let started = Arc::new(AtomicBool::new(false));
        let archived = Arc::new(AtomicBool::new(false));
        let host_state = NoticeHostState {
            sends: Arc::clone(&sends),
            lost_next: Arc::clone(&lost_next),
            started: Arc::clone(&started),
            archived: Arc::clone(&archived),
            checkout: checkout.clone(),
        };
        let (host, server) =
            native_fixture(move |request| decision_notice_host_reply(request, &host_state)).await;

        host.fixture_project_shell(
            &json!({"projects": [{"id": "alpha-native", "workspaceRoot": checkout, "title": "Exact T3 Alpha"}], "threads": []}),
            PROVIDER,
        );
        let mut service = Service::open_projects(
            settings.lock_profile().unwrap(),
            PROVIDER.into(),
            host,
            GitHub::new("unused").unwrap(),
            "127.0.0.1:9".parse().unwrap(),
            std::env::current_exe().unwrap(),
        )
        .unwrap();
        service.native_inbox = Some(NativeInbox::open(&service).unwrap());
        observe_pinned_inbox(service.native_inbox.as_ref().unwrap(), None);
        let service = Arc::new(service);
        let api = crate::web::router_with_t3_callers(
            Arc::clone(&service),
            [crate::Controller {
                credential: OPERATOR_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            }],
            Some(T3_KEY),
        );

        Self {
            _home: home,
            service,
            api,
            sends,
            lost_next,
            started,
            archived,
            server,
        }
    }

    async fn enroll(&self, actor: &str) {
        {
            let mut state = self.service.state.lock().await;
            assert!(matches!(
                self.service.request_enrollment(&mut state, actor),
                ServiceError::PlannerEnrollmentPending(_)
            ));
        }
        assert_eq!(self.service.take_enrollment().await.as_deref(), Some(actor));
        self.service.complete_enrollment(actor).await;
    }

    async fn project_id(&self, actor: &str) -> String {
        self.service
            .state
            .lock()
            .await
            .live_planner_project(actor)
            .unwrap()
            .to_owned()
    }

    async fn t3_post(&self, actor: &str, path: &str, body: Value) -> Value {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method(Method::POST)
            .uri(path)
            .header(axum::http::header::HOST, "127.0.0.1:9")
            .header("authorization", format!("Bearer {}", hex::encode(T3_KEY)))
            .header("x-nucleus-t3-caller", actor)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        let response = self.api.clone().oneshot(request).await.unwrap();
        assert!(response.status().is_success(), "{}", response.status());
        json_body(response).await
    }

    async fn assert_gate_rejects_free_text(&self, project: &str, decision_id: &str) {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method(Method::POST)
            .uri(format!(
                "/v1/planning/{project}/decisions/{decision_id}/answer"
            ))
            .header(axum::http::header::HOST, "127.0.0.1:9")
            .header(
                "authorization",
                format!("Bearer {}", hex::encode(OPERATOR_KEY)),
            )
            .header("content-type", "application/json")
            .body(axum::body::Body::from(r#"{"answer":"custom answer"}"#))
            .unwrap();
        let response = self.api.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    async fn answer_via_inbox(&self, project: &str, decision_id: &str, option_id: &str) {
        let key = self.service.native_inbox.as_ref().unwrap().credential;
        self.service
            .answer_inbox(
                &key,
                InboxAnswer {
                    field: inbox_field(project, decision_id),
                    option_id: option_id.into(),
                },
            )
            .await
            .unwrap();
    }

    async fn advance_tell(&self) -> Result<(), ServiceError> {
        let row = self
            .service
            .state
            .lock()
            .await
            .store
            .next_tell()?
            .expect("queued tell");
        self.service.advance_tell(&row).await
    }

    async fn has_pending_tell(&self) -> bool {
        self.service
            .state
            .lock()
            .await
            .store
            .next_tell()
            .unwrap()
            .is_some()
    }
}

fn decision_input(question: &str) -> DecisionInput {
    DecisionInput {
        question: question.into(),
        options: vec![
            DecisionOption {
                id: "ship".into(),
                label: "Ship now".into(),
            },
            DecisionOption {
                id: "hold".into(),
                label: "Hold release".into(),
            },
        ],
    }
}

async fn check_inbox_and_replay(fixture: &DecisionNoticeFixture, project: &str) {
    let alpha = Authority::Planner {
        actor: "alpha-planner".into(),
    };
    let operator = Authority::Operator {
        actor: "operator".into(),
    };
    let first = fixture
        .service
        .add_decision(
            project,
            decision_input("Ship the fixture   release?"),
            &alpha,
        )
        .await
        .unwrap();
    fixture.answer_via_inbox(project, &first.id, "ship").await;
    fixture.lost_next.store(true, Ordering::Relaxed);
    assert!(matches!(
        fixture.advance_tell().await,
        Err(ServiceError::Host(_))
    ));
    assert!(matches!(
        fixture
            .service
            .state
            .lock()
            .await
            .store
            .next_tell()
            .unwrap()
            .unwrap()
            .state,
        nucleus_store::TellState::InFlight(_)
    ));
    fixture.started.store(true, Ordering::Relaxed);
    fixture.advance_tell().await.unwrap();
    assert!(!fixture.has_pending_tell().await);
    {
        let sends = fixture.sends.lock().unwrap();
        assert_eq!(sends.len(), 1);
        assert_eq!(sends[0]["threadId"], "alpha-planner");
        let text = sends[0]["text"].as_str().unwrap();
        assert!(text.contains(&first.id));
        assert!(text.contains("Ship the fixture release?"));
        assert!(text.contains("Ship now (ship)"));
        assert!(text.contains("UTC"));
        assert!(!text.contains("Reply: nucleus tell"));
    }

    // Replaying the same answer sends nothing more; changing option or note sends once.
    fixture
        .service
        .answer_decision(
            project,
            &first.id,
            DecisionAnswerInput {
                option_id: "ship".into(),
                answer: None,
                based_on_option_id: None,
                note: None,
            },
            &operator,
        )
        .await
        .unwrap();
    assert!(!fixture.has_pending_tell().await);
    for note in ["Wait for CI", "  Wait for CI  "] {
        fixture
            .service
            .answer_decision(
                project,
                &first.id,
                DecisionAnswerInput {
                    option_id: "hold".into(),
                    answer: None,
                    based_on_option_id: None,
                    note: Some(note.into()),
                },
                &operator,
            )
            .await
            .unwrap();
    }
    fixture.advance_tell().await.unwrap();
    fixture.advance_tell().await.unwrap();
    assert!(!fixture.has_pending_tell().await);
    let sends = fixture.sends.lock().unwrap();
    assert_eq!(sends.len(), 2);
    let text = sends[1]["text"].as_str().unwrap();
    assert!(text.contains("Hold release (hold)"));
    assert!(text.contains("Note: Wait for CI"));
}

async fn check_gone_author_fallback(fixture: &DecisionNoticeFixture, project: &str) {
    let alpha = Authority::Planner {
        actor: "alpha-planner".into(),
    };
    let second = fixture
        .service
        .add_decision(project, decision_input("Fallback question?"), &alpha)
        .await
        .unwrap();
    fixture.archived.store(true, Ordering::Relaxed);
    fixture.answer_via_inbox(project, &second.id, "ship").await;
    fixture.advance_tell().await.unwrap();
    fixture.advance_tell().await.unwrap();
    fixture.advance_tell().await.unwrap();
    assert!(!fixture.has_pending_tell().await);
    let sends = fixture.sends.lock().unwrap();
    assert_eq!(sends.len(), 3);
    assert_eq!(sends[2]["threadId"], "next-planner");
    let text = sends[2]["text"].as_str().unwrap();
    assert!(text.contains(&second.id));
    assert!(text.contains("Ship now (ship)"));
    assert!(text.contains("Fallback delivery."));
    assert!(!text.contains("alpha-planner"));
}

async fn check_task_linked_wake_and_notify(fixture: &DecisionNoticeFixture, project: &str) {
    fixture.service.state.lock().await.settings.dispatch = Some(DispatchSettings {
        usage: nucleus_core::profiles::UsageLevel::Low,
        ..DispatchSettings::default()
    });
    let _created = fixture
        .t3_post(
            "next-planner",
            "/v1/planning/tasks",
            json!({
                "id": "gated-task",
                "reference": "gated-task",
                "brief": "---\nqueue:\n  complexity: high\n---\nGated work."
            }),
        )
        .await;
    let task_id = "gated-task";
    fixture.service.state.lock().await.schedule.park(task_id);
    let decision_id = format!("usage-permission-{task_id}");
    fixture
        .assert_gate_rejects_free_text(project, &decision_id)
        .await;
    fixture
        .answer_via_inbox(project, &decision_id, USAGE_APPROVE)
        .await;
    assert!(
        fixture
            .service
            .state
            .lock()
            .await
            .schedule
            .due(task_id)
            .is_some()
    );
    fixture.advance_tell().await.unwrap();
    fixture.advance_tell().await.unwrap();
    assert!(!fixture.has_pending_tell().await);
    let sends = fixture.sends.lock().unwrap();
    assert_eq!(sends.len(), 4);
    assert_eq!(sends[3]["threadId"], "next-planner");
    let text = sends[3]["text"].as_str().unwrap();
    assert!(text.contains(&decision_id));
    assert!(text.contains("Approve at Low usage (approve)"));
}

async fn check_task_question_wake_and_notify(fixture: &DecisionNoticeFixture, project: &str) {
    use nucleus_core::{Entry, Forge, Observation, Observed, PullRequest, Task};

    let head: nucleus_core::Head = "a".repeat(40).parse().unwrap();
    let pr = PullRequest {
        url: format!("https://github.com/{}/pull/1", crate::tests::REPOSITORY),
        head: head.clone(),
    };
    let mut task = Task::new(
        nucleus_core::Identity {
            id: "review-entry-task".into(),
            reference: "review-entry-task".into(),
            repository: crate::tests::REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::ReviewEntry,
            origin_thread: Some("next-planner".into()),
        },
        "Review the fixture".into(),
        Some(pr.clone()),
    );
    assert!(matches!(
        task.reconcile(&Observation {
            forge: Observed::Known(Forge::Merged { pr, commit: head }),
            host: Observed::Unknown,
            workspace: Observed::Unknown,
        }),
        Action::Ask(_)
    ));
    fixture
        .service
        .state
        .lock()
        .await
        .store
        .create(&task, &crate::event("admitted"))
        .unwrap();
    let row = fixture.service.task("review-entry-task").await.unwrap();
    fixture.service.native_task_decision(&row).await.unwrap();
    fixture
        .service
        .state
        .lock()
        .await
        .schedule
        .park("review-entry-task");
    fixture
        .assert_gate_rejects_free_text(project, "task-review-entry-task-1")
        .await;
    fixture
        .answer_via_inbox(project, "task-review-entry-task-1", ACCEPT)
        .await;
    assert!(
        fixture
            .service
            .state
            .lock()
            .await
            .schedule
            .due("review-entry-task")
            .is_some()
    );
    fixture.advance_tell().await.unwrap();
    fixture.advance_tell().await.unwrap();
    assert!(!fixture.has_pending_tell().await);
    let sends = fixture.sends.lock().unwrap();
    assert_eq!(sends.len(), 5);
    assert_eq!(sends[4]["threadId"], "next-planner");
    let text = sends[4]["text"].as_str().unwrap();
    assert!(text.contains("task-review-entry-task-1"));
    assert!(text.contains("Accept merge (accept)"));
}

async fn check_tell_failure_rolls_back_answer_atomically(
    fixture: &DecisionNoticeFixture,
    project: &str,
) {
    let next = Authority::Planner {
        actor: "next-planner".into(),
    };
    let failed = fixture
        .service
        .add_decision(project, decision_input("Atomic failure test?"), &next)
        .await
        .unwrap();
    let db_path = fixture
        .service
        .storage
        .database()
        .path()
        .join("engine.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER fail_tell_write BEFORE INSERT ON project_tell_deliveries
         BEGIN SELECT RAISE(ABORT, 'injected tell failure'); END;",
    )
    .unwrap();
    let inbox_key = fixture.service.native_inbox.as_ref().unwrap().credential;
    let err = fixture
        .service
        .answer_inbox(
            &inbox_key,
            InboxAnswer {
                field: inbox_field(project, &failed.id),
                option_id: "ship".into(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ServiceError::Store(_)));
    let stored = fixture
        .service
        .state
        .lock()
        .await
        .store
        .decision(project, &failed.id)
        .unwrap()
        .unwrap();
    assert!(stored.answer.is_none());
    assert!(!fixture.has_pending_tell().await);
    assert!(
        fixture
            .service
            .inbox_snapshot(&inbox_key)
            .await
            .unwrap()
            .pending
            .iter()
            .any(|form| form.field == inbox_field(project, &failed.id))
    );
    conn.execute_batch("DROP TRIGGER fail_tell_write;").unwrap();
    fixture.answer_via_inbox(project, &failed.id, "ship").await;
    fixture.advance_tell().await.unwrap();
    fixture.advance_tell().await.unwrap();
    assert!(!fixture.has_pending_tell().await);
    let sends = fixture.sends.lock().unwrap();
    assert_eq!(sends.len(), 6);
    assert_eq!(sends[5]["threadId"], "next-planner");
    assert!(sends[5]["text"].as_str().unwrap().contains(&failed.id));
}

async fn check_capped_planner_still_records_and_queues_notice(
    fixture: &DecisionNoticeFixture,
    project: &str,
) {
    let next = Authority::Planner {
        actor: "next-planner".into(),
    };
    let capped = fixture
        .service
        .add_decision(project, decision_input("At cap delivery test?"), &next)
        .await
        .unwrap();
    let now = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    let mut hit_cap = false;
    {
        let mut state = fixture.service.state.lock().await;
        for index in 0..25 {
            let key = format!("cap-seed-{index}");
            let delivery_id = format!("tell-cap-{index}");
            let text = format!("cap seed tell {index}");
            match state.store.record_tell(
                &nucleus_store::TellSubmission {
                    key: &key,
                    sender: "alpha-planner",
                    direct: Some("next-planner"),
                    from_project: project,
                    text: &text,
                    recorded_at: now,
                    no_live_planners: &[],
                },
                &[(project.to_string(), delivery_id)],
            ) {
                Ok(_) => {}
                Err(nucleus_store::StoreError::TellRateLimit(_)) => {
                    hit_cap = true;
                    break;
                }
                Err(other) => panic!("unexpected tell seed error: {other}"),
            }
        }
    }
    assert!(hit_cap);
    let delivered_state = serde_json::to_string(&nucleus_store::TellState::Delivered {
        at_ms: now,
        thread: "next-planner".into(),
    })
    .unwrap();
    let db_path = fixture
        .service
        .storage
        .database()
        .path()
        .join("engine.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute(
        "UPDATE project_tell_deliveries SET state = ?1, retry_at = NULL WHERE request_key LIKE 'cap-seed-%'",
        [delivered_state],
    )
    .unwrap();
    fixture.answer_via_inbox(project, &capped.id, "ship").await;
    let stored = fixture
        .service
        .state
        .lock()
        .await
        .store
        .decision(project, &capped.id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.answer.unwrap().input.option_id, "ship");
    fixture.advance_tell().await.unwrap();
    fixture.advance_tell().await.unwrap();
    assert!(!fixture.has_pending_tell().await);
    let sends = fixture.sends.lock().unwrap();
    assert_eq!(sends.len(), 7);
    assert_eq!(sends[6]["threadId"], "next-planner");
    assert!(sends[6]["text"].as_str().unwrap().contains(&capped.id));
}

#[tokio::test]
async fn decision_answer_notifies_author_falls_back_dedupes_replays_and_wakes_tasks() {
    let fixture = DecisionNoticeFixture::open().await;
    fixture.enroll("alpha-planner").await;
    fixture.enroll("next-planner").await;
    let project = fixture.project_id("alpha-planner").await;
    check_inbox_and_replay(&fixture, &project).await;
    check_gone_author_fallback(&fixture, &project).await;
    check_task_linked_wake_and_notify(&fixture, &project).await;
    check_task_question_wake_and_notify(&fixture, &project).await;
    check_tell_failure_rolls_back_answer_atomically(&fixture, &project).await;
    check_capped_planner_still_records_and_queues_notice(&fixture, &project).await;
    let decision = fixture
        .service
        .add_decision(
            &project,
            decision_input("Custom ruling?"),
            &Authority::Planner {
                actor: "next-planner".into(),
            },
        )
        .await
        .unwrap();
    fixture
        .service
        .answer_decision(
            &project,
            &decision.id,
            DecisionAnswerInput {
                option_id: String::new(),
                answer: Some("Ship after checks".into()),
                based_on_option_id: Some("ship".into()),
                note: None,
            },
            &Authority::Operator {
                actor: "operator".into(),
            },
        )
        .await
        .unwrap();
    fixture.advance_tell().await.unwrap();
    fixture.advance_tell().await.unwrap();
    let sends = fixture.sends.lock().unwrap();
    let text = sends.last().unwrap()["text"].as_str().unwrap();
    assert!(text.contains("Ship after checks (based on ship)"));
}
