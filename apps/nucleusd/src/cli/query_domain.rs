use nucleus_server::ServerStateDomain;

mod labels;
mod parse;
mod selected_task_command_admission;
mod selected_task_queries;
mod selected_task_review_decision;
mod state_domain;

use labels::query_domain_label;
use selected_task_review_decision::SelectedTaskReviewDecisionQueryArgs;
use state_domain::query_domain_state_domain;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum QueryDomain {
    Projects,
    Tasks,
    Workspaces,
    CommandEvidence,
    ProviderReadIntent,
    ProviderReadinessOverview,
    ProviderLiveReadExecutor,
    ProviderLiveReadSmokeEvidence,
    TaskTimeline {
        task_id: String,
    },
    TaskReadiness {
        project_id: String,
    },
    PlanningTaskSeeds {
        project_id: String,
    },
    PlanningSessions {
        project_id: String,
    },
    AcceptedMemory {
        project_id: String,
    },
    AcceptedMemoryProjection {
        project_id: String,
    },
    AcceptedMemoryProjectionWrites {
        project_id: String,
    },
    AcceptedMemoryProjectionImport {
        project_id: String,
    },
    AcceptedMemoryProjectionImportApply {
        project_id: String,
    },
    AcceptedMemoryImportApplyReviewDiagnostics {
        project_id: String,
    },
    AcceptedMemoryReviewReceiptStorageDiagnostics {
        project_id: String,
    },
    AcceptedMemoryActiveApplyDiagnostics {
        project_id: String,
    },
    AcceptedMemoryReviewReadiness {
        project_id: String,
    },
    MemoryProposals {
        project_id: String,
    },
    MemoryProposalReviewDiagnostics {
        project_id: String,
    },
    ResearchRunBriefs {
        project_id: String,
    },
    TaskSeedPromotionDiagnostics {
        project_id: String,
    },
    PlanningProjectionFileWriteDiagnostics {
        project_id: String,
    },
    PlanningProjectionImportDiagnostics {
        project_id: String,
    },
    PlanningProjectionImportApplyDiagnostics {
        project_id: String,
    },
    PlanningProjectionImportActiveApplyDiagnostics {
        project_id: String,
    },
    PlanningCapturePublicationDiagnostics {
        project_id: String,
    },
    ProductWorkflowSummary {
        project_id: String,
    },
    TaskWorkflowDrilldown {
        project_id: String,
        task_id: String,
    },
    SelectedTaskActionReadiness {
        project_id: String,
        task_id: String,
    },
    SelectedTaskOperatorActionGate {
        project_id: String,
        task_id: String,
    },
    SelectedTaskReviewNext {
        project_id: String,
        task_id: String,
    },
    SelectedTaskReviewOutcomeRoute {
        project_id: String,
        task_id: String,
    },
    SelectedTaskRouteAdmission {
        project_id: String,
        task_id: String,
        expected_revision: Option<String>,
        operator_ref: String,
    },
    SelectedTaskCompletionRouteApply {
        project_id: String,
        task_id: String,
        expected_revision: Option<String>,
        operator_ref: String,
        route_admission_id: Option<String>,
        review_decision_ref: Option<String>,
        evidence_refs: Vec<String>,
    },
    SelectedTaskReworkPreparation {
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
        project_id: String,
        task_id: String,
        expected_revision: Option<String>,
        operator_ref: String,
    },
    SelectedTaskScmHandoff {
        project_id: String,
        task_id: String,
    },
    SelectedTaskCommandAdmission {
        project_id: String,
        task_id: String,
        family: String,
        expected_revision: Option<String>,
        reason: Option<String>,
        operator_ref: String,
    },
    SelectedTaskReviewDecisionAdmission(SelectedTaskReviewDecisionQueryArgs),
    SelectedTaskReviewDecisionApply(SelectedTaskReviewDecisionQueryArgs),
    ProjectAuthorityMap {
        project_id: String,
    },
}

impl QueryDomain {
    pub(crate) fn label(&self) -> &'static str {
        query_domain_label(self)
    }

    pub(crate) fn state_domain(&self) -> Option<ServerStateDomain> {
        query_domain_state_domain(self)
    }
}

pub(super) fn expect_flag<I>(iter: &mut I, expected: &str) -> Result<(), String>
where
    I: Iterator<Item = String>,
{
    match iter.next().as_deref() {
        Some(flag) if flag == expected => Ok(()),
        Some(flag) => Err(format!("expected {expected}, got {flag}")),
        None => Err(format!("expected {expected}")),
    }
}
