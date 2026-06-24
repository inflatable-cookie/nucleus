//! Read-only diagnostics for planning task seed promotion state.

use std::collections::HashMap;

use nucleus_engine::{
    EnginePlanningReviewState, EngineTaskSeedCandidateProjection, EngineTaskSeedCandidateRecord,
    EngineTaskSeedPromotionState, EngineTaskSeedReadinessClass,
};
use nucleus_projects::ProjectId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningTaskSeedPromotionDiagnostics {
    pub project_id: ProjectId,
    pub task_seed_records: usize,
    pub ready_count: usize,
    pub blocked_count: usize,
    pub rejected_count: usize,
    pub promoted_count: usize,
    pub duplicate_promoted_task_ref_count: usize,
    pub missing_promoted_task_ref_count: usize,
    pub entries: Vec<PlanningTaskSeedPromotionDiagnosticEntry>,
    pub client_can_mutate: bool,
    pub task_creation_performed: bool,
    pub provider_execution_performed: bool,
    pub raw_planning_body_exposed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningTaskSeedPromotionDiagnosticEntry {
    pub seed_id: String,
    pub project_id: String,
    pub readiness: PlanningTaskSeedPromotionReadiness,
    pub review_state: PlanningTaskSeedPromotionReviewState,
    pub promotion_state: PlanningTaskSeedPromotionState,
    pub promoted_task_ref: Option<String>,
    pub promoted_task_exists: bool,
    pub duplicate_promoted_task_ref: bool,
    pub blocking_question_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningTaskSeedPromotionReadiness {
    Draft,
    Reviewable,
    ReadyForPromotion,
    Promoted,
    Blocked,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningTaskSeedPromotionReviewState {
    Draft,
    ReviewRequested,
    Accepted,
    ChangesRequested,
    Rejected,
    Superseded,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningTaskSeedPromotionState {
    NotReady,
    Reviewable,
    ReadyForPromotion,
    Promoted,
    Blocked,
}

pub fn planning_task_seed_promotion_diagnostics(
    project_id: ProjectId,
    records: impl IntoIterator<Item = EngineTaskSeedCandidateRecord>,
    task_exists: impl Fn(&str) -> bool,
) -> PlanningTaskSeedPromotionDiagnostics {
    let mut records = records
        .into_iter()
        .filter(|record| record.project_id == project_id)
        .collect::<Vec<_>>();
    records.sort_by(|left, right| left.seed_id.0.cmp(&right.seed_id.0));

    let projection =
        EngineTaskSeedCandidateProjection::from_records(project_id.clone(), records.clone());
    let readiness_by_seed = projection
        .candidates
        .iter()
        .map(|candidate| (candidate.seed_id.0.clone(), candidate.readiness.clone()))
        .collect::<HashMap<_, _>>();
    let promoted_ref_counts = records.iter().filter_map(promoted_task_ref).fold(
        HashMap::<String, usize>::new(),
        |mut counts, task_ref| {
            *counts.entry(task_ref).or_insert(0) += 1;
            counts
        },
    );

    let mut diagnostics = PlanningTaskSeedPromotionDiagnostics {
        project_id,
        task_seed_records: records.len(),
        ready_count: 0,
        blocked_count: 0,
        rejected_count: 0,
        promoted_count: 0,
        duplicate_promoted_task_ref_count: 0,
        missing_promoted_task_ref_count: 0,
        entries: Vec::new(),
        client_can_mutate: false,
        task_creation_performed: false,
        provider_execution_performed: false,
        raw_planning_body_exposed: false,
    };

    diagnostics.entries = records
        .iter()
        .map(|record| {
            let readiness = readiness_by_seed
                .get(&record.seed_id.0)
                .map(readiness_from_engine)
                .unwrap_or(PlanningTaskSeedPromotionReadiness::Blocked);
            let promoted_task_ref = promoted_task_ref(record);
            let duplicate_promoted_task_ref = promoted_task_ref
                .as_ref()
                .and_then(|task_ref| promoted_ref_counts.get(task_ref))
                .is_some_and(|count| *count > 1);
            let promoted_task_exists = promoted_task_ref
                .as_ref()
                .is_some_and(|task_ref| task_exists(task_ref));

            PlanningTaskSeedPromotionDiagnosticEntry {
                seed_id: record.seed_id.0.clone(),
                project_id: record.project_id.0.clone(),
                readiness,
                review_state: review_state(&record.review),
                promotion_state: promotion_state(&record.promotion),
                promoted_task_ref,
                promoted_task_exists,
                duplicate_promoted_task_ref,
                blocking_question_count: record.blocking_questions.len(),
            }
        })
        .collect();

    for entry in &diagnostics.entries {
        match entry.readiness {
            PlanningTaskSeedPromotionReadiness::ReadyForPromotion => diagnostics.ready_count += 1,
            PlanningTaskSeedPromotionReadiness::Blocked => diagnostics.blocked_count += 1,
            PlanningTaskSeedPromotionReadiness::Rejected => diagnostics.rejected_count += 1,
            PlanningTaskSeedPromotionReadiness::Promoted => diagnostics.promoted_count += 1,
            PlanningTaskSeedPromotionReadiness::Draft
            | PlanningTaskSeedPromotionReadiness::Reviewable => {}
        }
        if entry.duplicate_promoted_task_ref {
            diagnostics.duplicate_promoted_task_ref_count += 1;
        }
        if entry.promoted_task_ref.is_some() && !entry.promoted_task_exists {
            diagnostics.missing_promoted_task_ref_count += 1;
        }
    }

    diagnostics
}

fn promoted_task_ref(record: &EngineTaskSeedCandidateRecord) -> Option<String> {
    match &record.promotion {
        EngineTaskSeedPromotionState::Promoted { task_ref } => Some(task_ref.clone()),
        _ => None,
    }
}

fn readiness_from_engine(
    readiness: &EngineTaskSeedReadinessClass,
) -> PlanningTaskSeedPromotionReadiness {
    match readiness {
        EngineTaskSeedReadinessClass::Draft => PlanningTaskSeedPromotionReadiness::Draft,
        EngineTaskSeedReadinessClass::Reviewable => PlanningTaskSeedPromotionReadiness::Reviewable,
        EngineTaskSeedReadinessClass::ReadyForPromotion => {
            PlanningTaskSeedPromotionReadiness::ReadyForPromotion
        }
        EngineTaskSeedReadinessClass::Promoted => PlanningTaskSeedPromotionReadiness::Promoted,
        EngineTaskSeedReadinessClass::Blocked => PlanningTaskSeedPromotionReadiness::Blocked,
        EngineTaskSeedReadinessClass::Rejected => PlanningTaskSeedPromotionReadiness::Rejected,
    }
}

fn review_state(review: &EnginePlanningReviewState) -> PlanningTaskSeedPromotionReviewState {
    match review {
        EnginePlanningReviewState::Draft => PlanningTaskSeedPromotionReviewState::Draft,
        EnginePlanningReviewState::ReviewRequested => {
            PlanningTaskSeedPromotionReviewState::ReviewRequested
        }
        EnginePlanningReviewState::Accepted { .. } => {
            PlanningTaskSeedPromotionReviewState::Accepted
        }
        EnginePlanningReviewState::ChangesRequested { .. } => {
            PlanningTaskSeedPromotionReviewState::ChangesRequested
        }
        EnginePlanningReviewState::Rejected { .. } => {
            PlanningTaskSeedPromotionReviewState::Rejected
        }
        EnginePlanningReviewState::Superseded => PlanningTaskSeedPromotionReviewState::Superseded,
    }
}

fn promotion_state(promotion: &EngineTaskSeedPromotionState) -> PlanningTaskSeedPromotionState {
    match promotion {
        EngineTaskSeedPromotionState::NotReady { .. } => PlanningTaskSeedPromotionState::NotReady,
        EngineTaskSeedPromotionState::Reviewable => PlanningTaskSeedPromotionState::Reviewable,
        EngineTaskSeedPromotionState::ReadyForPromotion => {
            PlanningTaskSeedPromotionState::ReadyForPromotion
        }
        EngineTaskSeedPromotionState::Promoted { .. } => PlanningTaskSeedPromotionState::Promoted,
        EngineTaskSeedPromotionState::Blocked { .. } => PlanningTaskSeedPromotionState::Blocked,
    }
}

#[cfg(test)]
mod tests;
