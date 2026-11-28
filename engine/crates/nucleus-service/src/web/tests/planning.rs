use super::*;
use crate::tests::registry_fixture;

const PROJECT: &str = "/v1/planning/local-fixture";

pub(super) async fn put_as(api: &Router, path: &str, key: &[u8; 32], body: &Value) -> Response {
    api.clone()
        .oneshot(
            Request::put(path)
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
async fn dropped_items_keep_the_disposition_and_note_on_readback() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let api = router(
        Arc::new(service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let items = format!("{PROJECT}/items");
    for disposition in [Some("completed"), Some("deprecated"), None] {
        let created = json_body(
            post_as(
                &api,
                &items,
                &PLANNER_KEY,
                &json!({
                    "kind":"papercut","title":"Review defaults","body":"A stored item."
                }),
            )
            .await,
        )
        .await;
        let id = created["id"].as_str().unwrap();
        let mut wire = json!({"reason":"Reviewed on main."});
        if let Some(value) = disposition {
            wire["disposition"] = json!(value);
        }
        let response = post_as(&api, &format!("{items}/{id}/drop"), &PLANNER_KEY, &wire).await;
        assert_eq!(response.status(), StatusCode::OK);
        let listed = json_body(get_as(&api, &items, &PLANNER_KEY).await).await;
        let row = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == id)
            .unwrap();
        assert_eq!(row["state"], "dropped");
        assert_eq!(row["disposition"], disposition.unwrap_or("deprecated"));
        assert_eq!(row["reason"], wire["reason"]);
    }
    let historical = json!({"state":"dropped","reason":"Original note"});
    let restored: nucleus_store::planning::ItemState = serde_json::from_value(historical).unwrap();
    assert_eq!(json!(restored)["disposition"], "deprecated");
}

#[tokio::test]
async fn a_lead_promotes_at_the_version_seen_and_keeps_a_chosen_level_only_with_its_task() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let api = router(
        Arc::new(service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let items = format!("{PROJECT}/items");
    let body = "---\ntitle: Lead brief\nqueue:\n  complexity: high\n---\nShip it.\n";
    let add = |title: &str| json!({"kind":"lead","title":title,"body":body});
    let lead = json_body(post_as(&api, &items, &PLANNER_KEY, &add("Lead")).await).await;
    let id = lead["id"].as_str().expect("lead ID").to_owned();
    let version = |api: Router, id: String| async move {
        let history =
            json_body(get_as(&api, &format!("{PROJECT}/history/item/{id}"), &PLANNER_KEY).await)
                .await;
        history.as_array().expect("history").last().expect("entry")["sequence"]
            .as_i64()
            .expect("sequence")
    };
    let row = |listed: &Value, id: &str| {
        listed
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item["id"] == id)
            .expect("item")
            .clone()
    };
    let seen = version(api.clone(), id.clone()).await;
    let promote = format!("{items}/{id}/promote");

    // A view older than the item is refused, and the lead keeps its brief.
    let stale = json!({"complexity":"low","version":seen - 1});
    let refused = post_as(&api, &promote, &PLANNER_KEY, &stale).await;
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    // An admission refusal (an unknown repository) leaves the brief as filed too.
    let elsewhere = json!({"complexity":"low","version":seen,"repository":"example/missing"});
    let refused = post_as(&api, &promote, &PLANNER_KEY, &elsewhere).await;
    assert!(refused.status().is_client_error(), "{}", refused.status());
    let listed = json_body(get_as(&api, &items, &PLANNER_KEY).await).await;
    assert_eq!(row(&listed, &id)["body"], body);
    assert_eq!(row(&listed, &id)["state"], "open");
    assert_eq!(version(api.clone(), id.clone()).await, seen);

    // At the version seen, the chosen level is admitted and saved with the promotion.
    let chosen = json!({"complexity":"low","version":seen});
    let admitted = post_as(&api, &promote, &PLANNER_KEY, &chosen).await;
    assert_eq!(admitted.status(), StatusCode::CREATED);
    let task_id = json_body(admitted).await["identity"]["id"]
        .as_str()
        .expect("task ID")
        .to_owned();
    let task = json_body(get_as(&api, &format!("/v1/tasks/{task_id}"), &PLANNER_KEY).await).await;
    let brief = task["brief"]["text"].as_str().expect("brief").to_owned();
    assert!(brief.contains("complexity: low"), "{brief}");
    assert!(brief.contains("title: Lead brief"), "{brief}");
    assert!(brief.ends_with("Ship it.\n"), "{brief}");
    let listed = json_body(get_as(&api, &items, &PLANNER_KEY).await).await;
    assert_eq!(row(&listed, &id)["body"], brief);
    assert_eq!(row(&listed, &id)["state"], "promoted");

    // The level the brief already declares leaves the brief byte for byte.
    let same = json_body(post_as(&api, &items, &PLANNER_KEY, &add("Same")).await).await;
    let same_id = same["id"].as_str().expect("lead ID");
    let request = json!({"complexity":"high"});
    let admitted = post_as(
        &api,
        &format!("{items}/{same_id}/promote"),
        &PLANNER_KEY,
        &request,
    )
    .await;
    assert_eq!(admitted.status(), StatusCode::CREATED);
    let task_id = json_body(admitted).await["identity"]["id"]
        .as_str()
        .expect("task ID")
        .to_owned();
    let task = json_body(get_as(&api, &format!("/v1/tasks/{task_id}"), &PLANNER_KEY).await).await;
    assert_eq!(task["brief"]["text"], body);
    let listed = json_body(get_as(&api, &items, &PLANNER_KEY).await).await;
    assert_eq!(row(&listed, same_id)["body"], body);
}

#[tokio::test]
async fn board_lane_dispositions_survive_native_validation_and_readback() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let api = router(
        Arc::new(service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let path = format!("{PROJECT}/lanes/Delivery_Q4");
    let status = format!("{path}/status");
    let doc = json!({"version":0, "title":"Delivery", "aim":"Ship", "document":"Release"});
    assert_eq!(
        put_as(&api, &path, &PLANNER_KEY, &doc).await.status(),
        StatusCode::OK
    );
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/lane-dispositions.json"
    ))
    .unwrap();
    for wire in cases {
        let response = post_as(&api, &status, &PLANNER_KEY, &wire).await;
        assert_eq!(response.status(), StatusCode::OK);
        let plan = json_body(get_as(&api, &format!("{PROJECT}/plan"), &PLANNER_KEY).await).await;
        let lane = &plan["documents"][0];
        assert_eq!(lane["status"], wire["status"]);
        assert_eq!(lane["note"], wire["note"]);
    }
}

#[tokio::test]
async fn planning_routes_fence_document_versions_and_admit_tasks_without_host_io() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let api = router(
        Arc::new(service),
        [
            planner_controller(PLANNER_KEY, "planner"),
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
        ],
    );

    let plan = format!("{PROJECT}/plan");
    let lane = format!("{PROJECT}/lanes/ui");
    let response = get_as(&api, &plan, &PLANNER_KEY).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["idle"], true);
    let unknown = get_as(&api, "/v1/planning/other/plan", &PLANNER_KEY).await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        json_body(unknown).await["error"],
        ServiceError::TellUnknownProject("other".into()).to_string()
    );
    assert_eq!(
        get_as(&api, &plan, &[0; 32]).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let doc = json!({"version":0,"title":"UI","aim":"Simplify the board","document":"## Board"});
    assert_eq!(
        json_body(put_as(&api, &lane, &PLANNER_KEY, &doc).await).await["version"],
        1
    );
    assert_eq!(
        put_as(&api, &lane, &PLANNER_KEY, &doc).await.status(),
        StatusCode::CONFLICT
    );
    let result = json_body(
        post_as(
            &api,
            &format!("{lane}/status"),
            &PLANNER_KEY,
            &json!({"status":"done", "note":"Landed."}),
        )
        .await,
    )
    .await;
    assert_eq!(result["version"], 1);
    assert_eq!(result["status"], "done");

    let updated = json!({"version":0,"lanes":[{"key":"ui","horizon":"now","doneWhen":"Stable","statusNote":"Ready"}]});
    assert_eq!(
        put_as(&api, &plan, &PLANNER_KEY, &updated).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        put_as(&api, &plan, &PLANNER_KEY, &updated).await.status(),
        StatusCode::CONFLICT
    );
    let response = json_body(get_as(&api, &plan, &PLANNER_KEY).await).await;
    assert_eq!(response["idle"], false);
    assert_eq!(response["documents"][0]["note"], "Landed.");

    let brief = "---\ntitle: From planning\n---\nAdd a fixture.";
    let items = format!("{PROJECT}/items");
    let item = json_body(post_as(&api, &items, &PLANNER_KEY, &json!({
        "kind":"papercut","title":"Add a fixture","body":brief,"lanes":["ui"],"author":"spoofed"
    })).await).await;
    assert_eq!(item["author"], "planner");
    let id = item["id"].as_str().expect("item ID");
    let promote = format!("{items}/{id}/promote");
    let missing = post_as(&api, &promote, &PLANNER_KEY, &json!({})).await;
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    let first = post_as(&api, &promote, &PLANNER_KEY, &json!({"complexity":"low"})).await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let admitted = json_body(first).await;
    assert_eq!(admitted["number"], 1);
    assert_eq!(admitted["reference"], "nucleus-fixture#1");
    let repeated = post_as(&api, &promote, &PLANNER_KEY, &json!({})).await;
    assert_eq!(repeated.status(), StatusCode::OK);
    assert_eq!(json_body(repeated).await["identity"], admitted["identity"]);
    let task_id = admitted["identity"]["id"].as_str().expect("task ID");
    let task = json_body(get_as(&api, &format!("/v1/tasks/{task_id}"), &PLANNER_KEY).await).await;
    assert_eq!(
        task["source"],
        json!({"projectId":"local-fixture","itemId":id})
    );
    let promoted = task["brief"]["text"].as_str().unwrap();
    assert!(promoted.contains("title: From planning"));
    assert!(promoted.contains("complexity: low"));
    assert!(promoted.ends_with("Add a fixture."));
    let source = json_body(get_as(&api, &items, &PLANNER_KEY).await).await;
    assert_eq!(source[0]["body"], brief);
    assert_eq!(task["reference"], "nucleus-fixture#1");
    assert_eq!(task["identity"]["reference"], task_id);
    assert_eq!(task["identity"]["origin_thread"], "planner");

    assert_direct_admission_numbers(&api).await;
}

