mod support;

use super::*;
use support::*;

#[test]
fn git_commit_runner_outcomes_round_trip_sanitized_records() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = test_state(db.clone());

    let set = persist_git_commit_runner_outcomes(
        &state,
        input(
            command_set(vec![command("1", ready(), primary())]),
            completed(),
            false,
        ),
    )
    .expect("persist");

    let reopened = test_state(db);
    let records = read_git_commit_runner_outcomes(&reopened).expect("read");

    assert_eq!(records, set.records);
    assert_eq!(records[0].outcome_status, completed());
    assert_eq!(
        records[0].commit_message_ref,
        Some("commit-message-ref:1".to_owned())
    );
    assert_eq!(records[0].evidence_refs, vec!["evidence:runner"]);
    assert!(!records[0].no_effects.raw_output_retained);
    assert!(!records[0].commit_created);
    assert!(!records[0].push_executed);
}

#[test]
fn git_commit_runner_outcomes_represent_failure_blocked_repair_and_duplicate() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = test_state(temp_dir.path().join("db.sqlite"));

    let failed = persist_git_commit_runner_outcomes(
        &state,
        input(
            command_set(vec![command("failed", ready(), isolated())]),
            failed(),
            false,
        ),
    )
    .expect("failed");
    let mixed = persist_git_commit_runner_outcomes(
        &state,
        input(
            command_set(vec![
                command("blocked", blocked(), primary()),
                command("repair", repair_required(), isolated()),
            ]),
            completed(),
            false,
        ),
    )
    .expect("mixed");
    let duplicate = persist_git_commit_runner_outcomes(
        &state,
        GitCommitRunnerOutcomePersistenceInput {
            existing_outcome_ids: vec![failed.records[0].persisted_outcome_id.clone()],
            ..input(
                command_set(vec![command("failed", ready(), isolated())]),
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
fn git_commit_runner_outcomes_block_raw_payloads_and_widening() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = test_state(temp_dir.path().join("db.sqlite"));

    let set = persist_git_commit_runner_outcomes(
        &state,
        input(
            command_set(vec![command("blocked", ready(), primary())]),
            completed(),
            true,
        ),
    )
    .expect("blocked");

    let record = &set.records[0];
    assert_eq!(
        record.persistence_status,
        GitCommitRunnerOutcomePersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&GitCommitRunnerOutcomePersistenceBlocker::RawCommitMessagePresent));
    assert!(record
        .persistence_blockers
        .contains(&GitCommitRunnerOutcomePersistenceBlocker::ProviderPayloadPresent));
    assert!(record
        .persistence_blockers
        .contains(&GitCommitRunnerOutcomePersistenceBlocker::PushRequested));
}

#[test]
fn git_commit_runner_outcome_diagnostics_summarize_records() {
    let diagnostics = git_commit_runner_outcome_diagnostics_from_persisted_records(vec![
        persisted("completed", completed(), primary()),
        persisted("failed", failed_status(), primary()),
        persisted("blocked", blocked_status(), isolated()),
        persisted("repair", repair_status(), isolated()),
        persisted("duplicate", duplicate_status(), primary()),
    ]);

    assert_eq!(diagnostics.outcome_count, 5);
    assert_eq!(diagnostics.completed_count, 1);
    assert_eq!(diagnostics.failed_count, 1);
    assert_eq!(diagnostics.blocked_count, 1);
    assert_eq!(diagnostics.repair_required_count, 1);
    assert_eq!(diagnostics.duplicate_noop_count, 1);
    assert_eq!(diagnostics.primary_tree_count, 3);
    assert_eq!(diagnostics.isolated_worktree_count, 2);
    assert!(!diagnostics.commit_created);
    assert!(!diagnostics.no_effects.raw_output_retained);
}
