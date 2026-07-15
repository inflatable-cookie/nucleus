//! Durable project-lifecycle receipt records.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerStateService;

const RECEIPT_SCHEMA_VERSION: u16 = 1;
const RECEIPT_PREFIX: &str = "project-lifecycle-receipt:";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProjectLifecycleReceiptRecord {
    pub schema_version: u16,
    pub receipt_id: String,
    pub command_id: String,
    pub idempotency_key: String,
    pub request_fingerprint: String,
    pub project_id: String,
    pub action: String,
    pub actor_ref: String,
    pub authority_host_ref: String,
    pub previous_revision: Option<String>,
    pub resulting_revision: Option<String>,
}

pub(crate) fn receipt_record_id(idempotency_key: &str) -> PersistenceRecordId {
    PersistenceRecordId(format!(
        "{RECEIPT_PREFIX}{}",
        blake3::hash(idempotency_key.as_bytes()).to_hex()
    ))
}

pub(crate) fn read_project_lifecycle_receipt<B>(
    state: &ServerStateService<B>,
    idempotency_key: &str,
) -> Result<Option<ProjectLifecycleReceiptRecord>, LocalStoreError>
where
    B: LocalStoreBackend,
{
    state
        .projects()
        .get(&receipt_record_id(idempotency_key))?
        .map(|record| decode_receipt(&record.payload.bytes))
        .transpose()
}

pub fn read_project_lifecycle_receipts<B>(
    state: &ServerStateService<B>,
) -> Result<Vec<ProjectLifecycleReceiptRecord>, LocalStoreError>
where
    B: LocalStoreBackend,
{
    state
        .projects()
        .list()?
        .into_iter()
        .filter(|record| record.kind == PersistenceRecordKind::ProjectLifecycleReceipt)
        .map(|record| decode_receipt(&record.payload.bytes))
        .collect()
}

pub(crate) fn persist_project_lifecycle_receipt<B>(
    state: &ServerStateService<B>,
    receipt: &ProjectLifecycleReceiptRecord,
) -> Result<(), LocalStoreError>
where
    B: LocalStoreBackend,
{
    let bytes = serde_json::to_vec(receipt).map_err(|error| LocalStoreError::InvalidRecord {
        reason: format!("project lifecycle receipt encode failed: {error}"),
    })?;
    state.projects().put(
        LocalStoreRecord {
            id: receipt_record_id(&receipt.idempotency_key),
            domain: PersistenceDomain::Projects,
            kind: PersistenceRecordKind::ProjectLifecycleReceipt,
            revision_id: RevisionId(format!("rev:{}", receipt.receipt_id)),
            payload: LocalStoreRecordPayload {
                media_type: Some("application/json".to_owned()),
                bytes,
            },
        },
        RevisionExpectation::MustNotExist,
    )?;
    Ok(())
}

impl ProjectLifecycleReceiptRecord {
    pub(crate) fn applied(
        command_id: &str,
        idempotency_key: String,
        request_fingerprint: String,
        project_id: String,
        action: String,
        actor_ref: String,
        authority_host_ref: String,
        previous_revision: Option<String>,
        resulting_revision: Option<String>,
    ) -> Self {
        Self {
            schema_version: RECEIPT_SCHEMA_VERSION,
            receipt_id: format!("project-lifecycle:{command_id}"),
            command_id: command_id.to_owned(),
            idempotency_key,
            request_fingerprint,
            project_id,
            action,
            actor_ref,
            authority_host_ref,
            previous_revision,
            resulting_revision,
        }
    }
}

fn decode_receipt(bytes: &[u8]) -> Result<ProjectLifecycleReceiptRecord, LocalStoreError> {
    let receipt: ProjectLifecycleReceiptRecord =
        serde_json::from_slice(bytes).map_err(|error| LocalStoreError::InvalidRecord {
            reason: format!("project lifecycle receipt decode failed: {error}"),
        })?;
    if receipt.schema_version != RECEIPT_SCHEMA_VERSION {
        return Err(LocalStoreError::InvalidRecord {
            reason: format!(
                "unsupported project lifecycle receipt schema: {}",
                receipt.schema_version
            ),
        });
    }
    Ok(receipt)
}
