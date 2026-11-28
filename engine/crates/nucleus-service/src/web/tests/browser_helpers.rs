use super::*;

pub(super) async fn assert_browser_lanes(api: &Router, session: &str, events: &mut BodyDataStream) {
    let plan = "/api/engine/planning/fixture-product/plan";
    let lane = "/api/engine/planning/fixture-product/lanes/board";
    let cookie = Some(session);
    let initial = json_body(browser_request(api, Method::GET, plan, cookie, None).await).await;
    assert_eq!(initial["version"], 0);
    let document =
        json!({"title":"Board","aim":"Finish Settings","document":"## Steps","version":0});
    let saved =
        json_body(browser_request(api, Method::PUT, lane, cookie, Some(&document)).await).await;
    assert_eq!(saved["version"], 1);
    assert_event(events, &["event: planning"]).await;
    assert_eq!(
        browser_request(api, Method::PUT, lane, cookie, Some(&document))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let update = json!({"version":0,"lanes":[{"key":"board","horizon":"now","doneWhen":"Tools work","statusNote":"Ready"}]});
    let saved =
        json_body(browser_request(api, Method::PUT, plan, cookie, Some(&update)).await).await;
    assert_eq!(saved["version"], 1);
    assert_event(events, &["event: planning"]).await;
    let updated = json_body(browser_request(api, Method::GET, plan, cookie, None).await).await;
    assert_eq!(updated["lanes"][0]["key"], "board");
    assert_eq!(updated["documents"][0]["document"], "## Steps");
    // The paired board mounts the same planning handlers as the controller API.
    for path in [
        "/api/engine/planning/fixture-product/decisions",
        "/api/engine/planning/fixture-product/items",
    ] {
        let listed = json_body(browser_request(api, Method::GET, path, cookie, None).await).await;
        assert_eq!(listed, json!([]), "{path}");
    }
    let decision = json!({
        "question": "Use the new layout?",
        "options": [{"id": "yes", "label": "Use it"}, {"id": "no", "label": "Keep the current one"}],
    });
    let added = browser_request(
        api,
        Method::POST,
        "/api/engine/planning/fixture-product/decisions",
        cookie,
        Some(&decision),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_event(events, &["event: decisions"]).await;
    assert_browser_item(api, cookie, events).await;
    // The theme is a cache read; a fixture without a host config stream has none yet.
    let theme =
        json_body(browser_request(api, Method::GET, "/api/engine/theme", cookie, None).await).await;
    assert_eq!(theme, json!({"theme": null}));
    let catalog = browser_request(
        api,
        Method::GET,
        "/api/engine/profiles/catalog",
        cookie,
        None,
    )
    .await;
    assert_eq!(
        json_body(catalog).await,
        json!({"providers":null,"readAtMs":null,"status":"pending"})
    );
    let usage = browser_request(api, Method::GET, "/api/engine/profiles/usage", cookie, None).await;
    let window = json!({"counts":{},"groups":{},"sample":0});
    assert_eq!(
        json_body(usage).await,
        json!({"recent":window,"worker":window,"reviewer":window,"totals":{},"groupTotals":{},"limitedGroups":{}})
    );
    let reassign = browser_request(
        api,
        Method::POST,
        "/api/engine/settings/projects/reassign",
        cookie,
        Some(&json!({})),
    )
    .await;
    assert_ne!(reassign.status(), StatusCode::NOT_FOUND);
}

pub(super) async fn assert_browser_item(
    api: &Router,
    cookie: Option<&str>,
    events: &mut BodyDataStream,
) {
    let item = json!({"kind":"papercut","title":"Toast lingers","body":"It stays.","lanes":[]});
    let added = browser_request(
        api,
        Method::POST,
        "/api/engine/planning/fixture-product/items",
        cookie,
        Some(&item),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_eq!(json_body(added).await["kind"], "papercut");
    assert_event(events, &["event: planning"]).await;
    let listed = json_body(
        browser_request(
            api,
            Method::GET,
            "/api/engine/planning/fixture-product/items",
            cookie,
            None,
        )
        .await,
    )
    .await;
    let item = &listed[0];
    assert_eq!(item["title"], "Toast lingers");
    assert!(item["createdAtMs"].is_i64());
    assert_eq!(item["updatedAtMs"], item["createdAtMs"]);

    let id = item["id"].as_str().expect("papercut ID");
    let path = format!("/api/engine/planning/fixture-product/items/{id}");
    let wrong_project = format!("/api/engine/planning/other-project/items/{id}");
    let version = item["version"].as_i64().expect("papercut version");
    let edit =
        json!({"version":version,"title":"Toast has lingered","body":"It still stays.","lanes":[]});
    assert_eq!(
        browser_request(api, Method::PUT, &wrong_project, cookie, Some(&edit))
            .await
            .status(),
        StatusCode::NOT_FOUND,
    );
    let response = browser_request(api, Method::PUT, &path, cookie, Some(&edit)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = json_body(response).await;
    assert_eq!(saved["title"], edit["title"]);
    assert_eq!(saved["body"], edit["body"]);
    assert_eq!(saved["createdAtMs"], item["createdAtMs"]);
    assert!(saved["version"].as_i64().unwrap() > version);
    assert_event(events, &["event: planning"]).await;

    let stale = json!({"version":version,"title":"Stale edit","body":"Old text.","lanes":[]});
    assert_eq!(
        browser_request(api, Method::PUT, &path, cookie, Some(&stale))
            .await
            .status(),
        StatusCode::CONFLICT,
    );
    let listed = json_body(
        browser_request(
            api,
            Method::GET,
            "/api/engine/planning/fixture-product/items",
            cookie,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(listed[0], saved);

    assert_browser_lead_complexity(api, cookie, events).await;
}

/// A lead's list entry carries the complexity its brief declares, flow-style YAML included.
pub(super) async fn assert_browser_lead_complexity(
    api: &Router,
    cookie: Option<&str>,
    events: &mut BodyDataStream,
) {
    let lead = json!({"kind":"lead","title":"Flow lead","body":"---\nqueue: {complexity: medium, dependsOn: []}\n---\nDo the work.\n","lanes":[]});
    let added = browser_request(
        api,
        Method::POST,
        "/api/engine/planning/fixture-product/items",
        cookie,
        Some(&lead),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    assert_event(events, &["event: planning"]).await;
    let listed_lead = |listed: &Value| {
        listed
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item["kind"] == "lead")
            .expect("lead")
            .clone()
    };
    let items = "/api/engine/planning/fixture-product/items";
    let listed = json_body(browser_request(api, Method::GET, items, cookie, None).await).await;
    let current = listed_lead(&listed);
    assert_eq!(current["complexity"], "medium");
    let papercut = listed
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item["kind"] == "papercut")
        .expect("papercut");
    assert_eq!(
        papercut.get("complexity"),
        None,
        "papercut bodies are not briefs"
    );
}

pub(super) async fn assert_board_assets(api: &Router) {
    for path in ["/", "/settings", "/app.js"] {
        let response = browser_request(api, Method::GET, path, None, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        let bytes = to_bytes(response.into_body(), 1024).await.expect("asset");
        let expected = if path == "/app.js" {
            "Fixture Board"
        } else {
            "/app.js"
        };
        assert!(
            std::str::from_utf8(&bytes)
                .expect("utf8 asset")
                .contains(expected)
        );
    }
}

pub(super) async fn assert_browser_origin(api: &Router, session: &str) {
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/engine/tasks")
                .header(HOST, LOCAL_HOST)
                .header(ORIGIN, "http://127.0.0.1:10")
                .header("x-nucleus-board", "1")
                .header("cookie", session)
                .body(Body::empty())
                .expect("cross-origin request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = api
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/engine/tasks")
                .header(HOST, LOCAL_HOST)
                .header("cookie", session)
                .body(Body::empty())
                .expect("simple request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}
