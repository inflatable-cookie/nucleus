//! Server-owned local memory proposal seed path.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_memory::{
    encode_memory_proposal_storage_payload, MemoryConfidenceStorage, MemoryLinkStorageRefs,
    MemoryProposalStorageKind, MemoryProposalStorageRecord, MemoryProposalStorageScope,
    MemoryProposalStorageStatus, MemoryRetentionStoragePosture, MemoryReviewStorageState,
    MemoryReviewStorageStatus, MemorySensitivityStorage, MemorySourceStorageKind,
    MemorySourceStorageRef, MemorySupersessionStorageRefs, MEMORY_STORAGE_SCHEMA_VERSION,
};

use crate::state::ServerStateService;

/// Local memory proposal seed input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalMemoryProposalSeed {
    pub proposal_id: String,
    pub project_id: String,
}

impl LocalMemoryProposalSeed {
    /// Default bootstrap seed for local memory inspection.
    pub fn nucleus_local_bootstrap() -> Self {
        Self {
            proposal_id: "memory-proposal:nucleus-local:harness-identity".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
        }
    }
}

/// Seed one local memory proposal record through server-owned state access.
pub fn seed_local_memory_proposal<B>(
    state: &ServerStateService<B>,
    seed: LocalMemoryProposalSeed,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(seed.proposal_id.clone());
    if let Some(existing) = state.shared_memory().get(&record_id)? {
        return Ok(existing);
    }

    let record = MemoryProposalStorageRecord {
        schema_version: MEMORY_STORAGE_SCHEMA_VERSION,
        proposal_id: seed.proposal_id.clone(),
        scope: MemoryProposalStorageScope::Project {
            project_ref: seed.project_id,
        },
        kind: MemoryProposalStorageKind::ResearchFinding,
        status: MemoryProposalStorageStatus::Proposed,
        title: "Harness identity model needs stable mapping".to_owned(),
        summary:
            "Harness message, turn, and tool-call identities must be normalized before promotion."
                .to_owned(),
        detail: None,
        source_refs: vec![MemorySourceStorageRef {
            kind: MemorySourceStorageKind::ResearchBrief,
            source_ref: "research-run:nucleus-local:harness-communications".to_owned(),
            evidence_ref: Some("evidence:harness-communications-index".to_owned()),
        }],
        link_refs: MemoryLinkStorageRefs {
            research_brief_refs: vec![
                "research-run:nucleus-local:harness-communications".to_owned()
            ],
            evidence_refs: vec!["evidence:harness-communications-index".to_owned()],
            ..MemoryLinkStorageRefs::default()
        },
        confidence: MemoryConfidenceStorage::Low,
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
    };
    let payload = encode_memory_proposal_storage_payload(&record).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    let local_record = LocalStoreRecord {
        id: record_id,
        domain: PersistenceDomain::SharedMemory,
        kind: PersistenceRecordKind::SharedMemoryRecord,
        revision_id: RevisionId("rev:memory-proposal:1".to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state
        .shared_memory()
        .put(local_record, RevisionExpectation::MustNotExist)
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::control_api::{
        MemoryProposalsQuery, ServerControlRequest, ServerControlRequestKind,
        ServerControlResponseBody, ServerQuery, ServerQueryKind, ServerQueryResult,
    };
    use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn local_memory_proposal_seed_is_idempotent_and_queryable() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let mut handler = LocalControlRequestHandler::new(backend, None);

        let first = seed_local_memory_proposal(
            handler.state(),
            LocalMemoryProposalSeed::nucleus_local_bootstrap(),
        )
        .expect("first seed");
        let second = seed_local_memory_proposal(
            handler.state(),
            LocalMemoryProposalSeed::nucleus_local_bootstrap(),
        )
        .expect("second seed");

        assert_eq!(first, second);

        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:memory-proposal:query".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:memory-proposal".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::MemoryProposals(MemoryProposalsQuery {
                    project_id: ProjectId("project:nucleus-local".to_owned()),
                }),
            }),
        });

        assert!(matches!(
            response.body,
            ServerControlResponseBody::Query(ServerQueryResult::MemoryProposals(projection))
                if projection.proposals.len() == 1
        ));
    }
}
