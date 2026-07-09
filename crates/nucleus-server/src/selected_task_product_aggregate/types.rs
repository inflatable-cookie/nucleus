use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::TaskId;

use crate::{
    SelectedTaskActionFamily, SelectedTaskActionReadiness, SelectedTaskActionStatus,
    SelectedTaskCommandAdmission, SelectedTaskCommandAdmissionStatus,
    SelectedTaskCompletionRouteApply, SelectedTaskCompletionRouteApplyStatus,
    SelectedTaskOperatorActionGate, SelectedTaskReviewNext, SelectedTaskReviewNextCategory,
    SelectedTaskReviewOutcomeRoute, SelectedTaskReviewOutcomeRouteCandidate,
    SelectedTaskReviewOutcomeRouteStatus, SelectedTaskReviewState, SelectedTaskReworkPreparation,
    SelectedTaskReworkPreparationStatus, SelectedTaskRouteAdmission,
    SelectedTaskScmHandoffNextCategory, SelectedTaskScmHandoffReadiness,
    SelectedTaskScmHandoffState, SelectedTaskScmHandoffTargetShape, TaskWorkflowDrilldown,
    TaskWorkflowNoEffects,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductAggregateInput {
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub expected_revision: Option<RevisionId>,
    pub drilldown: Option<TaskWorkflowDrilldown>,
    pub action_readiness: Option<SelectedTaskActionReadiness>,
    pub operator_gate: Option<SelectedTaskOperatorActionGate>,
    pub command_admissions: Vec<SelectedTaskCommandAdmission>,
    pub review_next: Option<SelectedTaskReviewNext>,
    pub review_outcome_route: Option<SelectedTaskReviewOutcomeRoute>,
    pub route_admission: Option<SelectedTaskRouteAdmission>,
    pub completion_apply: Option<SelectedTaskCompletionRouteApply>,
    pub rework_preparation: Option<SelectedTaskReworkPreparation>,
    pub scm_handoff: Option<SelectedTaskScmHandoffReadiness>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductAggregate {
    pub aggregate_id: String,
    pub project_id: ProjectId,
    pub task_id: TaskId,
    pub identity: SelectedTaskProductIdentity,
    pub workflow: SelectedTaskProductWorkflow,
    pub readiness: SelectedTaskProductReadiness,
    pub command_previews: SelectedTaskProductCommandPreviews,
    pub work_evidence: SelectedTaskProductWorkEvidence,
    pub review: SelectedTaskProductReview,
    pub rework: SelectedTaskProductRework,
    pub completion: SelectedTaskProductCompletion,
    pub scm_handoff: SelectedTaskProductScmHandoff,
    pub source_health: SelectedTaskProductSourceHealth,
    pub gaps: Vec<SelectedTaskProductGap>,
    pub no_effects: TaskWorkflowNoEffects,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductIdentity {
    pub title: Option<String>,
    pub activity: Option<String>,
    pub assignment: Option<String>,
    pub action_type: Option<String>,
    pub expected_revision: Option<RevisionId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductWorkflow {
    pub primary_next_action: String,
    pub reason: String,
    pub phase: String,
    pub next_ref: Option<String>,
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductReadiness {
    pub blockers: Vec<SelectedTaskProductBlocker>,
    pub unavailable_actions: Vec<SelectedTaskProductUnavailableAction>,
    pub allowed_action_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductBlocker {
    pub family: SelectedTaskActionFamily,
    pub reason: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductUnavailableAction {
    pub family: SelectedTaskActionFamily,
    pub status: SelectedTaskActionStatus,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductCommandPreviews {
    pub admitted_count: usize,
    pub refused_count: usize,
    pub previews: Vec<SelectedTaskProductCommandPreview>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductCommandPreview {
    pub family: SelectedTaskActionFamily,
    pub status: SelectedTaskCommandAdmissionStatus,
    pub command_available: bool,
    pub refusal_reason: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductWorkEvidence {
    pub work_item_refs: Vec<String>,
    pub active_work_item_count: usize,
    pub completed_work_item_count: usize,
    pub evidence_refs: Vec<String>,
    pub timeline_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductReview {
    pub state: Option<SelectedTaskReviewState>,
    pub next_category: Option<SelectedTaskReviewNextCategory>,
    pub route_status: Option<SelectedTaskReviewOutcomeRouteStatus>,
    pub primary_route: Option<SelectedTaskReviewOutcomeRouteCandidate>,
    pub decision_ref: Option<String>,
    pub decision_available: bool,
    pub blocker_reasons: Vec<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductRework {
    pub status: Option<SelectedTaskReworkPreparationStatus>,
    pub summary: Option<String>,
    pub refusal_reason: Option<String>,
    pub reviewed_work_item_refs: Vec<String>,
    pub reviewed_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductCompletion {
    pub status: Option<SelectedTaskCompletionRouteApplyStatus>,
    pub command_available: bool,
    pub refusal_reason: Option<String>,
    pub evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductScmHandoff {
    pub state: Option<SelectedTaskScmHandoffState>,
    pub next_category: Option<SelectedTaskScmHandoffNextCategory>,
    pub target_shape: Option<SelectedTaskScmHandoffTargetShape>,
    pub blocker_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub gap_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductSourceHealth {
    pub sources: Vec<SelectedTaskProductSourceStatus>,
    pub missing_count: usize,
    pub partial_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductSourceStatus {
    pub source: SelectedTaskProductSource,
    pub state: SelectedTaskProductSourceState,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskProductSource {
    Drilldown,
    ActionReadiness,
    OperatorGate,
    CommandAdmissions,
    ReviewNext,
    ReviewOutcomeRoute,
    RouteAdmission,
    CompletionApply,
    ReworkPreparation,
    ScmHandoff,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectedTaskProductSourceState {
    Present,
    Missing,
    Partial,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedTaskProductGap {
    pub source: SelectedTaskProductSource,
    pub reason: String,
}
