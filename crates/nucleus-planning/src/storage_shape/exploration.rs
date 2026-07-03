//! Serializable open-ended exploration storage records.

use serde::{Deserialize, Serialize};

use crate::{
    ExplorationAssumption, ExplorationConfidence, ExplorationMode, ExplorationNote,
    ExplorationNoteKind, ExplorationOption, ExplorationOptionStatus, ExplorationPriority,
    ExplorationQuestion, ExplorationQuestionStatus, ExplorationSession, ExplorationSessionStatus,
    ExplorationTradeoff, ExplorationTradeoffPosture,
};

use super::{
    codec_error, ExplorationPromotionStorageRefs, PlanningParticipantStorageRef,
    PlanningRecordCodecError, PlanningSourceStorageRef, PLANNING_STORAGE_SCHEMA_VERSION,
};

/// Serializable open-ended exploration session record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExplorationSessionStorageRecord {
    pub schema_version: u16,
    pub session_id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub scope_prompt: String,
    pub mode: ExplorationStorageMode,
    pub status: ExplorationSessionStorageStatus,
    #[serde(default)]
    pub participants: Vec<PlanningParticipantStorageRef>,
    #[serde(default)]
    pub source_conversation_refs: Vec<PlanningSourceStorageRef>,
    #[serde(default)]
    pub questions: Vec<ExplorationQuestionStorageRecord>,
    #[serde(default)]
    pub assumptions: Vec<ExplorationAssumptionStorageRecord>,
    #[serde(default)]
    pub options: Vec<ExplorationOptionStorageRecord>,
    #[serde(default)]
    pub notes: Vec<ExplorationNoteStorageRecord>,
    pub promotion_refs: ExplorationPromotionStorageRefs,
}

/// Serializable open-ended exploration mode.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", content = "value", rename_all = "snake_case")]
pub enum ExplorationStorageMode {
    OpenEnded,
    ProblemFraming,
    ProductIdeation,
    ArchitectureExploration,
    ResearchScoping,
    OptionComparison,
    Other(String),
}

/// Serializable exploration lifecycle state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplorationSessionStorageStatus {
    Draft,
    Active,
    Paused,
    AwaitingPromotionReview,
    Promoted,
    Superseded,
    Archived,
}

/// Serializable exploration question.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExplorationQuestionStorageRecord {
    pub question_id: String,
    pub text: String,
    pub status: ExplorationQuestionStorageStatus,
    pub priority: ExplorationStoragePriority,
    pub blocker: bool,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

/// Serializable exploration question status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplorationQuestionStorageStatus {
    Open,
    NeedsResearch,
    Answered,
    Deferred,
    Superseded,
}

/// Serializable exploration priority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplorationStoragePriority {
    Low,
    Normal,
    High,
    Blocking,
}

/// Serializable exploration assumption.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExplorationAssumptionStorageRecord {
    pub assumption_id: String,
    pub statement: String,
    pub confidence: ExplorationStorageConfidence,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub challenge_refs: Vec<String>,
}

/// Serializable exploration confidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplorationStorageConfidence {
    Unknown,
    Low,
    Medium,
    High,
}

/// Serializable exploration option.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExplorationOptionStorageRecord {
    pub option_id: String,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub tradeoffs: Vec<ExplorationTradeoffStorageRecord>,
    pub status: ExplorationOptionStorageStatus,
    #[serde(default)]
    pub rationale_refs: Vec<String>,
}

/// Serializable exploration option status.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplorationOptionStorageStatus {
    Proposed,
    UnderReview,
    Preferred,
    Rejected,
    Deferred,
    Superseded,
}

/// Serializable exploration tradeoff.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExplorationTradeoffStorageRecord {
    pub label: String,
    pub posture: ExplorationTradeoffStoragePosture,
    pub detail: String,
}

/// Serializable exploration tradeoff posture.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExplorationTradeoffStoragePosture {
    Supports,
    Weakens,
    Mixed,
    Unknown,
}

/// Serializable risk, opportunity, constraint, or decision-ref note.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExplorationNoteStorageRecord {
    pub note_id: String,
    pub kind: ExplorationNoteStorageKind,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

/// Serializable exploration note kind.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ExplorationNoteStorageKind {
    Risk,
    Opportunity,
    Constraint,
    OpenConcern,
    DecisionRef(String),
}

