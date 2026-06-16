use serde::{Deserialize, Serialize};

use nucleus_core::{PersistenceDomain, PersistenceRecordKind};
use nucleus_local_store::LocalStoreRecord;

/// Serializable state record DTO.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlStateRecordDto {
    pub id: String,
    pub domain: String,
    pub kind: String,
    pub revision_id: String,
    pub media_type: Option<String>,
    pub payload_bytes: Vec<u8>,
}

impl From<&LocalStoreRecord> for ControlStateRecordDto {
    fn from(record: &LocalStoreRecord) -> Self {
        Self {
            id: record.id.0.clone(),
            domain: persistence_domain_dto(&record.domain),
            kind: persistence_kind_dto(&record.kind),
            revision_id: record.revision_id.0.clone(),
            media_type: record.payload.media_type.clone(),
            payload_bytes: record.payload.bytes.clone(),
        }
    }
}

fn persistence_domain_dto(domain: &PersistenceDomain) -> String {
    format!("{domain:?}")
}

fn persistence_kind_dto(kind: &PersistenceRecordKind) -> String {
    format!("{kind:?}")
}
