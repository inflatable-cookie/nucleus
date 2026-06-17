use serde::{Deserialize, Serialize};

use nucleus_command_policy::{
    command_evidence_from_storage_record, decode_command_evidence_storage_record, CommandEvidence,
};

use crate::control_api::{
    ServerCommandReceiptStatus, ServerControlError, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
    ServerStateRecordSet,
};
use crate::control_serialization_readiness::{
    CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};
use crate::read_only_command_control::{
    ReadOnlyCommandControlRejection, ReadOnlyCommandControlResult,
};
use crate::runtime_readiness_diagnostics::{
    RuntimeReadinessBlocker, RuntimeReadinessDiagnostics, RuntimeReadinessStatus,
    RuntimeReadinessSurface,
};
use crate::state::ServerStateDomain;

use super::{
    ControlApiCodecError, ControlProjectRecordDto, ControlStateRecordDto, ControlTaskRecordDto,
};

/// Serializable response envelope for the first control API wire format.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlResponseEnvelopeDto {
    pub protocol_family: String,
    pub protocol_version: u16,
    pub request_id: String,
    pub status: ControlResponseStatusDto,
    pub body: ControlResponseBodyDto,
}

impl TryFrom<&ServerControlResponse> for ControlResponseEnvelopeDto {
    type Error = ControlApiCodecError;

    fn try_from(response: &ServerControlResponse) -> Result<Self, Self::Error> {
        Ok(Self {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: response.request_id.0.clone(),
            status: ControlResponseStatusDto::from(&response.status),
            body: ControlResponseBodyDto::try_from(&response.body)?,
        })
    }
}

/// Serializable response status DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlResponseStatusDto {
    Accepted,
    Complete,
    Rejected,
    Partial,
}

impl From<&ServerControlResponseStatus> for ControlResponseStatusDto {
    fn from(status: &ServerControlResponseStatus) -> Self {
        match status {
            ServerControlResponseStatus::Accepted => Self::Accepted,
            ServerControlResponseStatus::Complete => Self::Complete,
            ServerControlResponseStatus::Rejected => Self::Rejected,
            ServerControlResponseStatus::Partial => Self::Partial,
        }
    }
}

/// Serializable response body DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponseBodyDto {
    QueryEmpty,
    QueryUnsupported {
        reason: String,
    },
    StateRecords {
        domain: String,
        records: Vec<ControlStateRecordDto>,
    },
    ProjectRecords {
        records: Vec<ControlProjectRecordDto>,
    },
    TaskRecords {
        records: Vec<ControlTaskRecordDto>,
    },
    CommandEvidenceRecords {
        records: Vec<ControlCommandEvidenceRecordDto>,
    },
    RuntimeReadinessDiagnostics {
        records: Vec<ControlRuntimeReadinessDiagnosticDto>,
    },
    CommandReceipt {
        command_id: String,
        status: String,
    },
    ReadOnlyCommandResult {
        command_id: String,
        command_request_id: String,
        evidence_id: String,
        status: String,
        exit_status: Option<i32>,
        retention: String,
        summary: Option<String>,
        stdout_captured_bytes: usize,
        stderr_captured_bytes: usize,
        stdout_truncated: bool,
        stderr_truncated: bool,
        events: usize,
        rejection: Option<ControlReadOnlyCommandRejectionDto>,
    },
    Error {
        kind: String,
        reason: String,
    },
}

impl TryFrom<&ServerControlResponseBody> for ControlResponseBodyDto {
    type Error = ControlApiCodecError;

