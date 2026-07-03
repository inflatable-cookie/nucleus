use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_research::decode_research_run_brief_storage_record;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{ResearchRunBriefsQuery, ServerControlError, ServerQueryResult};
use crate::research_run_briefs_projection::ResearchRunBriefsProjection;

pub(super) fn research_run_briefs_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: ResearchRunBriefsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut runs = Vec::new();
    for record in handler
        .state()
        .deep_research()
        .list()
        .map_err(storage_error)?
    {
        if record.kind != PersistenceRecordKind::ResearchRun {
            continue;
        }
        runs.push(
            decode_research_run_brief_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("research run brief decode failed: {}", error.reason),
                }
            })?,
        );
    }

    Ok(ServerQueryResult::ResearchRunBriefs(
        ResearchRunBriefsProjection::from_storage_records(query.project_id, runs),
    ))
}

#[cfg(test)]
mod tests {
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, RevisionId};
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_projects::ProjectId;
    use nucleus_research::{
        encode_research_run_brief_storage_payload, ResearchConfidenceStorage,
        ResearchCoverageStorageSummary, ResearchRunBriefStorageRecord,
        ResearchRunBriefStorageStatus, ResearchRunScopeStorageBoundary,
        RESEARCH_STORAGE_SCHEMA_VERSION,
    };

    use super::*;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn research_run_briefs_query_reads_sanitized_project_scoped_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        persist_run(&handler, "research-run:nucleus", "project:nucleus");
        persist_run(&handler, "research-run:other", "project:other");

        let result = research_run_briefs_query(
            &handler,
            ResearchRunBriefsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("research run briefs query");

        let ServerQueryResult::ResearchRunBriefs(projection) = result else {
            panic!("expected research run briefs projection");
        };

        assert_eq!(projection.project_id.0, "project:nucleus");
        assert_eq!(projection.runs.len(), 1);
        assert_eq!(projection.runs[0].run_id, "research-run:nucleus");
        assert_eq!(projection.source_counts.run_records, 1);
        assert!(!projection.client_can_mutate);
        assert!(!projection.provider_execution_available);
    }

    #[test]
    fn research_run_briefs_query_reports_decode_failures_without_effects() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);
        handler
            .state()
            .deep_research()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId("research-run:broken".to_owned()),
                    domain: PersistenceDomain::DeepResearch,
                    kind: PersistenceRecordKind::ResearchRun,
                    revision_id: RevisionId("rev:broken".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: b"{not-json".to_vec(),
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("put broken research run");

        let error = research_run_briefs_query(
            &handler,
            ResearchRunBriefsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect_err("decode failure");

        assert!(matches!(
            error,
            ServerControlError::StorageUnavailable { reason }
                if reason.contains("research run brief decode failed")
        ));
    }

    fn persist_run(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        run_id: &str,
        project_id: &str,
    ) {
        let payload = encode_research_run_brief_storage_payload(&ResearchRunBriefStorageRecord {
            schema_version: RESEARCH_STORAGE_SCHEMA_VERSION,
            run_id: run_id.to_owned(),
            project_id: Some(project_id.to_owned()),
            title: "Hidden from query".to_owned(),
            brief_summary: "Hidden from query".to_owned(),
            brief_detail: Some("Hidden from query".to_owned()),
            status: ResearchRunBriefStorageStatus::Proposed,
            scope_boundary: ResearchRunScopeStorageBoundary::default(),
            source_plan_refs: Vec::new(),
            confidence: ResearchConfidenceStorage::Unknown,
            coverage: ResearchCoverageStorageSummary::default(),
            questions: Vec::new(),
            source_refs: Vec::new(),
            observation_refs: Vec::new(),
            synthesis_refs: Vec::new(),
            created_at: None,
            updated_at: None,
            synthesized_at: None,
            accepted_at: None,
        })
        .expect("encode research run");
        handler
            .state()
            .deep_research()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(run_id.to_owned()),
                    domain: PersistenceDomain::DeepResearch,
                    kind: PersistenceRecordKind::ResearchRun,
                    revision_id: RevisionId(format!("rev:{run_id}:1")),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("put research run");
    }
}
