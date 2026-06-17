use nucleus_command_policy::CommandExecutionStatus;
use nucleus_local_store::SqliteBackend;
use nucleus_projects::ProjectId;

use super::*;

fn command(executable: &str, argv: Vec<&str>) -> ReadOnlyCommand {
    ReadOnlyCommand {
        project_id: ProjectId("project:readonly-control".to_owned()),
        execution_host_id: crate::EngineHostId("host:local".to_owned()),
        executable: executable.to_owned(),
        argv: argv.into_iter().map(str::to_owned).collect(),
        working_directory: std::env::current_dir().expect("current dir"),
        timeout_ms: 2_000,
        stdout_limit_bytes: 16,
        stderr_limit_bytes: 16,
        command_display: Some("read-only command control test".to_owned()),
    }
}

#[test]
fn read_only_command_control_runs_and_persists_sanitized_evidence() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    let result = run_read_only_command_control(
        &state,
        crate::ServerCommandId("command:readonly-control".to_owned()),
        command("printf", vec!["nucleus-readonly-control"]),
        temp_dir.path().join("artifacts"),
    )
    .expect("run command");
    let records = state.command_evidence().list().expect("list evidence");
    let json = String::from_utf8(records[0].payload.bytes.clone()).expect("json");

    assert_eq!(result.status, CommandExecutionStatus::Succeeded);
    assert_eq!(result.exit_status, Some(0));
    assert_eq!(records.len(), 1);
    assert!(!json.contains("nucleus-readonly-control"));
    assert!(!json.contains("raw_stdout"));
}

#[test]
fn read_only_command_control_rejects_shell_passthrough_before_spawn() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));

    let result = run_read_only_command_control(
        &state,
        crate::ServerCommandId("command:readonly-shell".to_owned()),
        command("/bin/sh", vec!["-c", "echo should-not-run"]),
        temp_dir.path().join("artifacts"),
    )
    .expect("reject command");

    assert_eq!(result.status, CommandExecutionStatus::BlockedByPolicy);
    assert!(matches!(
        result.rejection,
        Some(ReadOnlyCommandControlRejection::RunnerRejected { .. })
    ));
}

#[test]
fn read_only_command_control_rejects_invalid_working_directory_before_spawn() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut command = command("printf", vec!["should-not-run"]);
    command.working_directory = temp_dir.path().join("missing");

    let result = run_read_only_command_control(
        &state,
        crate::ServerCommandId("command:readonly-missing-dir".to_owned()),
        command,
        temp_dir.path().join("artifacts"),
    )
    .expect("reject command");

    assert_eq!(result.status, CommandExecutionStatus::BlockedByPolicy);
    assert!(matches!(
        result.rejection,
        Some(ReadOnlyCommandControlRejection::RunnerRejected { .. })
    ));
}

#[test]
fn read_only_command_control_rejects_missing_timeout_and_unbounded_output_before_spawn() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let mut command = command("printf", vec!["should-not-run"]);
    command.timeout_ms = 0;
    command.stdout_limit_bytes = 0;

    let result = run_read_only_command_control(
        &state,
        crate::ServerCommandId("command:readonly-bounds".to_owned()),
        command,
        temp_dir.path().join("artifacts"),
    )
    .expect("reject command");

    assert_eq!(result.status, CommandExecutionStatus::BlockedByPolicy);
    assert!(matches!(
        result.rejection,
        Some(ReadOnlyCommandControlRejection::RunnerRejected { reasons })
            if reasons.iter().any(|reason| reason.contains("MissingTimeout"))
                && reasons.iter().any(|reason| reason.contains("UnboundedOutput"))
    ));
}
