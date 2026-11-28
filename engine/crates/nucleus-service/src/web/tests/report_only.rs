use std::sync::Mutex;

use nucleus_core::{CallbackCredential, Head, Observation, Role, Workspace};
use nucleus_hosts::Binding;

use super::{
    planning::put_as,
    projects::{NoticeFixture, NoticeReply},
    *,
};
use crate::tests::{archive_snapshot_reply, archived_checkout_rows, git, native_fixture};

const TASK: &str = "report-cutover";
const PROJECT: &str = "fixture-product";
const HOST_PROJECT: &str = "local-fixture";
const WORKER: &str = "worker-report";
const PLANNER: &str = "planner-report";
const BRIEF: &str = "---\ntitle: Milestone QA\nqueue:\n  complexity: low\n  lanes: [qa, notes]\n  reportOnly: true\n  reportLane: qa\n---\nQualify the pinned commit.";

#[tokio::test]
async fn board_and_worker_lane_edits_both_refresh_paired_planning() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let turn = fixture.reserve().await;
    let assets = tempfile::tempdir().unwrap();
    std::fs::write(assets.path().join("index.html"), "").unwrap();
    std::fs::write(assets.path().join("app.js"), "").unwrap();
    let api = router_with_board(
        Arc::clone(&fixture.service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
        assets.path(),
    )
    .unwrap();
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let cookie = Some(cookie.as_str());
    let mut events = browser_request(&api, Method::GET, "/api/engine/events", cookie, None)
        .await
        .into_body()
        .into_data_stream();
    assert_event(&mut events, &["event: refresh"]).await;
    let settings = fixture.service.settings_changes.subscribe();

    let lane = format!("/api/engine/planning/{PROJECT}/lanes/qa");
    let edit = json!({
        "version": 1, "title": "qa", "aim": "qualification", "document": "board edit",
    });
    let saved = browser_request(&api, Method::PUT, &lane, cookie, Some(&edit)).await;
    assert_eq!(saved.status(), StatusCode::OK);
    assert_event(&mut events, &["event: planning"]).await;

    let saved = fixture.write(&turn, 2, "worker edit").await;
    assert_eq!(saved["version"], 3);
    assert_event(&mut events, &["event: planning"]).await;
    assert!(!settings.has_changed().unwrap());

    let plan = format!("/api/engine/planning/{PROJECT}/plan");
    let projection = json_body(browser_request(&api, Method::GET, &plan, cookie, None).await).await;
    let written = projection["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|document| document["key"] == "qa")
        .unwrap();
    assert_eq!(written["document"], "worker edit");
}

#[tokio::test]
async fn report_only_admission_refuses_hidden_tracked_edits() {
    let fixture = ReportFixture::new().await;
    let repo = &fixture.service.fixture().checkout;
    let tracked = repo.join("input");
    std::fs::write(&tracked, "published").unwrap();
    git(repo, &["add", "input"]);
    crate::tests::create_fixture_commit(repo, "publish input");
    let head: Head = git(repo, &["rev-parse", "HEAD"]).parse().unwrap();
    *fixture.published.lock().unwrap() = Some(head.clone());
    let route = format!("/v1/planning/{PROJECT}/tasks");
    let request = json!({"brief":BRIEF, "planningCommit":head});
    for (hide, show) in [
        ("--assume-unchanged", "--no-assume-unchanged"),
        ("--skip-worktree", "--no-skip-worktree"),
    ] {
        git(repo, &["update-index", hide, "input"]);
        std::fs::write(&tracked, "local draft").unwrap();
        assert!(git(repo, &["status", "--porcelain"]).is_empty());
        let response = post_as(&fixture.api, &route, &BOARD_KEY, &request).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            json_body(response).await["error"]
                .as_str()
                .unwrap()
                .contains("clean, published")
        );
        git(repo, &["update-index", show, "input"]);
        std::fs::write(&tracked, "published").unwrap();
    }
    assert_eq!(
        post_as(&fixture.api, &route, &BOARD_KEY, &request)
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn report_only_admits_an_attached_lane_and_proves_the_planning_pin() {
    let fixture = ReportFixture::new().await;
    let tasks = format!("/v1/planning/{PROJECT}/tasks");
    for (brief, refusal) in [
        (BRIEF.replace("  reportLane: qa\n", ""), "multiple lanes"),
        (
            BRIEF.replace("  reportLane: qa", "  reportLane: elsewhere"),
            "must also be attached",
        ),
        (
            BRIEF
                .replace("  lanes: [qa, notes]\n", "")
                .replace("  reportLane: qa\n", ""),
            "requires an attached lane",
        ),
        (
            BRIEF.replace("  reportLane: qa", "  reportLane: qa\n  interactive: true"),
            "queue.interactive",
        ),
    ] {
        let response = post_as(&fixture.api, &tasks, &BOARD_KEY, &json!({"brief":brief})).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{refusal}");
        assert!(
            json_body(response).await["error"]
                .as_str()
                .expect("refusal")
                .contains(refusal)
        );
    }
    let response = post_as(
        &fixture.api,
        &tasks,
        &BOARD_KEY,
        &json!({
            "brief": BRIEF, "planningCommit":"a".repeat(40),
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(response).await["error"]
            .as_str()
            .expect("pin refusal")
            .contains("changed")
    );
    fixture.admit().await;

    let item = json_body(post_as(&fixture.api, &format!("/v1/planning/{PROJECT}/items"), &BOARD_KEY, &json!({
        "kind":"lead","title":"Promoted report","body": BRIEF.replace("  lanes: [qa, notes]\n", "").replace("  reportLane: qa\n", ""),
        "lanes":["qa"],
    })).await).await;
    let id = item["id"].as_str().expect("lead ID");
    let response = post_as(
        &fixture.api,
        &format!("/v1/planning/{PROJECT}/items/{id}/promote"),
        &BOARD_KEY,
        &json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let admitted = json_body(response).await;
    let task = admitted["identity"]["id"].as_str().expect("promoted task");
    assert_eq!(
        fixture
            .service
            .task(task)
            .await
            .expect("promoted")
            .task
            .report_task()
            .expect("report")
            .lane,
        "qa"
    );
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "exercise one durable lifecycle across its real HTTP boundaries"
)]
async fn report_only_ticket_revision_and_historical_owner_acceptance() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let turn = fixture.reserve().await;
    let lane = turn.lane("qa");
    for refused in [
        turn.lane("notes"),
        lane.replace(PROJECT, "wrong-project"),
        lane.replace(TASK, "unknown-task"),
        lane.replace(&turn.instance, "other-run"),
        format!("/v1/tasks/{TASK}"),
    ] {
        assert_eq!(
            get_as(&fixture.api, &refused, turn.key()).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        get_as(&fixture.api, &lane, &BOARD_KEY).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        put_as(
            &fixture.api,
            &format!("/v1/planning/{PROJECT}/lanes/qa"),
            turn.key(),
            &json!({
                "version": 1, "title": "spoof", "aim": "spoof", "document": "spoof",
            })
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        put_as(
            &fixture.api,
            &turn.lane("notes"),
            turn.key(),
            &json!({
                "version": 1, "document": "foreign write",
            })
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        put_as(
            &fixture.api,
            &lane,
            turn.key(),
            &json!({
                "version": 1, "document": "metadata write", "title": "forged",
            })
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );

    let initial = json_body(get_as(&fixture.api, &lane, turn.key()).await).await;
    assert_eq!(initial["version"], 1);
    let first = fixture.write(&turn, 1, "slice 1").await;
    let latest = fixture.write(&turn, 2, "slice 1 and 2").await;
    assert_eq!(latest["version"], 3);
    assert_eq!(latest["title"], "qa");
    let stale_put = put_as(
        &fixture.api,
        &lane,
        turn.key(),
        &json!({"version":1,"document":"lost"}),
    )
    .await;
    assert_eq!(stale_put.status(), StatusCode::CONFLICT);
    let stale = ReportTurn::report(&first["artifact"], &fixture.head);
    let refused = post_as(&fixture.api, &turn.callback(), turn.key(), &stale).await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(refused).await["error"]
            .as_str()
            .expect("stale refusal")
            .contains("latest v3")
    );
    let mut wrong_digest = latest["artifact"].clone();
    wrong_digest["digest"] = json!("0".repeat(64));
    let refused = post_as(
        &fixture.api,
        &turn.callback(),
        turn.key(),
        &ReportTurn::report(&wrong_digest, &fixture.head),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(refused).await["error"]
            .as_str()
            .expect("digest refusal")
            .contains(
                latest["artifact"]["digest"]
                    .as_str()
                    .expect("latest digest")
            )
    );

    let report = ReportTurn::report(&latest["artifact"], &fixture.head);
    assert_eq!(
        post_json(&fixture.api, &turn.callback(), turn.key(), &report).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        get_as(&fixture.api, &lane, turn.key()).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let ready = fixture.settle(&turn).await;
    assert_eq!(ready.task.phase(), Phase::ReportReady);
    assert_eq!(ready.task.threads().get(Role::Worker), Some(WORKER));
    assert_eq!(ready.task.threads().get(Role::Reviewer), None);
    assert!(ready.task.question().is_none());
    assert_eq!(
        post_json(&fixture.api, &turn.callback(), turn.key(), &report).await,
        StatusCode::NO_CONTENT
    );
    let detail =
        json_body(get_as(&fixture.api, &format!("/v1/tasks/{TASK}"), &BOARD_KEY).await).await;
    assert_eq!(detail["report"]["delivery"]["artifact"], latest["artifact"]);
    assert!(detail["report"].get("receipts").is_none());

    assert_eq!(
        fixture.command(json!({"move":"done"})).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        fixture
            .command(json!({"move_work":{"instruction":"Re-run the missing slice"}}))
            .await
            .status(),
        StatusCode::OK
    );
    let revising = fixture.service.task(TASK).await.expect("working");
    assert_eq!(revising.task.phase(), Phase::Working);
    assert!(
        revising
            .task
            .report_task()
            .expect("report")
            .delivery
            .is_none()
    );
    assert_eq!(
        revising
            .task
            .report_task()
            .expect("report")
            .instruction
            .as_deref(),
        Some("Re-run the missing slice")
    );
    let revision = fixture.reserve().await;
    assert_ne!(revision.instance, turn.instance);
    assert_eq!(
        get_as(&fixture.api, &lane, turn.key()).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let amended = fixture.write(&revision, 3, "revised qualification").await;
    let amended_artifact = &amended["artifact"];
    let report = ReportTurn::report(amended_artifact, &fixture.head);
    assert_eq!(
        post_json(&fixture.api, &revision.callback(), revision.key(), &report).await,
        StatusCode::NO_CONTENT
    );
    let ready = fixture.settle(&revision).await;
    fixture.planner_write("later unrelated lane edit", 4).await;

    let complete = |version, artifact: &Value| {
        json!({"complete":{
            "version":version, "artifact":artifact, "reason":"Qualification reviewed",
        }})
    };
    assert_eq!(
        fixture
            .command(complete(ready.version, &latest["artifact"]))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        fixture
            .command(complete(ready.version - 1, amended_artifact))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    fixture.open_pr.store(true, Ordering::Relaxed);
    assert_eq!(
        fixture
            .command(complete(ready.version, amended_artifact))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    fixture.open_pr.store(false, Ordering::Relaxed);
    let mut worker = fixture.idle_worker();
    worker["pendingRuntimeRequest"] = json!({"kind":"permission"});
    fixture.observe_worker(&worker);
    assert_eq!(
        fixture
            .command(complete(ready.version, amended_artifact))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    worker["pendingRuntimeRequest"] = Value::Null;
    let mut unknown = worker.clone();
    unknown.as_object_mut().unwrap().remove("activeRunId");
    fixture.observe_worker(&unknown);
    let refused = fixture
        .command(complete(ready.version, amended_artifact))
        .await;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        json_body(refused).await["error"]
            .as_str()
            .unwrap()
            .contains("turn or input state is unknown")
    );
    // The idle worker has no pendingBackgroundTasks field.
    fixture.observe_worker(&worker);
    let accept = complete(ready.version, amended_artifact);
    let done = fixture.command(accept.clone()).await;
    assert_eq!(done.status(), StatusCode::OK);
    assert_eq!(json_body(done).await["phase"], "done");
    assert_eq!(fixture.command(accept).await.status(), StatusCode::OK);
    assert!(
        fixture
            .service
            .task(TASK)
            .await
            .expect("done")
            .task
            .pull_request()
            .is_none()
    );
}

#[tokio::test]
async fn report_only_archive_retains_dirty_or_unpublished_source() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let turn = fixture.reserve().await;
    let artifact = fixture.write(&turn, 1, "qualification").await["artifact"].clone();
    assert_eq!(
        post_json(
            &fixture.api,
            &turn.callback(),
            turn.key(),
            &ReportTurn::report(&artifact, &fixture.head)
        )
        .await,
        StatusCode::NO_CONTENT
    );
    let ready = fixture.settle(&turn).await;
    fixture.observe_worker(&fixture.idle_worker());
    let response = fixture
        .command(
            json!({"complete":{"version":ready.version,"artifact":artifact,"reason":"accepted"}}),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    // A disconnect after acceptance must leave the physical checkout in place.
    fixture.service.host.fixture_disconnect_shell();
    let done = fixture.service.task(TASK).await.expect("done");
    let outcome = fixture.service.archive_done(&done).await;
    assert!(
        matches!(outcome, Err(ServiceError::ArchiveEvidence(ref cause)) if cause.contains("synchronize")),
        "{outcome:?}"
    );
    assert!(fixture.checkout.is_dir());
    fixture.service.host.fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
        "snapshotSequence":1,"projects":[{"id":HOST_PROJECT,"workspaceRoot":fixture.service.fixture().checkout}],
        "threads":[],"archivedThreads":fixture.archived_threads(&done.task)
    }}));
    std::fs::write(fixture.checkout.join("dirty"), "work").expect("untracked");
    let outcome = fixture.service.archive_done(&done).await;
    assert!(
        matches!(
            outcome,
            Err(ServiceError::ReportCheckout(
                "the retained checkout contains local changes"
            ))
        ),
        "{outcome:?}"
    );
    assert!(fixture.checkout.join("dirty").exists());
    std::fs::remove_file(fixture.checkout.join("dirty")).expect("clean fixture");
    *fixture.published.lock().expect("remote refs") = None;
    let outcome = fixture.service.archive_done(&done).await;
    assert!(
        matches!(
            outcome,
            Err(ServiceError::ReportCheckout(
                "the source is not proved published on origin"
            ))
        ),
        "{outcome:?}"
    );
    assert!(fixture.checkout.is_dir());
    let root = &fixture.service.fixture().checkout;
    git(
        root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "advanced main",
        ],
    );
    let next = git(root, &["rev-parse", "HEAD"]).parse().expect("new head");
    *fixture.published.lock().expect("remote refs") = Some(next);
    let parent = nucleus_hosts::parent_thread(&fixture.checkout);
    let host = &fixture.service.host;
    {
        let state = fixture.service.state.lock().await;
        assert_eq!(
            state.store.archive_due_ids(None, 10, false).unwrap(),
            [TASK]
        );
    }
    let archive_read = "orchestration.getArchivedShellSnapshot";
    host.fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
        "snapshotSequence":1,"projects":[{"id":HOST_PROJECT,"workspaceRoot":fixture.service.fixture().checkout}],
        "threads":[],"archivedThreads":[]
    }}));
    let outcome = fixture.service.archive_done(&done).await;
    assert!(
        matches!(outcome, Err(ServiceError::CheckoutRetained(ref cause)) if cause.contains("idle or gone")),
        "{outcome:?}"
    );
    assert!(fixture.checkout.exists());
    let before = host.host_calls().get(archive_read).copied().unwrap_or(0);
    for status in ["running", "unknown"] {
        host.fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[{"id":HOST_PROJECT,"workspaceRoot":fixture.service.fixture().checkout}],"threads":[
                {"id":"delegated-child","parentThreadId":parent,"status":status}
            ],"archivedThreads":fixture.archived_threads(&done.task)
        }}));
        let outcome = fixture.service.archive_done(&done).await;
        assert!(
            matches!(outcome, Err(ServiceError::CheckoutRetained(ref cause)) if cause.contains("every task thread is idle")),
            "delegated child {status}: {outcome:?}"
        );
        assert!(fixture.checkout.exists());
    }
    host.fixture_held_shell(
        &json!({"kind":"thread.removed","sequence":2,"threadId":"delegated-child"}),
    );
    assert_eq!(
        fixture.service.archive_done(&done).await.expect("closeout"),
        Action::Nothing
    );
    assert!(!fixture.checkout.exists());
    assert_eq!(
        host.host_calls().get(archive_read),
        Some(&(before + 2)),
        "sweeping and retiring each verify their own archive evidence"
    );
}

