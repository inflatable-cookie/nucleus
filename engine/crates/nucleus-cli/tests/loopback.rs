use std::{io::Write, process::Command, time::Duration};

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
