use std::time::Duration;

use longhorn_git_workspace::{FixtureRoute, FixtureServer};
use serde_json::{Value, json};
use tokio::time::{sleep, timeout};

use super::*;

const DEVICE: &str = "/login/device/code";
const TOKEN: &str = "/login/oauth/access_token";

fn fixture_settings() -> (tempfile::TempDir, SettingsFile) {
    let root = tempfile::tempdir().expect("fixture root");
    let settings = SettingsFile::open(&root.path().canonicalize().expect("profile path"))
        .expect("fixture settings");
    (root, settings)
}

fn device_code() -> FixtureRoute {
    FixtureRoute::new(
        DEVICE,
        200,
        r#"{"device_code":"fixture-internal-code","user_code":"VERIFY-ME","verification_uri":"https://other.invalid","expires_in":30,"interval":5}"#,
    )
}

fn fixture_account() -> GitHubAccount {
    GitHubAccount {
        host: "github.com".into(),
        user_id: "1234".into(),
        login: "fixture-reviewer".into(),
    }
}

async fn flow_status(accounts: &GitHubAccounts, id: &str, status: &str) -> Value {
    timeout(Duration::from_secs(12), async {
        loop {
            let view = serde_json::to_value(accounts.flow_view(id).expect("existing flow"))
                .expect("public flow");
            if view["status"] == status {
                break view;
            }
            assert_ne!(view["status"], "failed", "{view}");
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("device flow progress")
}

#[tokio::test]
async fn verifies_confirms_refreshes_and_unlinks_the_device_account() {
    let (_root, settings) = fixture_settings();
    let server = FixtureServer::spawn(vec![
        device_code(),
        FixtureRoute::script(TOKEN, vec![
            (200, r#"{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}"#.into()),
            (200, r#"{"access_token":"fixture-rotated","refresh_token":"fixture-second-refresh","expires_in":3600}"#.into()),
        ]),
        FixtureRoute::new("/user", 200, r#"{"id":1234,"login":"fixture-reviewer"}"#),
    ]).expect("loopback");
    let accounts = Arc::new(GitHubAccounts::with_fixture(
        settings.clone(),
        &server.base_url(),
    ));
    assert!(
        accounts
            .reviewer_credential()
            .await
            .expect("unset")
            .is_none()
    );
    let initial = accounts.view().await.expect("settings");
    let id = accounts.start_device().expect("start").id;
    let waiting = flow_status(&accounts, &id, "waiting").await;
    assert_eq!(
        waiting["verificationUri"],
        "https://github.com/login/device"
    );
    assert_eq!(waiting["userCode"], "VERIFY-ME");
    assert!(!waiting.to_string().contains("fixture-internal-code"));
    let verified = flow_status(&accounts, &id, "confirm").await;
    assert_eq!(
        verified["account"],
        json!({"host":"github.com","userId":"1234","login":"fixture-reviewer"})
    );
    assert!(
        accounts
            .reviewer_credential()
            .await
            .expect("awaiting confirm")
            .is_none()
    );
    let saved = accounts.confirm(id, initial.revision).await.expect("save");
    let saved_json = serde_json::to_value(&saved).expect("public settings");
    assert_eq!(saved_json["reviewerAccountId"], "github.com:1234");
    assert_eq!(saved_json["accounts"][0]["presence"], "present");
    assert!(!saved_json.to_string().contains("fixture-access"));
    let stored = settings.read::<GitHubAccountSettings>().expect("metadata");
    assert!(
        !serde_json::to_string(&stored.value)
            .expect("serialized settings")
            .contains("fixture-access")
    );

    let credential = accounts
        .reviewer_credential()
        .await
        .expect("available")
        .expect("selected");
    assert_eq!(credential.user_id(), 1234);
    assert_eq!(credential.access_token(), "fixture-access");
    let rotated = accounts
        .refresh_rejected(&credential)
        .await
        .expect("rotated");
    assert_eq!(rotated.user_id(), 1234);
    assert_eq!(rotated.access_token(), "fixture-rotated");
    let refresh = &server.bodies_for(TOKEN)[1];
    assert!(refresh.contains("grant_type=refresh_token"));
    assert!(refresh.contains("refresh_token=fixture-refresh"));
    assert!(!refresh.contains("client_secret"));
    assert_eq!(server.request_count("/user"), 1);

    let unlinked = accounts.select(saved.revision, None).await.expect("unlink");
    assert!(
        accounts
            .reviewer_credential()
            .await
            .expect("unset")
            .is_none()
    );
    assert_eq!(
        serde_json::to_value(&unlinked).expect("view")["accounts"][0]["presence"],
        "present",
    );
    let signed_out = accounts
        .sign_out(unlinked.revision, "github.com:1234".into())
        .await
        .expect("sign out");
    assert!(signed_out.accounts.is_empty());
    assert!(
        read_grant(&accounts.scope(&accounts.slot(1234).expect("slot")))
            .expect("read")
            .is_none()
    );
}

#[tokio::test]
async fn confirmation_needs_the_current_revision_and_is_exclusive() {
    let (_root, settings) = fixture_settings();
    let server = FixtureServer::spawn(vec![
        device_code(),
        FixtureRoute::new(
            TOKEN,
            200,
            r#"{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}"#,
        ),
        FixtureRoute::new("/user", 200, r#"{"id":1234,"login":"fixture-reviewer"}"#),
    ])
    .expect("loopback");
    let accounts = Arc::new(GitHubAccounts::with_fixture(
        settings.clone(),
        &server.base_url(),
    ));
    let revision = accounts.view().await.expect("settings").revision;
    let id = accounts.start_device().expect("start").id;
    flow_status(&accounts, &id, "confirm").await;
    assert!(matches!(
        accounts.confirm(id.clone(), "stale".into()).await,
        Err(AccountError::Conflict)
    ));
    assert!(
        read_grant(&accounts.scope(&accounts.slot(1234).expect("slot")))
            .expect("read")
            .is_none()
    );
    let (account, grant) = accounts.claim_confirmation(&id).expect("one claim");
    assert!(matches!(
        accounts.claim_confirmation(&id),
        Err(AccountError::Saving)
    ));
    assert!(matches!(accounts.cancel(&id), Err(AccountError::Saving)));
    assert_eq!(
        serde_json::to_value(accounts.flow_view(&id).expect("status")).expect("DTO")["status"],
        "confirm"
    );
    let this = Arc::clone(&accounts);
    let saved = accounts
        .blocking(move |_| this.save_verified(&revision, &account, &grant))
        .await
        .expect("save");
    let saved = serde_json::to_value(saved).expect("public settings");
    settings
        .edit::<GitHubAccountSettings>(saved["revision"].as_str().expect("revision"), |value| {
            value.worker_account_id = value.reviewer_account_id.clone();
            Ok(())
        })
        .expect("fixture worker selection");
    let view = accounts.view().await.expect("shared");
    assert!(matches!(
        accounts
            .sign_out(view.revision, "github.com:1234".into())
            .await,
        Err(AccountError::WorkerUsesAccount)
    ));
}

#[tokio::test]
async fn cancellation_discards_the_unconfirmed_flow_and_missing_selected_grants_refuse() {
    let (_root, settings) = fixture_settings();
    let server = FixtureServer::spawn(vec![device_code()]).expect("loopback");
    let accounts = Arc::new(GitHubAccounts::with_fixture(
        settings.clone(),
        &server.base_url(),
    ));
    let id = accounts.start_device().expect("start").id;
    flow_status(&accounts, &id, "waiting").await;
    accounts.cancel(&id).expect("cancel");
    assert!(matches!(
        accounts.flow_view(&id),
        Err(AccountError::MissingFlow)
    ));
    assert_eq!(server.request_count(TOKEN), 0);

    let revision = settings
        .read::<GitHubAccountSettings>()
        .expect("initial")
        .revision;
    settings
        .edit::<GitHubAccountSettings>(&revision, |value| {
            value.accounts.push(fixture_account());
            value.reviewer_account_id = Some("github.com:1234".into());
            Ok(())
        })
        .expect("metadata without grant");
    assert!(matches!(
        accounts.reviewer_credential().await,
        Err(AccountError::NoGrant)
    ));
    assert_eq!(
        serde_json::to_value(accounts.view().await.expect("view")).expect("public")["accounts"][0]
            ["presence"],
        "missing"
    );
}

#[tokio::test]
async fn a_locked_selected_account_never_uses_installed_gh() {
    struct Locked;
    impl CredentialStore for Locked {
        fn store(&self, _: &CredentialSlot, _: &str) -> Result<(), longhorn_core::CredentialError> {
            Err(unavailable())
        }
        fn retrieve(
            &self,
            _: &CredentialSlot,
        ) -> Result<Option<String>, longhorn_core::CredentialError> {
            Err(unavailable())
        }
        fn remove(&self, _: &CredentialSlot) -> Result<(), longhorn_core::CredentialError> {
            Err(unavailable())
        }
    }
    fn unavailable() -> longhorn_core::CredentialError {
        longhorn_core::CredentialError::Unavailable {
            detail: "synthetic locked keychain".into(),
        }
    }
    let (_root, settings) = fixture_settings();
    let mut accounts = GitHubAccounts::with_fixture(settings, "http://127.0.0.1:9");
    accounts
        .seed_reviewer_fixture(&fixture_account(), "fixture-access")
        .expect("metadata");
    accounts.store = Arc::new(Locked);
    let accounts = Arc::new(accounts);
    let view = serde_json::to_value(accounts.view().await.expect("view")).expect("DTO");
    assert_eq!(view["reviewerAccountId"], "github.com:1234");
    assert_eq!(view["accounts"][0]["presence"], "unavailable");
    assert!(!view.to_string().contains("synthetic locked keychain"));
    assert!(matches!(
        accounts.reviewer_credential().await,
        Err(AccountError::Keychain)
    ));
}
