use std::{fs, io::Write, os::unix::fs::PermissionsExt, process::Command, time::Duration};

use axum::{
    Json, Router,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    routing::get,
};
use serde_json::json;
use tokio::net::TcpListener;

#[tokio::test]
async fn controller_key_comes_from_the_selected_environment_variable() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("loopback");
    let endpoint = listener.local_addr().expect("local address").to_string();
    let key = hex::encode([4; 32]);
    let expected = format!("Bearer {key}");
    let app = Router::new().route(
        "/v1/tasks/fixture/next",
        get(move |headers: HeaderMap| async move {
            if headers
                .get(AUTHORIZATION)
                .is_some_and(|value| *value == expected)
            {
                (StatusCode::OK, Json(json!({"version": 7})))
            } else {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({"error": "wrong controller key"})),
                )
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let command = tokio::task::spawn_blocking(move || {
        Command::new(env!("CARGO_BIN_EXE_nucleus-engine"))
            .args(["--endpoint", &endpoint, "next", "fixture"])
            .env("NUCLEUS_ENGINE_CONTROL_KEY", key)
            .env("NUCLEUS_ENGINE_FIXTURE_ORIGIN_KEY", hex::encode([9; 32]))
            .output()
    });
    let output = tokio::time::timeout(Duration::from_secs(5), command)
        .await
        .expect("CLI request completed")
        .expect("CLI process ran")
        .expect("CLI output");
    server.abort();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).expect("CLI response"),
        json!({"version": 7})
    );
}

#[test]
fn report_ticket_parse_failure_does_not_print_the_credential() {
    let marker = "synthetic-credential-appearing-in-a-wrong-json-type";
    let mut file = tempfile::NamedTempFile::new().expect("owner-only ticket");
    let ticket = json!({
        "endpoint": "http://127.0.0.1:9",
        "task": "fixture",
        "instance": "worker-1",
        "credential": marker,
    });
    file.write_all(ticket.to_string().as_bytes())
        .expect("malformed ticket");
    let output = Command::new(env!("CARGO_BIN_EXE_nucleus-engine"))
        .args(["report", "--ticket"])
        .arg(file.path())
        .output()
        .expect("CLI output");
    assert!(!output.status.success());
    let error = String::from_utf8(output.stderr).expect("CLI error");
    assert!(error.contains("invalid report ticket"));
    assert!(!error.contains(marker), "the CLI disclosed a credential");
}

