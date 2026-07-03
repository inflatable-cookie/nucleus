//! Serializable refs shared by planning storage records.

use serde::{Deserialize, Serialize};

use crate::{
    ExplorationPromotionRefs, PlanningOutputRefs, PlanningParticipantRef, PlanningParticipantRole,
    PlanningSourceKind, PlanningSourceRef,
};

/// Serializable planning participant ref.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningParticipantStorageRef {
    pub actor_ref: String,
    pub role: PlanningParticipantStorageRole,
}

/// Serializable planning participant role.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "role", content = "value", rename_all = "snake_case")]
pub enum PlanningParticipantStorageRole {
    Human,
    Agent,
    Steward,
    Harness,
    System,
    Other(String),
}

/// Serializable planning source ref.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningSourceStorageRef {
    pub source_ref: String,
    pub kind: PlanningSourceStorageKind,
}

/// Serializable planning source kind.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PlanningSourceStorageKind {
    OperatorPrompt,
    ConversationSummary,
    TranscriptRef,
    ExistingDocument,
    ResearchRun,
    Memory,
    Task,
    ProjectionFile,
    Other(String),
}

/// Serializable planning session output refs.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningOutputStorageRefs {
    #[serde(default)]
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub task_seed_refs: Vec<String>,
    #[serde(default)]
    pub memory_proposal_refs: Vec<String>,
    #[serde(default)]
    pub research_run_brief_refs: Vec<String>,
}

/// Serializable exploration promotion refs.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExplorationPromotionStorageRefs {
    #[serde(default)]
    pub accepted_artifact_refs: Vec<String>,
    #[serde(default)]
    pub research_run_brief_refs: Vec<String>,
    #[serde(default)]
    pub task_seed_refs: Vec<String>,
    #[serde(default)]
    pub memory_proposal_refs: Vec<String>,
    #[serde(default)]
    pub decision_refs: Vec<String>,
    #[serde(default)]
    pub goal_refs: Vec<String>,
    #[serde(default)]
    pub roadmap_branch_refs: Vec<String>,
}

impl From<&PlanningParticipantRef> for PlanningParticipantStorageRef {
    fn from(participant: &PlanningParticipantRef) -> Self {
        Self {
            actor_ref: participant.actor_ref.clone(),
            role: PlanningParticipantStorageRole::from(&participant.role),
        }
    }
}

impl From<&PlanningParticipantRole> for PlanningParticipantStorageRole {
    fn from(role: &PlanningParticipantRole) -> Self {
        match role {
            PlanningParticipantRole::Human => Self::Human,
            PlanningParticipantRole::Agent => Self::Agent,
            PlanningParticipantRole::Steward => Self::Steward,
            PlanningParticipantRole::Harness => Self::Harness,
            PlanningParticipantRole::System => Self::System,
            PlanningParticipantRole::Other(value) => Self::Other(value.clone()),
        }
    }
}

impl From<&PlanningSourceRef> for PlanningSourceStorageRef {
    fn from(source: &PlanningSourceRef) -> Self {
        Self {
            source_ref: source.source_ref.clone(),
            kind: PlanningSourceStorageKind::from(&source.kind),
        }
    }
}

impl From<&PlanningSourceKind> for PlanningSourceStorageKind {
    fn from(kind: &PlanningSourceKind) -> Self {
        match kind {
            PlanningSourceKind::OperatorPrompt => Self::OperatorPrompt,
            PlanningSourceKind::ConversationSummary => Self::ConversationSummary,
            PlanningSourceKind::TranscriptRef => Self::TranscriptRef,
            PlanningSourceKind::ExistingDocument => Self::ExistingDocument,
            PlanningSourceKind::ResearchRun => Self::ResearchRun,
            PlanningSourceKind::Memory => Self::Memory,
            PlanningSourceKind::Task => Self::Task,
            PlanningSourceKind::ProjectionFile => Self::ProjectionFile,
            PlanningSourceKind::Other(value) => Self::Other(value.clone()),
        }
    }
}

impl From<&PlanningOutputRefs> for PlanningOutputStorageRefs {
    fn from(refs: &PlanningOutputRefs) -> Self {
        Self {
            artifact_refs: refs
                .artifact_refs
                .iter()
                .map(|artifact_id| artifact_id.0.clone())
                .collect(),
            task_seed_refs: refs
                .task_seed_refs
                .iter()
                .map(|task_seed_id| task_seed_id.0.clone())
                .collect(),
            memory_proposal_refs: refs
                .memory_proposal_refs
                .iter()
                .map(|memory_id| memory_id.0.clone())
                .collect(),
            research_run_brief_refs: refs
                .research_run_brief_refs
                .iter()
                .map(|research_id| research_id.0.clone())
                .collect(),
        }
    }
}

impl From<&ExplorationPromotionRefs> for ExplorationPromotionStorageRefs {
    fn from(refs: &ExplorationPromotionRefs) -> Self {
        Self {
            accepted_artifact_refs: refs
                .accepted_artifact_refs
                .iter()
                .map(|artifact_id| artifact_id.0.clone())
                .collect(),
            research_run_brief_refs: refs
                .research_run_brief_refs
                .iter()
                .map(|research_id| research_id.0.clone())
                .collect(),
            task_seed_refs: refs
                .task_seed_refs
                .iter()
                .map(|task_seed_id| task_seed_id.0.clone())
                .collect(),
            memory_proposal_refs: refs
                .memory_proposal_refs
                .iter()
                .map(|memory_id| memory_id.0.clone())
                .collect(),
            decision_refs: refs
                .decision_refs
                .iter()
                .map(|decision_id| decision_id.0.clone())
                .collect(),
            goal_refs: refs
                .goal_refs
                .iter()
                .map(|goal_id| goal_id.0.clone())
                .collect(),
            roadmap_branch_refs: refs
                .roadmap_branch_refs
                .iter()
                .map(|branch_id| branch_id.0.clone())
                .collect(),
        }
    }
}
