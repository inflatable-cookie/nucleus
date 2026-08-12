//! Project storage record encode/decode with schema-version gating and
//! legacy v1 migration on decode.
//!
//! Split from the storage_codec god file; behavior unchanged.

use super::legacy::LegacyProjectStorageRecord;
use super::types::{
    ProjectRecordCodecError, ProjectStorageRecord, PROJECT_STORAGE_SCHEMA_VERSION,
};
use crate::Project;

pub fn encode_project_storage_record(
    project: &Project,
) -> Result<Vec<u8>, ProjectRecordCodecError> {
    encode_project_storage_payload(&ProjectStorageRecord::from(project))
}

pub fn encode_project_storage_payload(
    record: &ProjectStorageRecord,
) -> Result<Vec<u8>, ProjectRecordCodecError> {
    if record.schema_version != PROJECT_STORAGE_SCHEMA_VERSION {
        return Err(ProjectRecordCodecError {
            reason: format!(
                "unsupported project storage schema version: {}",
                record.schema_version
            ),
        });
    }
    serde_json::to_vec(record).map_err(codec_error)
}

pub fn decode_project_storage_record(
    bytes: &[u8],
) -> Result<ProjectStorageRecord, ProjectRecordCodecError> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(codec_error)?;
    if let Some(schema_version) = value.get("schema_version") {
        if !matches!(schema_version.as_u64(), Some(2) | Some(3)) {
            return Err(ProjectRecordCodecError {
                reason: format!(
                    "unsupported project storage schema version: {}",
                    schema_version
                ),
            });
        }
        let mut record: ProjectStorageRecord = serde_json::from_value(value).map_err(codec_error)?;
        record.schema_version = PROJECT_STORAGE_SCHEMA_VERSION;
        Ok(record)
    } else {
        serde_json::from_value::<LegacyProjectStorageRecord>(value)
            .map(LegacyProjectStorageRecord::migrate)
            .map_err(codec_error)
    }
}

fn codec_error(error: serde_json::Error) -> ProjectRecordCodecError {
    ProjectRecordCodecError {
        reason: error.to_string(),
    }
}