    fn try_from(
        body: &ServerControlResponseBody,
    ) -> Result<Self, <ControlResponseBodyDto as TryFrom<&ServerControlResponseBody>>::Error> {
        match body {
            ServerControlResponseBody::Query(ServerQueryResult::Empty) => Ok(Self::QueryEmpty),
            ServerControlResponseBody::Query(ServerQueryResult::Unsupported { reason }) => {
                Ok(Self::QueryUnsupported {
                    reason: reason.clone(),
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::StateRecords(records))
            | ServerControlResponseBody::Query(ServerQueryResult::AdapterSessions(records))
            | ServerControlResponseBody::Query(ServerQueryResult::ModelRoutes(records))
            | ServerControlResponseBody::Query(ServerQueryResult::RuntimeMetadata(records)) => {
                state_record_set_dto(records)
            }
            ServerControlResponseBody::Query(ServerQueryResult::RuntimeReadiness(records)) => {
                Ok(Self::RuntimeReadinessDiagnostics {
                    records: records
                        .iter()
                        .map(ControlRuntimeReadinessDiagnosticDto::from)
                        .collect(),
                })
            }
            ServerControlResponseBody::Command(receipt) => Ok(Self::CommandReceipt {
                command_id: receipt.command_id.0.clone(),
                status: command_receipt_status_dto(&receipt.status),
            }),
            ServerControlResponseBody::ReadOnlyCommand(result) => {
                Ok(read_only_command_result_dto(result))
            }
            ServerControlResponseBody::Error(error) => {
                let (kind, reason) = control_error_dto(error);
                Ok(Self::Error { kind, reason })
            }
        }
    }
}

/// Serializable sanitized rejection for read-only command results.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlReadOnlyCommandRejectionDto {
    HostReadinessBlocked { blockers: usize },
    RunnerRejected { reasons: Vec<String> },
    SpawnFailed { reason: String },
}

/// Serializable command evidence history record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlCommandEvidenceRecordDto {
    pub evidence_id: String,
    pub command_request_id: String,
    pub status: String,
    pub exit_status: Option<i32>,
    pub retention: String,
    pub summary: Option<String>,
    pub stdout_artifact_ref: Option<String>,
    pub stderr_artifact_ref: Option<String>,
}

/// Serializable sanitized runtime readiness diagnostics record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRuntimeReadinessDiagnosticDto {
    pub host_id: String,
    pub runtime_surface: String,
    pub status: String,
    pub blockers: Vec<ControlRuntimeReadinessBlockerDto>,
    pub evidence_refs: Vec<String>,
    pub repair_hints: Vec<String>,
    pub summary: Option<String>,
}

/// Serializable sanitized runtime readiness blocker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRuntimeReadinessBlockerDto {
    pub source: String,
    pub code: String,
    pub message: String,
}

impl From<&CommandEvidence> for ControlCommandEvidenceRecordDto {
    fn from(evidence: &CommandEvidence) -> Self {
        Self {
            evidence_id: evidence.id.0.clone(),
            command_request_id: evidence.request_id.0.clone(),
            status: command_execution_status_dto(&evidence.status),
            exit_status: evidence.exit_status,
            retention: retention_dto(&evidence.retention),
            summary: evidence.summary.clone(),
            stdout_artifact_ref: evidence.stdout_artifact_ref.clone(),
            stderr_artifact_ref: evidence.stderr_artifact_ref.clone(),
        }
    }
}

impl From<&RuntimeReadinessDiagnostics> for ControlRuntimeReadinessDiagnosticDto {
    fn from(diagnostics: &RuntimeReadinessDiagnostics) -> Self {
        Self {
            host_id: diagnostics.host_id.0.clone(),
            runtime_surface: runtime_surface_dto(&diagnostics.surface),
            status: runtime_readiness_status_dto(&diagnostics.status),
            blockers: diagnostics
                .blockers
                .iter()
                .map(ControlRuntimeReadinessBlockerDto::from)
                .collect(),
            evidence_refs: diagnostics.evidence_refs.clone(),
            repair_hints: diagnostics.repair_hints.clone(),
            summary: diagnostics.summary.clone(),
        }
    }
}

impl From<&RuntimeReadinessBlocker> for ControlRuntimeReadinessBlockerDto {
    fn from(blocker: &RuntimeReadinessBlocker) -> Self {
        Self {
            source: blocker.source.clone(),
            code: blocker.code.clone(),
            message: blocker.message.clone(),
        }
    }
}

