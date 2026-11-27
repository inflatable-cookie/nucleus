use std::{
    fs,
    io::Write,
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::Path as FilePath,
    process::{Command, Stdio},
    time::Duration,
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::Path,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    routing::{get, post},
};
use serde_json::json;
use tokio::{io::AsyncWriteExt, net::TcpListener, process::Child, time::timeout};

const REPORT: &str = r#"{"question":{"prompt":"Which option?","options":["A","B"]}}"#;
const REPORT_KEY: [u8; 32] = [7; 32];
const REPORT_PATH: &str = "/v1/runs/fixture/worker-1/report";

fn report_ticket(endpoint: SocketAddr) -> tempfile::NamedTempFile {
    let mut ticket = tempfile::NamedTempFile::new().expect("owner-only ticket");
    serde_json::to_writer(
        &mut ticket,
        &nucleus_service::ReportTicket {
            endpoint: format!("http://{endpoint}"),
            task: "fixture".into(),
            instance: "worker-1".into(),
            credential: REPORT_KEY,
        },
    )
    .expect("write report ticket");
    ticket
}

async fn start_report(ticket: &FilePath) -> Child {
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_nucleus"))
        .args(["report", "--ticket"])
        .arg(ticket)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start report CLI");
    child
        .stdin
        .take()
        .expect("report stdin")
        .write_all(REPORT.as_bytes())
        .await
        .expect("write and close report stdin");
    child
}

#[tokio::test]
async fn report_waits_for_the_ticket_endpoint() {
    let reservation = TcpListener::bind(("127.0.0.1", 0)).await.expect("loopback");
    let endpoint = reservation.local_addr().expect("local address");
    drop(reservation);
    let ticket = report_ticket(endpoint);
    let mut child = start_report(ticket.path()).await;
    tokio::time::sleep(Duration::from_millis(750)).await;
    assert!(child.try_wait().expect("CLI status").is_none());

    let listener = TcpListener::bind(endpoint)
        .await
        .expect("return to same port");
    let app = Router::new().route(
        REPORT_PATH,
        post(|headers: HeaderMap, body: Bytes| async move {
            assert_eq!(
                headers[AUTHORIZATION],
                format!("Bearer {}", hex::encode(REPORT_KEY))
            );
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).expect("report JSON"),
                serde_json::from_str::<serde_json::Value>(REPORT).expect("expected report JSON")
            );
            StatusCode::NO_CONTENT
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let output = timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .expect("report completed after endpoint returned")
        .expect("CLI output");
    server.abort();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn report_refusal_is_final_and_redacts_the_bearer() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("loopback");
    let ticket = report_ticket(listener.local_addr().expect("local address"));
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        REPORT_PATH,
        post(move || {
            let requests = requests.clone();
            async move {
                requests.send(()).expect("observe report request");
                (StatusCode::CONFLICT, Json(json!({"error": format!("conflicting report for {}", hex::encode(REPORT_KEY))})))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let output = timeout(
        Duration::from_secs(5),
        start_report(ticket.path()).await.wait_with_output(),
    )
    .await
    .expect("refusal completed without waiting to retry")
    .expect("CLI output");
    server.abort();
    assert!(!output.status.success());
    assert!(received.try_recv().is_ok(), "no report arrived");
    assert!(received.try_recv().is_err(), "refusal was retried");
    let error = String::from_utf8(output.stderr).expect("CLI error");
    assert!(error.contains("conflicting report for [redacted]"));
    assert!(!error.contains(&hex::encode(REPORT_KEY)));
}

#[tokio::test]
async fn controller_key_comes_from_the_selected_environment_variable() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("loopback");
    let endpoint = listener.local_addr().expect("local address").to_string();
    let key = hex::encode([4; 32]);
    let expected = format!("Bearer {key}");
    let app = Router::new().route(
        "/v1/tasks/{task}/next",
        get(
            move |headers: HeaderMap, Path(task): Path<String>| async move {
                if headers
                    .get(AUTHORIZATION)
                    .is_some_and(|value| *value == expected)
                {
                    (StatusCode::OK, Json(json!({"task": task})))
                } else {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"error": "wrong controller key"})),
                    )
                }
            },
        ),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let command = tokio::task::spawn_blocking(move || {
        for task in ["fixture", "fixture#7", "#7", "org/fixture#7"] {
            let output = Command::new(env!("CARGO_BIN_EXE_nucleus"))
                .args(["--endpoint", &endpoint, "next", task])
                .env("NUCLEUS_ENGINE_CONTROL_KEY", &key)
                .env("NUCLEUS_ENGINE_FIXTURE_ORIGIN_KEY", hex::encode([9; 32]))
                .output()
                .expect("CLI output");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&output.stdout).expect("CLI response"),
                json!({"task": task})
            );
        }
    });
    tokio::time::timeout(Duration::from_secs(5), command)
        .await
        .expect("CLI request completed")
        .expect("CLI process ran");
    server.abort();
}