#[tokio::test]
async fn archive_preserves_compare_errors_and_the_forge_retry_deadline() {
    let branch_reads = Arc::new(AtomicUsize::new(0));
    let reads = Arc::clone(&branch_reads);
    let comparisons = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&comparisons);
    let api = Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/branches"),
            get(move || async move {
                reads.fetch_add(1, Ordering::Relaxed);
                Json(json!([
                    {"name": "main", "commit": {"sha": "a".repeat(40)}},
                    {"name": "other", "commit": {"sha": "b".repeat(40)}}
                ]))
            }),
        )
        .route(
            &format!("/repos/{REPOSITORY}/compare/{{pair}}"),
            get(move || async move {
                if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                    StatusCode::NOT_FOUND.into_response()
                } else {
                    (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "120")]).into_response()
                }
            }),
        );
    let (forge, server) = serve_forge(api).await;
    let (_home, service) = fixture(forge);
    let project = service.fixture();
    let (task, _, _) = reservation(TASK, Entry::Brief, &project.start);
    let worktrees = service.worktrees();
    let checkout = worktrees
        .checkout(&project.checkout, REPOSITORY, TASK)
        .unwrap();
    let verify = || service.is_published_checkout(task.identity(), &checkout, &project.start);
    assert!(matches!(
        verify().await,
        Err(ServiceError::Forge(nucleus_forge::ForgeError::Status(
            StatusCode::NOT_FOUND
        )))
    ));
    let Err(ServiceError::Forge(nucleus_forge::ForgeError::Deferred { until })) = verify().await
    else {
        panic!("expected the compare throttle");
    };
    let deadline = until
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    assert_eq!(
        u128::from(service.forge_until.load(Ordering::Relaxed)),
        deadline
    );
    assert!(matches!(verify().await,
        Err(ServiceError::Forge(nucleus_forge::ForgeError::Deferred { until: next }))
        if next.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() == deadline));
    assert_eq!(branch_reads.load(Ordering::Relaxed), 2);
    assert_eq!(comparisons.load(Ordering::Relaxed), 2);
    server.abort();
}