#[test]
fn t3_status_reports_an_unconfigured_portable_profile() {
    let directory = tempfile::tempdir().expect("portable profile");
    let home = directory.path().canonicalize().expect("canonical home");
    let output = Command::new(env!("CARGO_BIN_EXE_nucleus-engine"))
        .args(["--endpoint", "127.0.0.1:9", "t3", "status", "--home"])
        .arg(&home)
        .env_remove("NUCLEUS_ENGINE_CONTROL_KEY")
        .env_remove("NUCLEUS_ENGINE_T3_INSTALL_BEARER")
        .env_remove("NUCLEUS_ENGINE_T3_BEARER")
        .output()
        .expect("CLI output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).expect("status JSON");
    assert_eq!(status["provider"], "nucleus-rust");
    assert!(status["registered"].is_null());
    assert_eq!(status["launcherVerified"], false);
    assert_eq!(
        status["launcher"],
        home.join("bin/nucleus-rust-acp").to_str().unwrap()
    );
    assert_eq!(status["engineHealth"], "credential unavailable");
    assert!(status["storage"]["database"].is_string());
    assert_eq!(home.read_dir().expect("unchanged profile").count(), 0);
}

#[test]
fn barge_is_optional_and_serve_refuses_an_absent_class_volume() {
    let fixture = tempfile::tempdir().expect("storage fixture");
    let root = fixture.path().canonicalize().expect("fixture root");
    let account = root.join("account");
    let tools = root.join("bin");
    let classes = root.join("classes");
    fs::create_dir(&account).expect("account home");
    fs::create_dir(&tools).expect("fixture tools directory");
    for class in ["worktrees", "scratch", "builds", "fallback"] {
        fs::create_dir_all(classes.join(class)).expect("class directory");
    }
    let cli = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nucleus-engine"));
        command
            .env("HOME", &account)
            .env("XDG_STATE_HOME", account.join("state"))
            .env("XDG_CACHE_HOME", account.join("cache"))
            .env("PATH", &tools)
            .env("BARGE_FIXTURE", &classes)
            .env_remove("BARGE_FIXTURE_ABSENT")
            .env_remove("NUCLEUS_ENGINE_CONTROL_KEY")
            .env_remove("NUCLEUS_ENGINE_T3_INSTALL_BEARER")
            .env_remove("NUCLEUS_ENGINE_T3_BEARER");
        command
    };
    let configured = cli()
        .args(["configure", "--enable"])
        .output()
        .expect("configure");
    assert!(
        configured.status.success(),
        "{}",
        String::from_utf8_lossy(&configured.stderr)
    );
    let home = account.join(".nucleus/engine");
    assert!(home.join("state/engine.json").is_file());

    let program = tools.join("barge");
    fs::write(&program, r#"#!/bin/sh
[ "$#" = 5 ] && [ "$1" = --json ] && [ "$2" = path ] && [ "$4" = --project ] && [ "$5" = nucleus ] || exit 2
if [ "${BARGE_FIXTURE_ABSENT-}" = "$3" ]; then
    printf '{"schema":"barge.path/1","data":{"path":"%s/fallback/nucleus","fallback":true}}\n' "$BARGE_FIXTURE"
else
    printf '{"schema":"barge.path/1","data":{"path":"%s/%s/nucleus","fallback":false}}\n' "$BARGE_FIXTURE" "$3"
fi
"#).expect("fixture Barge executable");
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700))
        .expect("executable permissions");
    let configured = cli()
        .args(["configure", "--enable", "--placement", "barge"])
        .output()
        .expect("configure Barge placement");
    assert!(
        configured.status.success(),
        "{}",
        String::from_utf8_lossy(&configured.stderr)
    );
    let status = cli().args(["t3", "status"]).output().expect("status");
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let status: serde_json::Value = serde_json::from_slice(&status.stdout).expect("status JSON");
    assert_eq!(status["storage"]["home"], json!(home));
    assert_eq!(status["storage"]["placement"], "barge");
    for class in ["worktrees", "scratch", "builds"] {
        assert_eq!(
            status["storage"]["bargePaths"][class],
            json!(classes.join(class).join("nucleus"))
        );
    }

    let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("occupied endpoint");
    let endpoint = occupied.local_addr().expect("bound address").to_string();
    let refused = cli()
        .args([
            "--endpoint",
            &endpoint,
            "serve",
            "--actor",
            "fixture",
            "--acp-provider",
            "nucleus-rust",
            "--t3",
            "http://127.0.0.1:9",
        ])
        .env("BARGE_FIXTURE_ABSENT", "builds")
        .env("NUCLEUS_ENGINE_GITHUB_TOKEN", "fixture")
        .env("NUCLEUS_ENGINE_T3_BEARER", "fixture")
        .env("NUCLEUS_ENGINE_CONTROL_KEY", hex::encode([1; 32]))
        .env("NUCLEUS_ENGINE_T3_CALLER_KEY", hex::encode([2; 32]))
        .output()
        .expect("serve refused");
    assert!(!refused.status.success());
    let error = String::from_utf8_lossy(&refused.stderr);
    assert!(
        error.contains("builds") && error.contains("configured volume is absent"),
        "{error}"
    );
    assert!(!home.join("data/databases/engine.sqlite").exists());
    assert!(!classes.join("scratch/nucleus").exists());
    assert!(!classes.join("fallback/nucleus").exists());
}
