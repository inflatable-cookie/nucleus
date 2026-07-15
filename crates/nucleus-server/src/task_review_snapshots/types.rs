use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct SnapshotRef(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ManifestRef(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct BlobRef(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct SnapshotFileRef(pub String);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotRole {
    Baseline,
    Target,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotCoverageState {
    CompleteAdmittedFiles,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SnapshotContentState {
    StoredText { blob_ref: BlobRef },
    BinaryMetadataOnly,
    OversizedMetadataOnly,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotFileEntry {
    pub file_ref: SnapshotFileRef,
    pub display_path: String,
    pub content_hash: String,
    pub byte_size: u64,
    pub content_state: SnapshotContentState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotManifest {
    pub snapshot_ref: SnapshotRef,
    pub manifest_ref: ManifestRef,
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub work_item_id: String,
    pub role: SnapshotRole,
    pub created_at_unix_seconds: u64,
    pub coverage: SnapshotCoverageState,
    pub retained_text_bytes: u64,
    pub files: Vec<SnapshotFileEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskReviewSnapshotCaptureRequest {
    pub project_id: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    pub work_item_id: String,
    pub role: SnapshotRole,
    pub created_at_unix_seconds: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotRetentionState {
    Active,
    AwaitingReview,
    CleanupGrace,
    Expired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotResolutionState {
    Available,
    CleanupPending,
    Missing,
    Expired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotManifestResolution {
    pub state: SnapshotResolutionState,
    pub manifest: Option<SnapshotManifest>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotTextResolutionState {
    Available,
    CleanupPending,
    NotStored,
    FileNotFound,
    BlobMissing,
    SnapshotMissing,
    SnapshotExpired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotTextResolution {
    pub state: SnapshotTextResolutionState,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SnapshotStoreError {
    CaptureUnavailable(String),
    InvalidRef(String),
    Io(String),
    Codec(String),
}

impl fmt::Display for SnapshotStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (kind, reason) = match self {
            Self::CaptureUnavailable(reason) => ("snapshot capture unavailable", reason),
            Self::InvalidRef(reason) => ("invalid snapshot ref", reason),
            Self::Io(reason) => ("snapshot store I/O failed", reason),
            Self::Codec(reason) => ("snapshot store codec failed", reason),
        };
        write!(formatter, "{kind}: {reason}")
    }
}

impl std::error::Error for SnapshotStoreError {}

impl From<std::io::Error> for SnapshotStoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}
