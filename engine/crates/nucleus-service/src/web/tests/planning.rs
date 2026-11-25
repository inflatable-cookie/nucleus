use super::*;

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
    assert_eq!(
        get_as(&api, "/v1/planning/other/plan", &PLANNER_KEY)
            .await
            .status(),
        StatusCode::BAD_REQUEST
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

#[tokio::test]
async fn review_entry_admission_retires_acceptance_when_the_exact_head_changes() {
    let head: nucleus_core::Head = "a".repeat(40).parse().expect("first head");
    let replacement: nucleus_core::Head = "b".repeat(40).parse().expect("new head");
    let latest = Arc::new(AtomicBool::new(false));
    let changed = Arc::clone(&latest);
    let reads = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&reads);
    let moved = replacement.clone();
    let first = head.clone();
    let (forge, server) = serve_forge(Router::new().route(
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
    ))
    .await;
    let (_home, service) = fixture(forge);
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
}
