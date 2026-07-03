use nucleus_core::PersistenceRecordKind;
use nucleus_local_store::LocalStoreBackend;
use nucleus_planning::{
    decode_exploration_session_storage_record, decode_planning_session_storage_record,
};

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{PlanningSessionsQuery, ServerControlError, ServerQueryResult};
use crate::planning_sessions_projection::PlanningSessionsProjection;

pub(super) fn planning_sessions_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: PlanningSessionsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut planning_sessions = Vec::new();
    let mut exploration_sessions = Vec::new();
    for record in handler.state().planning().list().map_err(storage_error)? {
        match record.kind {
            PersistenceRecordKind::PlanningSession => {
                planning_sessions.push(
                    decode_planning_session_storage_record(&record.payload.bytes).map_err(
                        |error| ServerControlError::StorageUnavailable {
                            reason: format!("planning session decode failed: {}", error.reason),
                        },
                    )?,
                );
            }
            PersistenceRecordKind::PlanningArtifact => {
                continue;
            }
            PersistenceRecordKind::TaskSeed => {
                continue;
            }
            PersistenceRecordKind::ResearchRun => {
                continue;
            }
            _ => {
                if let Ok(exploration) =
                    decode_exploration_session_storage_record(&record.payload.bytes)
                {
                    exploration_sessions.push(exploration);
                }
            }
        }
    }

    Ok(ServerQueryResult::PlanningSessions(
        PlanningSessionsProjection::from_storage_records(
            query.project_id,
            planning_sessions,
            exploration_sessions,
        ),
    ))
}

#[cfg(test)]
mod tests {
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_planning::{
        encode_planning_session_storage_payload, PlanningOutputStorageRefs,
        PlanningSessionStorageKind, PlanningSessionStorageRecord, PlanningSessionStorageStatus,
    };
    use nucleus_projects::ProjectId;

    use super::*;
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn planning_sessions_query_reads_sanitized_project_scoped_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);

        persist_session(&handler, "project:nucleus", "planning-session:nucleus");
        persist_session(&handler, "project:other", "planning-session:other");

        let result = planning_sessions_query(
            &handler,
            PlanningSessionsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect("planning sessions query");

        let ServerQueryResult::PlanningSessions(projection) = result else {
            panic!("expected planning sessions projection");
        };

        assert_eq!(projection.project_id.0, "project:nucleus");
        assert_eq!(projection.sessions.len(), 1);
        assert_eq!(projection.source_counts.planning_session_records, 1);
        assert_eq!(
            projection.sessions[0].session_id,
            "planning-session:nucleus"
        );
        assert_eq!(projection.sessions[0].source_ref_count, 0);
        assert!(!projection.client_can_mutate);
        assert!(!projection.provider_execution_available);
    }

    #[test]
    fn planning_sessions_query_reports_decode_failures_without_effects() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let handler = LocalControlRequestHandler::new(backend, None);
        handler
            .state()
            .planning()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId("planning-session:broken".to_owned()),
                    domain: PersistenceDomain::Planning,
                    kind: PersistenceRecordKind::PlanningSession,
                    revision_id: RevisionId("rev:broken".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: b"{not-json".to_vec(),
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("put broken session");

        let error = planning_sessions_query(
            &handler,
            PlanningSessionsQuery {
                project_id: ProjectId("project:nucleus".to_owned()),
            },
        )
        .expect_err("decode failure");

        assert!(matches!(
            error,
            ServerControlError::StorageUnavailable { reason }
                if reason.contains("planning session decode failed")
        ));
    }

    fn persist_session(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        project_id: &str,
        session_id: &str,
    ) {
        let payload = encode_planning_session_storage_payload(&PlanningSessionStorageRecord {
            schema_version: 1,
            session_id: session_id.to_owned(),
            project_id: project_id.to_owned(),
            kind: PlanningSessionStorageKind::ProjectIntake,
            status: PlanningSessionStorageStatus::Active,
            prompt_or_template_refs: vec!["template:intake".to_owned()],
            participants: Vec::new(),
            source_refs: Vec::new(),
            output_refs: PlanningOutputStorageRefs {
                artifact_refs: Vec::new(),
                task_seed_refs: vec!["seed:planning".to_owned()],
                memory_proposal_refs: Vec::new(),
                research_run_brief_refs: Vec::new(),
            },
        })
        .expect("encode session");

        handler
            .state()
            .planning()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(session_id.to_owned()),
                    domain: PersistenceDomain::Planning,
                    kind: PersistenceRecordKind::PlanningSession,
                    revision_id: RevisionId(format!("rev:{session_id}")),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("put session");
    }
}
