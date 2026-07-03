use serde::{Deserialize, Serialize};

use crate::control_envelope_dto::response::helpers::{command_execution_status_dto, retention_dto};
use crate::control_envelope_dto::response::ControlResponseBodyDto;
use crate::read_only_command_control::{
    ReadOnlyCommandControlRejection, ReadOnlyCommandControlResult,
};

/// Serializable sanitized rejection for read-only command results.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlReadOnlyCommandRejectionDto {
    HostReadinessBlocked { blockers: usize },
    RunnerRejected { reasons: Vec<String> },
    SpawnFailed { reason: String },
}

pub(super) fn read_only_command_result_dto(
    result: &ReadOnlyCommandControlResult,
) -> ControlResponseBodyDto {
    ControlResponseBodyDto::ReadOnlyCommandResult {
        command_id: result.command_id.0.clone(),
        command_request_id: result.command_request_id.0.clone(),
        evidence_id: result.evidence_id.0.clone(),
        status: command_execution_status_dto(&result.status),
        exit_status: result.exit_status,
        retention: retention_dto(&result.retention),
        summary: result.summary.clone(),
        stdout_captured_bytes: result.stdout_captured_bytes,
        stderr_captured_bytes: result.stderr_captured_bytes,
        stdout_truncated: result.stdout_truncated,
        stderr_truncated: result.stderr_truncated,
        events: result.events,
        rejection: result.rejection.as_ref().map(read_only_rejection_dto),
    }
}

fn read_only_rejection_dto(
    rejection: &ReadOnlyCommandControlRejection,
) -> ControlReadOnlyCommandRejectionDto {
    match rejection {
        ReadOnlyCommandControlRejection::HostReadinessBlocked { blockers } => {
            ControlReadOnlyCommandRejectionDto::HostReadinessBlocked {
                blockers: *blockers,
            }
        }
        ReadOnlyCommandControlRejection::RunnerRejected { reasons } => {
            ControlReadOnlyCommandRejectionDto::RunnerRejected {
                reasons: reasons.clone(),
            }
        }
        ReadOnlyCommandControlRejection::SpawnFailed { reason } => {
            ControlReadOnlyCommandRejectionDto::SpawnFailed {
                reason: reason.clone(),
            }
        }
    }
}
