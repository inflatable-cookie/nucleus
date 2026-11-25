use nucleus_core::profiles::{BriefPolicy, Complexity};

use super::*;
use crate::MAX_BRIEF_BYTES;

pub(super) fn brief_with_bytes(size: usize) -> String {
    const HEADER: &str = "---\ntitle: Byte boundary\nqueue:\n  complexity: low\n---\n";
    // Backslashes expand in JSON, while this last character counts as two UTF-8 bytes.
    format!("{HEADER}{}é", "\\".repeat(size - HEADER.len() - "é".len()))
}

async fn assert_brief_size_refusal(response: Response, size: usize) {
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(response).await["error"],
        format!("brief is {size} UTF-8 bytes and exceeds the 65536-byte limit")
    );
}

async fn large_json(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), 4 * MAX_BRIEF_BYTES)
        .await
        .expect("brief response body");
    serde_json::from_slice(&bytes).expect("brief response JSON")
}

async fn assert_task_transport_limits(api: &Router, command_path: &str, exact: &str) {
    let hold = post_as(api, command_path, &BOARD_KEY, &json!({"hold": exact})).await;
    assert_eq!(hold.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(hold).await["error"], "invalid request");

    let text = "x".repeat(BRIEF_BODY_LIMIT);
    for (path, input) in [
        (command_path, json!({"amend": text})),
        (
            "/v1/tasks",
            json!({"id":"too-big", "reference":"too-big", "brief":text}),
        ),
    ] {
        let response = post_as(api, path, &BOARD_KEY, &input).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            json_body(response).await["error"],
            "request exceeds the 458752-byte brief JSON body limit"
        );
    }
}

#[tokio::test]
async fn task_add_and_explicit_amend_check_decoded_brief_bytes() {
    let (home, service) = fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let assets = home.path().join("board");
    std::fs::create_dir(&assets).expect("assets directory");
    std::fs::write(assets.join("index.html"), "<script src='/app.js'></script>").unwrap();
    std::fs::write(assets.join("app.js"), "document.title = 'Fixture Board';").unwrap();
    let api = router_with_board(
        Arc::clone(&service),
        [
            planner_controller(PLANNER_KEY, "planner"),
            Controller {
                credential: BOARD_KEY,
                authority: Authority::Operator {
                    actor: "operator".into(),
                },
            },
        ],
        &assets,
    )
    .expect("board router");
    let browser = pair_board(&api, &BOARD_KEY).await;
    let exact = brief_with_bytes(MAX_BRIEF_BYTES);
    let oversized = format!("{exact}x");

    let add = json!({"id":"boundary", "reference":"boundary", "brief":exact});
    assert!(add.to_string().len() > DEFAULT_BODY_LIMIT);
    assert_eq!(
        post_as(&api, "/v1/tasks", &PLANNER_KEY, &add)
            .await
            .status(),
        StatusCode::CREATED
    );
    let invalid = json!({"id":"too-big", "reference":"too-big", "brief":oversized});
    assert_brief_size_refusal(
        browser_request(
            &api,
            Method::POST,
            "/api/engine/tasks",
            Some(&browser),
            Some(&invalid),
        )
        .await,
        MAX_BRIEF_BYTES + 1,
    )
    .await;
    assert_brief_size_refusal(
        post_as(&api, "/v1/planning-current/tasks", &PLANNER_KEY, &invalid).await,
        MAX_BRIEF_BYTES + 1,
    )
    .await;
    assert!(matches!(
        service.task("too-big").await,
        Err(ServiceError::Missing)
    ));

    let (legacy, _, _) = reservation("legacy-large", Entry::Brief, &service.fixture().start);
    seed_task(
        &service,
        &Task::new(legacy.identity().clone(), oversized.clone(), None),
    )
    .await;
    let response = get_as(&api, "/v1/tasks/legacy-large", &PLANNER_KEY).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(large_json(response).await["brief"]["text"], oversized);
    let before = service.task("legacy-large").await.expect("stored task");

    let path = "/v1/tasks/legacy-large/commands";
    assert_brief_size_refusal(
        post_as(&api, path, &BOARD_KEY, &json!({"amend": oversized})).await,
        MAX_BRIEF_BYTES + 1,
    )
    .await;
    assert_task_transport_limits(&api, path, &exact).await;
    assert_eq!(service.task("legacy-large").await.unwrap(), before);

    let response = browser_request(
        &api,
        Method::POST,
        "/api/engine/tasks/legacy-large/commands",
        Some(&browser),
        Some(&json!({"amend": exact, "briefVersion": before.task.brief().version})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let updated = service
        .task("legacy-large")
        .await
        .expect("amended legacy task");
    assert_eq!(updated.version, before.version + 1);
    assert_eq!(updated.task.brief().text, exact);
    assert_eq!(
        updated.task.brief().version,
        before.task.brief().version + 1
    );

    let stale = browser_request(
        &api,
        Method::POST,
        "/api/engine/tasks/legacy-large/commands",
        Some(&browser),
        Some(&json!({"amend": "Second draft", "briefVersion": before.task.brief().version})),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(stale).await["error"],
        "The brief changed. Reopen Amend to edit the latest version."
    );
    assert_eq!(service.task("legacy-large").await.unwrap(), updated);
}

#[tokio::test]
async fn promotion_checks_the_final_brief_without_limiting_lane_documents() {
    let (_home, service) = fixture(GitHub::new("fixture").expect("client"));
    let service = Arc::new(service);
    let api = router(
        Arc::clone(&service),
        [planner_controller(PLANNER_KEY, "planner")],
    );
    let exact = brief_with_bytes(MAX_BRIEF_BYTES);
    let items = "/v1/planning/local-fixture/items";
    let raw = "é".repeat(MAX_BRIEF_BYTES / 2);
    let added = post_as(
        &api,
        items,
        &PLANNER_KEY,
        &json!({"kind":"papercut", "title":"Adds frontmatter", "body":raw}),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let added = large_json(added).await;
    let id = added["id"].as_str().unwrap();
    let final_size = BriefPolicy::with_complexity(&raw, Complexity::Low)
        .unwrap()
        .len();
    assert!(final_size > raw.len());
    assert_brief_size_refusal(
        post_as(
            &api,
            &format!("{items}/{id}/promote"),
            &PLANNER_KEY,
            &json!({"complexity":"low"}),
        )
        .await,
        final_size,
    )
    .await;
    let state = service.state.lock().await;
    assert_eq!(
        state
            .store
            .item("local-fixture", id)
            .unwrap()
            .unwrap()
            .state,
        nucleus_store::planning::ItemState::Open
    );
    drop(state);

    let added = post_as(
        &api,
        items,
        &PLANNER_KEY,
        &json!({"kind":"lead", "title":"Exact brief", "body":exact}),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let added = large_json(added).await;
    let id = added["id"].as_str().unwrap();
    let response = post_as(
        &api,
        &format!("{items}/{id}/promote"),
        &PLANNER_KEY,
        &json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(json_body(response).await["number"], 1);

    let lane = super::planning::put_as(
        &api, "/v1/planning/local-fixture/lanes/evidence", &PLANNER_KEY,
        &json!({"version":0,"title":"Evidence","aim":"Keep the source material","document":format!("{exact}x")}),
    ).await;
    assert_eq!(lane.status(), StatusCode::OK);
}
