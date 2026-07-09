//! Serializable control query DTOs.

use serde::{Deserialize, Serialize};

mod authority_domains;
mod from_dto;
mod id;
mod planning_projection;
mod project_authority;
mod provider;
mod selected_task_to_dto;
mod state;
mod task_workflow;
mod to_dto;

use super::ControlApiCodecError;
pub use state::{ControlQueryScopeDto, ControlStateDomainDto};

/// Serializable query DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlQueryDto {
    State {
        query_id: String,
        domain: ControlStateDomainDto,
        scope: ControlQueryScopeDto,
    },
    RuntimeMetadata {
        query_id: String,
        action: String,
    },
    Diagnostics {
        query_id: String,
        domain: String,
    },
    ProviderReadIntent {
        query_id: String,
        action: String,
    },
    ProviderReadinessOverview {
        query_id: String,
        action: String,
    },
    ProviderLiveReadExecutor {
        query_id: String,
        action: String,
    },
    ProviderLiveReadSmokeEvidence {
        query_id: String,
        action: String,
    },
    TaskTimeline {
        query_id: String,
        action: String,
        task_id: String,
    },
    TaskReadiness {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningTaskSeeds {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningSessions {
        query_id: String,
        action: String,
        project_id: String,
    },
    MemoryProposals {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemory {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemoryProjectionDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemoryProjectionWriteDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemoryProjectionImportDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemoryProjectionImportApplyDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemoryImportApplyReviewDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemoryReviewReceiptStorageDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemoryActiveApplyDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    AcceptedMemoryReviewReadiness {
        query_id: String,
        action: String,
        project_id: String,
    },
    MemoryProposalReviewDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    ResearchRunBriefs {
        query_id: String,
        action: String,
        project_id: String,
    },
    TaskSeedPromotionDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningProjectionFileWriteDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningProjectionImportDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningProjectionImportApplyDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningProjectionImportActiveApplyDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    PlanningCapturePublicationDiagnostics {
        query_id: String,
        action: String,
        project_id: String,
    },
    ProductWorkflowSummary {
        query_id: String,
        action: String,
        project_id: String,
    },
    TaskWorkflowDrilldown {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
    },
    SelectedTaskActionReadiness {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
    },
    SelectedTaskOperatorActionGate {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
    },
    SelectedTaskReviewNext {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
    },
    SelectedTaskReviewOutcomeRoute {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
    },
    SelectedTaskRouteAdmission {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
        expected_revision: Option<String>,
        operator_ref: String,
    },
    SelectedTaskCompletionRouteApply {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
        expected_revision: Option<String>,
        operator_ref: String,
        route_admission_id: Option<String>,
        review_decision_ref: Option<String>,
        evidence_refs: Vec<String>,
    },
    SelectedTaskReworkPreparation {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
        operator_ref: String,
        route_admission_id: Option<String>,
        review_decision_ref: Option<String>,
        reviewed_work_item_refs: Vec<String>,
        reviewed_evidence_refs: Vec<String>,
        expected_task_revision: Option<String>,
        expected_work_item_revision: Option<String>,
    },
    SelectedTaskProductAggregate {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
        expected_revision: Option<String>,
        operator_ref: String,
    },
    SelectedTaskScmHandoff {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
    },
    SelectedTaskCommandAdmission {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
        family: String,
        expected_revision: Option<String>,
        reason: Option<String>,
        operator_ref: String,
    },
    SelectedTaskReviewDecisionAdmission {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
        decision_action: String,
        expected_revision: Option<String>,
        current_revision: Option<String>,
        reason: Option<String>,
        operator_ref: String,
        reviewed_evidence_refs: Vec<String>,
        idempotency_key: String,
    },
    SelectedTaskReviewDecisionApply {
        query_id: String,
        action: String,
        project_id: String,
        task_id: String,
        decision_action: String,
        expected_revision: Option<String>,
        current_revision: Option<String>,
        reason: Option<String>,
        operator_ref: String,
        reviewed_evidence_refs: Vec<String>,
        idempotency_key: String,
    },
    ProjectAuthorityMap {
        query_id: String,
        action: String,
        project_id: String,
        expected_domains: Vec<String>,
    },
}