#[tokio::test]
async fn cancelled_checkout_only_retires_clean_published_work() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let worktrees = fixture.service.worktrees();
    let checkout = worktrees
        .checkout(&fixture.service.fixture().checkout, REPOSITORY, TASK)
        .unwrap();
    checkout.allocate(&fixture.head).unwrap();
    fixture
        .service
        .command(
            TASK,
            &Authority::Operator {
                actor: "fixture".into(),
            },
            Command::Cancel,
        )
        .await
        .unwrap();
    let cancelled = fixture.service.task(TASK).await.unwrap();
    assert_eq!(cancelled.task.phase(), Phase::Cancelled);
    fixture
        .service
        .host
        .fixture_held_shell(&json!({"kind":"snapshot","snapshot":{
            "snapshotSequence":1,"projects":[{"id":HOST_PROJECT,"workspaceRoot":fixture.service.fixture().checkout}],"threads":[],
            "archivedThreads":fixture.archived_threads(&cancelled.task)
        }}));
    let draft = fixture.checkout.join("draft");
    std::fs::write(&draft, "unpublished").unwrap();
    assert!(matches!(
        fixture.service.archive_done(&cancelled).await,
        Err(ServiceError::CheckoutRetained(_))
    ));
    assert_eq!(std::fs::read_to_string(&draft).unwrap(), "unpublished");
    std::fs::remove_file(draft).unwrap();
    *fixture.published.lock().unwrap() = None;
    assert!(matches!(
        fixture.service.archive_done(&cancelled).await,
        Err(ServiceError::CheckoutRetained(_))
    ));
    assert!(fixture.checkout.is_dir());
    *fixture.published.lock().unwrap() = Some(fixture.head.clone());
    assert_eq!(
        fixture.service.archive_done(&cancelled).await.unwrap(),
        Action::Nothing
    );
    assert!(!fixture.checkout.exists());
}

