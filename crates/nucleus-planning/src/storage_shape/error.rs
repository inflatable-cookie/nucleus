//! Shared planning storage codec helpers.

/// Storage version used by the first planning JSON payloads.
pub const PLANNING_STORAGE_SCHEMA_VERSION: u16 = 1;

/// Planning record codec error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningRecordCodecError {
    pub reason: String,
}

pub fn codec_error(error: serde_json::Error) -> PlanningRecordCodecError {
    PlanningRecordCodecError {
        reason: error.to_string(),
    }
}
