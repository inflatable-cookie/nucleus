//! Planning artifacts and reviewable task seed candidates.

pub mod promotion;
pub mod storage_codec;

pub use promotion::{
    admit_task_seed_promotion, EngineTaskSeedPromotionAdmission, EngineTaskSeedPromotionCommand,
    EngineTaskSeedPromotionOutcome,
};
pub use storage_codec::{
    decode_task_seed_storage_record, encode_task_seed_storage_payload,
    encode_task_seed_storage_record, task_seed_from_storage_record,
    PlanningStorageAcceptanceCriterion, PlanningStorageAgentReadiness,
    PlanningStorageAgentReadinessHints, PlanningStorageReviewState, PlanningStorageTaskActionType,
    PlanningStorageTaskImportance, PlanningTaskSeedRecordCodecError,
    PlanningTaskSeedStoragePromotionState, PlanningTaskSeedStorageRecord,
};

use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EnginePlanningArtifactId(pub String);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EnginePlanningSessionId(pub String);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EngineTaskSeedId(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnginePlanningArtifactRecord {
    pub artifact_id: EnginePlanningArtifactId,
    pub project_id: ProjectId,
    pub kind: EnginePlanningArtifactKind,
    pub title: String,
    pub body: EnginePlanningArtifactBody,
    pub status: EnginePlanningArtifactStatus,
    pub source_planning_session_ref: Option<EnginePlanningSessionId>,
    pub source_research_run_refs: Vec<String>,
    pub source_memory_refs: Vec<String>,
    pub supersedes: Vec<EnginePlanningArtifactId>,
    pub superseded_by: Vec<EnginePlanningArtifactId>,
    pub projection_ref: Option<String>,
    pub review: EnginePlanningReviewState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnginePlanningArtifactKind {
    Vision,
    Principles,
    Constraints,
    ArchitectureOutline,
    SystemInventory,
    ResearchQuestionSet,
    ResearchRunBrief,
    ResearchSynthesis,
    DecisionRecord,
    RoadmapOutline,
    Milestone,
    TaskSeedGroup,
    OpenQuestionSet,
    Custom(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnginePlanningArtifactBody {
    Text(String),
    StructuredRef(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnginePlanningArtifactStatus {
    Draft,
    Active,
    Accepted,
    Superseded,
    Archived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnginePlanningReviewState {
    Draft,
    ReviewRequested,
    Accepted { reviewer_ref: String },
    ChangesRequested { reason: String },
    Rejected { reason: String },
    Superseded,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskSeedCandidateRecord {
    pub seed_id: EngineTaskSeedId,
    pub project_id: ProjectId,
    pub source_artifact_id: Option<EnginePlanningArtifactId>,
    pub title: String,
    pub problem_statement: String,
    pub suggested_action_type: TaskActionType,
    pub suggested_importance: TaskImportance,
    pub acceptance_criteria_draft: Vec<AcceptanceCriterion>,
    pub context_refs: Vec<String>,
    pub blocking_questions: Vec<String>,
    pub agent_readiness_hints: EngineTaskSeedAgentReadinessHints,
    pub review: EnginePlanningReviewState,
    pub promotion: EngineTaskSeedPromotionState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskSeedAgentReadinessHints {
    pub suggested_readiness: AgentReadiness,
    pub capability_hints: Vec<String>,
    pub validation_hint_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineTaskSeedPromotionState {
    NotReady { reason: String },
    Reviewable,
    ReadyForPromotion,
    Promoted { task_ref: String },
    Blocked { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskSeedCandidateProjection {
    pub project_id: ProjectId,
    pub candidates: Vec<EngineTaskSeedCandidate>,
    pub status_counts: Vec<EngineTaskSeedStatusCount>,
    pub source_counts: EngineTaskSeedSourceCounts,
    pub client_can_promote: bool,
    pub task_creation_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskSeedCandidate {
    pub seed_id: EngineTaskSeedId,
    pub project_id: ProjectId,
    pub title: String,
    pub readiness: EngineTaskSeedReadinessClass,
    pub suggested_action_type: TaskActionType,
    pub suggested_importance: TaskImportance,
    pub source_artifact_id: Option<EnginePlanningArtifactId>,
    pub reasons: Vec<String>,
    pub blocking_questions: Vec<String>,
    pub context_refs: Vec<String>,
    pub validation_hint_refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum EngineTaskSeedReadinessClass {
    Draft,
    Reviewable,
    ReadyForPromotion,
    Promoted,
    Blocked,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineTaskSeedStatusCount {
    pub readiness: EngineTaskSeedReadinessClass,
    pub count: usize,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EngineTaskSeedSourceCounts {
    pub task_seed_records: usize,
    pub source_artifact_refs: usize,
    pub context_refs: usize,
    pub validation_hint_refs: usize,
}

impl EngineTaskSeedCandidateProjection {
    pub fn from_records(
        project_id: ProjectId,
        records: impl IntoIterator<Item = EngineTaskSeedCandidateRecord>,
    ) -> Self {
        let mut candidates = records
            .into_iter()
            .filter(|record| record.project_id == project_id)
            .map(EngineTaskSeedCandidate::from_record)
            .collect::<Vec<_>>();

        candidates.sort_by(|left, right| {
            left.seed_id
                .0
                .cmp(&right.seed_id.0)
                .then_with(|| left.title.cmp(&right.title))
        });

        let mut projection = Self {
            project_id,
            candidates,
            status_counts: Vec::new(),
            source_counts: EngineTaskSeedSourceCounts::default(),
            client_can_promote: false,
            task_creation_performed: false,
        };
        projection.recount();
        projection
    }

    fn recount(&mut self) {
        let mut status_counts = Vec::<EngineTaskSeedStatusCount>::new();
        let mut source_counts = EngineTaskSeedSourceCounts {
            task_seed_records: self.candidates.len(),
            ..EngineTaskSeedSourceCounts::default()
        };

        for candidate in &self.candidates {
            match status_counts
                .iter_mut()
                .find(|count| count.readiness == candidate.readiness)
            {
                Some(count) => count.count += 1,
                None => status_counts.push(EngineTaskSeedStatusCount {
                    readiness: candidate.readiness.clone(),
                    count: 1,
                }),
            }
            if candidate.source_artifact_id.is_some() {
                source_counts.source_artifact_refs += 1;
            }
            source_counts.context_refs += candidate.context_refs.len();
            source_counts.validation_hint_refs += candidate.validation_hint_refs.len();
        }

        status_counts.sort_by(|left, right| left.readiness.cmp(&right.readiness));
        self.status_counts = status_counts;
        self.source_counts = source_counts;
    }
}

impl EngineTaskSeedCandidate {
    fn from_record(record: EngineTaskSeedCandidateRecord) -> Self {
        let readiness = classify_seed(&record);
        let reasons = reasons_for_seed(&record, &readiness);
        Self {
            seed_id: record.seed_id,
            project_id: record.project_id,
            title: record.title,
            readiness,
            suggested_action_type: record.suggested_action_type,
            suggested_importance: record.suggested_importance,
            source_artifact_id: record.source_artifact_id,
            reasons,
            blocking_questions: record.blocking_questions,
            context_refs: record.context_refs,
            validation_hint_refs: record.agent_readiness_hints.validation_hint_refs,
        }
    }
}

fn classify_seed(record: &EngineTaskSeedCandidateRecord) -> EngineTaskSeedReadinessClass {
    if !record.blocking_questions.is_empty() {
        return EngineTaskSeedReadinessClass::Blocked;
    }

    match &record.promotion {
        EngineTaskSeedPromotionState::Promoted { .. } => EngineTaskSeedReadinessClass::Promoted,
        EngineTaskSeedPromotionState::Blocked { .. } => EngineTaskSeedReadinessClass::Blocked,
        EngineTaskSeedPromotionState::ReadyForPromotion => {
            EngineTaskSeedReadinessClass::ReadyForPromotion
        }
        EngineTaskSeedPromotionState::Reviewable => EngineTaskSeedReadinessClass::Reviewable,
        EngineTaskSeedPromotionState::NotReady { .. } => match &record.review {
            EnginePlanningReviewState::Rejected { .. } => EngineTaskSeedReadinessClass::Rejected,
            EnginePlanningReviewState::Draft => EngineTaskSeedReadinessClass::Draft,
            EnginePlanningReviewState::ChangesRequested { .. } => {
                EngineTaskSeedReadinessClass::Blocked
            }
            EnginePlanningReviewState::ReviewRequested
            | EnginePlanningReviewState::Accepted { .. }
            | EnginePlanningReviewState::Superseded => EngineTaskSeedReadinessClass::Reviewable,
        },
    }
}

fn reasons_for_seed(
    record: &EngineTaskSeedCandidateRecord,
    readiness: &EngineTaskSeedReadinessClass,
) -> Vec<String> {
    let mut reasons = match readiness {
        EngineTaskSeedReadinessClass::Draft => {
            vec!["task seed is still draft planning output".to_owned()]
        }
        EngineTaskSeedReadinessClass::Reviewable => {
            vec!["task seed can be reviewed before promotion".to_owned()]
        }
        EngineTaskSeedReadinessClass::ReadyForPromotion => {
            vec!["task seed is marked ready for task-domain promotion".to_owned()]
        }
        EngineTaskSeedReadinessClass::Promoted => {
            vec!["task seed has already been promoted".to_owned()]
        }
        EngineTaskSeedReadinessClass::Blocked => {
            vec!["task seed has blockers before promotion".to_owned()]
        }
        EngineTaskSeedReadinessClass::Rejected => vec!["task seed was rejected".to_owned()],
    };

    reasons.extend(
        record
            .blocking_questions
            .iter()
            .map(|question| format!("blocking question: {question}")),
    );
    reasons
}

#[cfg(test)]
mod tests;