async fn assert_direct_admission_numbers(api: &Router) {
    let missing = post_as(
        api,
        &format!("{PROJECT}/tasks"),
        &PLANNER_KEY,
        &json!({"brief":"A plain brief."}),
    )
    .await;
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    assert!(
        json_body(missing).await["error"]
            .as_str()
            .unwrap()
            .starts_with("queue.complexity is required")
    );
    let direct = post_as(
        api,
        &format!("{PROJECT}/tasks"),
        &PLANNER_KEY,
        &json!({"brief":"---\nqueue:\n  complexity: low\n---\nA fixture brief."}),
    )
    .await;
    assert_eq!(direct.status(), StatusCode::CREATED);
    assert_eq!(json_body(direct).await["number"], 2);
    let legacy = post_as(
        api,
        "/v1/tasks",
        &PLANNER_KEY,
        &json!({
            "id":"legacy-admission","reference":"legacy-alias","brief":"---\nqueue:\n  complexity: low\n---\nAn existing CLI admission."
        }),
    )
    .await;
    assert_eq!(legacy.status(), StatusCode::CREATED);
    let legacy = json_body(legacy).await;
    assert_eq!(legacy["number"], 3);
    assert_eq!(legacy["reference"], "nucleus-fixture#3");
    assert_eq!(legacy["identity"]["reference"], "legacy-alias");
    let tasks = json_body(get_as(api, "/v1/tasks", &PLANNER_KEY).await).await;
    assert_eq!(tasks.as_array().expect("task summaries").len(), 3);
}

