mod support;

use super::*;
use crate::{ForgePullRequestProvider, ForgePullRequestTextSource, ServerStateService};
use nucleus_local_store::SqliteBackend;
use support::*;

#[test]
fn forge_pull_request_runner_outcomes_round_trip_sanitized_record() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db.clone()));

    let set = persist_forge_pull_request_runner_outcomes(
        &state,
        input(request_set(vec![request("1", ready())]), completed(), false),
    )
    .expect("persist");

    let reopened = ServerStateService::new(SqliteBackend::new(db));
    let records = read_forge_pull_request_runner_outcomes(&reopened).expect("read");

    assert_eq!(records, set.records);
    assert_eq!(records[0].outcome_status, completed());
    assert_eq!(
        records[0].forge_provider,
        Some(ForgePullRequestProvider::GitHub)
    );
    assert_eq!(
        records[0].title_source,
        Some(ForgePullRequestTextSource::GeneratedFromEvidence)
    );
    assert!(!records[0].pull_request_created);
    assert!(!records[0].provider_effect_executed);
    assert!(!records[0].raw_output_retained);
}

#[test]
fn forge_pull_request_runner_outcomes_represent_blocked_repair_and_duplicate() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let failed = persist_forge_pull_request_runner_outcomes(
        &state,
        input(
            request_set(vec![request("failed", ready())]),
            failed(),
            false,
        ),
    )
    .expect("failed");
    let mixed = persist_forge_pull_request_runner_outcomes(
        &state,
        input(
            request_set(vec![
                request("blocked", blocked()),
                request("repair", repair_required()),
            ]),
            completed(),
            false,
        ),
    )
    .expect("mixed");
    let duplicate = persist_forge_pull_request_runner_outcomes(
        &state,
        ForgePullRequestRunnerOutcomePersistenceInput {
            existing_outcome_ids: vec![failed.records[0].persisted_outcome_id.clone()],
            ..input(
                request_set(vec![request("failed", ready())]),
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
}

#[test]
fn forge_pull_request_runner_outcomes_block_raw_payloads_and_provider_writes() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let set = persist_forge_pull_request_runner_outcomes(
        &state,
        input(
            request_set(vec![request("blocked", ready())]),
            completed(),
            true,
        ),
    )
    .expect("blocked");
    let record = &set.records[0];

    assert_eq!(
        record.persistence_status,
        ForgePullRequestRunnerOutcomePersistenceStatus::Blocked
    );
    assert!(record
        .persistence_blockers
        .contains(&ForgePullRequestRunnerOutcomePersistenceBlocker::RawTitlePresent));
    assert!(record
        .persistence_blockers
        .contains(&ForgePullRequestRunnerOutcomePersistenceBlocker::PullRequestCreationRequested));
    assert!(record
        .persistence_blockers
        .contains(&ForgePullRequestRunnerOutcomePersistenceBlocker::ProviderEffectRequested));
}

#[test]
fn forge_pull_request_runner_outcome_diagnostics_summarize_records() {
    let diagnostics = forge_pull_request_runner_outcome_diagnostics_from_persisted_records(vec![
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
    assert_eq!(diagnostics.provider_request_prepared_count, 5);
    assert!(!diagnostics.pull_request_created);
    assert!(!diagnostics.raw_output_retained);
}