#[tokio::test]
async fn promote_and_demote_cli_commands_send_versioned_task_commands() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("loopback");
    let endpoint = listener.local_addr().expect("local address").to_string();
    let key = hex::encode([5; 32]);
    let (sent_tx, mut sent_rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        "/v1/tasks/{task}/commands",
        post(
            move |Path(task): Path<String>, Json(body): Json<serde_json::Value>| {
                let sent_tx = sent_tx.clone();
                async move {
                    sent_tx.send((task, body)).unwrap();
                    Json(json!({"ok": true}))
                }
            },
        ),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let run = tokio::task::spawn_blocking(move || {
        for args in [
            [
                "--endpoint",
                &endpoint,
                "promote",
                "fixture#7",
                "--version",
                "3",
            ],
            [
                "--endpoint",
                &endpoint,
                "demote",
                "fixture#7",
                "--version",
                "4",
            ],
        ] {
            let output = Command::new(env!("CARGO_BIN_EXE_nucleus"))
                .args(args)
                .env("NUCLEUS_ENGINE_CONTROL_KEY", &key)
                .env("NUCLEUS_ENGINE_FIXTURE_ORIGIN_KEY", hex::encode([9; 32]))
                .output()
                .expect("CLI output");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    });
    tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .expect("CLI commands completed")
        .expect("CLI process ran");
    server.abort();
    assert_eq!(
        sent_rx.recv().await.unwrap(),
        ("fixture#7".into(), json!({"promote": 3}))
    );
    assert_eq!(
        sent_rx.recv().await.unwrap(),
        ("fixture#7".into(), json!({"demote": 4}))
    );
}

#[tokio::test]
async fn report_ticket_parse_failure_does_not_print_the_credential() {
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
    let output = start_report(file.path())
        .await
        .wait_with_output()
        .await
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
    let output = Command::new(env!("CARGO_BIN_EXE_nucleus"))
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
        let mut command = Command::new(env!("CARGO_BIN_EXE_nucleus"));
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

#[tokio::test]
async fn item_reopen_cli_round_trips_note_and_response() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("loopback");
    let endpoint = listener.local_addr().expect("local address").to_string();
    let app = Router::new().route(
        "/v1/planning/product/items/idea/reopen",
        post(|Json(body): Json<serde_json::Value>| async move {
            assert_eq!(body, json!({"note":"Revisit", "version":7}));
            Json(json!({"id":"idea", "state":"open"}))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_nucleus"))
        .args([
            "--endpoint",
            &endpoint,
            "item.reopen",
            "product",
            "idea",
            "--note",
            "Revisit",
            "--version",
            "7",
        ])
        .env("NUCLEUS_ENGINE_CONTROL_KEY", hex::encode([4; 32]))
        .output()
        .await
        .expect("CLI output");
    server.abort();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap(),
        json!({"id":"idea", "state":"open"})
    );
}

#[tokio::test]
async fn watch_and_unwatch_cli_support_t3_identity_and_ticket() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("loopback");
    let endpoint = listener.local_addr().expect("local address").to_string();
    let ticket = report_ticket(listener.local_addr().expect("local address"));
    let t3_key = hex::encode([6; 32]);
    let expected_t3 = format!("Bearer {t3_key}");
    let expected_ticket = format!("Bearer {}", hex::encode(REPORT_KEY));
    let (requests_tx, mut requests_rx) = tokio::sync::mpsc::unbounded_channel();
    let tx_t3 = requests_tx.clone();
    let tx_ticket = requests_tx;
    let app = Router::new()
        .route(
            "/v1/tasks/{task}/{verb}",
            post(
                move |headers: HeaderMap, Path((task, verb)): Path<(String, String)>| {
                    let tx = tx_t3.clone();
                    let expected = expected_t3.clone();
                    async move {
                        assert_eq!(headers[AUTHORIZATION], expected);
                        assert_eq!(headers["x-nucleus-t3-caller"], "planner-thread");
                        tx.send((verb, task)).unwrap();
                        Json(json!({"reference": "repo#7", "title": "Fix", "phase": "working", "watching": true}))
                    }
                },
            ),
        )
        .route(
            "/v1/runs/fixture/worker-1/{verb}",
            post(
                move |headers: HeaderMap, Path(verb): Path<String>, Json(body): Json<serde_json::Value>| {
                    let tx = tx_ticket.clone();
                    let expected = expected_ticket.clone();
                    async move {
                        assert_eq!(headers[AUTHORIZATION], expected);
                        tx.send((format!("ticket-{verb}"), body["task"].as_str().unwrap().to_owned())).unwrap();
                        Json(json!({"reference": "repo#7", "title": "Fix", "phase": "working", "watching": false}))
                    }
                },
            ),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let ticket_path = ticket.path().to_path_buf();
    let run = tokio::task::spawn_blocking(move || {
        for verb in ["watch", "unwatch"] {
            let output = Command::new(env!("CARGO_BIN_EXE_nucleus"))
                .args(["--endpoint", &endpoint, verb, "other/repo#7"])
                .env("NUCLEUS_ENGINE_T3_CALLER_KEY", &t3_key)
                .env("T3CODE_THREAD_ID", "planner-thread")
                .env("T3CODE_DESKTOP_HOST_SCOPE", "desktop")
                .env_remove("NUCLEUS_TICKET")
                .env_remove("NUCLEUS_CONTINUATION_TICKET")
                .output()
                .expect("CLI output");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );

            let ticket_output = Command::new(env!("CARGO_BIN_EXE_nucleus"))
                .args([verb, "other/repo#7"])
                .env("NUCLEUS_TICKET", &ticket_path)
                .output()
                .expect("ticket CLI output");
            assert!(
                ticket_output.status.success(),
                "{}",
                String::from_utf8_lossy(&ticket_output.stderr)
            );
        }
    });
    tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .expect("CLI commands completed")
        .expect("CLI process ran");
    server.abort();
    assert_eq!(
        requests_rx.recv().await.unwrap(),
        ("watch".into(), "other/repo#7".into())
    );
    assert_eq!(
        requests_rx.recv().await.unwrap(),
        ("ticket-watch".into(), "other/repo#7".into())
    );
    assert_eq!(
        requests_rx.recv().await.unwrap(),
        ("unwatch".into(), "other/repo#7".into())
    );
    assert_eq!(
        requests_rx.recv().await.unwrap(),
        ("ticket-unwatch".into(), "other/repo#7".into())
    );
}
