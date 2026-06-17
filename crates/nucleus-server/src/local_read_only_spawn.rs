//! First bounded read-only local spawn boundary.
//!
//! This module runs a structured local command only after host-spawn readiness
//! is ready and the read-only command policy gates pass. It rejects shell
//! passthrough and PTY-shaped work. It captures bounded output for summary
//! counts only and returns sanitized evidence/events without raw stdout or
//! stderr payloads.

use nucleus_command_policy::{
    CommandExecutionStatus, CommandProcessSupervisionEventKind, CommandProcessSupervisionStatus,
    CommandProcessTerminalStatus,
};

use evidence::{command_evidence, summarize_runner_rejections, supervision_event};
use spawn::spawn_and_wait;

use crate::host_spawn_readiness::HostSpawnReadinessStatus;
use crate::local_command_runner::LocalReadOnlyCommandRunner;

mod evidence;
mod spawn;
mod types;

pub use types::{
    LocalReadOnlySpawnError, LocalReadOnlySpawnInput, LocalReadOnlySpawnOutcome,
    LocalReadOnlySpawnOutputSummary, LocalReadOnlySpawnRejection, LocalReadOnlySpawnResult,
};

/// Run one bounded read-only structured invocation.
pub fn run_local_read_only_spawn(input: LocalReadOnlySpawnInput) -> LocalReadOnlySpawnResult {
    if input.host_gate.status != HostSpawnReadinessStatus::Ready {
        return LocalReadOnlySpawnResult::blocked(
            command_evidence(
                &input.request,
                CommandExecutionStatus::BlockedByPolicy,
                None,
                "host-spawn readiness blocked before execution".to_owned(),
            ),
            LocalReadOnlySpawnRejection::HostReadinessBlocked(input.host_gate.blockers),
        );
    }

    let runner = LocalReadOnlyCommandRunner::default();
    let rejections = runner.rejections(&input.request, &input.invocation);
    if !rejections.is_empty() {
        return LocalReadOnlySpawnResult::blocked(
            command_evidence(
                &input.request,
                CommandExecutionStatus::BlockedByPolicy,
                None,
                format!(
                    "read-only spawn blocked before execution: {}",
                    summarize_runner_rejections(&rejections)
                ),
            ),
            LocalReadOnlySpawnRejection::RunnerRejected(rejections),
        );
    }

    let accepted = supervision_event(
        &input,
        0,
        CommandProcessSupervisionEventKind::Accepted,
        CommandProcessSupervisionStatus::Accepted,
        None,
        Some("read-only spawn accepted".to_owned()),
    );

    match spawn_and_wait(&input.invocation) {
        Err(error) => {
            let failed_evidence = command_evidence(
                &input.request,
                CommandExecutionStatus::Failed,
                None,
                format!("read-only spawn failed before running: {}", error.summary()),
            );
            let terminal = supervision_event(
                &input,
                1,
                CommandProcessSupervisionEventKind::Terminal,
                CommandProcessSupervisionStatus::Terminal,
                Some(CommandProcessTerminalStatus::Failed),
                Some("read-only spawn failed before running".to_owned()),
            );

            LocalReadOnlySpawnResult::completed(
                LocalReadOnlySpawnOutcome::SpawnFailed(error),
                failed_evidence,
                vec![accepted, terminal],
                LocalReadOnlySpawnOutputSummary::default(),
            )
        }
        Ok(spawn_result) => {
            let running = supervision_event(
                &input,
                1,
                CommandProcessSupervisionEventKind::Running,
                CommandProcessSupervisionStatus::Running,
                None,
                Some("read-only spawn running".to_owned()),
            );
            let terminal_status = if spawn_result.timed_out {
                CommandProcessTerminalStatus::TimedOut
            } else if spawn_result.exit_status == Some(0) {
                CommandProcessTerminalStatus::Succeeded
            } else {
                CommandProcessTerminalStatus::Failed
            };
            let status = match terminal_status {
                CommandProcessTerminalStatus::Succeeded => CommandExecutionStatus::Succeeded,
                CommandProcessTerminalStatus::Failed => CommandExecutionStatus::Failed,
                CommandProcessTerminalStatus::Cancelled => CommandExecutionStatus::Cancelled,
                CommandProcessTerminalStatus::TimedOut => CommandExecutionStatus::TimedOut,
            };
            let terminal = supervision_event(
                &input,
                2,
                CommandProcessSupervisionEventKind::Terminal,
                CommandProcessSupervisionStatus::Terminal,
                Some(terminal_status),
                Some("read-only spawn terminal status recorded".to_owned()),
            );
            let evidence = command_evidence(
                &input.request,
                status,
                spawn_result.exit_status,
                spawn_result.summary(),
            );

            LocalReadOnlySpawnResult::completed(
                LocalReadOnlySpawnOutcome::Finished,
                evidence,
                vec![accepted, running, terminal],
                spawn_result.output,
            )
        }
    }
}

#[cfg(test)]
mod tests;
