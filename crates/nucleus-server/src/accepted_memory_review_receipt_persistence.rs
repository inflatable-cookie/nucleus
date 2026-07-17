//! Persistence helpers for accepted-memory import-apply review receipts.
//!
//! These helpers persist sanitized operator review receipts. They do not apply
//! accepted memory, write projection files, call SCM/forge providers, run
//! embeddings/search, sync provider memory, extract memories, mutate tasks,
//! schedule agents, or trigger UI behavior.

mod mapping;
#[cfg(test)]
mod tests;

use crate::provider_no_effects::{MemoryApplyNoEffects};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_memory::{
    decode_accepted_memory_review_receipt_storage_record,
    encode_accepted_memory_review_receipt_storage_payload,
    AcceptedMemoryReviewReceiptStorageRecord,
};
use nucleus_projects::ProjectId;

pub use mapping::accepted_memory_review_receipt_storage_record;

use crate::accepted_memory_import_apply_review_command::AcceptedMemoryImportApplyReviewReceipt;
use crate::control_api::ServerControlError;
use crate::state::ServerStateService;

/// Persistence outcome for one sanitized review receipt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReceiptPersistenceReceipt {
    pub review_receipt_id: String,
    pub project_id: ProjectId,
    pub status: AcceptedMemoryReviewReceiptPersistenceStatus,
    pub record_id: Option<PersistenceRecordId>,
    pub revision_id: Option<RevisionId>,
    pub no_effects: AcceptedMemoryReviewReceiptPersistenceNoEffects,
}

/// Durable review receipt persistence status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryReviewReceiptPersistenceStatus {
    Persisted,
    DuplicateNoop,
}

/// Effects explicitly absent from review receipt persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryReviewReceiptPersistenceNoEffects {
    pub review_receipt_written: bool,
    pub no_effects: MemoryApplyNoEffects,
}

impl AcceptedMemoryReviewReceiptPersistenceNoEffects {
    pub fn persisted_only() -> Self {
        Self {
            review_receipt_written: true,
        no_effects: MemoryApplyNoEffects::none(),
        }
    }

    pub fn duplicate_without_mutation() -> Self {
        Self {
            review_receipt_written: false,
        no_effects: MemoryApplyNoEffects::none(),
        }
    }
}

/// Persist one accepted-memory import-apply review receipt.
pub fn persist_accepted_memory_review_receipt<B>(
    state: &ServerStateService<B>,
    project_id: ProjectId,
    receipt: &AcceptedMemoryImportApplyReviewReceipt,
) -> Result<AcceptedMemoryReviewReceiptPersistenceReceipt, ServerControlError>
where
    B: LocalStoreBackend,
{
    let storage = accepted_memory_review_receipt_storage_record(project_id.clone(), receipt);
    let payload =
        encode_accepted_memory_review_receipt_storage_payload(&storage).map_err(|error| {
            ServerControlError::StorageUnavailable {
                reason: format!(
                    "accepted-memory review receipt encode failed: {}",
                    error.reason
                ),
            }
        })?;
    let record_id = PersistenceRecordId(storage.review_receipt_id.clone());
    let revision_id = RevisionId(format!("rev:accepted-memory-review:{}", storage.command_id));

    let record = LocalStoreRecord {
        id: record_id.clone(),
        domain: PersistenceDomain::SharedMemory,
        kind: PersistenceRecordKind::SharedMemoryReviewReceipt,
        revision_id: revision_id.clone(),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    match state
        .shared_memory()
        .get(&record_id)
        .map_err(local_store_error)?
    {
        Some(existing) => {
            if existing.kind != PersistenceRecordKind::SharedMemoryReviewReceipt {
                return Err(ServerControlError::Conflict {
                    reason: format!(
                        "accepted-memory review receipt id collides with {:?}: {}",
                        existing.kind, record_id.0
                    ),
                });
            }
            if existing.payload.bytes == record.payload.bytes {
                return Ok(AcceptedMemoryReviewReceiptPersistenceReceipt {
                    review_receipt_id: storage.review_receipt_id,
                    project_id,
                    status: AcceptedMemoryReviewReceiptPersistenceStatus::DuplicateNoop,
                    record_id: Some(record_id),
                    revision_id: Some(existing.revision_id),
                    no_effects:
                        AcceptedMemoryReviewReceiptPersistenceNoEffects::duplicate_without_mutation(
                        ),
                });
            }
            Err(ServerControlError::Conflict {
                reason: format!(
                    "accepted-memory review receipt already exists with different payload: {}",
                    record_id.0
                ),
            })
        }
        None => {
            state
                .shared_memory()
                .put(record, RevisionExpectation::MustNotExist)
                .map_err(local_store_error)?;
            Ok(AcceptedMemoryReviewReceiptPersistenceReceipt {
                review_receipt_id: storage.review_receipt_id,
                project_id,
                status: AcceptedMemoryReviewReceiptPersistenceStatus::Persisted,
                record_id: Some(record_id),
                revision_id: Some(revision_id),
                no_effects: AcceptedMemoryReviewReceiptPersistenceNoEffects::persisted_only(),
            })
        }
    }
}

/// Decode persisted review receipts from shared-memory state records.
pub fn decode_persisted_accepted_memory_review_receipt(
    record: &LocalStoreRecord,
) -> Result<AcceptedMemoryReviewReceiptStorageRecord, ServerControlError> {
    if record.kind != PersistenceRecordKind::SharedMemoryReviewReceipt {
        return Err(ServerControlError::InvalidRequest {
            reason: format!(
                "expected shared memory review receipt, got {:?}",
                record.kind
            ),
        });
    }
    decode_accepted_memory_review_receipt_storage_record(&record.payload.bytes).map_err(|error| {
        ServerControlError::StorageUnavailable {
            reason: format!(
                "accepted-memory review receipt decode failed for {}: {}",
                record.id.0, error.reason
            ),
        }
    })
}

fn local_store_error(error: LocalStoreError) -> ServerControlError {
    match error {
        LocalStoreError::RecordNotFound { record_id } => ServerControlError::NotFound {
            reason: format!("record not found: {}", record_id.0),
        },
        LocalStoreError::RevisionConflict(conflict) => ServerControlError::Conflict {
            reason: format!(
                "revision conflict for {}: expected {:?}, actual {:?}",
                conflict.record_id.0, conflict.expected, conflict.actual
            ),
        },
        LocalStoreError::InvalidRecord { reason } => ServerControlError::InvalidRequest { reason },
        LocalStoreError::UnsupportedDomain { domain } => ServerControlError::Unsupported {
            reason: format!("unsupported domain: {:?}", domain),
        },
        LocalStoreError::UnsupportedRecordKind { reason } => {
            ServerControlError::Unsupported { reason }
        }
        LocalStoreError::DuplicateRecord { record_id } => ServerControlError::Conflict {
            reason: format!("duplicate record: {}", record_id.0),
        },
        LocalStoreError::TransactionRejected { reason }
        | LocalStoreError::Unavailable { reason }
        | LocalStoreError::BackendBusy { reason }
        | LocalStoreError::BackendRejected { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
    }
}
