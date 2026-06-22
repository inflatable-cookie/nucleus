mod support;

use super::*;
use support::*;

#[test]
fn git_push_runner_outcomes_round_trip_sanitized_records() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = test_state(db.clone());

    let set = persist_git_push_runner_outcomes(
        &state,
        input(command_set(vec![command("1", ready())]), completed(), false),
    )
    .expect("persist");

    let reopened = test_state(db);
    let records = read_git_push_runner_outcomes(&reopened).expect("read");

    assert_eq!(records, set.records);
    assert_eq!(records[0].outcome_status, completed());
    assert_eq!(
        records[0]
            .remote_target
            .as_ref()
            .expect("remote")
            .remote_name,
        "origin"
    );
    assert_eq!(records[0].evidence_refs, vec!["evidence:runner"]);
    assert!(!records[0].raw_output_retained);
    assert!(!records[0].push_executed);
    assert!(!records[0].pull_request_created);
}

#[test]
fn git_push_runner_outcomes_represent_failure_blocked_repair_and_duplicate() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = test_state(temp_dir.path().join("db.sqlite"));

    let failed = persist_git_push_runner_outcomes(
        &state,
        input(
            command_set(vec![command("failed", ready())]),
            failed(),
            false,
        ),
    )
    .expect("failed");
    let mixed = persist_git_push_runner_outcomes(
        &state,
        input(
            command_set(vec![
                command("blocked", blocked()),
                command("repair", repair_required()),
            ]),
            completed(),
            false,
        ),
    )
    .expect("mixed");
    let duplicate = persist_git_push_runner_outcomes(
        &state,
        GitPushRunnerOutcomePersistenceInput {
            existing_outcome_ids: vec![failed.records[0].persisted_outcome_id.clone()],
            ..input(
                command_set(vec![command("failed", ready())]),
                completed(),
                false,
            )
        },
    )
    .expect("duplicate");

    assert_eq!(failed.records[0].outcome_status, failed_status());
    assert_eq!(mixed.records[0].outcome_status, blocked_status());
    assert_eq!(mixed.records[1].outcome_status, repair_status());
    assert_eq!(duplicate.records[0].outcome_status, duplicate_status());
    assert!(duplicate.records[0].duplicate_outcome_detected);
}

#[test]
fn git_push_runner_outcomes_block_raw_payloads_and_widening() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = test_state(temp_dir.path().join("db.sqlite"));

    let set = persist_git_push_runner_outcomes(
        &state,
        input(
            command_set(vec![command("blocked", ready())]),
            completed(),
            true,
        ),
    )
    .expect("blocked");

    let record = &set.records[0];
    assert_eq!(
        record.persistence_status,
        GitPushRunnerOutcomePersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&GitPushRunnerOutcomePersistenceBlocker::ProviderPayloadPresent));
    assert!(record
        .persistence_blockers
        .contains(&GitPushRunnerOutcomePersistenceBlocker::PullRequestRequested));
}

#[test]
fn git_push_runner_outcome_diagnostics_summarize_records() {
    let diagnostics = git_push_runner_outcome_diagnostics_from_persisted_records(vec![
        persisted("completed", completed()),
        persisted("failed", failed_status()),
        persisted("blocked", blocked_status()),
        persisted("repair", repair_status()),
        persisted("duplicate", duplicate_status()),
    ]);

    assert_eq!(diagnostics.outcome_count, 5);
    assert_eq!(diagnostics.completed_count, 1);
    assert_eq!(diagnostics.failed_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.repair_required_count, 1);
    assert_eq!(diagnostics.duplicate_noop_count, 1);
    assert_eq!(diagnostics.remote_target_count, 5);
    assert!(!diagnostics.push_executed);
    assert!(!diagnostics.raw_output_retained);
}