#[tokio::test]
async fn revised_report_opens_its_own_planner_notice() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let first = fixture.reserve().await;
    let original = fixture.write(&first, 1, "initial qualification").await;
    let original = ReportTurn::report(&original["artifact"], &fixture.head);
    let ready = fixture.deliver(&first, &original).await;
    fixture.notices.lock().unwrap().next_reply = NoticeReply::Lost;
    assert!(matches!(
        fixture.notice_pass().await,
        Err(ServiceError::Host(_))
    ));
    let spent = fixture.service.task(TASK).await.unwrap();
    assert!(spent.version > ready.version);
    fixture.report(&first, &original).await;
    assert_eq!(fixture.service.task(TASK).await.unwrap(), spent);

    let same = fixture.revise("Recheck the existing qualification").await;
    fixture.report(&first, &original).await;
    let mut same_artifact = original.clone();
    same_artifact["report_ready"]["summary"] = json!("Rechecked existing evidence.");
    let same = fixture.deliver(&same, &same_artifact).await;
    assert!(same.task.report_task().unwrap().notice_attempted);
    assert_eq!(
        fixture.service.notify_report_ready(&same).await.unwrap(),
        Action::Nothing
    );
    assert_eq!(fixture.notices.lock().unwrap().sends.len(), 1);

    let revision = fixture.revise("Update the qualification").await;
    let changed = fixture.write(&revision, 2, "revised qualification").await;
    let revised = ReportTurn::report(&changed["artifact"], &fixture.head);
    let revised_ready = fixture.deliver(&revision, &revised).await;
    fixture.report(&first, &original).await;
    fixture.report(&revision, &revised).await;
    assert_eq!(fixture.service.task(TASK).await.unwrap(), revised_ready);
    assert!(
        !revised_ready.task.report_task().unwrap().notice_attempted,
        "a changed, authenticated lane artifact must open a new planner notice"
    );
    fixture.service.host.wait_for_requests().await;
    assert_eq!(fixture.notice_pass().await.unwrap(), Action::Nothing);
    let messages = &fixture.notices.lock().unwrap().sends;
    assert_eq!(messages.len(), 2);
    assert_ne!(messages[0]["commandId"], messages[1]["commandId"]);
    assert!(messages[0]["text"].as_str().unwrap().contains("qa v2"));
    assert!(messages[1]["text"].as_str().unwrap().contains("qa v3"));
}

