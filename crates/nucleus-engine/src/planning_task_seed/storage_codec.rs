use serde::{Deserialize, Serialize};

use nucleus_projects::ProjectId;
use nucleus_tasks::{AcceptanceCriterion, AgentReadiness, TaskActionType, TaskImportance};

use super::{
    EnginePlanningArtifactId, EnginePlanningReviewState, EngineTaskSeedAgentReadinessHints,
    EngineTaskSeedCandidateRecord, EngineTaskSeedId, EngineTaskSeedPromotionState,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningTaskSeedStorageRecord {
    pub seed_id: String,
    pub project_id: String,
    pub source_artifact_id: Option<String>,
    pub title: String,
    pub problem_statement: String,
    pub suggested_action_type: PlanningStorageTaskActionType,
    pub suggested_importance: PlanningStorageTaskImportance,
    pub acceptance_criteria_draft: Vec<PlanningStorageAcceptanceCriterion>,
    pub context_refs: Vec<String>,
    pub blocking_questions: Vec<String>,
    pub agent_readiness_hints: PlanningStorageAgentReadinessHints,
    pub review: PlanningStorageReviewState,
    pub promotion: PlanningTaskSeedStoragePromotionState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningStorageAcceptanceCriterion {
    pub text: String,
    pub required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningStorageAgentReadinessHints {
    pub suggested_readiness: PlanningStorageAgentReadiness,
    pub capability_hints: Vec<String>,
    pub validation_hint_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningStorageAgentReadiness {
    pub ready_for_agent: bool,
    pub required_context_refs: Vec<String>,
    pub allowed_actions: Vec<PlanningStorageTaskActionType>,
    pub stop_conditions: Vec<String>,
    pub validation_commands: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningStorageTaskActionType {
    Research,
    Plan,
    Execute,
    Test,
    Check,
    Review,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningStorageTaskImportance {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum PlanningStorageReviewState {
    Draft,
    ReviewRequested,
    Accepted { reviewer_ref: String },
    ChangesRequested { reason: String },
    Rejected { reason: String },
    Superseded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "value", rename_all = "snake_case")]
pub enum PlanningTaskSeedStoragePromotionState {
    NotReady { reason: String },
    Reviewable,
    ReadyForPromotion,
    Promoted { task_ref: String },
    Blocked { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningTaskSeedRecordCodecError {
    pub reason: String,
}

impl From<&EngineTaskSeedCandidateRecord> for PlanningTaskSeedStorageRecord {
    fn from(record: &EngineTaskSeedCandidateRecord) -> Self {
        Self {
            seed_id: record.seed_id.0.clone(),
            project_id: record.project_id.0.clone(),
            source_artifact_id: record
                .source_artifact_id
                .as_ref()
                .map(|artifact_id| artifact_id.0.clone()),
            title: record.title.clone(),
            problem_statement: record.problem_statement.clone(),
            suggested_action_type: PlanningStorageTaskActionType::from(
                &record.suggested_action_type,
            ),
            suggested_importance: PlanningStorageTaskImportance::from(&record.suggested_importance),
            acceptance_criteria_draft: record
                .acceptance_criteria_draft
                .iter()
                .map(PlanningStorageAcceptanceCriterion::from)
                .collect(),
            context_refs: record.context_refs.clone(),
            blocking_questions: record.blocking_questions.clone(),
            agent_readiness_hints: PlanningStorageAgentReadinessHints::from(
                &record.agent_readiness_hints,
            ),
            review: PlanningStorageReviewState::from(&record.review),
            promotion: PlanningTaskSeedStoragePromotionState::from(&record.promotion),
        }
    }
}

impl From<&PlanningTaskSeedStorageRecord> for EngineTaskSeedCandidateRecord {
    fn from(record: &PlanningTaskSeedStorageRecord) -> Self {
        Self {
            seed_id: EngineTaskSeedId(record.seed_id.clone()),
            project_id: ProjectId(record.project_id.clone()),
            source_artifact_id: record
                .source_artifact_id
                .as_ref()
                .map(|artifact_id| EnginePlanningArtifactId(artifact_id.clone())),
            title: record.title.clone(),
            problem_statement: record.problem_statement.clone(),
            suggested_action_type: TaskActionType::from(&record.suggested_action_type),
            suggested_importance: TaskImportance::from(&record.suggested_importance),
            acceptance_criteria_draft: record
                .acceptance_criteria_draft
                .iter()
                .map(AcceptanceCriterion::from)
                .collect(),
            context_refs: record.context_refs.clone(),
            blocking_questions: record.blocking_questions.clone(),
            agent_readiness_hints: EngineTaskSeedAgentReadinessHints::from(
                &record.agent_readiness_hints,
            ),
            review: EnginePlanningReviewState::from(&record.review),
            promotion: EngineTaskSeedPromotionState::from(&record.promotion),
        }
    }
}

impl From<&AcceptanceCriterion> for PlanningStorageAcceptanceCriterion {
    fn from(criterion: &AcceptanceCriterion) -> Self {
        Self {
            text: criterion.text.clone(),
            required: criterion.required,
        }
    }
}

impl From<&PlanningStorageAcceptanceCriterion> for AcceptanceCriterion {
    fn from(criterion: &PlanningStorageAcceptanceCriterion) -> Self {
        Self {
            text: criterion.text.clone(),
            required: criterion.required,
        }
    }
}

impl From<&EngineTaskSeedAgentReadinessHints> for PlanningStorageAgentReadinessHints {
    fn from(hints: &EngineTaskSeedAgentReadinessHints) -> Self {
        Self {
            suggested_readiness: PlanningStorageAgentReadiness::from(&hints.suggested_readiness),
            capability_hints: hints.capability_hints.clone(),
            validation_hint_refs: hints.validation_hint_refs.clone(),
        }
    }
}

impl From<&PlanningStorageAgentReadinessHints> for EngineTaskSeedAgentReadinessHints {
    fn from(hints: &PlanningStorageAgentReadinessHints) -> Self {
        Self {
            suggested_readiness: AgentReadiness::from(&hints.suggested_readiness),
            capability_hints: hints.capability_hints.clone(),
            validation_hint_refs: hints.validation_hint_refs.clone(),
        }
    }
}

impl From<&AgentReadiness> for PlanningStorageAgentReadiness {
    fn from(readiness: &AgentReadiness) -> Self {
        Self {
            ready_for_agent: readiness.ready_for_agent,
            required_context_refs: readiness.required_context_refs.clone(),
            allowed_actions: readiness
                .allowed_actions
                .iter()
                .map(PlanningStorageTaskActionType::from)
                .collect(),
            stop_conditions: readiness.stop_conditions.clone(),
            validation_commands: readiness.validation_commands.clone(),
        }
    }
}

impl From<&PlanningStorageAgentReadiness> for AgentReadiness {
    fn from(readiness: &PlanningStorageAgentReadiness) -> Self {
        Self {
            ready_for_agent: readiness.ready_for_agent,
            required_context_refs: readiness.required_context_refs.clone(),
            allowed_actions: readiness
                .allowed_actions
                .iter()
                .map(TaskActionType::from)
                .collect(),
            stop_conditions: readiness.stop_conditions.clone(),
            validation_commands: readiness.validation_commands.clone(),
        }
    }
}

impl From<&TaskActionType> for PlanningStorageTaskActionType {
    fn from(action_type: &TaskActionType) -> Self {
        match action_type {
            TaskActionType::Research => Self::Research,
            TaskActionType::Plan => Self::Plan,
            TaskActionType::Execute => Self::Execute,
            TaskActionType::Test => Self::Test,
            TaskActionType::Check => Self::Check,
            TaskActionType::Review => Self::Review,
        }
    }
}

impl From<&PlanningStorageTaskActionType> for TaskActionType {
    fn from(action_type: &PlanningStorageTaskActionType) -> Self {
        match action_type {
            PlanningStorageTaskActionType::Research => Self::Research,
            PlanningStorageTaskActionType::Plan => Self::Plan,
            PlanningStorageTaskActionType::Execute => Self::Execute,
            PlanningStorageTaskActionType::Test => Self::Test,
            PlanningStorageTaskActionType::Check => Self::Check,
            PlanningStorageTaskActionType::Review => Self::Review,
        }
    }
}

impl From<&TaskImportance> for PlanningStorageTaskImportance {
    fn from(importance: &TaskImportance) -> Self {
        match importance {
            TaskImportance::Low => Self::Low,
            TaskImportance::Normal => Self::Normal,
            TaskImportance::High => Self::High,
            TaskImportance::Critical => Self::Critical,
        }
    }
}

impl From<&PlanningStorageTaskImportance> for TaskImportance {
    fn from(importance: &PlanningStorageTaskImportance) -> Self {
        match importance {
            PlanningStorageTaskImportance::Low => Self::Low,
            PlanningStorageTaskImportance::Normal => Self::Normal,
            PlanningStorageTaskImportance::High => Self::High,
            PlanningStorageTaskImportance::Critical => Self::Critical,
        }
    }
}

impl From<&EnginePlanningReviewState> for PlanningStorageReviewState {
    fn from(review: &EnginePlanningReviewState) -> Self {
        match review {
            EnginePlanningReviewState::Draft => Self::Draft,
            EnginePlanningReviewState::ReviewRequested => Self::ReviewRequested,
            EnginePlanningReviewState::Accepted { reviewer_ref } => Self::Accepted {
                reviewer_ref: reviewer_ref.clone(),
            },
            EnginePlanningReviewState::ChangesRequested { reason } => Self::ChangesRequested {
                reason: reason.clone(),
            },
            EnginePlanningReviewState::Rejected { reason } => Self::Rejected {
                reason: reason.clone(),
            },
            EnginePlanningReviewState::Superseded => Self::Superseded,
        }
    }
}

impl From<&PlanningStorageReviewState> for EnginePlanningReviewState {
    fn from(review: &PlanningStorageReviewState) -> Self {
        match review {
            PlanningStorageReviewState::Draft => Self::Draft,
            PlanningStorageReviewState::ReviewRequested => Self::ReviewRequested,
            PlanningStorageReviewState::Accepted { reviewer_ref } => Self::Accepted {
                reviewer_ref: reviewer_ref.clone(),
            },
            PlanningStorageReviewState::ChangesRequested { reason } => Self::ChangesRequested {
                reason: reason.clone(),
            },
            PlanningStorageReviewState::Rejected { reason } => Self::Rejected {
                reason: reason.clone(),
            },
            PlanningStorageReviewState::Superseded => Self::Superseded,
        }
    }
}

impl From<&EngineTaskSeedPromotionState> for PlanningTaskSeedStoragePromotionState {
    fn from(promotion: &EngineTaskSeedPromotionState) -> Self {
        match promotion {
            EngineTaskSeedPromotionState::NotReady { reason } => Self::NotReady {
                reason: reason.clone(),
            },
            EngineTaskSeedPromotionState::Reviewable => Self::Reviewable,
            EngineTaskSeedPromotionState::ReadyForPromotion => Self::ReadyForPromotion,
            EngineTaskSeedPromotionState::Promoted { task_ref } => Self::Promoted {
                task_ref: task_ref.clone(),
            },
            EngineTaskSeedPromotionState::Blocked { reason } => Self::Blocked {
                reason: reason.clone(),
            },
        }
    }
}

impl From<&PlanningTaskSeedStoragePromotionState> for EngineTaskSeedPromotionState {
    fn from(promotion: &PlanningTaskSeedStoragePromotionState) -> Self {
        match promotion {
            PlanningTaskSeedStoragePromotionState::NotReady { reason } => Self::NotReady {
                reason: reason.clone(),
            },
            PlanningTaskSeedStoragePromotionState::Reviewable => Self::Reviewable,
            PlanningTaskSeedStoragePromotionState::ReadyForPromotion => Self::ReadyForPromotion,
            PlanningTaskSeedStoragePromotionState::Promoted { task_ref } => Self::Promoted {
                task_ref: task_ref.clone(),
            },
            PlanningTaskSeedStoragePromotionState::Blocked { reason } => Self::Blocked {
                reason: reason.clone(),
            },
        }
    }
}

pub fn encode_task_seed_storage_record(
    record: &EngineTaskSeedCandidateRecord,
) -> Result<Vec<u8>, PlanningTaskSeedRecordCodecError> {
    encode_task_seed_storage_payload(&PlanningTaskSeedStorageRecord::from(record))
}

pub fn encode_task_seed_storage_payload(
    record: &PlanningTaskSeedStorageRecord,
) -> Result<Vec<u8>, PlanningTaskSeedRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

pub fn decode_task_seed_storage_record(
    bytes: &[u8],
) -> Result<PlanningTaskSeedStorageRecord, PlanningTaskSeedRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

pub fn task_seed_from_storage_record(
    record: &PlanningTaskSeedStorageRecord,
) -> EngineTaskSeedCandidateRecord {
    EngineTaskSeedCandidateRecord::from(record)
}

fn codec_error(error: serde_json::Error) -> PlanningTaskSeedRecordCodecError {
    PlanningTaskSeedRecordCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests;
