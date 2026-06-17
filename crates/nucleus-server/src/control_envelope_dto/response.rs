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
    RuntimeReceiptRecords {
        records: Vec<ControlRuntimeReceiptRecordDto>,
    },
    CheckpointRecords {
        records: Vec<ControlCheckpointRecordDto>,
    },
    DiffSummaryRecords {
        records: Vec<ControlDiffSummaryRecordDto>,
    },
    RuntimeReadinessDiagnostics {
        records: Vec<ControlRuntimeReadinessDiagnosticDto>,
    },
    TaskTimeline {
        task_id: String,
        entries: Vec<ControlTaskTimelineEntryDto>,
        last_source_event_id: Option<String>,
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
            ServerControlResponseBody::Query(ServerQueryResult::RuntimeReceipts(records)) => {
                Ok(Self::RuntimeReceiptRecords {
                    records: records
                        .iter()
                        .map(ControlRuntimeReceiptRecordDto::from)
                        .collect(),
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::CheckpointRecords(records)) => {
                Ok(Self::CheckpointRecords {
                    records: records
                        .iter()
                        .map(ControlCheckpointRecordDto::from)
                        .collect(),
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::DiffSummaryRecords(records)) => {
                Ok(Self::DiffSummaryRecords {
                    records: records
                        .iter()
                        .map(ControlDiffSummaryRecordDto::from)
                        .collect(),
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::TaskTimeline(projection)) => {
                Ok(Self::TaskTimeline {
                    task_id: projection.task_id.0.clone(),
                    entries: projection
                        .entries
                        .iter()
                        .map(ControlTaskTimelineEntryDto::from)
                        .collect(),
                    last_source_event_id: projection
                        .last_cursor
                        .as_ref()
                        .map(|cursor| cursor.source_event_id.clone()),
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

/// Serializable sanitized runtime receipt record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRuntimeReceiptRecordDto {
    pub receipt_id: String,
    pub family: String,
    pub status: String,
    pub command_ref: Option<String>,
    pub effect_ref: Option<String>,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub summary: Option<String>,
}

/// Serializable sanitized checkpoint record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlCheckpointRecordDto {
    pub checkpoint_id: String,
    pub family: String,
    pub primary_workflow_ref: String,
    pub project_ref: String,
    pub source_ref: Option<String>,
    pub scm_adapter_ref: Option<String>,
    pub authority_host_ref: String,
    pub created_by_actor_ref: String,
    pub causal_refs: Vec<String>,
    pub parent_checkpoint_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub summary: Option<String>,
    pub recovery_state: String,
}

/// Serializable sanitized diff summary record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlDiffSummaryRecordDto {
    pub diff_id: String,
    pub kind: String,
    pub source_boundary_ref: String,
    pub target_boundary_ref: String,
    pub source_ref: Option<String>,
    pub adapter_ref: Option<String>,
    pub generated_by_ref: String,
    pub confidence: String,
    pub summary: String,
    pub changed_paths: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
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

/// Serializable task timeline entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskTimelineEntryDto {
    pub entry_id: String,
    pub task_id: String,
    pub kind: String,
    pub source_command_id: String,
    pub source_event_id: String,
    pub source_projection_id: String,
    pub summary: String,
}

impl From<&nucleus_engine::EngineTaskTimelineEntry> for ControlTaskTimelineEntryDto {
    fn from(entry: &nucleus_engine::EngineTaskTimelineEntry) -> Self {
        Self {
            entry_id: entry.entry_id.0.clone(),
            task_id: entry.task_id.0.clone(),
            kind: match entry.kind {
                nucleus_engine::EngineTaskTimelineEntryKind::TaskCommandAdmitted => {
                    "task_command_admitted".to_owned()
                }
            },
            source_command_id: entry.source_command_id.clone(),
            source_event_id: entry.source_event_id.clone(),
            source_projection_id: entry.source_cursor.projection_id.clone(),
            summary: entry.summary.text.clone(),
        }
    }
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

impl From<&nucleus_engine::EngineRuntimeReceiptRecord> for ControlRuntimeReceiptRecordDto {
    fn from(receipt: &nucleus_engine::EngineRuntimeReceiptRecord) -> Self {
        Self {
            receipt_id: receipt.receipt_id.0.clone(),
            family: runtime_receipt_family_dto(&receipt.family),
            status: runtime_receipt_status_dto(&receipt.status),
            command_ref: receipt.command_ref.as_ref().map(runtime_receipt_ref_dto),
            effect_ref: receipt.effect_ref.as_ref().map(runtime_receipt_ref_dto),
            evidence_refs: receipt
                .evidence_refs
                .iter()
                .map(runtime_receipt_ref_dto)
                .collect(),
            artifact_refs: receipt
                .artifact_refs
                .iter()
                .map(runtime_receipt_ref_dto)
                .collect(),
            summary: receipt.summary.clone(),
        }
    }
}

impl From<&nucleus_engine::EngineCheckpointRecord> for ControlCheckpointRecordDto {
    fn from(record: &nucleus_engine::EngineCheckpointRecord) -> Self {
        Self {
            checkpoint_id: record.checkpoint_id.0.clone(),
            family: checkpoint_family_dto(&record.family),
            primary_workflow_ref: checkpoint_ref_dto(&record.primary_workflow_ref),
            project_ref: checkpoint_ref_dto(&record.project_ref),
            source_ref: record.source_ref.as_ref().map(checkpoint_ref_dto),
            scm_adapter_ref: record.scm_adapter_ref.as_ref().map(checkpoint_ref_dto),
            authority_host_ref: checkpoint_ref_dto(&record.authority_host_ref),
            created_by_actor_ref: checkpoint_ref_dto(&record.created_by_actor_ref),
            causal_refs: record.causal_refs.iter().map(checkpoint_ref_dto).collect(),
            parent_checkpoint_refs: record
                .parent_checkpoint_refs
                .iter()
                .map(checkpoint_ref_dto)
                .collect(),
            artifact_refs: record
                .artifact_refs
                .iter()
                .map(checkpoint_ref_dto)
                .collect(),
            summary: record.summary.clone(),
            recovery_state: checkpoint_recovery_state_dto(&record.recovery_state),
        }
    }
}

impl From<&nucleus_engine::EngineDiffSummaryRecord> for ControlDiffSummaryRecordDto {
    fn from(record: &nucleus_engine::EngineDiffSummaryRecord) -> Self {
        Self {
            diff_id: record.diff_id.0.clone(),
            kind: diff_summary_kind_dto(&record.kind),
            source_boundary_ref: checkpoint_ref_dto(&record.source_boundary_ref),
            target_boundary_ref: checkpoint_ref_dto(&record.target_boundary_ref),
            source_ref: record.source_ref.as_ref().map(checkpoint_ref_dto),
            adapter_ref: record.adapter_ref.as_ref().map(checkpoint_ref_dto),
            generated_by_ref: checkpoint_ref_dto(&record.generated_by_ref),
            confidence: diff_summary_confidence_dto(&record.confidence),
            summary: record.summary.clone(),
            changed_paths: record.changed_paths.clone(),
            evidence_refs: record
                .evidence_refs
                .iter()
                .map(checkpoint_ref_dto)
                .collect(),
            artifact_refs: record
                .artifact_refs
                .iter()
                .map(checkpoint_ref_dto)
                .collect(),
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

fn runtime_receipt_family_dto(family: &nucleus_engine::EngineRuntimeReceiptEffectFamily) -> String {
    match family {
        nucleus_engine::EngineRuntimeReceiptEffectFamily::CommandExecution => "command_execution",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::HarnessProvider => "harness_provider",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::ToolCall => "tool_call",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::ScmForge => "scm_forge",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::CheckpointDiff => "checkpoint_diff",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::Research => "research",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::Memory => "memory",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::Effigy => "effigy",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::Steward => "steward",
        nucleus_engine::EngineRuntimeReceiptEffectFamily::Custom(value) => value,
    }
    .to_owned()
}

fn runtime_receipt_status_dto(status: &nucleus_engine::EngineRuntimeReceiptStatus) -> String {
    match status {
        nucleus_engine::EngineRuntimeReceiptStatus::Accepted => "accepted",
        nucleus_engine::EngineRuntimeReceiptStatus::Queued => "queued",
        nucleus_engine::EngineRuntimeReceiptStatus::Started => "started",
        nucleus_engine::EngineRuntimeReceiptStatus::InProgress => "in_progress",
        nucleus_engine::EngineRuntimeReceiptStatus::WaitingForApproval => "waiting_for_approval",
        nucleus_engine::EngineRuntimeReceiptStatus::WaitingForUserInput => "waiting_for_user_input",
        nucleus_engine::EngineRuntimeReceiptStatus::Blocked => "blocked",
        nucleus_engine::EngineRuntimeReceiptStatus::Completed => "completed",
        nucleus_engine::EngineRuntimeReceiptStatus::CompletedWithWarnings => {
            "completed_with_warnings"
        }
        nucleus_engine::EngineRuntimeReceiptStatus::Cancelled => "cancelled",
        nucleus_engine::EngineRuntimeReceiptStatus::Failed => "failed",
        nucleus_engine::EngineRuntimeReceiptStatus::TimedOut => "timed_out",
        nucleus_engine::EngineRuntimeReceiptStatus::RecoveryRequired => "recovery_required",
        nucleus_engine::EngineRuntimeReceiptStatus::Recovered => "recovered",
        nucleus_engine::EngineRuntimeReceiptStatus::Unknown => "unknown",
    }
    .to_owned()
}

fn runtime_receipt_ref_dto(receipt_ref: &nucleus_engine::EngineRuntimeReceiptRef) -> String {
    match receipt_ref {
        nucleus_engine::EngineRuntimeReceiptRef::CommandId(value)
        | nucleus_engine::EngineRuntimeReceiptRef::CommandRequestId(value)
        | nucleus_engine::EngineRuntimeReceiptRef::CommandEvidenceId(value)
        | nucleus_engine::EngineRuntimeReceiptRef::Artifact(value)
        | nucleus_engine::EngineRuntimeReceiptRef::EventId(value)
        | nucleus_engine::EngineRuntimeReceiptRef::Custom(value) => value.clone(),
    }
}

fn checkpoint_family_dto(family: &nucleus_engine::EngineCheckpointFamily) -> String {
    match family {
        nucleus_engine::EngineCheckpointFamily::TaskWork => "task_work",
        nucleus_engine::EngineCheckpointFamily::AgentSession => "agent_session",
        nucleus_engine::EngineCheckpointFamily::Thread => "thread",
        nucleus_engine::EngineCheckpointFamily::Turn => "turn",
        nucleus_engine::EngineCheckpointFamily::ScmChangeWorkflow => "scm_change_workflow",
        nucleus_engine::EngineCheckpointFamily::ValidationRun => "validation_run",
        nucleus_engine::EngineCheckpointFamily::ResearchRun => "research_run",
        nucleus_engine::EngineCheckpointFamily::StewardOperation => "steward_operation",
        nucleus_engine::EngineCheckpointFamily::ManualOperation => "manual_operation",
        nucleus_engine::EngineCheckpointFamily::Custom(value) => value,
    }
    .to_owned()
}

fn checkpoint_recovery_state_dto(state: &nucleus_engine::EngineCheckpointRecoveryState) -> String {
    match state {
        nucleus_engine::EngineCheckpointRecoveryState::Available => "available",
        nucleus_engine::EngineCheckpointRecoveryState::RepairRequired => "repair_required",
        nucleus_engine::EngineCheckpointRecoveryState::MissingSource => "missing_source",
        nucleus_engine::EngineCheckpointRecoveryState::Superseded => "superseded",
        nucleus_engine::EngineCheckpointRecoveryState::Unknown => "unknown",
    }
    .to_owned()
}

fn diff_summary_kind_dto(kind: &nucleus_engine::EngineDiffSummaryKind) -> String {
    match kind {
        nucleus_engine::EngineDiffSummaryKind::Source => "source",
        nucleus_engine::EngineDiffSummaryKind::ManagementProjection => "management_projection",
        nucleus_engine::EngineDiffSummaryKind::TaskState => "task_state",
        nucleus_engine::EngineDiffSummaryKind::MemoryProjection => "memory_projection",
        nucleus_engine::EngineDiffSummaryKind::PlanningArtifact => "planning_artifact",
        nucleus_engine::EngineDiffSummaryKind::ResearchSynthesis => "research_synthesis",
        nucleus_engine::EngineDiffSummaryKind::ArtifactManifest => "artifact_manifest",
        nucleus_engine::EngineDiffSummaryKind::Custom(value) => value,
    }
    .to_owned()
}

fn diff_summary_confidence_dto(confidence: &nucleus_engine::EngineDiffSummaryConfidence) -> String {
    match confidence {
        nucleus_engine::EngineDiffSummaryConfidence::Exact => "exact",
        nucleus_engine::EngineDiffSummaryConfidence::High => "high",
        nucleus_engine::EngineDiffSummaryConfidence::Partial => "partial",
        nucleus_engine::EngineDiffSummaryConfidence::Estimated => "estimated",
        nucleus_engine::EngineDiffSummaryConfidence::Unknown => "unknown",
    }
    .to_owned()
}

fn checkpoint_ref_dto(checkpoint_ref: &nucleus_engine::EngineCheckpointRef) -> String {
    match checkpoint_ref {
        nucleus_engine::EngineCheckpointRef::ProjectId(value)
        | nucleus_engine::EngineCheckpointRef::TaskId(value)
        | nucleus_engine::EngineCheckpointRef::AgentSessionId(value)
        | nucleus_engine::EngineCheckpointRef::ThreadId(value)
        | nucleus_engine::EngineCheckpointRef::TurnId(value)
        | nucleus_engine::EngineCheckpointRef::CommandId(value)
        | nucleus_engine::EngineCheckpointRef::EventId(value)
        | nucleus_engine::EngineCheckpointRef::ReceiptId(value)
        | nucleus_engine::EngineCheckpointRef::AuthorityHostId(value)
        | nucleus_engine::EngineCheckpointRef::ActorId(value)
        | nucleus_engine::EngineCheckpointRef::RepoId(value)
        | nucleus_engine::EngineCheckpointRef::ScmAdapterRef(value)
        | nucleus_engine::EngineCheckpointRef::SnapshotRef(value)
        | nucleus_engine::EngineCheckpointRef::PublicationRef(value)
        | nucleus_engine::EngineCheckpointRef::ArtifactRef(value)
        | nucleus_engine::EngineCheckpointRef::Custom(value) => value.clone(),
    }
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