#[tokio::test]
async fn revised_report_gets_its_own_exact_rejection_retry() {
    let fixture = ReportFixture::new().await;
    fixture.admit().await;
    let first = fixture.reserve().await;
    let original = fixture.write(&first, 1, "initial qualification").await;
    let original = ReportTurn::report(&original["artifact"], &fixture.head);
    fixture.deliver(&first, &original).await;
    assert_eq!(
        fixture.reject_notice().await,
        Action::Wait(WaitReason::Question)
    );
    assert_eq!(fixture.reject_notice().await, Action::Nothing);

    let revision = fixture.revise("Update the qualification").await;
    let changed = fixture.write(&revision, 2, "revised qualification").await;
    let revised = ReportTurn::report(&changed["artifact"], &fixture.head);
    fixture.deliver(&revision, &revised).await;
    assert_eq!(
        fixture.reject_notice().await,
        Action::Wait(WaitReason::Question)
    );

    let same = fixture.revise("Recheck the revised qualification").await;
    fixture.deliver(&same, &revised).await;
    assert_eq!(fixture.reject_notice().await, Action::Nothing);
    let spent = fixture.service.task(TASK).await.unwrap();
    assert!(spent.task.report_task().unwrap().notice_attempted);
    fixture.report(&same, &revised).await;
    assert_eq!(fixture.service.task(TASK).await.unwrap(), spent);
    assert_eq!(
        fixture.service.notify_report_ready(&spent).await.unwrap(),
        Action::Nothing
    );

    let notices = fixture.notices.lock().unwrap();
    let [original, original_retry, revised, revised_retry] = notices.sends.as_slice() else {
        panic!("each artifact gets one attempt and one retry");
    };
    assert_eq!(original["text"], original_retry["text"]);
    assert_eq!(revised["text"], revised_retry["text"]);
    assert_ne!(original["text"], revised["text"]);
    let commands: std::collections::BTreeSet<_> = notices
        .sends
        .iter()
        .map(|send| send["commandId"].as_str().unwrap())
        .collect();
    assert_eq!(commands.len(), 4);
}

