use nucleus_local_store::SqliteBackend;

#[test]
fn command_runner_smoke_persists_sanitized_evidence() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state_path = temp_dir.path().join("nucleus.sqlite");

    crate::run(vec![
        "--state".to_owned(),
        state_path.display().to_string(),
        "command-runner".to_owned(),
        "smoke".to_owned(),
    ])
    .expect("run command-runner smoke");

    let state = nucleus_server::ServerStateService::new(SqliteBackend::new(state_path));
    let records = state.command_evidence().list().expect("list evidence");

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].id.0, "command:request:nucleusd-smoke:evidence");
    assert_eq!(
        records[0].payload.media_type.as_deref(),
        Some("application/json")
    );
}

#[test]
fn command_runner_read_only_spawn_smoke_persists_sanitized_evidence() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state_path = temp_dir.path().join("nucleus.sqlite");

    crate::run(vec![
        "--state".to_owned(),
        state_path.display().to_string(),
        "command-runner".to_owned(),
        "read-only-spawn-smoke".to_owned(),
    ])
    .expect("run command-runner read-only spawn smoke");

    let state = nucleus_server::ServerStateService::new(SqliteBackend::new(state_path));
    let records = state.command_evidence().list().expect("list evidence");
    let json = String::from_utf8(records[0].payload.bytes.clone()).expect("json");

    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].id.0,
        "command:request:nucleusd-read-only-spawn-smoke:spawn:evidence"
    );
    assert!(!json.contains("nucleus-read-only-spawn-smoke"));
    assert!(!json.contains("raw_stdout"));
}

#[test]
fn command_runner_read_only_command_persists_sanitized_evidence() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state_path = temp_dir.path().join("nucleus.sqlite");

    crate::run(vec![
        "--state".to_owned(),
        state_path.display().to_string(),
        "command-runner".to_owned(),
        "read-only".to_owned(),
        "--stdout-limit".to_owned(),
        "8".to_owned(),
        "--".to_owned(),
        "printf".to_owned(),
        "nucleus-readonly-cli".to_owned(),
    ])
    .expect("run command-runner read-only command");

    let state = nucleus_server::ServerStateService::new(SqliteBackend::new(state_path));
    let records = state.command_evidence().list().expect("list evidence");
    let json = String::from_utf8(records[0].payload.bytes.clone()).expect("json");

    assert_eq!(records.len(), 1);
    assert!(!json.contains("nucleus-readonly-cli"));
    assert!(!json.contains("raw_stdout"));
}

#[test]
fn command_runner_read_only_command_rejects_shell_passthrough() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state_path = temp_dir.path().join("nucleus.sqlite");

    crate::run(vec![
        "--state".to_owned(),
        state_path.display().to_string(),
        "command-runner".to_owned(),
        "read-only".to_owned(),
        "--".to_owned(),
        "/bin/sh".to_owned(),
        "-c".to_owned(),
        "echo should-not-run".to_owned(),
    ])
    .expect("shell passthrough returns sanitized rejection");

    let state = nucleus_server::ServerStateService::new(SqliteBackend::new(state_path));
    let records = state.command_evidence().list().expect("list evidence");
    let json = String::from_utf8(records[0].payload.bytes.clone()).expect("json");

    assert_eq!(records.len(), 1);
    assert!(!json.contains("should-not-run"));
    assert!(!json.contains("raw_stdout"));
}
