//! Response body DTOs and conversion.

use serde::{Deserialize, Serialize};

pub(in crate::control_envelope_dto::response) mod read_only;

use read_only::ControlReadOnlyCommandRejectionDto;

use super::provider_live_read_executor::ControlProviderLiveReadExecutorDiagnosticsDto;
use super::provider_live_read_smoke_evidence::ControlProviderLiveReadSmokeEvidenceDiagnosticsDto;
use super::provider_read_intent::ControlProviderReadIntentQueryResultDto;
use super::provider_readiness_overview::ControlProviderReadinessOverviewDto;
use super::records::{
    ControlAcceptedMemoryActiveApplyDiagnosticsDto, ControlAcceptedMemoryConfidenceCountDto,
    ControlAcceptedMemoryImportApplyReviewDiagnosticsDto, ControlAcceptedMemoryKindCountDto,
    ControlAcceptedMemoryProjectionDiagnosticsDto,
    ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto,
    ControlAcceptedMemoryProjectionImportDiagnosticsDto,
    ControlAcceptedMemoryProjectionWriteDiagnosticsDto, ControlAcceptedMemoryRetentionCountDto,
    ControlAcceptedMemoryReviewReadinessDto,
    ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto, ControlAcceptedMemoryScopeCountDto,
    ControlAcceptedMemorySensitivityCountDto, ControlAcceptedMemorySourceCountsDto,
    ControlAcceptedMemoryStatusCountDto, ControlAcceptedMemorySummaryDto,
    ControlCheckpointRecordDto, ControlCommandEvidenceRecordDto, ControlDiagnosticsResultDto,
    ControlDiffSummaryRecordDto, ControlMemoryProposalRetentionCountDto,
    ControlMemoryProposalReviewDiagnosticsDto, ControlMemoryProposalScopeCountDto,
    ControlMemoryProposalSensitivityCountDto, ControlMemoryProposalSourceCountsDto,
    ControlMemoryProposalStatusCountDto, ControlMemoryProposalSummaryDto,
    ControlPlanningCapturePublicationDiagnosticsDto,
    ControlPlanningProjectionFileWriteDiagnosticsDto,
    ControlPlanningProjectionImportActiveApplyDiagnosticsDto,
    ControlPlanningProjectionImportApplyDiagnosticsDto,
    ControlPlanningProjectionImportDiagnosticsDto, ControlPlanningSessionSourceCountsDto,
    ControlPlanningSessionStatusCountDto, ControlPlanningSessionSummaryDto,
    ControlPlanningTaskSeedCandidateDto, ControlPlanningTaskSeedSourceCountsDto,
    ControlPlanningTaskSeedStatusCountDto, ControlProductWorkflowSummaryDto,
    ControlProjectAuthorityMapDto, ControlResearchObservationKindCountDto,
    ControlResearchRunBriefSourceCountsDto, ControlResearchRunBriefStatusCountDto,
    ControlResearchRunBriefSummaryDto, ControlResearchSourceKindCountDto,
    ControlResearchSynthesisKindCountDto, ControlRuntimeReadinessDiagnosticDto,
    ControlRuntimeReceiptRecordDto, ControlSelectedTaskActionReadinessDto,
    ControlSelectedTaskCommandAdmissionDto, ControlSelectedTaskCompletionRouteApplyDto,
    ControlSelectedTaskOperatorActionGateDto, ControlSelectedTaskProductAggregateDto,
    ControlSelectedTaskReviewDecisionAdmissionDto, ControlSelectedTaskReviewDecisionRecordDto,
    ControlSelectedTaskReviewNextDto, ControlSelectedTaskReviewOutcomeRouteDto,
    ControlSelectedTaskReworkPreparationDto, ControlSelectedTaskRouteAdmissionDto,
    ControlSelectedTaskScmHandoffDto, ControlTaskReadinessCandidateDto,
    ControlTaskReadinessSourceCountsDto, ControlTaskReadinessStatusCountDto,
    ControlTaskSeedPromotionDiagnosticsDto, ControlTaskTimelineEntryDto,
    ControlTaskWorkflowDrilldownDto,
};
use crate::control_envelope_dto::{
    ControlProjectRecordDto, ControlStateRecordDto, ControlTaskRecordDto,
};
use crate::diagnostics_read_models::TaskAgentWorkUnitDiagnosticDto;
use crate::ControlGoalRecordDto;

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
    GoalRecords {
        records: Vec<ControlGoalRecordDto>,
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
    PlanningSessions {
        project_id: String,
        sessions: Vec<ControlPlanningSessionSummaryDto>,
        status_counts: Vec<ControlPlanningSessionStatusCountDto>,
        source_counts: ControlPlanningSessionSourceCountsDto,
        client_can_mutate: bool,
        provider_execution_available: bool,
    },
    MemoryProposals {
        project_id: String,
        proposals: Vec<ControlMemoryProposalSummaryDto>,
        status_counts: Vec<ControlMemoryProposalStatusCountDto>,
        scope_counts: Vec<ControlMemoryProposalScopeCountDto>,
        sensitivity_counts: Vec<ControlMemoryProposalSensitivityCountDto>,
        retention_counts: Vec<ControlMemoryProposalRetentionCountDto>,
        source_counts: ControlMemoryProposalSourceCountsDto,
        client_can_mutate: bool,
        provider_execution_available: bool,
    },
    AcceptedMemory {
        project_id: String,
        memories: Vec<ControlAcceptedMemorySummaryDto>,
        status_counts: Vec<ControlAcceptedMemoryStatusCountDto>,
        scope_counts: Vec<ControlAcceptedMemoryScopeCountDto>,
        kind_counts: Vec<ControlAcceptedMemoryKindCountDto>,
        sensitivity_counts: Vec<ControlAcceptedMemorySensitivityCountDto>,
        retention_counts: Vec<ControlAcceptedMemoryRetentionCountDto>,
        confidence_counts: Vec<ControlAcceptedMemoryConfidenceCountDto>,
        source_counts: ControlAcceptedMemorySourceCountsDto,
        client_can_mutate: bool,
        projection_written: bool,
        embedding_available: bool,
        provider_sync_available: bool,
    },
    AcceptedMemoryProjectionDiagnostics {
        diagnostics: ControlAcceptedMemoryProjectionDiagnosticsDto,
    },
    AcceptedMemoryProjectionWriteDiagnostics {
        diagnostics: ControlAcceptedMemoryProjectionWriteDiagnosticsDto,
    },
    AcceptedMemoryProjectionImportDiagnostics {
        diagnostics: ControlAcceptedMemoryProjectionImportDiagnosticsDto,
    },
    AcceptedMemoryProjectionImportApplyDiagnostics {
        diagnostics: ControlAcceptedMemoryProjectionImportApplyDiagnosticsDto,
    },
    AcceptedMemoryImportApplyReviewDiagnostics {
        diagnostics: ControlAcceptedMemoryImportApplyReviewDiagnosticsDto,
    },
    AcceptedMemoryReviewReceiptStorageDiagnostics {
        diagnostics: ControlAcceptedMemoryReviewReceiptStorageDiagnosticsDto,
    },
    AcceptedMemoryActiveApplyDiagnostics {
        diagnostics: ControlAcceptedMemoryActiveApplyDiagnosticsDto,
    },
    AcceptedMemoryReviewReadiness {
        readiness: ControlAcceptedMemoryReviewReadinessDto,
    },
    MemoryProposalReviewDiagnostics {
        diagnostics: ControlMemoryProposalReviewDiagnosticsDto,
    },
    ResearchRunBriefs {
        project_id: String,
        runs: Vec<ControlResearchRunBriefSummaryDto>,
        status_counts: Vec<ControlResearchRunBriefStatusCountDto>,
        source_kind_counts: Vec<ControlResearchSourceKindCountDto>,
        observation_kind_counts: Vec<ControlResearchObservationKindCountDto>,
        synthesis_kind_counts: Vec<ControlResearchSynthesisKindCountDto>,
        source_counts: ControlResearchRunBriefSourceCountsDto,
        client_can_mutate: bool,
        provider_execution_available: bool,
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
    PlanningProjectionImportApplyDiagnostics {
        diagnostics: ControlPlanningProjectionImportApplyDiagnosticsDto,
    },
    PlanningProjectionImportActiveApplyDiagnostics {
        diagnostics: ControlPlanningProjectionImportActiveApplyDiagnosticsDto,
    },
    PlanningCapturePublicationDiagnostics {
        diagnostics: ControlPlanningCapturePublicationDiagnosticsDto,
    },
    ProductWorkflowSummary {
        summary: ControlProductWorkflowSummaryDto,
    },
    TaskWorkflowDrilldown {
        drilldown: ControlTaskWorkflowDrilldownDto,
    },
    SelectedTaskActionReadiness {
        readiness: ControlSelectedTaskActionReadinessDto,
    },
    SelectedTaskOperatorActionGate {
        gate: ControlSelectedTaskOperatorActionGateDto,
    },
    SelectedTaskReviewNext {
        review_next: ControlSelectedTaskReviewNextDto,
    },
    SelectedTaskReviewOutcomeRoute {
        route: ControlSelectedTaskReviewOutcomeRouteDto,
    },
    SelectedTaskRouteAdmission {
        admission: ControlSelectedTaskRouteAdmissionDto,
    },
    SelectedTaskCompletionRouteApply {
        apply: ControlSelectedTaskCompletionRouteApplyDto,
    },
    SelectedTaskReworkPreparation {
        preparation: ControlSelectedTaskReworkPreparationDto,
    },
    SelectedTaskProductAggregate {
        aggregate: ControlSelectedTaskProductAggregateDto,
    },
    SelectedTaskScmHandoff {
        handoff: ControlSelectedTaskScmHandoffDto,
    },
    SelectedTaskCommandAdmission {
        admission: ControlSelectedTaskCommandAdmissionDto,
    },
    SelectedTaskReviewDecisionAdmission {
        admission: ControlSelectedTaskReviewDecisionAdmissionDto,
    },
    SelectedTaskReviewDecisionApply {
        record: ControlSelectedTaskReviewDecisionRecordDto,
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
        error_kind: Option<String>,
        error_reason: Option<String>,
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
