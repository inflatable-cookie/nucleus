//! Response body DTOs and conversion.

use serde::{Deserialize, Serialize};

use crate::control_api::{ServerControlResponseBody, ServerQueryResult};
use crate::read_only_command_control::{
    ReadOnlyCommandControlRejection, ReadOnlyCommandControlResult,
};

use super::helpers::{
    command_execution_status_dto, command_receipt_status_dto, control_error_dto, retention_dto,
    state_record_set_dto,
};
use super::provider_live_read_executor::ControlProviderLiveReadExecutorDiagnosticsDto;
use super::provider_live_read_smoke_evidence::ControlProviderLiveReadSmokeEvidenceDiagnosticsDto;
use super::provider_read_intent::ControlProviderReadIntentQueryResultDto;
use super::provider_readiness_overview::ControlProviderReadinessOverviewDto;
use super::records::{
    ControlCheckpointRecordDto, ControlCommandEvidenceRecordDto, ControlDiagnosticsResultDto,
    ControlDiffSummaryRecordDto, ControlPlanningCapturePublicationDiagnosticsDto,
    ControlPlanningProjectionFileWriteDiagnosticsDto,
    ControlPlanningProjectionImportDiagnosticsDto, ControlPlanningTaskSeedCandidateDto,
    ControlPlanningTaskSeedSourceCountsDto, ControlPlanningTaskSeedStatusCountDto,
    ControlProjectAuthorityMapDto, ControlRuntimeReadinessDiagnosticDto,
    ControlRuntimeReceiptRecordDto, ControlTaskReadinessCandidateDto,
    ControlTaskReadinessSourceCountsDto, ControlTaskReadinessStatusCountDto,
    ControlTaskSeedPromotionDiagnosticsDto, ControlTaskTimelineEntryDto,
};
use crate::control_envelope_dto::{
    ControlApiCodecError, ControlProjectRecordDto, ControlStateRecordDto, ControlTaskRecordDto,
};
use crate::diagnostics_read_models::TaskAgentWorkUnitDiagnosticDto;

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
    TaskWorkProgressRecords {
        records: Vec<TaskAgentWorkUnitDiagnosticDto>,
        client_can_mutate: bool,
        provider_execution_available: bool,
    },
    RuntimeReadinessDiagnostics {
        records: Vec<ControlRuntimeReadinessDiagnosticDto>,
    },
    Diagnostics {
        result: ControlDiagnosticsResultDto,
    },
    TaskTimeline {
        task_id: String,
        entries: Vec<ControlTaskTimelineEntryDto>,
        last_source_event_id: Option<String>,
    },
    TaskReadiness {
        project_id: String,
        candidates: Vec<ControlTaskReadinessCandidateDto>,
        status_counts: Vec<ControlTaskReadinessStatusCountDto>,
        source_counts: ControlTaskReadinessSourceCountsDto,
        client_can_mutate: bool,
        provider_execution_available: bool,
    },
    PlanningTaskSeeds {
        project_id: String,
        candidates: Vec<ControlPlanningTaskSeedCandidateDto>,
        status_counts: Vec<ControlPlanningTaskSeedStatusCountDto>,
        source_counts: ControlPlanningTaskSeedSourceCountsDto,
        client_can_promote: bool,
        task_creation_performed: bool,
    },
    TaskSeedPromotionDiagnostics {
        diagnostics: ControlTaskSeedPromotionDiagnosticsDto,
    },
    PlanningProjectionFileWriteDiagnostics {
        diagnostics: ControlPlanningProjectionFileWriteDiagnosticsDto,
    },
    PlanningProjectionImportDiagnostics {
        diagnostics: ControlPlanningProjectionImportDiagnosticsDto,
    },
    PlanningCapturePublicationDiagnostics {
        diagnostics: ControlPlanningCapturePublicationDiagnosticsDto,
    },
    ProjectAuthorityMap {
        record: ControlProjectAuthorityMapDto,
    },
    ProviderReadIntent {
        result: ControlProviderReadIntentQueryResultDto,
    },
    ProviderReadinessOverview {
        overview: ControlProviderReadinessOverviewDto,
    },
    ProviderLiveReadExecutorDiagnostics {
        diagnostics: ControlProviderLiveReadExecutorDiagnosticsDto,
    },
    ProviderLiveReadSmokeEvidenceDiagnostics {
        diagnostics: ControlProviderLiveReadSmokeEvidenceDiagnosticsDto,
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
            ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(result)) => {
                Ok(Self::Diagnostics {
                    result: ControlDiagnosticsResultDto::from(result),
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
            ServerControlResponseBody::Query(ServerQueryResult::TaskWorkProgress(records)) => {
                Ok(Self::TaskWorkProgressRecords {
                    records: records.clone(),
                    client_can_mutate: false,
                    provider_execution_available: false,
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
            ServerControlResponseBody::Query(ServerQueryResult::TaskReadiness(projection)) => {
                Ok(Self::TaskReadiness {
                    project_id: projection.project_id.0.clone(),
                    candidates: projection
                        .candidates
                        .iter()
                        .map(ControlTaskReadinessCandidateDto::from)
                        .collect(),
                    status_counts: projection
                        .status_counts
                        .iter()
                        .map(ControlTaskReadinessStatusCountDto::from)
                        .collect(),
                    source_counts: ControlTaskReadinessSourceCountsDto::from(
                        &projection.source_counts,
                    ),
                    client_can_mutate: projection.client_can_mutate,
                    provider_execution_available: projection.provider_execution_available,
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::PlanningTaskSeeds(projection)) => {
                Ok(Self::PlanningTaskSeeds {
                    project_id: projection.project_id.0.clone(),
                    candidates: projection
                        .candidates
                        .iter()
                        .map(ControlPlanningTaskSeedCandidateDto::from)
                        .collect(),
                    status_counts: projection
                        .status_counts
                        .iter()
                        .map(ControlPlanningTaskSeedStatusCountDto::from)
                        .collect(),
                    source_counts: ControlPlanningTaskSeedSourceCountsDto::from(
                        &projection.source_counts,
                    ),
                    client_can_promote: projection.client_can_promote,
                    task_creation_performed: projection.task_creation_performed,
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::TaskSeedPromotionDiagnostics(
                diagnostics,
            )) => Ok(Self::TaskSeedPromotionDiagnostics {
                diagnostics: ControlTaskSeedPromotionDiagnosticsDto::from(diagnostics),
            }),
            ServerControlResponseBody::Query(
                ServerQueryResult::PlanningProjectionFileWriteDiagnostics(diagnostics),
            ) => Ok(Self::PlanningProjectionFileWriteDiagnostics {
                diagnostics: ControlPlanningProjectionFileWriteDiagnosticsDto::from(diagnostics),
            }),
            ServerControlResponseBody::Query(
                ServerQueryResult::PlanningProjectionImportDiagnostics(diagnostics),
            ) => Ok(Self::PlanningProjectionImportDiagnostics {
                diagnostics: ControlPlanningProjectionImportDiagnosticsDto::from(diagnostics),
            }),
            ServerControlResponseBody::Query(
                ServerQueryResult::PlanningCapturePublicationDiagnostics(diagnostics),
            ) => Ok(Self::PlanningCapturePublicationDiagnostics {
                diagnostics: ControlPlanningCapturePublicationDiagnosticsDto::from(diagnostics),
            }),
            ServerControlResponseBody::Query(ServerQueryResult::ProjectAuthorityMap(record)) => {
                Ok(Self::ProjectAuthorityMap {
                    record: ControlProjectAuthorityMapDto::from(record),
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::ProviderReadIntent(result)) => {
                Ok(Self::ProviderReadIntent {
                    result: ControlProviderReadIntentQueryResultDto::from(result),
                })
            }
            ServerControlResponseBody::Query(ServerQueryResult::ProviderReadinessOverview(
                overview,
            )) => Ok(Self::ProviderReadinessOverview {
                overview: ControlProviderReadinessOverviewDto::from(overview),
            }),
            ServerControlResponseBody::Query(
                ServerQueryResult::ProviderLiveReadExecutorDiagnostics(diagnostics),
            ) => Ok(Self::ProviderLiveReadExecutorDiagnostics {
                diagnostics: ControlProviderLiveReadExecutorDiagnosticsDto::from(diagnostics),
            }),
            ServerControlResponseBody::Query(
                ServerQueryResult::ProviderLiveReadSmokeEvidenceDiagnostics(diagnostics),
            ) => Ok(Self::ProviderLiveReadSmokeEvidenceDiagnostics {
                diagnostics: ControlProviderLiveReadSmokeEvidenceDiagnosticsDto::from(diagnostics),
            }),
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

pub(super) fn read_only_rejection_dto(
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
