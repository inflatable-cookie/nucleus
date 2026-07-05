//! Persistence adapter for accepted-memory admissions.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_memory::{
    encode_accepted_memory_storage_payload, MemoryProposalAcceptanceAdmission,
    MemoryProposalAcceptanceAdmissionStatus, MemoryProposalAcceptanceBlocker,
};

use crate::control_api::ServerControlError;
use crate::state::ServerStateService;

/// Sanitized result of accepted-memory persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryPersistenceReceipt {
    pub admission_id: String,
    pub memory_id: String,
    pub proposal_id: String,
    pub status: AcceptedMemoryPersistenceStatus,
    pub record_id: Option<PersistenceRecordId>,
    pub revision_id: Option<RevisionId>,
    pub created_by_ref: Option<String>,
    pub accepted_by_ref: Option<String>,
    pub reviewer_ref: Option<String>,
    pub source_ref_count: usize,
    pub link_ref_count: usize,
    pub evidence_refs: Vec<String>,
    pub sensitivity: Option<String>,
    pub retention: Option<String>,
    pub blockers: Vec<MemoryProposalAcceptanceBlocker>,
    pub no_effects: AcceptedMemoryPersistenceNoEffects,
}

/// Persistence outcome bucket.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryPersistenceStatus {
    Persisted,
    Blocked,
}

/// Effects explicitly absent from accepted-memory persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryPersistenceNoEffects {
    pub shared_memory_written: bool,
    pub proposal_mutated: bool,
    pub projection_written: bool,
    pub embedding_generated: bool,
    pub search_index_updated: bool,
    pub provider_native_memory_synced: bool,
    pub automatic_extraction_run: bool,
    pub task_mutated: bool,
    pub scm_or_forge_mutated: bool,
    pub ui_triggered: bool,
}

impl AcceptedMemoryPersistenceNoEffects {
    pub fn persisted_only() -> Self {
        Self {
            shared_memory_written: true,
            proposal_mutated: false,
            projection_written: false,
            embedding_generated: false,
            search_index_updated: false,
            provider_native_memory_synced: false,
            automatic_extraction_run: false,
            task_mutated: false,
            scm_or_forge_mutated: false,
            ui_triggered: false,
        }
    }

    pub fn blocked_without_mutation() -> Self {
        Self {
            shared_memory_written: false,
            proposal_mutated: false,
            projection_written: false,
            embedding_generated: false,
            search_index_updated: false,
            provider_native_memory_synced: false,
            automatic_extraction_run: false,
            task_mutated: false,
            scm_or_forge_mutated: false,
            ui_triggered: false,
        }
    }
}

/// Persist an admitted accepted-memory record through the shared-memory state domain.
pub fn persist_accepted_memory_admission<B>(
    state: &ServerStateService<B>,
    admission: MemoryProposalAcceptanceAdmission,
) -> Result<AcceptedMemoryPersistenceReceipt, ServerControlError>
where
    B: LocalStoreBackend,
{
    if admission.status != MemoryProposalAcceptanceAdmissionStatus::Admitted {
        return Ok(blocked_receipt(admission));
    }

    let accepted_record =
        admission
            .accepted_record
            .ok_or_else(|| ServerControlError::InvalidRequest {
                reason: "accepted-memory admission is admitted without an accepted record"
                    .to_owned(),
            })?;

    if accepted_record.memory_id != admission.memory_id {
        return Err(ServerControlError::Conflict {
            reason: format!(
                "accepted-memory id mismatch: admission {}, record {}",
                admission.memory_id, accepted_record.memory_id
            ),
        });
    }

    if accepted_record.source_proposal_id.as_deref() != Some(admission.proposal_id.as_str()) {
        return Err(ServerControlError::Conflict {
            reason: format!(
                "accepted-memory source proposal mismatch for {}",
                admission.proposal_id
            ),
        });
    }

    let payload = encode_accepted_memory_storage_payload(&accepted_record).map_err(|error| {
        ServerControlError::StorageUnavailable {
            reason: format!("accepted-memory encode failed: {}", error.reason),
        }
    })?;
    let record_id = PersistenceRecordId(admission.memory_id.clone());
    let revision_id = RevisionId(format!("rev:accepted-memory:{}", admission.admission_id));

    state
        .shared_memory()
        .put(
            LocalStoreRecord {
                id: record_id.clone(),
                domain: PersistenceDomain::SharedMemory,
                kind: PersistenceRecordKind::SharedMemoryRecord,
                revision_id: revision_id.clone(),
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            RevisionExpectation::MustNotExist,
        )
        .map_err(local_store_error)?;

    let link_ref_count = accepted_record.link_refs.planning_session_refs.len()
        + accepted_record.link_refs.exploration_session_refs.len()
        + accepted_record.link_refs.planning_artifact_refs.len()
        + accepted_record.link_refs.task_seed_refs.len()
        + accepted_record.link_refs.research_brief_refs.len()
        + accepted_record.link_refs.task_refs.len()
        + accepted_record.link_refs.evidence_refs.len();

    Ok(AcceptedMemoryPersistenceReceipt {
        admission_id: admission.admission_id,
        memory_id: admission.memory_id,
        proposal_id: admission.proposal_id,
        status: AcceptedMemoryPersistenceStatus::Persisted,
        record_id: Some(record_id),
        revision_id: Some(revision_id),
        created_by_ref: Some(accepted_record.actors.created_by_ref),
        accepted_by_ref: Some(accepted_record.actors.accepted_by_ref),
        reviewer_ref: Some(accepted_record.review.reviewer_ref),
        source_ref_count: accepted_record.source_refs.len(),
        link_ref_count,
        evidence_refs: admission.evidence_refs,
        sensitivity: Some(format!("{:?}", accepted_record.sensitivity)),
        retention: Some(format!("{:?}", accepted_record.retention)),
        blockers: Vec::new(),
        no_effects: AcceptedMemoryPersistenceNoEffects::persisted_only(),
    })
}

fn blocked_receipt(
    admission: MemoryProposalAcceptanceAdmission,
) -> AcceptedMemoryPersistenceReceipt {
    AcceptedMemoryPersistenceReceipt {
        admission_id: admission.admission_id,
        memory_id: admission.memory_id,
        proposal_id: admission.proposal_id,
        status: AcceptedMemoryPersistenceStatus::Blocked,
        record_id: None,
        revision_id: None,
        created_by_ref: None,
        accepted_by_ref: None,
        reviewer_ref: None,
        source_ref_count: 0,
        link_ref_count: 0,
        evidence_refs: admission.evidence_refs,
        sensitivity: None,
        retention: None,
        blockers: admission.blockers,
        no_effects: AcceptedMemoryPersistenceNoEffects::blocked_without_mutation(),
    }
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
        | LocalStoreError::BackendRejected { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
    }
}
