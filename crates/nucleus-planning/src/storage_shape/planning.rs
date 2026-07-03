//! Serializable guided planning session storage records.

use serde::{Deserialize, Serialize};

use crate::{PlanningSession, PlanningSessionKind, PlanningSessionStatus};

use super::{
    codec_error, PlanningOutputStorageRefs, PlanningParticipantStorageRef,
    PlanningRecordCodecError, PlanningSourceStorageRef, PLANNING_STORAGE_SCHEMA_VERSION,
};

/// Serializable guided planning session record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PlanningSessionStorageRecord {
    pub schema_version: u16,
    pub session_id: String,
    pub project_id: String,
    pub kind: PlanningSessionStorageKind,
    pub status: PlanningSessionStorageStatus,
    #[serde(default)]
    pub prompt_or_template_refs: Vec<String>,
    #[serde(default)]
    pub participants: Vec<PlanningParticipantStorageRef>,
    #[serde(default)]
    pub source_refs: Vec<PlanningSourceStorageRef>,
    pub output_refs: PlanningOutputStorageRefs,
}

/// Serializable planning session kind.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PlanningSessionStorageKind {
    ProjectIntake,
    VisionDefinition,
    Ideation,
    ArchitecturePlanning,
    ResearchPlanning,
    DeepResearch,
    RoadmapPlanning,
    TaskBreakdown,
    DecisionReview,
    Other(String),
}

/// Serializable planning session lifecycle state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningSessionStorageStatus {
    Draft,
    Active,
    Paused,
    Review,
    Accepted,
    Superseded,
    Archived,
}

impl From<&PlanningSession> for PlanningSessionStorageRecord {
    fn from(session: &PlanningSession) -> Self {
        Self {
            schema_version: PLANNING_STORAGE_SCHEMA_VERSION,
            session_id: session.id.0.clone(),
            project_id: session.project_id.0.clone(),
            kind: PlanningSessionStorageKind::from(&session.kind),
            status: PlanningSessionStorageStatus::from(&session.status),
            prompt_or_template_refs: session.prompt_or_template_refs.clone(),
            participants: session
                .participants
                .iter()
                .map(PlanningParticipantStorageRef::from)
                .collect(),
            source_refs: session
                .source_refs
                .iter()
                .map(PlanningSourceStorageRef::from)
                .collect(),
            output_refs: PlanningOutputStorageRefs::from(&session.output_refs),
        }
    }
}

impl From<&PlanningSessionKind> for PlanningSessionStorageKind {
    fn from(kind: &PlanningSessionKind) -> Self {
        match kind {
            PlanningSessionKind::ProjectIntake => Self::ProjectIntake,
            PlanningSessionKind::VisionDefinition => Self::VisionDefinition,
            PlanningSessionKind::Ideation => Self::Ideation,
            PlanningSessionKind::ArchitecturePlanning => Self::ArchitecturePlanning,
            PlanningSessionKind::ResearchPlanning => Self::ResearchPlanning,
            PlanningSessionKind::DeepResearch => Self::DeepResearch,
            PlanningSessionKind::RoadmapPlanning => Self::RoadmapPlanning,
            PlanningSessionKind::TaskBreakdown => Self::TaskBreakdown,
            PlanningSessionKind::DecisionReview => Self::DecisionReview,
            PlanningSessionKind::Other(value) => Self::Other(value.clone()),
        }
    }
}

impl From<&PlanningSessionStatus> for PlanningSessionStorageStatus {
    fn from(status: &PlanningSessionStatus) -> Self {
        match status {
            PlanningSessionStatus::Draft => Self::Draft,
            PlanningSessionStatus::Active => Self::Active,
            PlanningSessionStatus::Paused => Self::Paused,
            PlanningSessionStatus::Review => Self::Review,
            PlanningSessionStatus::Accepted => Self::Accepted,
            PlanningSessionStatus::Superseded => Self::Superseded,
            PlanningSessionStatus::Archived => Self::Archived,
        }
    }
}

/// Encode a planning session into the first JSON storage payload.
pub fn encode_planning_session_storage_record(
    session: &PlanningSession,
) -> Result<Vec<u8>, PlanningRecordCodecError> {
    encode_planning_session_storage_payload(&PlanningSessionStorageRecord::from(session))
}

/// Encode an already decoded planning session storage record.
pub fn encode_planning_session_storage_payload(
    record: &PlanningSessionStorageRecord,
) -> Result<Vec<u8>, PlanningRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode the first JSON storage payload into a planning session storage record.
pub fn decode_planning_session_storage_record(
    bytes: &[u8],
) -> Result<PlanningSessionStorageRecord, PlanningRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}
