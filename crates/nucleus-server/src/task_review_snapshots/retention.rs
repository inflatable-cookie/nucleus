use serde::{Deserialize, Serialize};

use super::types::{ManifestRef, SnapshotRef, SnapshotRetentionState};

pub(super) const CLEANUP_GRACE_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(super) struct SnapshotRetentionRecord {
    pub snapshot_ref: SnapshotRef,
    pub manifest_ref: ManifestRef,
    pub state: SnapshotRetentionState,
    pub cleanup_after_unix_seconds: Option<u64>,
}

impl SnapshotRetentionRecord {
    pub fn active(snapshot_ref: SnapshotRef, manifest_ref: ManifestRef) -> Self {
        Self {
            snapshot_ref,
            manifest_ref,
            state: SnapshotRetentionState::Active,
            cleanup_after_unix_seconds: None,
        }
    }
}
