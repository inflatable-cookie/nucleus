//! Server-owned local research run brief seed path.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_research::{
    encode_research_run_brief_storage_payload, ResearchConfidenceStorage,
    ResearchCoverageStorageSummary, ResearchObservationStorageKind,
    ResearchObservationStorageRecord, ResearchPromotionTargetStorageRefs,
    ResearchQuestionSourceRequirementStorage, ResearchQuestionStoragePriority,
    ResearchQuestionStorageRecord, ResearchQuestionStorageStatus,
    ResearchRetrievalStorageMethodHint, ResearchRunBriefStorageRecord,
    ResearchRunBriefStorageStatus, ResearchRunScopeStorageBoundary, ResearchSourceStorageKind,
    ResearchSourceStorageRef, ResearchSourceStorageReliability, ResearchSynthesisStorageKind,
    ResearchSynthesisStorageRef, RESEARCH_STORAGE_SCHEMA_VERSION,
};

use crate::state::ServerStateService;

/// Local research run brief seed input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalResearchRunBriefSeed {
    pub run_id: String,
    pub project_id: String,
}

impl LocalResearchRunBriefSeed {
    /// Default bootstrap seed for local research inspection.
    pub fn nucleus_local_bootstrap() -> Self {
        Self {
            run_id: "research-run:nucleus-local:harness-communications".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
        }
    }
}

/// Seed one local research run brief record through server-owned state access.
pub fn seed_local_research_run_brief<B>(
    state: &ServerStateService<B>,
    seed: LocalResearchRunBriefSeed,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(seed.run_id.clone());
    if let Some(existing) = state.deep_research().get(&record_id)? {
        return Ok(existing);
    }

    let record = ResearchRunBriefStorageRecord {
        schema_version: RESEARCH_STORAGE_SCHEMA_VERSION,
        run_id: seed.run_id.clone(),
        project_id: Some(seed.project_id),
        title: "Harness communications research brief".to_owned(),
        brief_summary: "Inspect harness communication APIs and identity rules.".to_owned(),
        brief_detail: None,
        status: ResearchRunBriefStorageStatus::Proposed,
        scope_boundary: ResearchRunScopeStorageBoundary {
            in_scope: vec!["provider docs".to_owned(), "source refs".to_owned()],
            out_of_scope: vec![
                "crawler execution".to_owned(),
                "provider execution".to_owned(),
            ],
            constraints: vec!["refs only".to_owned()],
        },
        source_plan_refs: vec!["source-plan:harness-communications:v1".to_owned()],
        confidence: ResearchConfidenceStorage::Unknown,
        coverage: ResearchCoverageStorageSummary {
            covered_refs: Vec::new(),
            gap_refs: vec!["gap:harness-message-identity".to_owned()],
            note: Some("Bootstrap brief only; no source retrieval.".to_owned()),
        },
        questions: vec![ResearchQuestionStorageRecord {
            question_id: "research-question:nucleus-local:harness-identity".to_owned(),
            run_id: seed.run_id.clone(),
            text: "Which identity model does each harness use?".to_owned(),
            priority: ResearchQuestionStoragePriority::High,
            status: ResearchQuestionStorageStatus::Open,
            source_requirements: vec![ResearchQuestionSourceRequirementStorage {
                label: "official docs or source code".to_owned(),
                required: true,
            }],
            answer_summary: None,
            evidence_refs: Vec::new(),
            open_gap_refs: vec!["gap:harness-message-identity".to_owned()],
        }],
        source_refs: vec![ResearchSourceStorageRef {
            source_id: "research-source:nucleus-local:harness-docs".to_owned(),
            run_id: seed.run_id.clone(),
            kind: ResearchSourceStorageKind::OfficialDocs,
            locator: "docs/research/source-hubs/harness-communications.md".to_owned(),
            accessed_at: None,
            author_or_publisher: Some("nucleus".to_owned()),
            published_or_updated_at: None,
            retrieval_method: ResearchRetrievalStorageMethodHint::Manual,
            reliability: ResearchSourceStorageReliability::Primary,
            quote_or_license_note: Some("local refs only".to_owned()),
            retained_artifact_refs: Vec::new(),
        }],
        observation_refs: vec![ResearchObservationStorageRecord {
            observation_id: "research-observation:nucleus-local:harness-identity".to_owned(),
            run_id: seed.run_id.clone(),
            source_refs: vec!["research-source:nucleus-local:harness-docs".to_owned()],
            kind: ResearchObservationStorageKind::Evidence,
            summary: "Harness integrations need stable identity rules.".to_owned(),
            evidence_ref: Some("evidence:harness-communications-index".to_owned()),
        }],
        synthesis_refs: vec![ResearchSynthesisStorageRef {
            synthesis_id: "research-synthesis:nucleus-local:harness-identity".to_owned(),
            run_id: seed.run_id.clone(),
            kind: ResearchSynthesisStorageKind::DecisionSupport,
            observation_refs: vec!["research-observation:nucleus-local:harness-identity".to_owned()],
            source_coverage_refs: vec!["research-source:nucleus-local:harness-docs".to_owned()],
            confidence: ResearchConfidenceStorage::Low,
            gap_refs: vec!["gap:harness-message-identity".to_owned()],
            promotion_targets: ResearchPromotionTargetStorageRefs {
                memory_proposal_refs: vec![
                    "memory-proposal:nucleus-local:harness-identity".to_owned()
                ],
                planning_artifact_refs: Vec::new(),
                task_seed_refs: Vec::new(),
                source_evidence_refs: vec!["evidence:harness-communications-index".to_owned()],
            },
        }],
        created_at: None,
        updated_at: None,
        synthesized_at: None,
        accepted_at: None,
    };
    let payload = encode_research_run_brief_storage_payload(&record).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    let local_record = LocalStoreRecord {
        id: record_id,
        domain: PersistenceDomain::DeepResearch,
        kind: PersistenceRecordKind::ResearchRun,
        revision_id: RevisionId("rev:research-run:1".to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state
        .deep_research()
        .put(local_record, RevisionExpectation::MustNotExist)
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::control_api::{
        ResearchRunBriefsQuery, ServerControlRequest, ServerControlRequestKind,
        ServerControlResponseBody, ServerQuery, ServerQueryKind, ServerQueryResult,
    };
    use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn local_research_run_seed_is_idempotent_and_queryable() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let mut handler = LocalControlRequestHandler::new(backend, None);

        let first = seed_local_research_run_brief(
            handler.state(),
            LocalResearchRunBriefSeed::nucleus_local_bootstrap(),
        )
        .expect("first seed");
        let second = seed_local_research_run_brief(
            handler.state(),
            LocalResearchRunBriefSeed::nucleus_local_bootstrap(),
        )
        .expect("second seed");

        assert_eq!(first, second);

        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:research-run:query".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:research-run".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::ResearchRunBriefs(ResearchRunBriefsQuery {
                    project_id: ProjectId("project:nucleus-local".to_owned()),
                }),
            }),
        });

        assert!(matches!(
            response.body,
            ServerControlResponseBody::Query(ServerQueryResult::ResearchRunBriefs(projection))
                if projection.runs.len() == 1
        ));
    }
}