async fn recover_rewritten_source(service: &Service, api: &Router, restored: &AtomicBool) {
    service.pass().await.expect("observe source mismatch");
    let card = json_body(get_as(api, "/v1/tasks/external", &BOARD_KEY).await).await;
    assert_eq!(card["wait"], "external_merge_blocked");
    assert_eq!(card["attention"], "attention");
    assert_eq!(
        card["waitDetail"],
        "the merged pull request source could not be verified against the task’s recorded head. Use Recheck after the repair."
    );
    assert!(card["nextCheckAt"].is_null());
    restored.store(true, Ordering::Relaxed);
    let owner = Authority::Operator {
        actor: "operator".into(),
    };
    service
        .command("external", &owner, Command::Hold("Source checked".into()))
        .await
        .unwrap();
    service
        .command("external", &owner, Command::Release)
        .await
        .unwrap();
}

fn external_review_forge(
    head: &nucleus_core::Head,
    replacement: &nucleus_core::Head,
    latest: Arc<AtomicBool>,
    restored: Arc<AtomicBool>,
    calls: Arc<AtomicUsize>,
) -> Router {
    let remote = restored;
    let original = head.clone();
    let descendant = replacement.clone();
    let changed = latest;
    let moved = replacement.clone();
    let first = head.clone();
    Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/git/ref/pull/1/head"),
            get(move || async move {
                let sha = if remote.load(Ordering::Relaxed) {
                    descendant
                } else {
                    original
                };
                Json(json!({"ref":"refs/pull/1/head","object":{"type":"commit","sha":sha}}))
            }),
        )
        .route(
            &format!("/repos/{REPOSITORY}/compare/{head}...{replacement}"),
            get(|| async { Json(json!({"status":"ahead"})) }),
        )
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1"),
            get(move || {
                calls.fetch_add(1, Ordering::Relaxed);
                let seen = if changed.load(Ordering::Relaxed) {
                    &moved
                } else {
                    &first
                };
                let mut pull = forge_pull(seen);
                pull["head"]["ref"] = json!("existing-topic");
                pull["merged"] = json!(true);
                pull["state"] = json!("closed");
                pull["merge_commit_sha"] = json!("f".repeat(40));
                std::future::ready(Json(pull))
            }),
        )
        .route(
            &format!("/repos/{REPOSITORY}/branches/main"),
            get(|| async { Json(json!({"name":"main","commit":{"sha":"f".repeat(40)}})) }),
        )
}

