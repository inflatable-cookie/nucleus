use serde::{Deserialize, Serialize};

use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
use nucleus_local_store::LocalStoreRecord;
use nucleus_projects::{
    decode_project_storage_record, ProjectStorageImportanceLevel, ProjectStorageStatus,
};

use super::ControlApiCodecError;

/// Display-ready project record DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlProjectRecordDto {
    pub project_id: String,
    pub display_name: String,
    pub status: String,
    pub importance_level: String,
    pub revision_id: String,
}

impl TryFrom<&LocalStoreRecord> for ControlProjectRecordDto {
    type Error = ControlApiCodecError;

    fn try_from(record: &LocalStoreRecord) -> Result<Self, Self::Error> {
        if record.domain != PersistenceDomain::Projects
            || record.kind != PersistenceRecordKind::Project
        {
            return Err(ControlApiCodecError::unsupported(
                "project display DTO requires project records",
            ));
        }

        let decoded = decode_project_storage_record(&record.payload.bytes).map_err(|error| {
            ControlApiCodecError::malformed(format!(
                "project storage payload could not be decoded: {}",
                error.reason
            ))
        })?;

        Ok(Self {
            project_id: decoded.project_id,
            display_name: decoded.display_name,
            status: project_status_dto(&decoded.status),
            importance_level: project_importance_dto(&decoded.importance_level),
            revision_id: record.revision_id.0.clone(),
        })
    }
}

fn project_status_dto(status: &ProjectStorageStatus) -> String {
    match status {
        ProjectStorageStatus::Active => "active",
        ProjectStorageStatus::Parked => "parked",
        ProjectStorageStatus::Archived => "archived",
    }
    .to_owned()
}

fn project_importance_dto(level: &ProjectStorageImportanceLevel) -> String {
    match level {
        ProjectStorageImportanceLevel::Low => "low",
        ProjectStorageImportanceLevel::Normal => "normal",
        ProjectStorageImportanceLevel::High => "high",
        ProjectStorageImportanceLevel::Critical => "critical",
    }
    .to_owned()
}
