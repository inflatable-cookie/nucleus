//! Codex read-only smoke tests, split from the smoke god file; behavior
//! unchanged.

use super::outcome::finish_outcome;
use super::drive::SmokeObservation;
use super::{CodexReadOnlySmokeCleanup, CodexReadOnlySmokeStatus};
use swallowtail_core::SafeDiagnostic;
use swallowtail_runtime::{CleanupOutcome, TerminalOutcome, TerminalStatus};

fn observation(status: TerminalStatus, cleanup: CleanupOutcome) -> SmokeObservation {
    SmokeObservation {
        terminal: Ok(TerminalOutcome::new(status, cleanup)),
        events_seen: 4,
        provider_requests_seen: 0,
    }
}

#[test]
fn completed_smoke_preserves_safe_refs_counts_and_cleanup() {
    let outcome = finish_outcome(
        "thread-1".to_owned(),
        "turn-1".to_owned(),
        observation(TerminalStatus::Completed, CleanupOutcome::Clean),
        CleanupOutcome::Clean,
        CleanupOutcome::Clean,
    );

    assert_eq!(outcome.thread_id, "thread-1");
    assert_eq!(outcome.turn_id, "turn-1");
    assert_eq!(outcome.events_seen, 4);
    assert_eq!(outcome.status, CodexReadOnlySmokeStatus::Completed);
    assert_eq!(outcome.cleanup, CodexReadOnlySmokeCleanup::Completed);
}

#[test]
fn cleanup_uncertainty_overrides_provider_completion() {
    let outcome = finish_outcome(
        "thread-1".to_owned(),
        "turn-1".to_owned(),
        observation(TerminalStatus::Completed, CleanupOutcome::Clean),
        CleanupOutcome::Clean,
        CleanupOutcome::Failed(SafeDiagnostic::new("fixture", "cleanup failed")),
    );

    assert!(matches!(
        outcome.status,
        CodexReadOnlySmokeStatus::CleanupRequired(_)
    ));
    assert!(matches!(
        outcome.cleanup,
        CodexReadOnlySmokeCleanup::Failed(_)
    ));
}

#[test]
fn timeout_remains_distinct() {
    let outcome = finish_outcome(
        "thread-1".to_owned(),
        "turn-1".to_owned(),
        observation(TerminalStatus::TimedOut, CleanupOutcome::NotApplicable),
        CleanupOutcome::Clean,
        CleanupOutcome::Clean,
    );

    assert_eq!(outcome.status, CodexReadOnlySmokeStatus::TimedOut);
    assert_eq!(outcome.turn_status, "timed_out");
}

#[test]
fn detachment_does_not_claim_provider_completion() {
    let outcome = finish_outcome(
        "thread-1".to_owned(),
        "turn-1".to_owned(),
        observation(TerminalStatus::Detached, CleanupOutcome::Clean),
        CleanupOutcome::Clean,
        CleanupOutcome::Clean,
    );

    assert_eq!(outcome.turn_status, "detached");
    assert!(matches!(
        outcome.status,
        CodexReadOnlySmokeStatus::Failed(reason)
            if reason.contains("provider work may continue")
    ));
}
