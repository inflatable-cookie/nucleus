use longhorn_core::{CredentialError, CredentialSlot, CredentialStore, MemoryCredentialStore};
use longhorn_git_workspace::{FixtureRoute, FixtureServer};
use nucleus_store::{GitHubAccount, GitHubAccountSettings};

use super::*;
use crate::github_accounts::GitHubAccounts;

/// A credential store which records each lookup. While offering, it answers any
/// slot Nucleus never wrote with the token a former `nucleus.github-reviewer`
/// item held.
#[derive(Default)]
struct FormerReviewerToken {
    saved: MemoryCredentialStore,
    offering: AtomicBool,
    lookups: AtomicUsize,
}

impl CredentialStore for FormerReviewerToken {
    fn store(&self, slot: &CredentialSlot, secret: &str) -> Result<(), CredentialError> {
        self.saved.store(slot, secret)
    }

    fn retrieve(&self, slot: &CredentialSlot) -> Result<Option<String>, CredentialError> {
        self.lookups.fetch_add(1, Ordering::Relaxed);
        let offering = self.offering.load(Ordering::Relaxed);
        Ok(self
            .saved
            .retrieve(slot)?
            .or_else(|| offering.then(|| "fixture-former-token".into())))
    }

    fn remove(&self, slot: &CredentialSlot) -> Result<(), CredentialError> {
        self.saved.remove(slot)
    }
}

#[tokio::test]
async fn the_former_reviewer_import_request_cannot_import_or_change_the_selected_reviewer() {
    // GitHub would verify the former token as another account.
    let github = FixtureServer::spawn(vec![FixtureRoute::new(
        "/user",
        200,
        r#"{"id":5678,"login":"fixture-former-reviewer"}"#,
    )])
    .expect("loopback");
    let (home, mut service) = fixture(GitHub::new("forge-fixture").expect("client"));
    let keychain = Arc::new(FormerReviewerToken::default());
    let accounts = GitHubAccounts::with_fixture(service.settings.clone(), &github.base_url())
        .with_fixture_store(keychain.clone());
    accounts
        .seed_reviewer_fixture(
            &GitHubAccount {
                host: "github.com".into(),
                user_id: "1234".into(),
                login: "fixture-reviewer".into(),
            },
            "fixture-selected-token",
        )
        .expect("selected reviewer");
    service.github_accounts = Arc::new(accounts);
    let service = Arc::new(service);
    let assets = home.path().join("board-assets");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(
        assets.join("index.html"),
        "<script src=\"/app.js\"></script>",
    )
    .unwrap();
    std::fs::write(assets.join("app.js"), "// fixture").unwrap();
    let operator = Controller {
        credential: BOARD_KEY,
        authority: Authority::Operator {
            actor: "fixture-operator".into(),
        },
    };
    let api = router_with_board(Arc::clone(&service), [operator], &assets).unwrap();
    let cookie = pair_board(&api, &BOARD_KEY).await;
    let board = "/api/engine/settings/github-accounts";
    let before = browser_request(&api, Method::GET, board, Some(&cookie), None).await;
    let before = json_body(before).await;
    let document = || service.settings.read::<GitHubAccountSettings>().unwrap();
    let revision = document().revision;
    let lookups = keychain.lookups.load(Ordering::Relaxed);
    keychain.offering.store(true, Ordering::Relaxed);

    // The exact bodies and paths the board and an operator client used.
    let former = json!({"organization": "fixture-org"});
    let from_board = browser_request(
        &api,
        Method::POST,
        &format!("{board}/import-reviewer"),
        Some(&cookie),
        Some(&former),
    )
    .await;
    assert_eq!(from_board.status(), StatusCode::NOT_FOUND);
    let path = "/v1/settings/github-accounts/import-reviewer";
    let from_operator = post_as(&api, path, &BOARD_KEY, &former).await;
    assert_eq!(from_operator.status(), StatusCode::NOT_FOUND);

    keychain.offering.store(false, Ordering::Relaxed);
    assert_eq!(keychain.lookups.load(Ordering::Relaxed), lookups);
    assert!(github.requests().is_empty());
    assert_eq!(document().revision, revision);
    let reviewer = service
        .github_accounts
        .reviewer_credential()
        .await
        .expect("available")
        .expect("selected");
    assert_eq!(reviewer.user_id(), 1234);
    assert_eq!(reviewer.access_token(), "fixture-selected-token");
    let after = browser_request(&api, Method::GET, board, Some(&cookie), None).await;
    let after = json_body(after).await;
    assert_eq!(after, before);
    assert_eq!(
        after,
        json!({
            "revision": revision,
            "accounts": [{"host": "github.com", "userId": "1234",
                "login": "fixture-reviewer", "presence": "present"}],
            "workerAccountId": null,
            "reviewerAccountId": "github.com:1234",
            "canSignIn": true
        })
    );
}

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