impl From<&ExplorationSession> for ExplorationSessionStorageRecord {
    fn from(session: &ExplorationSession) -> Self {
        Self {
            schema_version: PLANNING_STORAGE_SCHEMA_VERSION,
            session_id: session.id.0.clone(),
            project_id: session
                .project_id
                .as_ref()
                .map(|project_id| project_id.0.clone()),
            title: session.title.clone(),
            scope_prompt: session.scope_prompt.clone(),
            mode: ExplorationStorageMode::from(&session.mode),
            status: ExplorationSessionStorageStatus::from(&session.status),
            participants: session
                .participants
                .iter()
                .map(PlanningParticipantStorageRef::from)
                .collect(),
            source_conversation_refs: session
                .source_conversation_refs
                .iter()
                .map(PlanningSourceStorageRef::from)
                .collect(),
            questions: session
                .questions
                .iter()
                .map(ExplorationQuestionStorageRecord::from)
                .collect(),
            assumptions: session
                .assumptions
                .iter()
                .map(ExplorationAssumptionStorageRecord::from)
                .collect(),
            options: session
                .options
                .iter()
                .map(ExplorationOptionStorageRecord::from)
                .collect(),
            notes: session
                .notes
                .iter()
                .map(ExplorationNoteStorageRecord::from)
                .collect(),
            promotion_refs: ExplorationPromotionStorageRefs::from(&session.promotion_refs),
        }
    }
}

impl From<&ExplorationMode> for ExplorationStorageMode {
    fn from(mode: &ExplorationMode) -> Self {
        match mode {
            ExplorationMode::OpenEnded => Self::OpenEnded,
            ExplorationMode::ProblemFraming => Self::ProblemFraming,
            ExplorationMode::ProductIdeation => Self::ProductIdeation,
            ExplorationMode::ArchitectureExploration => Self::ArchitectureExploration,
            ExplorationMode::ResearchScoping => Self::ResearchScoping,
            ExplorationMode::OptionComparison => Self::OptionComparison,
            ExplorationMode::Other(value) => Self::Other(value.clone()),
        }
    }
}

impl From<&ExplorationSessionStatus> for ExplorationSessionStorageStatus {
    fn from(status: &ExplorationSessionStatus) -> Self {
        match status {
            ExplorationSessionStatus::Draft => Self::Draft,
            ExplorationSessionStatus::Active => Self::Active,
            ExplorationSessionStatus::Paused => Self::Paused,
            ExplorationSessionStatus::AwaitingPromotionReview => Self::AwaitingPromotionReview,
            ExplorationSessionStatus::Promoted => Self::Promoted,
            ExplorationSessionStatus::Superseded => Self::Superseded,
            ExplorationSessionStatus::Archived => Self::Archived,
        }
    }
}

impl From<&ExplorationQuestion> for ExplorationQuestionStorageRecord {
    fn from(question: &ExplorationQuestion) -> Self {
        Self {
            question_id: question.id.0.clone(),
            text: question.text.clone(),
            status: ExplorationQuestionStorageStatus::from(&question.status),
            priority: ExplorationStoragePriority::from(&question.priority),
            blocker: question.blocker,
            evidence_refs: question.evidence_refs.clone(),
        }
    }
}

impl From<&ExplorationQuestionStatus> for ExplorationQuestionStorageStatus {
    fn from(status: &ExplorationQuestionStatus) -> Self {
        match status {
            ExplorationQuestionStatus::Open => Self::Open,
            ExplorationQuestionStatus::NeedsResearch => Self::NeedsResearch,
            ExplorationQuestionStatus::Answered => Self::Answered,
            ExplorationQuestionStatus::Deferred => Self::Deferred,
            ExplorationQuestionStatus::Superseded => Self::Superseded,
        }
    }
}

impl From<&ExplorationPriority> for ExplorationStoragePriority {
    fn from(priority: &ExplorationPriority) -> Self {
        match priority {
            ExplorationPriority::Low => Self::Low,
            ExplorationPriority::Normal => Self::Normal,
            ExplorationPriority::High => Self::High,
            ExplorationPriority::Blocking => Self::Blocking,
        }
    }
}

