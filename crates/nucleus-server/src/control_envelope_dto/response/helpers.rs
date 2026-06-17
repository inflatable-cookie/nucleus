//! Response DTO scalar and state-record mapping helpers.

use nucleus_command_policy::{
    command_evidence_from_storage_record, decode_command_evidence_storage_record,
};

use crate::control_api::{ServerCommandReceiptStatus, ServerControlError, ServerStateRecordSet};
use crate::runtime_readiness_diagnostics::{RuntimeReadinessStatus, RuntimeReadinessSurface};
use crate::state::ServerStateDomain;

use super::body::ControlResponseBodyDto;
use super::records::ControlCommandEvidenceRecordDto;
use crate::control_envelope_dto::{
    ControlApiCodecError, ControlProjectRecordDto, ControlStateRecordDto, ControlTaskRecordDto,
};

pub(super) fn runtime_surface_dto(surface: &RuntimeReadinessSurface) -> String {
    match surface {
        RuntimeReadinessSurface::LocalHostCommandExecution => "local_host_command_execution",
    }
    .to_owned()
}

pub(super) fn runtime_readiness_status_dto(status: &RuntimeReadinessStatus) -> String {
    match status {
        RuntimeReadinessStatus::Ready => "ready",
        RuntimeReadinessStatus::Degraded => "degraded",
        RuntimeReadinessStatus::Unsupported => "unsupported",
    }
    .to_owned()
}

pub(super) fn command_execution_status_dto(
    status: &nucleus_command_policy::CommandExecutionStatus,
) -> String {
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

pub(super) fn retention_dto(retention: &nucleus_command_policy::CommandOutputRetention) -> String {
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

pub(super) fn runtime_receipt_family_dto(
    family: &nucleus_engine::EngineRuntimeReceiptEffectFamily,
) -> String {
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

pub(super) fn runtime_receipt_status_dto(
    status: &nucleus_engine::EngineRuntimeReceiptStatus,
) -> String {
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

pub(super) fn runtime_receipt_ref_dto(
    receipt_ref: &nucleus_engine::EngineRuntimeReceiptRef,
) -> String {
    match receipt_ref {
        nucleus_engine::EngineRuntimeReceiptRef::CommandId(value)
        | nucleus_engine::EngineRuntimeReceiptRef::CommandRequestId(value)
        | nucleus_engine::EngineRuntimeReceiptRef::CommandEvidenceId(value)
        | nucleus_engine::EngineRuntimeReceiptRef::Artifact(value)
        | nucleus_engine::EngineRuntimeReceiptRef::EventId(value)
        | nucleus_engine::EngineRuntimeReceiptRef::Custom(value) => value.clone(),
    }
}

pub(super) fn checkpoint_family_dto(family: &nucleus_engine::EngineCheckpointFamily) -> String {
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

pub(super) fn checkpoint_recovery_state_dto(
    state: &nucleus_engine::EngineCheckpointRecoveryState,
) -> String {
    match state {
        nucleus_engine::EngineCheckpointRecoveryState::Available => "available",
        nucleus_engine::EngineCheckpointRecoveryState::RepairRequired => "repair_required",
        nucleus_engine::EngineCheckpointRecoveryState::MissingSource => "missing_source",
        nucleus_engine::EngineCheckpointRecoveryState::Superseded => "superseded",
        nucleus_engine::EngineCheckpointRecoveryState::Unknown => "unknown",
    }
    .to_owned()
}

pub(super) fn diff_summary_kind_dto(kind: &nucleus_engine::EngineDiffSummaryKind) -> String {
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

pub(super) fn diff_summary_confidence_dto(
    confidence: &nucleus_engine::EngineDiffSummaryConfidence,
) -> String {
    match confidence {
        nucleus_engine::EngineDiffSummaryConfidence::Exact => "exact",
        nucleus_engine::EngineDiffSummaryConfidence::High => "high",
        nucleus_engine::EngineDiffSummaryConfidence::Partial => "partial",
        nucleus_engine::EngineDiffSummaryConfidence::Estimated => "estimated",
        nucleus_engine::EngineDiffSummaryConfidence::Unknown => "unknown",
    }
    .to_owned()
}

pub(super) fn checkpoint_ref_dto(checkpoint_ref: &nucleus_engine::EngineCheckpointRef) -> String {
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

pub(super) fn state_record_set_dto(
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

pub(super) fn control_error_dto(error: &ServerControlError) -> (String, String) {
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

pub(super) fn command_receipt_status_dto(status: &ServerCommandReceiptStatus) -> String {
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
