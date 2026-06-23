use serde::{Deserialize, Serialize};

use nucleus_engine::{
    EngineTaskSeedCandidate, EngineTaskSeedReadinessClass, EngineTaskSeedSourceCounts,
    EngineTaskSeedStatusCount,
};
use nucleus_tasks::{TaskActionType, TaskImportance};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningTaskSeedCandidateDto {
    pub seed_id: String,
    pub project_id: String,
    pub title: String,
    pub readiness: String,
    pub suggested_action_type: String,
    pub suggested_importance: String,
    pub source_artifact_id: Option<String>,
    pub reasons: Vec<String>,
    pub blocking_questions: Vec<String>,
    pub context_refs: Vec<String>,
    pub validation_hint_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningTaskSeedStatusCountDto {
    pub readiness: String,
    pub count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlPlanningTaskSeedSourceCountsDto {
    pub task_seed_records: usize,
    pub source_artifact_refs: usize,
    pub context_refs: usize,
    pub validation_hint_refs: usize,
}

impl From<&EngineTaskSeedCandidate> for ControlPlanningTaskSeedCandidateDto {
    fn from(candidate: &EngineTaskSeedCandidate) -> Self {
        Self {
            seed_id: candidate.seed_id.0.clone(),
            project_id: candidate.project_id.0.clone(),
            title: candidate.title.clone(),
            readiness: readiness_dto(&candidate.readiness),
            suggested_action_type: action_type_dto(&candidate.suggested_action_type),
            suggested_importance: importance_dto(&candidate.suggested_importance),
            source_artifact_id: candidate
                .source_artifact_id
                .as_ref()
                .map(|artifact_id| artifact_id.0.clone()),
            reasons: candidate.reasons.clone(),
            blocking_questions: candidate.blocking_questions.clone(),
            context_refs: candidate.context_refs.clone(),
            validation_hint_refs: candidate.validation_hint_refs.clone(),
        }
    }
}

impl From<&EngineTaskSeedStatusCount> for ControlPlanningTaskSeedStatusCountDto {
    fn from(count: &EngineTaskSeedStatusCount) -> Self {
        Self {
            readiness: readiness_dto(&count.readiness),
            count: count.count,
        }
    }
}

impl From<&EngineTaskSeedSourceCounts> for ControlPlanningTaskSeedSourceCountsDto {
    fn from(counts: &EngineTaskSeedSourceCounts) -> Self {
        Self {
            task_seed_records: counts.task_seed_records,
            source_artifact_refs: counts.source_artifact_refs,
            context_refs: counts.context_refs,
            validation_hint_refs: counts.validation_hint_refs,
        }
    }
}

fn readiness_dto(readiness: &EngineTaskSeedReadinessClass) -> String {
    match readiness {
        EngineTaskSeedReadinessClass::Draft => "draft",
        EngineTaskSeedReadinessClass::Reviewable => "reviewable",
        EngineTaskSeedReadinessClass::ReadyForPromotion => "ready_for_promotion",
        EngineTaskSeedReadinessClass::Promoted => "promoted",
        EngineTaskSeedReadinessClass::Blocked => "blocked",
        EngineTaskSeedReadinessClass::Rejected => "rejected",
    }
    .to_owned()
}

fn action_type_dto(action_type: &TaskActionType) -> String {
    match action_type {
        TaskActionType::Research => "research",
        TaskActionType::Plan => "plan",
        TaskActionType::Execute => "execute",
        TaskActionType::Test => "test",
        TaskActionType::Check => "check",
        TaskActionType::Review => "review",
    }
    .to_owned()
}

fn importance_dto(importance: &TaskImportance) -> String {
    match importance {
        TaskImportance::Low => "low",
        TaskImportance::Normal => "normal",
        TaskImportance::High => "high",
        TaskImportance::Critical => "critical",
    }
    .to_owned()
}
