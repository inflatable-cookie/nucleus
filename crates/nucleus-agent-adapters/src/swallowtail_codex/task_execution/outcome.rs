//! Task turn outcome mapping: terminal statuses and cleanup outcomes to
//! durable task execution outcomes.
//!
//! Split from the task_execution god file; behavior unchanged.

use nucleus_agent_protocol::{TaskExecutionLinkage, TaskExecutionOutcome};
use swallowtail_adapter_codex::{
    codex_approval_request_extension, codex_user_input_request_extension,
};
use swallowtail_runtime::{CleanupOutcome, TerminalOutcome, TerminalStatus};

pub(super) fn map_outcome(
    linkage: TaskExecutionLinkage,
    terminal: Result<TerminalOutcome, String>,
    turn_cleanup: CleanupOutcome,
    session_cleanup: CleanupOutcome,
) -> TaskExecutionOutcome {
    let terminal = match terminal {
        Ok(terminal) => terminal,
        Err(reason) => {
            return TaskExecutionOutcome::RecoveryRequired {
                linkage: Some(linkage),
                reason: cleanup_reason(&reason, None, &turn_cleanup, &session_cleanup),
            };
        }
    };
    if cleanup_failed(terminal.cleanup())
        || cleanup_failed(&turn_cleanup)
        || cleanup_failed(&session_cleanup)
    {
        return TaskExecutionOutcome::RecoveryRequired {
            linkage: Some(linkage),
            reason: cleanup_reason(
                "Codex task execution ended with uncertain cleanup",
                Some(terminal.cleanup()),
                &turn_cleanup,
                &session_cleanup,
            ),
        };
    }
    match terminal.status() {
        TerminalStatus::Completed => TaskExecutionOutcome::Completed(linkage),
        TerminalStatus::Detached => TaskExecutionOutcome::RecoveryRequired {
            linkage: Some(linkage),
            reason: "Codex task observation detached while provider work may continue.".to_owned(),
        },
        TerminalStatus::Cancelled => TaskExecutionOutcome::Cancelled {
            linkage: Some(linkage),
            reason: "Codex task turn was cancelled.".to_owned(),
        },
        TerminalStatus::TimedOut => TaskExecutionOutcome::RecoveryRequired {
            linkage: Some(linkage),
            reason: "Codex task turn timed out; workspace state requires recovery review."
                .to_owned(),
        },
        TerminalStatus::ProviderRequestObserved(observation)
            if observation.namespace() == &codex_approval_request_extension() =>
        {
            TaskExecutionOutcome::WaitingForApproval(linkage)
        }
        TerminalStatus::ProviderRequestObserved(observation)
            if observation.namespace() == &codex_user_input_request_extension() =>
        {
            TaskExecutionOutcome::WaitingForUserInput(linkage)
        }
        TerminalStatus::ProviderRequestObserved(_) => TaskExecutionOutcome::Failed {
            linkage: Some(linkage),
            reason: "Codex task turn observed an undeclared provider request.".to_owned(),
        },
        TerminalStatus::ProviderFailed(diagnostic) => TaskExecutionOutcome::Failed {
            linkage: Some(linkage),
            reason: format!(
                "Codex provider failed: [{}] {}",
                diagnostic.code(),
                diagnostic.message()
            ),
        },
        TerminalStatus::HostFailed(diagnostic) => TaskExecutionOutcome::Failed {
            linkage: Some(linkage),
            reason: format!(
                "Codex host failed: [{}] {}",
                diagnostic.code(),
                diagnostic.message()
            ),
        },
        TerminalStatus::RuntimeFailed(diagnostic) => TaskExecutionOutcome::Failed {
            linkage: Some(linkage),
            reason: format!(
                "Codex runtime failed: [{}] {}",
                diagnostic.code(),
                diagnostic.message()
            ),
        },
    }
}

fn cleanup_failed(cleanup: &CleanupOutcome) -> bool {
    matches!(
        cleanup,
        CleanupOutcome::Degraded(_) | CleanupOutcome::Failed(_)
    )
}

pub(super) fn cleanup_reason(
    reason: &str,
    terminal: Option<&CleanupOutcome>,
    turn: &CleanupOutcome,
    session: &CleanupOutcome,
) -> String {
    format!(
        "{reason}; terminal_cleanup={}, turn_cleanup={}, session_cleanup={}",
        cleanup_label(terminal.unwrap_or(&CleanupOutcome::NotApplicable)),
        cleanup_label(turn),
        cleanup_label(session)
    )
}

fn cleanup_label(cleanup: &CleanupOutcome) -> &'static str {
    match cleanup {
        CleanupOutcome::Clean => "clean",
        CleanupOutcome::Degraded(_) => "degraded",
        CleanupOutcome::Failed(_) => "failed",
        CleanupOutcome::NotApplicable => "not_applicable",
    }
}
