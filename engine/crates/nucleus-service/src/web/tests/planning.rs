use super::*;

const PROJECT: &str = "/v1/planning/local-fixture";

async fn put_as(api: &Router, path: &str, key: &[u8; 32], body: &Value) -> Response {
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
    let first = post_as(&api, &promote, &PLANNER_KEY, &json!({})).await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let admitted = json_body(first).await;
    let repeated = post_as(&api, &promote, &PLANNER_KEY, &json!({})).await;
    assert_eq!(repeated.status(), StatusCode::OK);
    assert_eq!(json_body(repeated).await["identity"], admitted["identity"]);
    let task_id = admitted["identity"]["id"].as_str().expect("task ID");
    let task = json_body(get_as(&api, &format!("/v1/tasks/{task_id}"), &PLANNER_KEY).await).await;
    assert_eq!(
        task["source"],
        json!({"projectId":"local-fixture","itemId":id})
    );
    assert_eq!(task["brief"]["text"], brief);
    assert_eq!(task["identity"]["origin_thread"], "planner");

    let direct = post_as(
        &api,
        &format!("{PROJECT}/tasks"),
        &PLANNER_KEY,
        &json!({"brief":"A plain brief."}),
    )
    .await;
    assert_eq!(direct.status(), StatusCode::CREATED);
    let tasks = json_body(get_as(&api, "/v1/tasks", &PLANNER_KEY).await).await;
    assert_eq!(tasks.as_array().expect("task summaries").len(), 2);
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
    let added = post_as(
        &api,
        &decisions,
        &PLANNER_KEY,
        &json!({
            "question":"Ship?",
            "options":[{"id":"yes","label":"Ship"},{"id":"no","label":"Hold"}],
            "author":"spoofed"
        }),
    )
    .await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let decision = json_body(added).await;
    assert_eq!(decision["author"], "planner");
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
