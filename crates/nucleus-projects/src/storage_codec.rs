//! Project storage codec.
//!
//! Module index over the storage surface: record types, domain conversions,
//! legacy migration, and the schema-gated codec.

mod codec;
mod convert;
mod legacy;
mod types;
#[cfg(test)]
mod tests;

pub use codec::{
    decode_project_storage_record, encode_project_storage_payload, encode_project_storage_record,
};
pub use types::{
    GitRemoteMetadataStorageRecord, ManagementProjectionStorageRecord, ProjectRecordCodecError,
    ProjectResourceLocatorStorageRecord, ProjectResourceStorageKind,
    ProjectResourceStorageLocationStatus, ProjectResourceStorageRecord,
    ProjectResourceStorageRole, ProjectRetentionStorage, ProjectStorageImportanceLevel,
    ProjectStorageLocationStatus, ProjectStorageRecord, ProjectStorageStatus,
    WorkingResourceStorageRecord, PROJECT_STORAGE_SCHEMA_VERSION,
};
