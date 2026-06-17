//! Read-only command control API execution path.
//!
//! This module accepts structured command values from the control API and runs
//! them through the existing local read-only spawn helper. It is not a shell,
//! terminal, PTY, write-capable runner, or remote execution path.

use std::path::PathBuf;
use std::time::Duration;

use nucleus_command_policy::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandEnvironmentPolicy, CommandExecutionRequest,
    CommandExecutionStatus, CommandInvocation, CommandOutputRetention, CommandPolicyId,
    CommandRequestId, CommandRisk, CommandSandboxProfile, CommandScope,
};
use nucleus_core::RevisionId;
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreResult, RevisionExpectation,
};

use crate::commands::ReadOnlyCommand;
use crate::local_read_only_spawn_smoke::{
    build_local_read_only_spawn_smoke_input, LocalReadOnlySpawnSmokeInput,
};
use crate::runtime_receipt_state::{
    runtime_receipt_from_read_only_command_result, write_runtime_receipt,
};
use crate::server_read_only_spawn::{run_server_read_only_spawn, ServerReadOnlySpawnInput};
use crate::state::ServerStateService;
use crate::{LocalReadOnlySpawnInput, LocalReadOnlySpawnOutcome, LocalReadOnlySpawnRejection};

/// Sanitized result returned to control-plane clients.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadOnlyCommandControlResult {
    pub command_id: crate::ServerCommandId,
    pub command_request_id: CommandRequestId,
    pub evidence_id: nucleus_command_policy::CommandEvidenceId,
    pub status: CommandExecutionStatus,
    pub exit_status: Option<i32>,
    pub retention: CommandOutputRetention,
    pub summary: Option<String>,
    pub stdout_captured_bytes: usize,
    pub stderr_captured_bytes: usize,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub events: usize,
    pub rejection: Option<ReadOnlyCommandControlRejection>,
}

/// Sanitized rejection detail for client rendering.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReadOnlyCommandControlRejection {
    HostReadinessBlocked { blockers: usize },
    RunnerRejected { reasons: Vec<String> },
    SpawnFailed { reason: String },
}

/// Execute a local read-only control command and persist sanitized evidence.
pub fn run_read_only_command_control<B>(
    state: &ServerStateService<B>,
    command_id: crate::ServerCommandId,
    command: ReadOnlyCommand,
    artifact_store_root: PathBuf,
) -> LocalStoreResult<ReadOnlyCommandControlResult>
where
    B: LocalStoreBackend,
{
    let command_request_id = CommandRequestId(format!("{}:request", command_id.0));
    let mut input = build_local_read_only_spawn_input(
        &command_id,
        &command_request_id,
        command,
        artifact_store_root,
    )?;
    input.spawn.request.id = command_request_id.clone();
    input.spawn.invocation.command_request_id = command_request_id.clone();

    let result = run_server_read_only_spawn(state, input)?;
    let rejection = control_rejection(&result.spawn.outcome, &result.spawn.rejection);
    let evidence = result.spawn.evidence;

    let control_result = ReadOnlyCommandControlResult {
        command_id,
        command_request_id,
        evidence_id: evidence.id,
        status: evidence.status,
        exit_status: evidence.exit_status,
        retention: evidence.retention,
        summary: evidence.summary,
        stdout_captured_bytes: result.spawn.output.stdout_captured_bytes,
        stderr_captured_bytes: result.spawn.output.stderr_captured_bytes,
        stdout_truncated: result.spawn.output.stdout_truncated,
        stderr_truncated: result.spawn.output.stderr_truncated,
        events: result.spawn.events.len(),
        rejection,
    };
    let receipt = runtime_receipt_from_read_only_command_result(&control_result);
    write_runtime_receipt(
        state,
        &receipt,
        RevisionId(format!(
            "rev:{}:runtime-receipt:1",
            control_result.command_id.0
        )),
        RevisionExpectation::Any,
    )?;

    Ok(control_result)
}

fn build_local_read_only_spawn_input(
    command_id: &crate::ServerCommandId,
    command_request_id: &CommandRequestId,
    command: ReadOnlyCommand,
    artifact_store_root: PathBuf,
) -> LocalStoreResult<ServerReadOnlySpawnInput> {
    let working_directory = command.working_directory.clone();
    let mut input = build_local_read_only_spawn_smoke_input(LocalReadOnlySpawnSmokeInput {
        project_id: command.project_id.clone(),
        execution_host_id: command.execution_host_id.clone(),
        working_directory: working_directory.clone(),
        artifact_store_root,
        first_sequence: crate::ServerEventSequence(700),
        evidence_revision_id: RevisionId(format!("rev:{}:read-only-command:1", command_id.0)),
        evidence_revision: RevisionExpectation::Any,
    })
    .map_err(|error| LocalStoreError::InvalidRecord {
        reason: format!("failed to build read-only command readiness: {error:?}"),
    })?;

    input.spawn = LocalReadOnlySpawnInput {
        project_id: command.project_id,
        execution_host_id: command.execution_host_id,
        request: CommandExecutionRequest {
            id: command_request_id.clone(),
            policy_id: Some(CommandPolicyId(
                "command:policy:local-readonly-control".to_owned(),
            )),
            authority_area: CommandAuthorityArea::Validation,
            scope: CommandScope::ReadOnlyInspection,
            risk: CommandRisk::Low,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            approval: CommandApprovalPolicy::AutoAllowed,
            command_display: command.command_display,
            working_directory_hint: Some(working_directory.display().to_string()),
        },
        invocation: CommandInvocation {
            command_request_id: command_request_id.clone(),
            executable: command.executable,
            argv: command.argv,
            working_directory,
            timeout: Duration::from_millis(command.timeout_ms),
            stdout_limit_bytes: command.stdout_limit_bytes,
            stderr_limit_bytes: command.stderr_limit_bytes,
            environment_policy: CommandEnvironmentPolicy::MinimalInheritedSafe,
            sandbox: CommandSandboxProfile::NoFilesystemWrite,
            output_retention: CommandOutputRetention::SummaryOnly,
        },
        host_gate: input.spawn.host_gate,
        first_sequence: input.spawn.first_sequence,
    };

    Ok(input)
}

fn control_rejection(
    outcome: &LocalReadOnlySpawnOutcome,
    rejection: &Option<LocalReadOnlySpawnRejection>,
) -> Option<ReadOnlyCommandControlRejection> {
    match rejection {
        Some(LocalReadOnlySpawnRejection::HostReadinessBlocked(blockers)) => {
            Some(ReadOnlyCommandControlRejection::HostReadinessBlocked {
                blockers: blockers.len(),
            })
        }
        Some(LocalReadOnlySpawnRejection::RunnerRejected(rejections)) => {
            Some(ReadOnlyCommandControlRejection::RunnerRejected {
                reasons: rejections
                    .iter()
                    .map(|rejection| format!("{rejection:?}"))
                    .collect(),
            })
        }
        None => match outcome {
            LocalReadOnlySpawnOutcome::SpawnFailed(error) => {
                Some(ReadOnlyCommandControlRejection::SpawnFailed {
                    reason: format!("{error:?}"),
                })
            }
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests;
