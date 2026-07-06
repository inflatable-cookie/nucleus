//! Server response to transport response body conversion.

use super::accepted_memory_body_conversion::accepted_memory_query_body_dto;
use super::body::read_only::read_only_command_result_dto;
use super::body::ControlResponseBodyDto;
use super::helpers::{command_receipt_status_dto, control_error_dto, state_record_set_dto};
use super::memory_proposals::memory_proposals_body_dto;
use super::planning_sessions_body::planning_sessions_body_dto;
use super::provider_live_read_executor::ControlProviderLiveReadExecutorDiagnosticsDto;
use super::provider_live_read_smoke_evidence::ControlProviderLiveReadSmokeEvidenceDiagnosticsDto;
use super::provider_read_intent::ControlProviderReadIntentQueryResultDto;
use super::provider_readiness_overview::ControlProviderReadinessOverviewDto;
use super::records::{
    ControlCheckpointRecordDto, ControlDiagnosticsResultDto, ControlDiffSummaryRecordDto,
    ControlMemoryProposalReviewDiagnosticsDto, ControlPlanningCapturePublicationDiagnosticsDto,
    ControlPlanningProjectionFileWriteDiagnosticsDto,
    ControlPlanningProjectionImportActiveApplyDiagnosticsDto,
    ControlPlanningProjectionImportApplyDiagnosticsDto,
    ControlPlanningProjectionImportDiagnosticsDto, ControlPlanningTaskSeedCandidateDto,
    ControlPlanningTaskSeedSourceCountsDto, ControlPlanningTaskSeedStatusCountDto,
    ControlProductWorkflowSummaryDto, ControlProjectAuthorityMapDto,
    ControlRuntimeReadinessDiagnosticDto, ControlRuntimeReceiptRecordDto,
    ControlSelectedTaskActionReadinessDto, ControlSelectedTaskOperatorActionGateDto,
    ControlTaskReadinessCandidateDto, ControlTaskReadinessSourceCountsDto,
    ControlTaskReadinessStatusCountDto, ControlTaskSeedPromotionDiagnosticsDto,
    ControlTaskTimelineEntryDto, ControlTaskWorkflowDrilldownDto,
};
use super::research_run_briefs::research_run_briefs_body_dto;
use crate::control_api::{ServerControlResponseBody, ServerQueryResult};
use crate::control_envelope_dto::ControlApiCodecError;

impl TryFrom<&ServerControlResponseBody> for ControlResponseBodyDto {
    type Error = ControlApiCodecError;

    fn try_from(
        body: &ServerControlResponseBody,
    ) -> Result<Self, <ControlResponseBodyDto as TryFrom<&ServerControlResponseBody>>::Error> {
        if let Some(dto) = accepted_memory_query_body_dto(body) {
            return Ok(dto);
        }

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
            ServerControlResponseBody::Query(ServerQueryResult::PlanningSessions(projection)) => {
                Ok(planning_sessions_body_dto(projection))
            }
            ServerControlResponseBody::Query(
                ServerQueryResult::AcceptedMemory(_)
                | ServerQueryResult::AcceptedMemoryProjectionDiagnostics(_)
                | ServerQueryResult::AcceptedMemoryProjectionWriteDiagnostics(_)
                | ServerQueryResult::AcceptedMemoryProjectionImportDiagnostics(_)
                | ServerQueryResult::AcceptedMemoryProjectionImportApplyDiagnostics(_)
                | ServerQueryResult::AcceptedMemoryImportApplyReviewDiagnostics(_)
                | ServerQueryResult::AcceptedMemoryReviewReceiptStorageDiagnostics(_)
                | ServerQueryResult::AcceptedMemoryActiveApplyDiagnostics(_)
                | ServerQueryResult::AcceptedMemoryReviewReadiness(_),
            ) => unreachable!("accepted memory query bodies are handled before the main match"),
            ServerControlResponseBody::Query(ServerQueryResult::MemoryProposals(projection)) => {
                Ok(memory_proposals_body_dto(projection))
            }
            ServerControlResponseBody::Query(
                ServerQueryResult::MemoryProposalReviewDiagnostics(diagnostics),
            ) => Ok(Self::MemoryProposalReviewDiagnostics {
                diagnostics: ControlMemoryProposalReviewDiagnosticsDto::from(diagnostics),
            }),
            ServerControlResponseBody::Query(ServerQueryResult::ResearchRunBriefs(projection)) => {
                Ok(research_run_briefs_body_dto(projection))
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
                ServerQueryResult::PlanningProjectionImportApplyDiagnostics(diagnostics),
            ) => Ok(Self::PlanningProjectionImportApplyDiagnostics {
                diagnostics: ControlPlanningProjectionImportApplyDiagnosticsDto::from(diagnostics),
            }),
            ServerControlResponseBody::Query(
                ServerQueryResult::PlanningProjectionImportActiveApplyDiagnostics(diagnostics),
            ) => Ok(Self::PlanningProjectionImportActiveApplyDiagnostics {
                diagnostics: ControlPlanningProjectionImportActiveApplyDiagnosticsDto::from(
                    diagnostics,
                ),
            }),
            ServerControlResponseBody::Query(
                ServerQueryResult::PlanningCapturePublicationDiagnostics(diagnostics),
            ) => Ok(Self::PlanningCapturePublicationDiagnostics {
                diagnostics: ControlPlanningCapturePublicationDiagnosticsDto::from(diagnostics),
            }),
            ServerControlResponseBody::Query(ServerQueryResult::ProductWorkflowSummary(
                summary,
            )) => Ok(Self::ProductWorkflowSummary {
                summary: ControlProductWorkflowSummaryDto::from(summary),
            }),
            ServerControlResponseBody::Query(ServerQueryResult::TaskWorkflowDrilldown(
                drilldown,
            )) => Ok(Self::TaskWorkflowDrilldown {
                drilldown: ControlTaskWorkflowDrilldownDto::from(drilldown),
            }),
            ServerControlResponseBody::Query(ServerQueryResult::SelectedTaskActionReadiness(
                readiness,
            )) => Ok(Self::SelectedTaskActionReadiness {
                readiness: ControlSelectedTaskActionReadinessDto::from(readiness),
            }),
            ServerControlResponseBody::Query(
                ServerQueryResult::SelectedTaskOperatorActionGate(gate),
            ) => Ok(Self::SelectedTaskOperatorActionGate {
                gate: ControlSelectedTaskOperatorActionGateDto::from(gate),
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
