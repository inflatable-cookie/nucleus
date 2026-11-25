use super::*;

#[tokio::test]
async fn github_account_settings_require_an_operator_and_explicit_selection() {
    let (_home, mut service) = fixture(GitHub::new("forge-fixture").expect("client"));
    service.github_accounts = Arc::new(crate::github_accounts::GitHubAccounts::with_fixture(
        service.settings.clone(),
        "http://127.0.0.1:9",
    ));
    let api = settings_api(&Arc::new(service));
    let path = "/v1/settings/github-accounts";
    assert_eq!(
        get_as(&api, path, &PLANNER_KEY).await.status(),
        StatusCode::FORBIDDEN
    );
    let response = get_as(&api, path, &BOARD_KEY).await;
    assert_eq!(response.status(), StatusCode::OK);
    let view = json_body(response).await;
    assert_eq!(view["accounts"], json!([]));
    assert_eq!(view["reviewerAccountId"], Value::Null);
    assert_eq!(view["workerAccountId"], Value::Null);
    let select_path = "/v1/settings/github-accounts/reviewer";
    assert_eq!(
        put_settings(
            &api,
            select_path,
            &BOARD_KEY,
            &json!({"revision": view["revision"]})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST,
    );
    let explicit_unlink = json!({"revision": view["revision"], "accountId": null});
    assert_eq!(
        put_settings(&api, select_path, &PLANNER_KEY, &explicit_unlink)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        put_settings(&api, select_path, &BOARD_KEY, &explicit_unlink)
            .await
            .status(),
        StatusCode::OK
    );
}