struct ReportFixture {
    _home: tempfile::TempDir,
    service: Arc<Service>,
    api: Router,
    head: Head,
    published: Arc<Mutex<Option<Head>>>,
    open_pr: Arc<AtomicBool>,
    notices: Arc<Mutex<NoticeFixture>>,
    checkout: std::path::PathBuf,
    forge: tokio::task::JoinHandle<()>,
    host: tokio::task::JoinHandle<()>,
}

impl ReportFixture {
    fn archived_threads(&self, task: &Task) -> Vec<Value> {
        archived_checkout_rows(
            &Binding {
                project_id: HOST_PROJECT.into(),
                worktree_path: self.checkout.to_str().unwrap().into(),
                branch: format!("ns-{TASK}"),
            },
            task,
        )
    }

    fn idle_worker(&self) -> Value {
        json!({"id":WORKER,"projectId":HOST_PROJECT,"worktreePath":self.checkout,
            "branch":format!("ns-{TASK}"),"status":"completed","latestRunId":"native-run",
            "activeRunId":null,"pendingRuntimeRequest":null})
    }

    fn observe_worker(&self, row: &Value) {
        self.service.host.fixture_held_shell(&json!({
            "kind":"snapshot","snapshot":{"projects":[{"id":HOST_PROJECT,"workspaceRoot":self.service.fixture().checkout}],"threads":[row],"snapshotSequence":9}
        }));
    }

