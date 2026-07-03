//! App-native structured planning domain types.
//!
//! This crate owns planning and exploration value records. It does not
//! implement storage, model orchestration, task creation, memory extraction,
//! deep research execution, projection apply, or UI behavior.

pub mod artifacts;
pub mod exploration;
pub mod ids;
pub mod refs;
pub mod sessions;
pub mod storage_shape;

pub use artifacts::{
    PlanningArtifactLink, PlanningArtifactSourceRefs, PlanningReviewState, PlanningTaskSeedLink,
    PlanningTaskSeedPromotionLinkState,
};
pub use exploration::{
    ExplorationAssumption, ExplorationConfidence, ExplorationMode, ExplorationNote,
    ExplorationNoteKind, ExplorationOption, ExplorationOptionStatus, ExplorationPriority,
    ExplorationPromotionRefs, ExplorationQuestion, ExplorationQuestionStatus, ExplorationSession,
    ExplorationSessionStatus, ExplorationSessionTimestamps, ExplorationTradeoff,
    ExplorationTradeoffPosture,
};
pub use ids::{
    ExplorationAssumptionId, ExplorationNoteId, ExplorationOptionId, ExplorationQuestionId,
    ExplorationSessionId, MemoryProposalId, PlanningArtifactId, PlanningDecisionId, PlanningGoalId,
    PlanningSessionId, PlanningTaskSeedId, ResearchRunBriefId, RoadmapBranchId,
};
pub use refs::{
    PlanningOutputRefs, PlanningParticipantRef, PlanningParticipantRole, PlanningSourceKind,
    PlanningSourceRef,
};
pub use sessions::{
    PlanningSession, PlanningSessionKind, PlanningSessionStatus, PlanningSessionTimestamps,
};
pub use storage_shape::{
    decode_exploration_session_storage_record, decode_planning_session_storage_record,
    encode_exploration_session_storage_payload, encode_exploration_session_storage_record,
    encode_planning_session_storage_payload, encode_planning_session_storage_record,
    ExplorationAssumptionStorageRecord, ExplorationNoteStorageKind, ExplorationNoteStorageRecord,
    ExplorationOptionStorageRecord, ExplorationOptionStorageStatus,
    ExplorationPromotionStorageRefs, ExplorationQuestionStorageRecord,
    ExplorationQuestionStorageStatus, ExplorationSessionStorageRecord,
    ExplorationSessionStorageStatus, ExplorationStorageConfidence, ExplorationStorageMode,
    ExplorationStoragePriority, ExplorationTradeoffStoragePosture,
    ExplorationTradeoffStorageRecord, PlanningOutputStorageRefs, PlanningParticipantStorageRef,
    PlanningParticipantStorageRole, PlanningRecordCodecError, PlanningSessionStorageKind,
    PlanningSessionStorageRecord, PlanningSessionStorageStatus, PlanningSourceStorageKind,
    PlanningSourceStorageRef, PLANNING_STORAGE_SCHEMA_VERSION,
};