fn read_only_command_result_dto(result: &ReadOnlyCommandControlResult) -> ControlResponseBodyDto {
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

fn runtime_surface_dto(surface: &RuntimeReadinessSurface) -> String {
    match surface {
        RuntimeReadinessSurface::LocalHostCommandExecution => "local_host_command_execution",
    }
    .to_owned()
}

fn runtime_readiness_status_dto(status: &RuntimeReadinessStatus) -> String {
    match status {
        RuntimeReadinessStatus::Ready => "ready",
        RuntimeReadinessStatus::Degraded => "degraded",
        RuntimeReadinessStatus::Unsupported => "unsupported",
    }
    .to_owned()
}

fn command_execution_status_dto(status: &nucleus_command_policy::CommandExecutionStatus) -> String {
    match status {
        nucleus_command_policy::CommandExecutionStatus::Accepted => "accepted",
        nucleus_command_policy::CommandExecutionStatus::Rejected => "rejected",
        nucleus_command_policy::CommandExecutionStatus::Queued => "queued",
        nucleus_command_policy::CommandExecutionStatus::Running => "running",
        nucleus_command_policy::CommandExecutionStatus::Succeeded => "succeeded",
        nucleus_command_policy::CommandExecutionStatus::Failed => "failed",
        nucleus_command_policy::CommandExecutionStatus::Cancelled => "cancelled",
        nucleus_command_policy::CommandExecutionStatus::TimedOut => "timed_out",
        nucleus_command_policy::CommandExecutionStatus::BlockedByPolicy => "blocked_by_policy",
    }
    .to_owned()
}

fn retention_dto(retention: &nucleus_command_policy::CommandOutputRetention) -> String {
    match retention {
        nucleus_command_policy::CommandOutputRetention::Discard => "discard",
        nucleus_command_policy::CommandOutputRetention::SummaryOnly => "summary_only",
        nucleus_command_policy::CommandOutputRetention::ArtifactReference => "artifact_reference",
        nucleus_command_policy::CommandOutputRetention::FullArtifactWithApproval => {
            "full_artifact_with_approval"
        }
    }
    .to_owned()
}

fn state_record_set_dto(
    records: &ServerStateRecordSet,
) -> Result<ControlResponseBodyDto, ControlApiCodecError> {
    if records.domain == ServerStateDomain::Projects {
        return Ok(ControlResponseBodyDto::ProjectRecords {
            records: records
                .records
                .iter()
                .map(ControlProjectRecordDto::try_from)
                .collect::<Result<Vec<_>, _>>()?,
        });
    }

    if records.domain == ServerStateDomain::Tasks {
        return Ok(ControlResponseBodyDto::TaskRecords {
            records: records
                .records
                .iter()
                .map(ControlTaskRecordDto::try_from)
                .collect::<Result<Vec<_>, _>>()?,
        });
    }

    if records.domain == ServerStateDomain::CommandEvidence {
        return Ok(ControlResponseBodyDto::CommandEvidenceRecords {
            records: records
                .records
                .iter()
                .map(|record| {
                    decode_command_evidence_storage_record(&record.payload.bytes)
                        .map_err(|error| {
                            ControlApiCodecError::malformed(format!(
                                "failed to decode command evidence {}: {}",
                                record.id.0, error.reason
                            ))
                        })
                        .map(|decoded| command_evidence_from_storage_record(&decoded))
                        .map(|evidence| ControlCommandEvidenceRecordDto::from(&evidence))
                })
                .collect::<Result<Vec<_>, _>>()?,
        });
    }

    Ok(ControlResponseBodyDto::StateRecords {
        domain: format!("{:?}", records.domain),
        records: records
            .records
            .iter()
            .map(ControlStateRecordDto::from)
            .collect(),
    })
}

fn control_error_dto(error: &ServerControlError) -> (String, String) {
    match error {
        ServerControlError::Unauthorized { reason } => ("unauthorized".to_owned(), reason.clone()),
        ServerControlError::Unsupported { reason } => ("unsupported".to_owned(), reason.clone()),
        ServerControlError::InvalidRequest { reason } => {
            ("invalid_request".to_owned(), reason.clone())
        }
        ServerControlError::NotFound { reason } => ("not_found".to_owned(), reason.clone()),
        ServerControlError::Conflict { reason } => ("conflict".to_owned(), reason.clone()),
        ServerControlError::StorageUnavailable { reason } => {
            ("storage_unavailable".to_owned(), reason.clone())
        }
        ServerControlError::RuntimeUnavailable { reason } => {
            ("runtime_unavailable".to_owned(), reason.clone())
        }
        ServerControlError::Deferred { reason } => ("deferred".to_owned(), reason.clone()),
    }
}

fn command_receipt_status_dto(status: &ServerCommandReceiptStatus) -> String {
    match status {
        ServerCommandReceiptStatus::AcceptedForStateMutation => {
            "accepted_for_state_mutation".to_owned()
        }
        ServerCommandReceiptStatus::AcceptedForRuntimeScheduling => {
            "accepted_for_runtime_scheduling".to_owned()
        }
        ServerCommandReceiptStatus::Rejected(_) => "rejected".to_owned(),
    }
}
