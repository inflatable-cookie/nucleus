use nucleus_projects::ProjectStorageRecord;
use nucleus_tasks::TaskStorageRecord;

use crate::{
    EnginePlanningArtifactBody, EnginePlanningArtifactKind, EnginePlanningArtifactRecord,
    EnginePlanningArtifactStatus, EnginePlanningReviewState, EngineTaskSeedCandidateRecord,
    PlanningStorageAcceptanceCriterion, PlanningStorageAgentReadinessHints,
    PlanningStorageTaskActionType, PlanningStorageTaskImportance,
    PlanningTaskSeedStoragePromotionState,
};
use serde::{Deserialize, Serialize};

pub const MANAGEMENT_PROJECTION_ROOT: &str = "nucleus";
pub const MANAGEMENT_PROJECTION_SCHEMA_V1: &str = "nucleus.management_projection.v1";

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ManagementProjectionRecordId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ManagementProjectionFileRef(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ManagementProjectionSchemaVersion(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionFileRefError {
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionRecordKind {
    Project,
    RepoMembership,
    Task,
    Index,
    ArtifactIndex,
    PlanningArtifact,
    PlanningTaskSeed,
    SharedMemory,
    ResearchSynthesis,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionEnvelope {
    pub schema_version: ManagementProjectionSchemaVersion,
    pub record_id: ManagementProjectionRecordId,
    pub record_kind: ManagementProjectionRecordKind,
    pub file_ref: ManagementProjectionFileRef,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionRoot {
    pub relative_path: String,
    pub visible_by_default: bool,
}

impl Default for ManagementProjectionRoot {
    fn default() -> Self {
        Self {
            relative_path: MANAGEMENT_PROJECTION_ROOT.to_owned(),
            visible_by_default: true,
        }
    }
}

impl ManagementProjectionSchemaVersion {
    pub fn current() -> Self {
        Self(MANAGEMENT_PROJECTION_SCHEMA_V1.to_owned())
    }
}

impl ManagementProjectionFileRef {
    pub fn project() -> Self {
        Self("nucleus/project.toml".to_owned())
    }

    pub fn repo_membership(repo_membership_id: &str) -> Self {
        Self(format!("nucleus/repos/{repo_membership_id}.toml"))
    }

    pub fn task(task_id: &str) -> Self {
        Self(format!("nucleus/tasks/{task_id}.toml"))
    }

    pub fn indexes_readme() -> Self {
        Self("nucleus/indexes/README.md".to_owned())
    }

    pub fn artifacts_readme() -> Self {
        Self("nucleus/artifacts/README.md".to_owned())
    }

    pub fn try_planning_artifact(
        artifact_id: &str,
    ) -> Result<Self, ManagementProjectionFileRefError> {
        safe_projection_file_stem(artifact_id)?;
        Ok(Self(format!("nucleus/planning/{artifact_id}.toml")))
    }

    pub fn try_planning_task_seed(seed_id: &str) -> Result<Self, ManagementProjectionFileRefError> {
        safe_projection_file_stem(seed_id)?;
        Ok(Self(format!("nucleus/planning/task-seeds/{seed_id}.toml")))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionExportPlan {
    pub root: ManagementProjectionRoot,
    pub entries: Vec<ManagementProjectionExportEntry>,
    pub issues: Vec<ManagementProjectionExportIssue>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionExportEntry {
    pub envelope: ManagementProjectionEnvelope,
    pub payload: ManagementProjectionPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionExportIssue {
    pub kind: ManagementProjectionExportIssueKind,
    pub record_id: Option<ManagementProjectionRecordId>,
    pub field: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionExportIssueKind {
    InvalidFileRef,
    DecodeFailed,
    UnsupportedRecord,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionPlanningExportDiagnostics {
    pub exportable_planning_artifacts: usize,
    pub exportable_planning_task_seeds: usize,
    pub blocked_records: usize,
    pub unsupported_records: usize,
    pub decode_failed_records: usize,
    pub file_write_authority: bool,
    pub scm_mutation_authority: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionFileDocument {
    pub envelope: ManagementProjectionEnvelope,
    pub payload: ManagementProjectionPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionFileFormat {
    TomlV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "record", rename_all = "snake_case")]
pub enum ManagementProjectionPayload {
    Project(ProjectStorageRecord),
    Task(TaskStorageRecord),
    PlanningArtifact(ManagementProjectionPlanningArtifactRecord),
    PlanningTaskSeed(ManagementProjectionPlanningTaskSeedRecord),
    Index {
        title: String,
    },
    ArtifactIndex {
        title: String,
    },
    Unsupported {
        payload_kind: String,
        retained_payload: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionFileCodecError {
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionPlanningArtifactRecord {
    pub artifact_id: String,
    pub project_id: String,
    pub artifact_kind: ManagementProjectionPlanningArtifactKind,
    pub title: String,
    pub body: ManagementProjectionPlanningArtifactBody,
    pub status: ManagementProjectionPlanningArtifactStatus,
    pub source_planning_session_ref: Option<String>,
    pub source_research_run_refs: Vec<String>,
    pub source_memory_refs: Vec<String>,
    pub supersedes: Vec<String>,
    pub superseded_by: Vec<String>,
    pub projection_ref: Option<String>,
    pub review: ManagementProjectionPlanningReviewState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionPlanningTaskSeedRecord {
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
    pub review: ManagementProjectionPlanningReviewState,
    pub promotion: PlanningTaskSeedStoragePromotionState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionPlanningArtifactKind {
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ManagementProjectionPlanningArtifactBody {
    Text(String),
    StructuredRef(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionPlanningArtifactStatus {
    Draft,
    Active,
    Accepted,
    Superseded,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "value", rename_all = "snake_case")]
pub enum ManagementProjectionPlanningReviewState {
    Draft,
    ReviewRequested,
    Accepted { reviewer_ref: String },
    ChangesRequested { reason: String },
    Rejected { reason: String },
    Superseded,
}

impl From<&EnginePlanningArtifactRecord> for ManagementProjectionPlanningArtifactRecord {
    fn from(record: &EnginePlanningArtifactRecord) -> Self {
        Self {
            artifact_id: record.artifact_id.0.clone(),
            project_id: record.project_id.0.clone(),
            artifact_kind: ManagementProjectionPlanningArtifactKind::from(&record.kind),
            title: record.title.clone(),
            body: ManagementProjectionPlanningArtifactBody::from(&record.body),
            status: ManagementProjectionPlanningArtifactStatus::from(&record.status),
            source_planning_session_ref: record
                .source_planning_session_ref
                .as_ref()
                .map(|session_id| session_id.0.clone()),
            source_research_run_refs: record.source_research_run_refs.clone(),
            source_memory_refs: record.source_memory_refs.clone(),
            supersedes: record
                .supersedes
                .iter()
                .map(|artifact_id| artifact_id.0.clone())
                .collect(),
            superseded_by: record
                .superseded_by
                .iter()
                .map(|artifact_id| artifact_id.0.clone())
                .collect(),
            projection_ref: record.projection_ref.clone(),
            review: ManagementProjectionPlanningReviewState::from(&record.review),
        }
    }
}

impl From<&EngineTaskSeedCandidateRecord> for ManagementProjectionPlanningTaskSeedRecord {
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
            review: ManagementProjectionPlanningReviewState::from(&record.review),
            promotion: PlanningTaskSeedStoragePromotionState::from(&record.promotion),
        }
    }
}

impl From<&EnginePlanningArtifactKind> for ManagementProjectionPlanningArtifactKind {
    fn from(kind: &EnginePlanningArtifactKind) -> Self {
        match kind {
            EnginePlanningArtifactKind::Vision => Self::Vision,
            EnginePlanningArtifactKind::Principles => Self::Principles,
            EnginePlanningArtifactKind::Constraints => Self::Constraints,
            EnginePlanningArtifactKind::ArchitectureOutline => Self::ArchitectureOutline,
            EnginePlanningArtifactKind::SystemInventory => Self::SystemInventory,
            EnginePlanningArtifactKind::ResearchQuestionSet => Self::ResearchQuestionSet,
            EnginePlanningArtifactKind::ResearchRunBrief => Self::ResearchRunBrief,
            EnginePlanningArtifactKind::ResearchSynthesis => Self::ResearchSynthesis,
            EnginePlanningArtifactKind::DecisionRecord => Self::DecisionRecord,
            EnginePlanningArtifactKind::RoadmapOutline => Self::RoadmapOutline,
            EnginePlanningArtifactKind::Milestone => Self::Milestone,
            EnginePlanningArtifactKind::TaskSeedGroup => Self::TaskSeedGroup,
            EnginePlanningArtifactKind::OpenQuestionSet => Self::OpenQuestionSet,
            EnginePlanningArtifactKind::Custom(value) => Self::Custom(value.clone()),
        }
    }
}

impl From<&EnginePlanningArtifactBody> for ManagementProjectionPlanningArtifactBody {
    fn from(body: &EnginePlanningArtifactBody) -> Self {
        match body {
            EnginePlanningArtifactBody::Text(text) => Self::Text(text.clone()),
            EnginePlanningArtifactBody::StructuredRef(value) => Self::StructuredRef(value.clone()),
        }
    }
}

impl From<&EnginePlanningArtifactStatus> for ManagementProjectionPlanningArtifactStatus {
    fn from(status: &EnginePlanningArtifactStatus) -> Self {
        match status {
            EnginePlanningArtifactStatus::Draft => Self::Draft,
            EnginePlanningArtifactStatus::Active => Self::Active,
            EnginePlanningArtifactStatus::Accepted => Self::Accepted,
            EnginePlanningArtifactStatus::Superseded => Self::Superseded,
            EnginePlanningArtifactStatus::Archived => Self::Archived,
        }
    }
}

impl From<&EnginePlanningReviewState> for ManagementProjectionPlanningReviewState {
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

fn safe_projection_file_stem(value: &str) -> Result<(), ManagementProjectionFileRefError> {
    let unsafe_path = value.trim().is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.split('.').any(|segment| segment == "..");

    if unsafe_path {
        Err(ManagementProjectionFileRefError {
            reason: format!("unsafe management projection file id: {value}"),
        })
    } else {
        Ok(())
    }
}