#[tokio::test]
async fn review_entry_admission_retires_acceptance_when_the_exact_head_changes() {
    let (_home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let head = service.fixture().start.clone();
    let replacement: nucleus_core::Head = "b".repeat(40).parse().unwrap();
    let restored = Arc::new(AtomicBool::new(false));
    let latest = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicUsize::new(0));
    let app = external_review_forge(
        &head,
        &replacement,
        latest.clone(),
        restored.clone(),
        reads.clone(),
    );
    let (forge, server) = serve_forge(app).await;
    service.forge = forge;
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator".into(),
            },
        }],
    );
    let path = format!("{PROJECT}/tasks");
    let input = json!({
        "id":"external",
        "brief":"---\nqueue:\n  complexity: low\n---\nReview the existing fixture change.",
        "review":{"url":PR,"head":head},
    });
    let admitted = post_as(&api, &path, &BOARD_KEY, &input).await;
    assert_eq!(admitted.status(), StatusCode::CREATED);
    assert_eq!(
        json_body(admitted).await["identity"]["entry"],
        "review_entry"
    );
    assert_eq!(reads.load(Ordering::Relaxed), 0);

    let _ = service.pass().await.expect("observe admitted PR");
    let asked = service.task("external").await.expect("task");
    assert_eq!(
        asked.task.question(),
        Some(&Question::Accept { head: head.clone() })
    );
    latest.store(true, Ordering::Relaxed);
    {
        let mut state = service.state.lock().await;
        service.wake_task(
            &mut state,
            "external",
            asked.version,
            crate::schedule::Priority::Wake,
        );
    }
    recover_rewritten_source(&service, &api, &restored).await;
    let _ = service.pass().await.expect("observe replacement head");
    let row = service.task("external").await.expect("reconciled task");
    assert_eq!(row.task.pull_request().expect("PR").head, replacement);
    assert_eq!(row.task.question(), None);
    assert_eq!(
        post_json(
            &api,
            "/v1/tasks/external/commands",
            &BOARD_KEY,
            &json!({"answer":{"accept":{"head":head,"reason":"stale question"}}}),
        )
        .await,
        StatusCode::CONFLICT,
    );
    assert!(
        service
            .task("external")
            .await
            .expect("task")
            .task
            .verdict()
            .is_none()
    );
    server.abort();
}

