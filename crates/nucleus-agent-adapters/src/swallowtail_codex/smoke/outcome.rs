//! Codex read-only smoke outcome composition.
//!
//! Split from the smoke god file; behavior unchanged.

use swallowtail_runtime::{CleanupOutcome, TerminalOutcome, TerminalStatus};

use super::drive::SmokeObservation;
use super::CodexReadOnlySmokeCleanup;
use super::CodexReadOnlySmokeOutcome;
use super::CodexReadOnlySmokeStatus;

pub(super) fn finish_outcome(
    thread_id: String,
    turn_id: String,
    observation: SmokeObservation,
    turn_cleanup: CleanupOutcome,
    session_cleanup: CleanupOutcome,
) -> CodexReadOnlySmokeOutcome {
    let cleanup = combined_cleanup(
        observation
            .terminal
            .as_ref()
            .ok()
            .map(TerminalOutcome::cleanup),
        &turn_cleanup,
        &session_cleanup,
    );
    let (turn_status, mut status) = match observation.terminal {
        Ok(terminal) => terminal_status(terminal.status()),
        Err(reason) => (
            "runtime_failed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(reason),
        ),
    };
    if let CodexReadOnlySmokeCleanup::Failed(reason) = &cleanup {
        status = CodexReadOnlySmokeStatus::CleanupRequired(reason.clone());
    }
    CodexReadOnlySmokeOutcome {
        provider_turn_started: true,
        thread_id,
        turn_id,
        turn_status,
        events_seen: observation.events_seen,
        provider_requests_seen: observation.provider_requests_seen,
        status,
        cleanup,
    }
}

pub(super) fn terminal_status(status: &TerminalStatus) -> (String, CodexReadOnlySmokeStatus) {
    match status {
        TerminalStatus::Completed => ("completed".to_owned(), CodexReadOnlySmokeStatus::Completed),
        TerminalStatus::Detached => (
            "detached".to_owned(),
            CodexReadOnlySmokeStatus::Failed(
                "Codex diagnostic observation detached while provider work may continue".to_owned(),
            ),
        ),
        TerminalStatus::TimedOut => ("timed_out".to_owned(), CodexReadOnlySmokeStatus::TimedOut),
        TerminalStatus::Cancelled => (
            "cancelled".to_owned(),
            CodexReadOnlySmokeStatus::Failed("Codex diagnostic turn was cancelled".to_owned()),
        ),
        TerminalStatus::ProviderRequestObserved(_) => (
            "provider_request_observed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(
                "Codex diagnostic observed a disallowed provider request".to_owned(),
            ),
        ),
        TerminalStatus::ProviderFailed(diagnostic) => (
            "provider_failed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(format!(
                "Codex provider failed: [{}] {}",
                diagnostic.code(),
                diagnostic.message()
            )),
        ),
        TerminalStatus::HostFailed(diagnostic) => (
            "host_failed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(format!(
                "Codex host failed: [{}] {}",
                diagnostic.code(),
                diagnostic.message()
            )),
        ),
        TerminalStatus::RuntimeFailed(diagnostic) => (
            "runtime_failed".to_owned(),
            CodexReadOnlySmokeStatus::Failed(format!(
                "Codex runtime failed: [{}] {}",
                diagnostic.code(),
                diagnostic.message()
            )),
        ),
    }
}

pub(super) fn cleanup_label(cleanup: &CleanupOutcome) -> &'static str {
    match cleanup {
        CleanupOutcome::Clean => "clean",
        CleanupOutcome::Degraded(_) => "degraded",
        CleanupOutcome::Failed(_) => "failed",
        CleanupOutcome::NotApplicable => "not_applicable",
    }
}

fn combined_cleanup(
    terminal: Option<&CleanupOutcome>,
    turn: &CleanupOutcome,
    session: &CleanupOutcome,
) -> CodexReadOnlySmokeCleanup {
    if [terminal, Some(turn), Some(session)]
        .into_iter()
        .flatten()
        .any(cleanup_failed)
    {
        CodexReadOnlySmokeCleanup::Failed(format!(
            "terminal_cleanup={}, turn_cleanup={}, session_cleanup={}",
            terminal.map(cleanup_label).unwrap_or("unknown"),
            cleanup_label(turn),
            cleanup_label(session)
        ))
    } else {
        CodexReadOnlySmokeCleanup::Completed
    }
}

fn cleanup_failed(cleanup: &CleanupOutcome) -> bool {
    matches!(
        cleanup,
        CleanupOutcome::Degraded(_) | CleanupOutcome::Failed(_)
    )
}
