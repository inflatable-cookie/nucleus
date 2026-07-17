//! Persistence adapter for memory proposal review commands.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    RevisionExpectation,
};
use nucleus_memory::{
    decode_memory_proposal_storage_record, encode_memory_proposal_storage_payload,
};

use crate::control_api::ServerControlError;
use crate::memory_proposal_review_command::{
    admit_memory_proposal_review, MemoryProposalReviewAdmission, MemoryProposalReviewCommand,
    MemoryProposalReviewDecision, MemoryProposalReviewRejection,
};
use crate::state::ServerStateService;

/// Persist one admitted memory proposal review command.
pub fn review_memory_proposal<B>(
    state: &ServerStateService<B>,
    command: MemoryProposalReviewCommand,
) -> Result<MemoryProposalReviewAdmission, ServerControlError>
where
    B: LocalStoreBackend,
{
    let proposal_id = command.proposal_id.clone();
    let record_id = PersistenceRecordId(proposal_id.clone());
    let existing = state
        .shared_memory()
        .get(&record_id)
        .map_err(local_store_error)?
        .ok_or_else(|| ServerControlError::NotFound {
            reason: format!("memory proposal not found: {proposal_id}"),
        })?;

    if existing.kind != PersistenceRecordKind::SharedMemoryRecord {
        return Err(ServerControlError::InvalidRequest {
            reason: format!(
                "shared-memory record is not a memory proposal: {}",
                record_id.0
            ),
        });
    }

    let mut proposal =
        decode_memory_proposal_storage_record(&existing.payload.bytes).map_err(|error| {
            ServerControlError::StorageUnavailable {
                reason: format!("memory proposal decode failed: {}", error.reason),
            }
        })?;

    let decision = admit_memory_proposal_review(command, &proposal);
    let admission = match decision {
        MemoryProposalReviewDecision::Admitted(admission) => admission,
        MemoryProposalReviewDecision::Rejected(rejection) => {
            return Err(review_rejection_error(rejection));
        }
    };

    proposal.status = admission.next_proposal_status;
    proposal.review.status = admission.next_review_status;
    proposal.review.reviewer_ref = admission.reviewer_ref.clone();
    proposal.review.note = admission.note.clone();

    let payload = encode_memory_proposal_storage_payload(&proposal).map_err(|error| {
        ServerControlError::StorageUnavailable {
            reason: format!("memory proposal encode failed: {}", error.reason),
        }
    })?;

    let revision_id = RevisionId(format!(
        "rev:memory-proposal-review:{}",
        admission.command_id
    ));
    state
        .shared_memory()
        .put(
            LocalStoreRecord {
                id: existing.id,
                domain: PersistenceDomain::SharedMemory,
                kind: PersistenceRecordKind::SharedMemoryRecord,
                revision_id,
                payload: LocalStoreRecordPayload {
                    media_type: Some("application/json".to_owned()),
                    bytes: payload,
                },
            },
            RevisionExpectation::Exact(admission.expected_revision.clone()),
        )
        .map_err(local_store_error)?;

    Ok(admission)
}

