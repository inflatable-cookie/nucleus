use super::*;
use nucleus_core::PersistenceRecordId;
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload};
use nucleus_memory::{
    decode_memory_proposal_storage_record, encode_memory_proposal_storage_payload,
    MemoryConfidenceStorage, MemoryLinkStorageRefs, MemoryProposalStorageKind,
    MemoryProposalStorageRecord, MemoryProposalStorageScope, MemoryProposalStorageStatus,
    MemoryRetentionStoragePosture, MemoryReviewStorageState, MemoryReviewStorageStatus,
    MemorySensitivityStorage, MemorySourceStorageKind, MemorySourceStorageRef,
    MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
};

#[test]
fn handler_executes_memory_proposal_review_without_accepting_memory() {
    let (_temp_dir, mut handler) = handler(None);
    seed_memory_proposal(&handler, MemoryProposalStorageStatus::Proposed);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:memory-review".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:memory-review".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::MemoryProposalReview(crate::MemoryProposalReviewCommand {
                command_id: "command:memory-review".to_owned(),
                proposal_id: "memory-proposal:1".to_owned(),
                expected_revision: RevisionId("rev:memory-proposal:1".to_owned()),
                action: crate::MemoryProposalReviewAction::MarkReviewedForPromotion,
                reviewer_ref: Some("user:tom".to_owned()),
                note: Some("Reviewed proposal; acceptance authority is deferred.".to_owned()),
            }),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::AcceptedForStateMutation,
            ..
        })
    ));

    let stored = handler
        .state()
        .shared_memory()
        .get(&PersistenceRecordId("memory-proposal:1".to_owned()))
        .expect("get memory proposal")
        .expect("proposal exists");
    let proposal =
        decode_memory_proposal_storage_record(&stored.payload.bytes).expect("decode proposal");

    assert_eq!(
        proposal.status,
        MemoryProposalStorageStatus::ReviewRequested
    );
    assert_eq!(
        proposal.review.status,
        MemoryReviewStorageStatus::ReviewedForPromotion
    );
    assert_eq!(
        proposal.review.note,
        Some("Reviewed proposal; acceptance authority is deferred.".to_owned())
    );
    assert_eq!(
        handler
            .state()
            .event_journal()
            .list()
            .expect("events")
            .len(),
        0
    );
}

#[test]
fn handler_rejects_memory_proposal_review_revision_conflict() {
    let (_temp_dir, mut handler) = handler(None);
    seed_memory_proposal(&handler, MemoryProposalStorageStatus::Proposed);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:memory-review:conflict".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:memory-review:conflict".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::MemoryProposalReview(crate::MemoryProposalReviewCommand {
                command_id: "command:memory-review:conflict".to_owned(),
                proposal_id: "memory-proposal:1".to_owned(),
                expected_revision: RevisionId("rev:stale".to_owned()),
                action: crate::MemoryProposalReviewAction::Queue,
                reviewer_ref: None,
                note: None,
            }),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::Rejected(ServerControlError::Conflict { .. }),
            ..
        })
    ));
}

fn seed_memory_proposal(
    handler: &LocalControlRequestHandler<SqliteBackend>,
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

    handler
        .state()
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