    #[expect(
        clippy::too_many_lines,
        reason = "one fixture trace covers a complete lifecycle"
    )]
    async fn new() -> Self {
        let (home, mut service) = fixture(GitHub::new("fixture").expect("forge"));
        let head = service.fixture().start.clone();
        let published = Arc::new(Mutex::new(Some(head.clone())));
        let open_pr = Arc::new(AtomicBool::new(false));
        let origin = Arc::clone(&published);
        let branch = Arc::clone(&published);
        let prs = Arc::clone(&open_pr);
        let (forge, forge_server) = serve_forge(Router::new()
            .route(&format!("/repos/{REPOSITORY}/branches/main"), get(move || async move {
                Json(json!({"name":"main","commit":{"sha":branch.lock().expect("branch").as_ref()}}))
            }))
            .route(&format!("/repos/{REPOSITORY}/branches"), get(move || async move {
                let remote = origin.lock().expect("origin");
                Json(remote.iter().map(|head| json!({"name":"main","commit":{"sha":head}})).collect::<Vec<_>>())
            }))
            .route("/graphql", post(move |Json(request): Json<Value>| async move {
                assert_eq!(request["variables"]["head"], format!("ns-{TASK}"));
                assert!(request["query"].as_str().expect("query").contains("headRefName:$head,states:OPEN"));
                Json(json!({"data":{"repository":{"pullRequests":{"totalCount":u8::from(prs.load(Ordering::Relaxed))}}}}))
            }))
        ).await;
        service.forge = forge;

        let checkout = nucleus_work::checkout_path(service.storage.work().path(), REPOSITORY, TASK);
        let root = service.fixture().checkout.clone();
        let path = checkout.clone();
        let notices = Arc::new(Mutex::new(NoticeFixture::default()));
        let deliveries = Arc::clone(&notices);
        let (host, host_server) = native_fixture(move |request| {
            let planner = json!({"id":PLANNER,"projectId":HOST_PROJECT,"updatedAt":"2026-11-23T18:10:00Z"});
            let snapshot = match request["tag"].as_str() {
                Some("orchestration.subscribeShell") => json!({"kind":"snapshot","snapshot":{
                    "projects":[{"id":HOST_PROJECT,"workspaceRoot":root}], "threads":[planner],
                }}),
                Some("orchestration.subscribeThread") if request["payload"]["threadId"] == PLANNER => {
                    json!({"kind":"snapshot","snapshotSequence":1,"projection":{
                        "thread":planner, "runs":[], "messages":[],
                    }})
                }
                Some("orchestration.subscribeThread") => {
                    assert_eq!(request["payload"]["threadId"], WORKER);
                    json!({"kind":"snapshot","snapshotSequence":1,"projection":{
                    "thread":{"id":WORKER,"projectId":HOST_PROJECT,"worktreePath":path,"branch":format!("ns-{TASK}")},
                    "runs":[],"messages":[],"runtimeRequests":[],"providerThreads":[],"turnItems":[],"subagents":[]
                    }})
                }
                Some("orchestration.dispatchCommand") => return deliveries.lock().unwrap().dispatch(request),
                Some("orchestration.getArchivedShellSnapshot") => return archive_snapshot_reply(request, 2, &[]),
                _ => panic!("unexpected fixture request {request}"),
            };
            json!({"_tag":"Chunk","requestId":request["id"],"values":[snapshot,{"kind":"synchronized"}]})
        }).await;
        // The fixture owns all task threads. Its wire snapshots control their activity
        // independently of unrelated processes on the test machine.
        service.host = host.with_quiet_fixture_processes();
        service.host.fixture_project_shell(&json!({"projects":[{"id":HOST_PROJECT,"workspaceRoot":service.fixture().checkout}], "threads":[]}), "fixture-acp");
        let service = Arc::new(service);
        let enrollment = crate::router_with_t3_callers(Arc::clone(&service), [], Some(PLANNER_KEY));
        let request = enrollment.oneshot(
            Request::get("/v1/tasks")
                .header("host", LOCAL_HOST)
                .header(
                    "authorization",
                    format!("Bearer {}", hex::encode(PLANNER_KEY)),
                )
                .header("x-nucleus-t3-caller", PLANNER)
                .body(Body::empty())
                .unwrap(),
        );
        tokio::pin!(request);
        tokio::select! {
            biased;
            () = service.enrollment_wake.notified() => {}
            _ = &mut request => panic!("planner request finished before enrollment"),
        }
        assert_eq!(service.take_enrollment().await.as_deref(), Some(PLANNER));
        service.complete_enrollment(PLANNER).await;
        assert_eq!(request.await.unwrap().status(), StatusCode::OK);
        let api = router(
            Arc::clone(&service),
            [Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            }],
        );
        for key in ["qa", "notes"] {
            let response = put_as(
                &api,
                &format!("/v1/planning/{PROJECT}/lanes/{key}"),
                &BOARD_KEY,
                &json!({
                    "version":0, "title":key, "aim":"qualification", "document":"initial",
                }),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        Self {
            _home: home,
            service,
            api,
            head,
            published,
            open_pr,
            notices,
            checkout,
            forge: forge_server,
            host: host_server,
        }
    }

    async fn admit(&self) {
        let response = post_as(
            &self.api,
            &format!("/v1/planning/{PROJECT}/tasks"),
            &BOARD_KEY,
            &json!({
                "id": TASK, "brief": BRIEF, "planningCommit": self.head,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    async fn reserve(&self) -> ReportTurn {
        let prior = self.service.task(TASK).await.expect("task");
        let mut task = prior.task.clone();
        let worktrees = self.service.worktrees();
        let checkout = worktrees
            .checkout(&self.service.fixture().checkout, REPOSITORY, TASK)
            .expect("checkout");
        assert_eq!(
            checkout.allocate(&self.head).expect("worktree"),
            Workspace::Clean(self.head.clone())
        );
        let observation = Observation {
            host: task
                .threads()
                .get(Role::Worker)
                .map_or(Observed::Unknown, |thread| {
                    Observed::Known(Host::Retained {
                        thread: thread.into(),
                        state: RetainedThread::Queueable,
                    })
                }),
            forge: Observed::Unknown,
            workspace: Observed::Known(Workspace::Clean(self.head.clone())),
        };
        if task.phase() == Phase::Queued {
            assert_eq!(
                task.reconcile(&observation),
                Action::Advance(Phase::Working)
            );
        }
        let row = nucleus_store::TaskRow {
            task: task.clone(),
            version: prior.version,
            number: prior.number,
        };
        let instance = task.next_launch_instance().expect("run identity");
        let prompt = crate::prompt::Prompt {
            row: &row,
            role: Role::Worker,
            via: &nucleus_core::Launch::Create,
            replaced_thread: None,
            instance: &instance,
            checkout: checkout.path(),
            scratch: std::path::Path::new("/scratch/run"),
            branch: checkout.branch(),
            checkout_head: Some(&self.head),
            pr: None,
            pr_description: None,
            discovered_skill: None,
            model: "fixture",
            shared_model: None,
            lanes: &crate::prompt::LaneContext::default(),
            dependencies: &crate::DependencyStatus::default(),
            command: std::path::Path::new("/engine"),
            ticket: std::path::Path::new("/scratch/ticket"),
        }
        .render()
        .text;
        assert!(prompt.contains("Report-only delivery"));
        assert!(prompt.contains("lane.put 'fixture-product' 'qa' VERSION --ticket"));
        assert!(prompt.contains("report_ready"));
        assert!(!prompt.contains("Ready for review"));
        if let Some(instruction) = task
            .report_task()
            .and_then(|report| report.instruction.as_deref())
        {
            assert!(prompt.contains(instruction));
        }
        let credential = task
            .reserve_grouped_launch(
                &observation,
                LaunchInputs {
                    scratch: None,
                    thread: WORKER.into(),
                    started_at: 1,
                    input: prompt,
                },
                &[42; 32],
                None,
                "fixture-group".into(),
            )
            .expect("worker launch");
        let instance = task.run().expect("run").launch().instance.clone();
        task.record_send(&instance, 2).expect("send recorded");
        self.service
            .save(&prior, task, &event("fixture_run"))
            .await
            .expect("save run");
        ReportTurn {
            instance,
            credential,
        }
    }

    async fn settle(&self, turn: &ReportTurn) -> nucleus_store::TaskRow {
        let prior = self.service.task(TASK).await.expect("reported");
        let observation = Observation {
            host: Observed::Known(Host::Current {
                instance: turn.instance.clone(),
                state: RunState::Ended,
            }),
            forge: Observed::Unknown,
            workspace: Observed::Known(Workspace::Clean(self.head.clone())),
        };
        assert_eq!(
            self.service
                .apply(&prior, &observation, Action::Advance(Phase::ReportReady))
                .await
                .expect("settle report"),
            Action::Advance(Phase::ReportReady)
        );
        let settled = self.service.task(TASK).await.expect("report ready");
        assert_eq!(settled.task.phase(), Phase::ReportReady);
        settled
    }

    async fn report(&self, turn: &ReportTurn, report: &Value) {
        assert_eq!(
            post_json(&self.api, &turn.callback(), turn.key(), report).await,
            StatusCode::NO_CONTENT
        );
    }

    async fn deliver(&self, turn: &ReportTurn, report: &Value) -> nucleus_store::TaskRow {
        self.report(turn, report).await;
        self.settle(turn).await
    }

    async fn revise(&self, instruction: &str) -> ReportTurn {
        assert_eq!(
            self.command(json!({"move_work":{"instruction":instruction}}))
                .await
                .status(),
            StatusCode::OK
        );
        self.reserve().await
    }

    async fn notice_pass(&self) -> Result<Action, ServiceError> {
        assert!(
            self.service
                .state
                .lock()
                .await
                .schedule
                .due(TASK)
                .is_some_and(|due| due <= tokio::time::Instant::now()),
            "settling or reopening the report schedules its notice"
        );
        self.service
            .pass()
            .await
            .expect("scheduler pass")
            .into_iter()
            .find(|outcome| outcome.task == TASK)
            .expect("the scheduler processed the report")
            .result
    }

    async fn reject_notice(&self) -> Action {
        self.notices.lock().unwrap().next_reply = NoticeReply::Rejected;
        self.notice_pass().await.expect("exact native rejection")
    }

    async fn write(&self, turn: &ReportTurn, version: u64, document: &str) -> Value {
        let response = put_as(
            &self.api,
            &turn.lane("qa"),
            turn.key(),
            &json!({"version":version,"document":document}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        json_body(response).await
    }

    async fn planner_write(&self, document: &str, version: u64) {
        let response = put_as(
            &self.api,
            &format!("/v1/planning/{PROJECT}/lanes/qa"),
            &BOARD_KEY,
            &json!({
                "version":version, "title":"qa", "aim":"qualification", "document":document,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    async fn command(&self, command: Value) -> Response {
        post_as(
            &self.api,
            &format!("/v1/tasks/{TASK}/commands"),
            &BOARD_KEY,
            &command,
        )
        .await
    }
}

impl Drop for ReportFixture {
    fn drop(&mut self) {
        self.forge.abort();
        self.host.abort();
    }
}

struct ReportTurn {
    instance: String,
    credential: CallbackCredential,
}

impl ReportTurn {
    fn key(&self) -> &[u8; 32] {
        self.credential.as_bytes()
    }

    fn callback(&self) -> String {
        format!("/v1/runs/{TASK}/{}/report", self.instance)
    }

    fn lane(&self, key: &str) -> String {
        format!("/v1/runs/{TASK}/{}/lanes/{PROJECT}/{key}", self.instance)
    }

    fn report(artifact: &Value, head: &Head) -> Value {
        json!({"report_ready":{"artifact":artifact,"summary":"Qualification settled.","head":head}})
    }
}
