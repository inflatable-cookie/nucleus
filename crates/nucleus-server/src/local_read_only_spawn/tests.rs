use std::time::Duration;

use nucleus_command_policy::CommandExecutionStatus;
use nucleus_core::RevisionId;
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use tempfile::tempdir;

use super::*;
use crate::{
    write_command_evidence, HostSpawnReadinessGate, HostSpawnReadinessStatus, ServerStateService,
};

mod fixtures;
use fixtures::{host, invocation, project_id, ready_gate, spawn_input};

#[test]
fn blocked_host_readiness_prevents_process_spawn_attempt() {
    let blocked_gate = HostSpawnReadinessGate {
        project_id: project_id(),
        execution_host_id: host(),
        status: HostSpawnReadinessStatus::Blocked,
        blockers: vec![crate::HostSpawnReadinessBlocker::Custom(
            "blocked test gate".to_owned(),
        )],
        summary: Some("blocked".to_owned()),
    };
    let result = run_local_read_only_spawn(spawn_input(
        invocation("definitely-not-a-real-command", Vec::new()),
        blocked_gate,
    ));

    assert_eq!(result.outcome, LocalReadOnlySpawnOutcome::Blocked);
    assert_eq!(
        result.evidence.status,
        CommandExecutionStatus::BlockedByPolicy
    );
    assert!(result.events.is_empty());
    assert!(matches!(
        result.rejection,
        Some(LocalReadOnlySpawnRejection::HostReadinessBlocked(_))
    ));
}

#[test]
fn shell_passthrough_is_rejected_before_spawn() {
    let result = run_local_read_only_spawn(spawn_input(
        invocation("/bin/sh", vec!["-c", "echo should-not-run"]),
        ready_gate(),
    ));

    assert_eq!(result.outcome, LocalReadOnlySpawnOutcome::Blocked);
    assert_eq!(
        result.evidence.status,
        CommandExecutionStatus::BlockedByPolicy
    );
    assert!(result.events.is_empty());
    assert!(matches!(
        result.rejection,
        Some(LocalReadOnlySpawnRejection::RunnerRejected(_))
    ));
}

#[test]
fn read_only_spawn_runs_structured_invocation_and_returns_sanitized_evidence() {
    let result = run_local_read_only_spawn(spawn_input(
        invocation("echo", vec!["nucleus"]),
        ready_gate(),
    ));

    assert_eq!(result.outcome, LocalReadOnlySpawnOutcome::Finished);
    assert_eq!(result.evidence.status, CommandExecutionStatus::Succeeded);
    assert_eq!(result.evidence.exit_status, Some(0));
    assert_eq!(result.events.len(), 3);
    assert_eq!(
        result.events[0].payload.kind,
        nucleus_command_policy::CommandProcessSupervisionEventKind::Accepted
    );
    assert_eq!(
        result.events[1].payload.kind,
        nucleus_command_policy::CommandProcessSupervisionEventKind::Running
    );
    assert_eq!(
        result.events[2].payload.kind,
        nucleus_command_policy::CommandProcessSupervisionEventKind::Terminal
    );
    assert!(!result
        .evidence
        .summary
        .expect("summary")
        .contains("nucleus"));
}

#[cfg(target_os = "macos")]
#[test]
fn no_filesystem_write_sandbox_blocks_file_creation() {
    let scratch = tempdir().expect("scratch dir");
    let target = scratch.path().join("blocked.txt");
    let target_arg = target.to_str().expect("utf8 path").to_owned();
    let result = run_local_read_only_spawn(spawn_input(
        invocation("/usr/bin/touch", vec![target_arg.as_str()]),
        ready_gate(),
    ));

    assert_eq!(result.outcome, LocalReadOnlySpawnOutcome::Finished);
    assert_ne!(result.evidence.exit_status, Some(0));
    assert!(
        !target.exists(),
        "sandboxed spawn must not create files under NoFilesystemWrite"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn project_restricted_sandbox_allows_writes_inside_project_root() {
    let scratch = tempdir().expect("scratch dir");
    let target = scratch.path().join("allowed.txt");
    let target_arg = target.to_str().expect("utf8 path").to_owned();
    let mut restricted = invocation("/usr/bin/touch", vec![target_arg.as_str()]);
    restricted.working_directory = scratch.path().to_path_buf();
    restricted.sandbox = nucleus_command_policy::CommandSandboxProfile::ProjectRestricted;
    let result = run_local_read_only_spawn(spawn_input(restricted, ready_gate()));

    assert_eq!(result.evidence.exit_status, Some(0));
    assert!(
        target.exists(),
        "ProjectRestricted must allow writes under the project root"
    );
}

#[test]
fn minimal_environment_drops_unlisted_parent_variables() {
    std::env::set_var("NUCLEUS_TEST_SECRET_TOKEN", "leak-me");
    let leaked = run_local_read_only_spawn(spawn_input(
        invocation("/usr/bin/printenv", vec!["NUCLEUS_TEST_SECRET_TOKEN"]),
        ready_gate(),
    ));
    let path_present = run_local_read_only_spawn(spawn_input(
        invocation("/usr/bin/printenv", vec!["PATH"]),
        ready_gate(),
    ));
    std::env::remove_var("NUCLEUS_TEST_SECRET_TOKEN");

    assert_ne!(
        leaked.evidence.exit_status,
        Some(0),
        "unlisted parent environment variables must not reach the child"
    );
    assert_eq!(path_present.evidence.exit_status, Some(0));
}

#[test]
fn read_only_spawn_enforces_timeout() {
    let mut slow = invocation("sleep", vec!["1"]);
    slow.timeout = Duration::from_millis(10);
    let result = run_local_read_only_spawn(spawn_input(slow, ready_gate()));

    assert_eq!(result.outcome, LocalReadOnlySpawnOutcome::Finished);
    assert_eq!(result.evidence.status, CommandExecutionStatus::TimedOut);
    assert!(result
        .evidence
        .summary
        .expect("summary")
        .contains("timed_out=true"));
}

#[test]
fn read_only_spawn_reports_output_truncation_without_raw_payloads() {
    let mut noisy = invocation("printf", vec!["abcdefghijklmnop"]);
    noisy.stdout_limit_bytes = 4;
    let result = run_local_read_only_spawn(spawn_input(noisy, ready_gate()));

    assert_eq!(result.evidence.status, CommandExecutionStatus::Succeeded);
    assert_eq!(result.output.stdout_captured_bytes, 4);
    assert!(result.output.stdout_truncated);
    let summary = result.evidence.summary.expect("summary");

    assert!(summary.contains("stdout_truncated=true"));
    assert!(!summary.contains("abcdefghijklmnop"));
    assert_eq!(result.evidence.stdout_artifact_ref, None);
    assert_eq!(result.evidence.stderr_artifact_ref, None);
}

#[test]
fn read_only_spawn_evidence_storage_excludes_raw_output_fields() {
    let temp_dir = tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
    let result = run_local_read_only_spawn(spawn_input(
        invocation("echo", vec!["stored-secret-shaped-text"]),
        ready_gate(),
    ));
    let record = write_command_evidence(
        &state,
        &result.evidence,
        RevisionId("rev:spawn:evidence:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write evidence");
    let json = String::from_utf8(record.payload.bytes).expect("json");

    for forbidden in [
        "raw_stdout",
        "raw_stderr",
        "stdout_bytes",
        "stderr_bytes",
        "stored-secret-shaped-text",
        "terminal_stream",
    ] {
        assert!(
            !json.contains(forbidden),
            "storage payload should not contain {forbidden}"
        );
    }
}
