//! Swallowtail Codex task execution tests, split from the task_execution god
//! file; behavior unchanged.

use super::outcome::map_outcome;
use super::block_on_worker;
use nucleus_agent_protocol::{TaskExecutionLinkage, TaskExecutionOutcome};
use swallowtail_adapter_codex::{
    codex_approval_request_extension, codex_user_input_request_extension,
};
use swallowtail_core::{ProviderRequestRef, SafeDiagnostic};
use swallowtail_runtime::{
    CallbackId, CleanupOutcome, ProviderRequestObservation, TerminalOutcome, TerminalStatus,
};

fn linkage() -> TaskExecutionLinkage {
    TaskExecutionLinkage {
        session_id: "session-1".to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-1".to_owned(),
    }
}

fn observed(namespace: swallowtail_core::ExtensionNamespace) -> TerminalOutcome {
    TerminalOutcome::new(
        TerminalStatus::ProviderRequestObserved(ProviderRequestObservation::new(
            CallbackId::new("callback-1").expect("callback id"),
            namespace,
            ProviderRequestRef::new("provider-request-1").expect("provider request"),
        )),
        CleanupOutcome::NotApplicable,
    )
}

#[test]
fn provider_requests_keep_approval_and_user_input_distinct() {
    assert!(matches!(
        map_outcome(
            linkage(),
            Ok(observed(codex_approval_request_extension())),
            CleanupOutcome::NotApplicable,
            CleanupOutcome::Clean,
        ),
        TaskExecutionOutcome::WaitingForApproval(_)
    ));
    assert!(matches!(
        map_outcome(
            linkage(),
            Ok(observed(codex_user_input_request_extension())),
            CleanupOutcome::NotApplicable,
            CleanupOutcome::Clean,
        ),
        TaskExecutionOutcome::WaitingForUserInput(_)
    ));
}

#[test]
fn task_futures_can_run_from_inside_an_existing_local_executor() {
    let result = futures_executor::block_on(async { block_on_worker(async { 42 }) });

    assert_eq!(result, 42);
}

#[test]
fn timeout_detachment_and_cleanup_uncertainty_require_recovery() {
    let timeout = TerminalOutcome::new(TerminalStatus::TimedOut, CleanupOutcome::NotApplicable);
    assert!(matches!(
        map_outcome(
            linkage(),
            Ok(timeout),
            CleanupOutcome::NotApplicable,
            CleanupOutcome::Clean,
        ),
        TaskExecutionOutcome::RecoveryRequired { .. }
    ));
    let detached =
        TerminalOutcome::new(TerminalStatus::Detached, CleanupOutcome::NotApplicable);
    assert!(matches!(
        map_outcome(
            linkage(),
            Ok(detached),
            CleanupOutcome::NotApplicable,
            CleanupOutcome::Clean,
        ),
        TaskExecutionOutcome::RecoveryRequired { reason, .. }
            if reason.contains("provider work may continue")
    ));
    let completed =
        TerminalOutcome::new(TerminalStatus::Completed, CleanupOutcome::NotApplicable);
    assert!(matches!(
        map_outcome(
            linkage(),
            Ok(completed),
            CleanupOutcome::NotApplicable,
            CleanupOutcome::Failed(SafeDiagnostic::new("fixture.cleanup", "cleanup failed",)),
        ),
        TaskExecutionOutcome::RecoveryRequired { .. }
    ));
}

#[test]
fn completed_cancelled_and_failed_outcomes_remain_distinct() {
    assert!(matches!(
        map_outcome(
            linkage(),
            Ok(TerminalOutcome::new(
                TerminalStatus::Completed,
                CleanupOutcome::NotApplicable,
            )),
            CleanupOutcome::NotApplicable,
            CleanupOutcome::Clean,
        ),
        TaskExecutionOutcome::Completed(_)
    ));
    assert!(matches!(
        map_outcome(
            linkage(),
            Ok(TerminalOutcome::new(
                TerminalStatus::Cancelled,
                CleanupOutcome::NotApplicable,
            )),
            CleanupOutcome::NotApplicable,
            CleanupOutcome::Clean,
        ),
        TaskExecutionOutcome::Cancelled { .. }
    ));
    assert!(matches!(
        map_outcome(
            linkage(),
            Ok(TerminalOutcome::new(
                TerminalStatus::ProviderFailed(SafeDiagnostic::new(
                    "fixture.provider",
                    "provider failed",
                )),
                CleanupOutcome::NotApplicable,
            )),
            CleanupOutcome::NotApplicable,
            CleanupOutcome::Clean,
        ),
        TaskExecutionOutcome::Failed { .. }
    ));
}
