use super::*;
use nucleus_local_store::SqliteBackend;

#[test]
fn git_dry_run_execution_persistence_records_round_trip_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let record = persist_git_dry_run_execution(&state, input(capture("1", true))).expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_git_dry_run_executions(&reopened).expect("read");

    assert_eq!(records, vec![record]);
    assert_eq!(records[0].changed_path_count, 3);
    assert_eq!(records[0].insertion_count, 12);
    assert_eq!(records[0].evidence_refs, vec!["evidence:capture"]);
    assert!(records[0].git_dry_run_executed);
    assert!(!records[0].commit_executed);
    assert!(!records[0].raw_output_retained);
}

#[test]
fn git_dry_run_execution_state_api_reads_records_in_stable_order() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    persist_git_dry_run_execution(&state, input(capture("b", false))).expect("persist b");
    persist_git_dry_run_execution(&state, input(capture("a", false))).expect("persist a");

    let records = read_git_dry_run_executions(&state).expect("read");

    assert_eq!(records[0].capture_id, "capture:a");
    assert_eq!(records[1].capture_id, "capture:b");
}

#[test]
fn git_dry_run_execution_duplicate_blocked_preserves_terminal_outcomes() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let failed = persist_git_dry_run_execution(
        &state,
        input(capture_with_status(
            "failed",
            GitDryRunEvidenceCaptureStatus::Failed,
        )),
    )
    .expect("persist failed");
    let repair = persist_git_dry_run_execution(
        &state,
        input(capture_with_status(
            "repair",
            GitDryRunEvidenceCaptureStatus::RepairRequired,
        )),
    )
    .expect("persist repair");
    let duplicate = persist_git_dry_run_execution(
        &state,
        GitDryRunExecutionPersistenceInput {
            existing_execution_ids: vec![failed.persisted_execution_id.clone()],
            ..input(capture_with_status(
                "failed",
                GitDryRunEvidenceCaptureStatus::Completed,
            ))
        },
    )
    .expect("duplicate");

    assert_eq!(
        failed.capture_status,
        GitDryRunEvidenceCaptureStatus::Failed
    );
    assert_eq!(
        repair.capture_status,
        GitDryRunEvidenceCaptureStatus::RepairRequired
    );
    assert_eq!(
        duplicate.persistence_status,
        GitDryRunExecutionPersistenceStatus::DuplicateNoop
    );
    assert!(duplicate.duplicate_execution_detected);
}

#[test]
fn git_dry_run_execution_duplicate_blocked_blocks_raw_or_external_requests() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    let mut input = input(capture("blocked", true));
    input.raw_stdout_present = true;
    input.raw_diff_present = true;
    input.commit_requested = true;
    input.forge_requested = true;

    let record = persist_git_dry_run_execution(&state, input).expect("blocked");

    assert_eq!(
        record.persistence_status,
        GitDryRunExecutionPersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&GitDryRunExecutionPersistenceBlocker::RawStdoutPresent));
    assert!(record
        .persistence_blockers
        .contains(&GitDryRunExecutionPersistenceBlocker::CommitRequested));
    assert!(!record.commit_executed);
    assert!(!record.raw_output_retained);
}

#[test]
fn git_dry_run_execution_diagnostics_source_summarizes_persisted_records() {
    let diagnostics = git_dry_run_execution_diagnostics_from_persisted_records(vec![
        persisted("completed", GitDryRunEvidenceCaptureStatus::Completed, true),
        persisted("failed", GitDryRunEvidenceCaptureStatus::Failed, false),
        persisted("timeout", GitDryRunEvidenceCaptureStatus::TimedOut, false),
        persisted("blocked", GitDryRunEvidenceCaptureStatus::Blocked, false),
        persisted(
            "repair",
            GitDryRunEvidenceCaptureStatus::RepairRequired,
            false,
        ),
    ]);

    assert_eq!(diagnostics.execution_count, 5);
    assert_eq!(diagnostics.completed_count, 1);
    assert_eq!(diagnostics.failed_count, 1);
    assert_eq!(diagnostics.timed_out_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.repair_required_count, 1);
    assert_eq!(diagnostics.dry_run_executed_count, 1);
    assert!(!diagnostics.commit_executed);
    assert!(!diagnostics.raw_output_retained);
}

fn input(capture: GitDryRunEvidenceCaptureRecord) -> GitDryRunExecutionPersistenceInput {
    GitDryRunExecutionPersistenceInput {
        capture,
        existing_execution_ids: Vec::new(),
        raw_stdout_present: false,
        raw_stderr_present: false,
        raw_diff_present: false,
        checkout_requested: false,
        branch_mutation_requested: false,
        commit_requested: false,
        push_requested: false,
        forge_requested: false,
        provider_write_requested: false,
        callback_response_requested: false,
        interruption_requested: false,
        recovery_requested: false,
    }
}

fn capture(id: &str, git_dry_run_executed: bool) -> GitDryRunEvidenceCaptureRecord {
    capture_with_status_and_execution(
        id,
        GitDryRunEvidenceCaptureStatus::Completed,
        git_dry_run_executed,
    )
}

fn capture_with_status(
    id: &str,
    status: GitDryRunEvidenceCaptureStatus,
) -> GitDryRunEvidenceCaptureRecord {
    capture_with_status_and_execution(id, status, false)
}

fn capture_with_status_and_execution(
    id: &str,
    status: GitDryRunEvidenceCaptureStatus,
    git_dry_run_executed: bool,
) -> GitDryRunEvidenceCaptureRecord {
    GitDryRunEvidenceCaptureRecord {
        capture_id: format!("capture:{id}"),
        handoff_id: format!("handoff:{id}"),
        request_id: format!("request:{id}"),
        descriptor_id: "git-dry-run-diff-stat".to_owned(),
        repo_id: "repo:1".to_owned(),
        status,
        blockers: Vec::new(),
        exit_code: Some(0),
        changed_path_count: 3,
        staged_path_count: 1,
        unstaged_path_count: 1,
        untracked_path_count: 1,
        insertion_count: 12,
        deletion_count: 4,
        evidence_refs: vec!["evidence:capture".to_owned(), "evidence:capture".to_owned()],
        git_dry_run_executed,
        git_mutation_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_retained: false,
    }
}

fn persisted(
    id: &str,
    status: GitDryRunEvidenceCaptureStatus,
    git_dry_run_executed: bool,
) -> GitDryRunExecutionPersistenceRecord {
    GitDryRunExecutionPersistenceRecord {
        persisted_execution_id: format!("persisted:{id}"),
        capture_id: format!("capture:{id}"),
        handoff_id: format!("handoff:{id}"),
        request_id: format!("request:{id}"),
        descriptor_id: "git-dry-run-diff-stat".to_owned(),
        repo_id: "repo:1".to_owned(),
        capture_status: status,
        capture_blockers: Vec::new(),
        persistence_status: GitDryRunExecutionPersistenceStatus::Persisted,
        persistence_blockers: Vec::new(),
        duplicate_execution_detected: false,
        exit_code: Some(0),
        changed_path_count: 1,
        staged_path_count: 0,
        unstaged_path_count: 1,
        untracked_path_count: 0,
        insertion_count: 0,
        deletion_count: 0,
        evidence_refs: vec!["evidence:capture".to_owned()],
        git_dry_run_executed,
        checkout_executed: false,
        branch_mutation_executed: false,
        commit_executed: false,
        push_executed: false,
        forge_effect_executed: false,
        provider_write_executed: false,
        callback_response_executed: false,
        interruption_executed: false,
        recovery_executed: false,
        raw_output_retained: false,
    }
}
