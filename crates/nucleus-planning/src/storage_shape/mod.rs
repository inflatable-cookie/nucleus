//! JSON storage codec for app-native planning records.
//!
//! These payloads persist structured planning state only. They intentionally do
//! not store raw transcripts, provider payloads, secrets, private memories, or
//! active task mutation records.

mod error;
mod exploration;
mod goals;
mod planning;
mod refs;

#[cfg(test)]
mod tests;

pub use error::{codec_error, PlanningRecordCodecError, PLANNING_STORAGE_SCHEMA_VERSION};
pub use exploration::{
    decode_exploration_session_storage_record, encode_exploration_session_storage_payload,
    encode_exploration_session_storage_record, ExplorationAssumptionStorageRecord,
    ExplorationNoteStorageKind, ExplorationNoteStorageRecord, ExplorationOptionStorageRecord,
    ExplorationOptionStorageStatus, ExplorationQuestionStorageRecord,
    ExplorationQuestionStorageStatus, ExplorationSessionStorageRecord,
    ExplorationSessionStorageStatus, ExplorationStorageConfidence, ExplorationStorageMode,
    ExplorationStoragePriority, ExplorationTradeoffStoragePosture,
    ExplorationTradeoffStorageRecord,
};
pub use goals::{
    decode_goal_storage_record, encode_goal_storage_payload, encode_goal_storage_record,
    goal_from_storage_record, GoalStorageRecord, GoalStorageStatus,
};
pub use planning::{
    decode_planning_session_storage_record, encode_planning_session_storage_payload,
    encode_planning_session_storage_record, PlanningSessionStorageKind,
    PlanningSessionStorageRecord, PlanningSessionStorageStatus,
};
pub use refs::{
    ExplorationPromotionStorageRefs, PlanningOutputStorageRefs, PlanningParticipantStorageRef,
    PlanningParticipantStorageRole, PlanningSourceStorageKind, PlanningSourceStorageRef,
};