fn review_rejection_error(rejection: MemoryProposalReviewRejection) -> ServerControlError {
    match rejection {
        MemoryProposalReviewRejection::EmptyCommandId => ServerControlError::InvalidRequest {
            reason: "memory proposal review command requires a command id".to_owned(),
        },
        MemoryProposalReviewRejection::EmptyProposalId => ServerControlError::InvalidRequest {
            reason: "memory proposal review command requires a proposal id".to_owned(),
        },
        MemoryProposalReviewRejection::EmptyExpectedRevision => {
            ServerControlError::InvalidRequest {
                reason: "memory proposal review command requires an expected revision".to_owned(),
            }
        }
        MemoryProposalReviewRejection::EmptyReviewerRef => ServerControlError::InvalidRequest {
            reason: "memory proposal review reviewer ref must not be empty".to_owned(),
        },
        MemoryProposalReviewRejection::EmptyNote => ServerControlError::InvalidRequest {
            reason: "memory proposal review note must not be empty".to_owned(),
        },
        MemoryProposalReviewRejection::ProposalIdMismatch {
            command_proposal_id,
            storage_proposal_id,
        } => ServerControlError::Conflict {
            reason: format!(
                "memory proposal id mismatch: command {command_proposal_id}, storage {storage_proposal_id}"
            ),
        },
        MemoryProposalReviewRejection::TerminalProposalStatus { status } => {
            ServerControlError::Conflict {
                reason: format!("memory proposal has terminal status: {status:?}"),
            }
        }
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
        | LocalStoreError::BackendBusy { reason }
        | LocalStoreError::BackendRejected { reason } => {
            ServerControlError::StorageUnavailable { reason }
        }
    }
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::{RevisionExpectation, SqliteBackend};
    use nucleus_memory::{
        MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalStorageKind,
        MemoryProposalStorageRecord, MemoryProposalStorageScope, MemoryProposalStorageStatus,
        MemoryRetentionStoragePosture, MemoryReviewStorageState, MemoryReviewStorageStatus,
        MemorySensitivityStorage, MemorySourceStorageKind, MemorySourceStorageRef,
        MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
    };

    use super::*;

    #[test]
    fn review_memory_proposal_persists_proposal_only_review_state() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        seed_proposal(&state, MemoryProposalStorageStatus::Proposed);

        let admission = review_memory_proposal(
            &state,
            MemoryProposalReviewCommand {
                command_id: "command:memory:review".to_owned(),
                proposal_id: "memory-proposal:1".to_owned(),
                expected_revision: RevisionId("rev:memory-proposal:1".to_owned()),
                action: crate::MemoryProposalReviewAction::MarkReviewedForPromotion,
                reviewer_ref: Some("user:tom".to_owned()),
                note: Some("Promote once accepted-memory authority exists.".to_owned()),
            },
        )
        .expect("review memory proposal");

        let stored = state
            .shared_memory()
            .get(&PersistenceRecordId("memory-proposal:1".to_owned()))
            .expect("get proposal")
            .expect("proposal exists");
        let proposal =
            decode_memory_proposal_storage_record(&stored.payload.bytes).expect("decode proposal");

        assert_eq!(
            admission.no_effects,
            crate::MemoryProposalReviewNoEffects::proposal_only()
        );
        assert_eq!(
            proposal.status,
            MemoryProposalStorageStatus::ReviewRequested
        );
        assert_eq!(
            proposal.review.status,
            MemoryReviewStorageStatus::ReviewedForPromotion
        );
        assert_eq!(proposal.review.reviewer_ref, Some("user:tom".to_owned()));
        assert_eq!(
            stored.revision_id,
            RevisionId("rev:memory-proposal-review:command:memory:review".to_owned())
        );
    }

    #[test]
    fn review_memory_proposal_rejects_stale_revision() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let state =
            ServerStateService::new(SqliteBackend::new(temp_dir.path().join("nucleus.sqlite")));
        seed_proposal(&state, MemoryProposalStorageStatus::Proposed);

        let error = review_memory_proposal(
            &state,
            MemoryProposalReviewCommand {
                command_id: "command:memory:review".to_owned(),
                proposal_id: "memory-proposal:1".to_owned(),
                expected_revision: RevisionId("rev:stale".to_owned()),
                action: crate::MemoryProposalReviewAction::Queue,
                reviewer_ref: None,
                note: None,
            },
        )
        .expect_err("stale revision must reject");

        assert!(matches!(error, ServerControlError::Conflict { .. }));
    }

    fn seed_proposal(
        state: &ServerStateService<SqliteBackend>,
        status: MemoryProposalStorageStatus,
    ) {
        let payload = encode_memory_proposal_storage_payload(&MemoryProposalStorageRecord {
            schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
            proposal_id: "memory-proposal:1".to_owned(),
            scope: MemoryProposalStorageScope::Project {
                project_ref: "project:nucleus".to_owned(),
            },
            kind: MemoryProposalStorageKind::Decision,
            status,
            title: "Remember review boundary".to_owned(),
            summary: "Review updates proposal metadata only.".to_owned(),
            detail: None,
            source_refs: vec![MemorySourceStorageRef {
                kind: MemorySourceStorageKind::PlanningSession,
                source_ref: "planning-session:memory".to_owned(),
                evidence_ref: None,
            }],
            link_refs: MemoryLinkStorageRefs::default(),
            confidence: MemoryConfidenceStorage::Medium,
            review: MemoryReviewStorageState {
                status: MemoryReviewStorageStatus::NeedsHumanReview,
                reviewer_ref: None,
                note: None,
            },
            sensitivity: MemorySensitivityStorage::InternalProject,
            retention: MemoryRetentionStoragePosture::ReviewQueue,
            supersession: MemorySupersessionStorageRefs::default(),
            proposed_at: None,
            updated_at: None,
        })
        .expect("encode proposal");

        state
            .shared_memory()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId("memory-proposal:1".to_owned()),
                    domain: PersistenceDomain::SharedMemory,
                    kind: PersistenceRecordKind::SharedMemoryRecord,
                    revision_id: RevisionId("rev:memory-proposal:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("seed proposal");
    }
}