#[tokio::test]
async fn planning_decision_history_identifies_authenticated_actors() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let api = router(
        Arc::new(service),
        [
            planner_controller(PLANNER_KEY, "planner"),
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
        ],
    );
    let decisions = format!("{PROJECT}/decisions");
    let duplicate = post_as(
        &api,
        &decisions,
        &PLANNER_KEY,
        &json!({
            "question":"Ship?", "options":[{"id":"yes","label":"Ship"},{"id":"no","label":" Ship "}]
        }),
    )
    .await;
    assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(duplicate).await["error"],
        "decision option labels must be distinct"
    );
    let added = post_as(
        &api,
        &decisions,
        &PLANNER_KEY,
        &json!({
            "question":"Ship?",
            "options":[{"id":"yes","label":"Ship"},{"id":"no","label":"Hold"},
                {"id":"revise","label":"Revise"},{"id":"wait","label":"Wait"}],
            "author":"spoofed"
        }),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let decision = json_body(added).await;
    assert_eq!(decision["author"], "planner");
    assert_eq!(decision["options"].as_array().unwrap().len(), 4);
    let id = decision["id"].as_str().expect("decision ID");
    let answer = format!("{decisions}/{id}/answer");
    assert_eq!(
        post_as(&api, &answer, &PLANNER_KEY, &json!({"optionId":"yes"}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post_as(&api, &answer, &BOARD_KEY, &json!({"optionId":"unknown"}))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    for option in ["yes", "no"] {
        let answered = json_body(
            post_as(
                &api,
                &answer,
                &BOARD_KEY,
                &json!({"optionId":option,"author":"spoofed"}),
            )
            .await,
        )
        .await;
        assert_eq!(answered["answer"]["author"], "operator");
        assert_eq!(answered["answer"]["optionId"], option);
    }
    let custom = json_body(
        post_as(
            &api,
            &answer,
            &BOARD_KEY,
            &json!({"answer":"Ship after checks", "basedOnOptionId":"yes"}),
        )
        .await,
    )
    .await;
    assert_eq!(custom["answer"]["answer"], "Ship after checks");
    assert_eq!(custom["answer"]["basedOnOptionId"], "yes");
    let pending = format!("{decisions}?pending=true");
    assert_eq!(
        json_body(get_as(&api, &pending, &BOARD_KEY).await).await,
        json!([])
    );
    let history = format!("{PROJECT}/history/decision/{id}");
    let history = json_body(get_as(&api, &history, &BOARD_KEY).await).await;
    assert_eq!(history[0]["actor"], "planner");
    assert_eq!(history[1]["snapshot"]["answer"]["optionId"], "yes");
    assert_eq!(history[2]["snapshot"]["answer"]["optionId"], "no");
    assert_eq!(
        history[3]["snapshot"]["answer"]["answer"],
        "Ship after checks"
    );
}

// Pause the real Git invocation after admission has released the state lock.
fn gated_git(service: &mut Service, home: &std::path::Path) -> Arc<crate::project::git_gate::Gate> {
    service.git = crate::project::LocalGit(home.to_path_buf());
    crate::project::git_gate::install(home.to_path_buf())
}

async fn wait_for_git(gate: &crate::project::git_gate::Gate, count: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while gate.entered.load(Ordering::SeqCst) < count {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Git consultations entered");
}

#[tokio::test]
async fn concurrent_promotions_return_one_task_and_publish_one_wake() {
    let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let gate = gated_git(&mut service, home.path());
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let items = format!("{PROJECT}/items");
    let item = json_body(
        post_as(
            &api,
            &items,
            &PLANNER_KEY,
            &json!({
                "kind":"papercut", "title":"Concurrent", "body":"A fixture."
            }),
        )
        .await,
    )
    .await;
    let path = format!("{items}/{}/promote", item["id"].as_str().unwrap());
    let mut changes = service.changes.subscribe();
    let request = |api: Router, path: String| {
        tokio::spawn(async move {
            post_as(&api, &path, &PLANNER_KEY, &json!({"complexity":"low"})).await
        })
    };
    let first = request(api.clone(), path.clone());
    let second = request(api.clone(), path);
    wait_for_git(&gate, 2).await;
    gate.release();
    let first = first.await.unwrap();
    let second = second.await.unwrap();
    assert!(matches!(
        (first.status(), second.status()),
        (StatusCode::CREATED, StatusCode::OK) | (StatusCode::OK, StatusCode::CREATED)
    ));
    let first = json_body(first).await;
    let second = json_body(second).await;
    assert_eq!(first["identity"], second["identity"]);
    assert_eq!(first["number"], second["number"]);
    assert_eq!(first["number"], 1);
    let change = changes.try_recv().expect("one admission wake");
    assert_eq!(change.task_id, first["identity"]["id"].as_str().unwrap());
    assert!(changes.try_recv().is_err());
    let state = service.state.lock().await;
    assert_eq!(state.capacity_waiters.len(), 1);
}

#[tokio::test]
async fn admission_rechecks_scope_after_git_consultation() {
    let (home, mut service) = fixture(GitHub::new("fixture").unwrap());
    let gate = gated_git(&mut service, home.path());
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let request = tokio::spawn(async move {
        post_as(
            &api,
            &format!("{PROJECT}/tasks"),
            &PLANNER_KEY,
            &json!({"brief":"---\nqueue:\n  complexity: low\n---\nA fixture."}),
        )
        .await
    });
    wait_for_git(&gate, 1).await;
    service.state.lock().await.settings.projects = Some(nucleus_store::Projects::default());
    gate.release();
    let response = request.await.unwrap();
    assert_ne!(response.status(), StatusCode::CREATED);
    let state = service.state.lock().await;
    assert!(state.capacity_waiters.is_empty());
}

#[tokio::test]
async fn reopen_items_preserves_history_and_rejects_stale_versions() {
    let (_home, service) = fixture(GitHub::new("fixture").unwrap());
    let api = router(
        Arc::new(service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let items = format!("{PROJECT}/items");
    for (action, body) in [
        ("park", json!({"reason":"Later", "revisitAt":"2026-01-01"})),
        ("drop", json!({"reason":"Done", "disposition":"completed"})),
    ] {
        let created = json_body(
            post_as(
                &api,
                &items,
                &PLANNER_KEY,
                &json!({"kind":"papercut", "title":action, "body":"Body"}),
            )
            .await,
        )
        .await;
        let id = created["id"].as_str().unwrap();
        let history =
            json_body(get_as(&api, &format!("{PROJECT}/history/item/{id}"), &PLANNER_KEY).await)
                .await;
        let version = history[0]["sequence"].as_i64().unwrap();
        assert_eq!(
            post_as(&api, &format!("{items}/{id}/{action}"), &PLANNER_KEY, &body)
                .await
                .status(),
            StatusCode::OK
        );
        let reopen = format!("{items}/{id}/reopen");
        assert_eq!(
            post_as(
                &api,
                &reopen,
                &PLANNER_KEY,
                &json!({"version":version, "note":"Again"})
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        let result =
            json_body(post_as(&api, &reopen, &PLANNER_KEY, &json!({"note":"Again"})).await).await;
        assert_eq!(result["state"], "open");
        let history =
            json_body(get_as(&api, &format!("{PROJECT}/history/item/{id}"), &PLANNER_KEY).await)
                .await;
        assert_eq!(result["version"], history[2]["sequence"]);
        assert_eq!(history[2]["snapshot"]["note"], "Again");
        let edit =
            json!({"version":result["version"], "title":"Updated", "body":"Body", "lanes":[]});
        assert_eq!(
            put_as(&api, &format!("{items}/{id}"), &PLANNER_KEY, &edit)
                .await
                .status(),
            StatusCode::OK
        );
        if action == "drop" {
            assert_eq!(history[1]["snapshot"]["disposition"], "completed");
        }
    }
}

async fn stored_label_fixture() -> (tempfile::TempDir, Service) {
    let (home, service) = registry_fixture(GitHub::new("fixture").expect("client"));
    service.host.fixture_project_shell(
        &json!({
            "projects": [{
                "id": "local-fixture",
                "workspaceRoot": service.fixture().checkout,
            }],
            "threads": [{"id":"named-thread", "title":"Longhorn filer"}],
            "archivedThreads": [{"id":"archived-thread", "title":"Archived collaborator"}],
        }),
        "fixture-acp",
    );
    let current = service.settings.read::<nucleus_store::Projects>().unwrap();
    let (updated, _) = service
        .settings
        .edit(
            &current.revision,
            |projects: &mut nucleus_store::Projects| {
                projects.projects.insert(
                    "local-fixture".into(),
                    nucleus_store::ProjectSettings {
                        planner_claim: None,
                        claimed_planner_threads: vec!["past-planner".into()],
                        name: "Longhorn".into(),
                        archived: false,
                        repositories: Vec::new(),
                    },
                );
                Ok(())
            },
        )
        .unwrap();
    service.state.lock().await.settings.projects = Some(updated.value);

    let rows = [
        ("past-planner", "past-planner", Some("local-fixture")),
        ("named-thread-item", "named-thread", None),
        ("archived-thread-item", "archived-thread", None),
        (
            "attested-operator-item",
            "operator via T3 Inbox (attested)",
            None,
        ),
        ("fixture-operator-item", "fixture-operator", None),
        ("unknown-item", "unknown-thread-id", None),
    ];
    {
        let mut state = service.state.lock().await;
        for (id, actor, author_project_id) in rows {
            state
                .store
                .add_item_with_author_project(
                    "local-fixture",
                    id.into(),
                    nucleus_store::planning::ItemKind::Papercut,
                    nucleus_store::planning::ItemContent {
                        title: id.into(),
                        body: "A real stored planning row.".into(),
                        lanes: Vec::new(),
                    },
                    author_project_id.map(str::to_owned),
                    nucleus_store::planning::WriteAt { actor, at_ms: 42 },
                )
                .expect("persist item and history row");
        }
    }

    (home, service)
}

#[tokio::test]
async fn paired_item_authors_and_actors_have_labels_from_stored_rows() {
    let (home, service) = stored_label_fixture().await;
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).expect("assets directory");
    std::fs::write(assets.join("index.html"), "<script src='/app.js'></script>")
        .expect("board HTML");
    std::fs::write(assets.join("app.js"), "document.title = 'Fixture Board';")
        .expect("board JavaScript");
    let api = router_with_board(
        Arc::new(service),
        [Controller {
            credential: BOARD_KEY,
            authority: Authority::Operator {
                actor: "operator via T3 Inbox (attested)".into(),
            },
        }],
        &assets,
    )
    .expect("paired board router");
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let listed = json_body(
        browser_request(
            &api,
            Method::GET,
            "/api/engine/planning/local-fixture/items",
            Some(&cookie),
            None,
        )
        .await,
    )
    .await;
    let author_labels = listed
        .as_array()
        .expect("stored item rows")
        .iter()
        .map(|row| {
            (
                row["id"].as_str().unwrap(),
                row["authorLabel"].as_str().unwrap(),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(author_labels["past-planner"], "Longhorn planner");
    assert_eq!(author_labels["named-thread-item"], "Longhorn filer");
    assert_eq!(
        author_labels["archived-thread-item"],
        "Archived collaborator"
    );
    assert_eq!(author_labels["attested-operator-item"], "Operator");
    assert_eq!(author_labels["fixture-operator-item"], "Operator");
    assert_eq!(author_labels["unknown-item"], "Agent thread");

    for (id, expected) in [
        ("past-planner", "Longhorn planner"),
        ("named-thread-item", "Longhorn filer"),
        ("archived-thread-item", "Archived collaborator"),
        ("attested-operator-item", "Operator"),
        ("fixture-operator-item", "Operator"),
        ("unknown-item", "Agent thread"),
    ] {
        let history = json_body(
            browser_request(
                &api,
                Method::GET,
                &format!("/api/engine/planning/local-fixture/history/item/{id}"),
                Some(&cookie),
                None,
            )
            .await,
        )
        .await;
        assert_eq!(history[0]["actorLabel"], expected, "{id}");
    }
}