impl From<&ExplorationAssumption> for ExplorationAssumptionStorageRecord {
    fn from(assumption: &ExplorationAssumption) -> Self {
        Self {
            assumption_id: assumption.id.0.clone(),
            statement: assumption.statement.clone(),
            confidence: ExplorationStorageConfidence::from(&assumption.confidence),
            evidence_refs: assumption.evidence_refs.clone(),
            challenge_refs: assumption.challenge_refs.clone(),
        }
    }
}

impl From<&ExplorationConfidence> for ExplorationStorageConfidence {
    fn from(confidence: &ExplorationConfidence) -> Self {
        match confidence {
            ExplorationConfidence::Unknown => Self::Unknown,
            ExplorationConfidence::Low => Self::Low,
            ExplorationConfidence::Medium => Self::Medium,
            ExplorationConfidence::High => Self::High,
        }
    }
}

impl From<&ExplorationOption> for ExplorationOptionStorageRecord {
    fn from(option: &ExplorationOption) -> Self {
        Self {
            option_id: option.id.0.clone(),
            title: option.title.clone(),
            summary: option.summary.clone(),
            tradeoffs: option
                .tradeoffs
                .iter()
                .map(ExplorationTradeoffStorageRecord::from)
                .collect(),
            status: ExplorationOptionStorageStatus::from(&option.status),
            rationale_refs: option.rationale_refs.clone(),
        }
    }
}

impl From<&ExplorationOptionStatus> for ExplorationOptionStorageStatus {
    fn from(status: &ExplorationOptionStatus) -> Self {
        match status {
            ExplorationOptionStatus::Proposed => Self::Proposed,
            ExplorationOptionStatus::UnderReview => Self::UnderReview,
            ExplorationOptionStatus::Preferred => Self::Preferred,
            ExplorationOptionStatus::Rejected => Self::Rejected,
            ExplorationOptionStatus::Deferred => Self::Deferred,
            ExplorationOptionStatus::Superseded => Self::Superseded,
        }
    }
}

impl From<&ExplorationTradeoff> for ExplorationTradeoffStorageRecord {
    fn from(tradeoff: &ExplorationTradeoff) -> Self {
        Self {
            label: tradeoff.label.clone(),
            posture: ExplorationTradeoffStoragePosture::from(&tradeoff.posture),
            detail: tradeoff.detail.clone(),
        }
    }
}

impl From<&ExplorationTradeoffPosture> for ExplorationTradeoffStoragePosture {
    fn from(posture: &ExplorationTradeoffPosture) -> Self {
        match posture {
            ExplorationTradeoffPosture::Supports => Self::Supports,
            ExplorationTradeoffPosture::Weakens => Self::Weakens,
            ExplorationTradeoffPosture::Mixed => Self::Mixed,
            ExplorationTradeoffPosture::Unknown => Self::Unknown,
        }
    }
}

impl From<&ExplorationNote> for ExplorationNoteStorageRecord {
    fn from(note: &ExplorationNote) -> Self {
        Self {
            note_id: note.id.0.clone(),
            kind: ExplorationNoteStorageKind::from(&note.kind),
            title: note.title.clone(),
            body: note.body.clone(),
            evidence_refs: note.evidence_refs.clone(),
        }
    }
}

impl From<&ExplorationNoteKind> for ExplorationNoteStorageKind {
    fn from(kind: &ExplorationNoteKind) -> Self {
        match kind {
            ExplorationNoteKind::Risk => Self::Risk,
            ExplorationNoteKind::Opportunity => Self::Opportunity,
            ExplorationNoteKind::Constraint => Self::Constraint,
            ExplorationNoteKind::OpenConcern => Self::OpenConcern,
            ExplorationNoteKind::DecisionRef(decision_id) => {
                Self::DecisionRef(decision_id.0.clone())
            }
        }
    }
}

/// Encode an exploration session into the first JSON storage payload.
pub fn encode_exploration_session_storage_record(
    session: &ExplorationSession,
) -> Result<Vec<u8>, PlanningRecordCodecError> {
    encode_exploration_session_storage_payload(&ExplorationSessionStorageRecord::from(session))
}

/// Encode an already decoded exploration session storage record.
pub fn encode_exploration_session_storage_payload(
    record: &ExplorationSessionStorageRecord,
) -> Result<Vec<u8>, PlanningRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode the first JSON storage payload into an exploration session storage
/// record.
pub fn decode_exploration_session_storage_record(
    bytes: &[u8],
) -> Result<ExplorationSessionStorageRecord, PlanningRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}
