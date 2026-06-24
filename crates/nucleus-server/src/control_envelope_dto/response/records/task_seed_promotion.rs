use serde::{Deserialize, Serialize};

use crate::{
    PlanningTaskSeedPromotionDiagnosticEntry, PlanningTaskSeedPromotionDiagnostics,
    PlanningTaskSeedPromotionReadiness, PlanningTaskSeedPromotionReviewState,
    PlanningTaskSeedPromotionState,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskSeedPromotionDiagnosticsDto {
    pub project_id: String,
    pub task_seed_records: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub rejected_count: usize,
    pub promoted_count: usize,
    pub duplicate_promoted_task_ref_count: usize,
    pub missing_promoted_task_ref_count: usize,
    pub entries: Vec<ControlTaskSeedPromotionDiagnosticEntryDto>,
    pub client_can_mutate: bool,
    pub task_creation_performed: bool,
    pub provider_execution_performed: bool,
    pub raw_planning_body_exposed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlTaskSeedPromotionDiagnosticEntryDto {
    pub seed_id: String,
    pub project_id: String,
    pub readiness: String,
    pub review_state: String,
    pub promotion_state: String,
    pub promoted_task_ref: Option<String>,
    pub promoted_task_exists: bool,
    pub duplicate_promoted_task_ref: bool,
    pub blocking_question_count: usize,
}

impl From<&PlanningTaskSeedPromotionDiagnostics> for ControlTaskSeedPromotionDiagnosticsDto {
    fn from(diagnostics: &PlanningTaskSeedPromotionDiagnostics) -> Self {
        Self {
            project_id: diagnostics.project_id.0.clone(),
            task_seed_records: diagnostics.task_seed_records,
            ready_count: diagnostics.ready_count,
            blocked_count: diagnostics.blocked_count,
            rejected_count: diagnostics.rejected_count,
            promoted_count: diagnostics.promoted_count,
            duplicate_promoted_task_ref_count: diagnostics.duplicate_promoted_task_ref_count,
            missing_promoted_task_ref_count: diagnostics.missing_promoted_task_ref_count,
            entries: diagnostics
                .entries
                .iter()
                .map(ControlTaskSeedPromotionDiagnosticEntryDto::from)
                .collect(),
            client_can_mutate: diagnostics.client_can_mutate,
            task_creation_performed: diagnostics.task_creation_performed,
            provider_execution_performed: diagnostics.provider_execution_performed,
            raw_planning_body_exposed: diagnostics.raw_planning_body_exposed,
        }
    }
}

impl From<&PlanningTaskSeedPromotionDiagnosticEntry>
    for ControlTaskSeedPromotionDiagnosticEntryDto
{
    fn from(entry: &PlanningTaskSeedPromotionDiagnosticEntry) -> Self {
        Self {
            seed_id: entry.seed_id.clone(),
            project_id: entry.project_id.clone(),
            readiness: readiness_dto(&entry.readiness),
            review_state: review_state_dto(&entry.review_state),
            promotion_state: promotion_state_dto(&entry.promotion_state),
            promoted_task_ref: entry.promoted_task_ref.clone(),
            promoted_task_exists: entry.promoted_task_exists,
            duplicate_promoted_task_ref: entry.duplicate_promoted_task_ref,
            blocking_question_count: entry.blocking_question_count,
        }
    }
}

fn readiness_dto(readiness: &PlanningTaskSeedPromotionReadiness) -> String {
    match readiness {
        PlanningTaskSeedPromotionReadiness::Draft => "draft",
        PlanningTaskSeedPromotionReadiness::Reviewable => "reviewable",
        PlanningTaskSeedPromotionReadiness::ReadyForPromotion => "ready_for_promotion",
        PlanningTaskSeedPromotionReadiness::Promoted => "promoted",
        PlanningTaskSeedPromotionReadiness::Blocked => "blocked",
        PlanningTaskSeedPromotionReadiness::Rejected => "rejected",
    }
    .to_owned()
}

fn review_state_dto(review_state: &PlanningTaskSeedPromotionReviewState) -> String {
    match review_state {
        PlanningTaskSeedPromotionReviewState::Draft => "draft",
        PlanningTaskSeedPromotionReviewState::ReviewRequested => "review_requested",
        PlanningTaskSeedPromotionReviewState::Accepted => "accepted",
        PlanningTaskSeedPromotionReviewState::ChangesRequested => "changes_requested",
        PlanningTaskSeedPromotionReviewState::Rejected => "rejected",
        PlanningTaskSeedPromotionReviewState::Superseded => "superseded",
    }
    .to_owned()
}

fn promotion_state_dto(promotion_state: &PlanningTaskSeedPromotionState) -> String {
    match promotion_state {
        PlanningTaskSeedPromotionState::NotReady => "not_ready",
        PlanningTaskSeedPromotionState::Reviewable => "reviewable",
        PlanningTaskSeedPromotionState::ReadyForPromotion => "ready_for_promotion",
        PlanningTaskSeedPromotionState::Promoted => "promoted",
        PlanningTaskSeedPromotionState::Blocked => "blocked",
    }
    .to_owned()
}
