//! Host-local immutable source snapshots for task review boundaries.

mod capture;
mod filesystem;
mod retention;
mod store;
mod types;

pub use store::TaskReviewSnapshotStore;
pub use types::{
    BlobRef, ManifestRef, SnapshotContentState, SnapshotCoverageState, SnapshotFileEntry,
    SnapshotFileRef, SnapshotManifest, SnapshotManifestResolution, SnapshotRef,
    SnapshotResolutionState, SnapshotRetentionState, SnapshotRole, SnapshotStoreError,
    SnapshotTextResolution, SnapshotTextResolutionState, TaskReviewSnapshotCaptureRequest,
};

#[cfg(test)]
mod tests;
