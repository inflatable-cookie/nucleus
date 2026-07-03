//! Server-owned local planning session seed path.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_planning::{
    encode_planning_session_storage_record, PlanningOutputRefs, PlanningParticipantRef,
    PlanningParticipantRole, PlanningSession, PlanningSessionId, PlanningSessionKind,
    PlanningSessionStatus, PlanningSessionTimestamps, PlanningSourceKind, PlanningSourceRef,
    PlanningTaskSeedId,
};
use nucleus_projects::ProjectId;

use crate::state::ServerStateService;

/// Local planning session seed input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalPlanningSessionSeed {
    pub session_id: String,
    pub project_id: String,
    pub template_ref: String,
    pub task_seed_ref: String,
}

impl LocalPlanningSessionSeed {
    /// Default bootstrap seed for local planning inspection.
    pub fn nucleus_local_bootstrap() -> Self {
        Self {
            session_id: "planning-session:nucleus-local:bootstrap".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            template_ref: "template:nucleus:project-intake:v1".to_owned(),
            task_seed_ref: "seed:nucleus-local:planning-bootstrap".to_owned(),
        }
    }
}

/// Seed one local planning session record through server-owned state access.
pub fn seed_local_planning_session<B>(
    state: &ServerStateService<B>,
    seed: LocalPlanningSessionSeed,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(seed.session_id.clone());
    if let Some(existing) = state.planning().get(&record_id)? {
        return Ok(existing);
    }

    let session = PlanningSession {
        id: PlanningSessionId(seed.session_id.clone()),
        project_id: ProjectId(seed.project_id),
        kind: PlanningSessionKind::ProjectIntake,
        status: PlanningSessionStatus::Active,
        prompt_or_template_refs: vec![seed.template_ref],
        participants: vec![PlanningParticipantRef {
            actor_ref: "system:nucleusd-bootstrap".to_owned(),
            role: PlanningParticipantRole::System,
        }],
        source_refs: vec![PlanningSourceRef {
            source_ref: "bootstrap:planning-session".to_owned(),
            kind: PlanningSourceKind::OperatorPrompt,
        }],
        output_refs: PlanningOutputRefs {
            artifact_refs: Vec::new(),
            task_seed_refs: vec![PlanningTaskSeedId(seed.task_seed_ref)],
            memory_proposal_refs: Vec::new(),
            research_run_brief_refs: Vec::new(),
        },
        timestamps: PlanningSessionTimestamps {
            created_at: None,
            updated_at: None,
            accepted_at: None,
        },
    };
    let payload = encode_planning_session_storage_record(&session).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    let record = LocalStoreRecord {
        id: record_id,
        domain: PersistenceDomain::Planning,
        kind: PersistenceRecordKind::PlanningSession,
        revision_id: RevisionId("rev:planning-session:1".to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state
        .planning()
        .put(record, RevisionExpectation::MustNotExist)
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;

    use super::*;
    use crate::control_api::{
        PlanningSessionsQuery, ServerControlRequest, ServerControlRequestKind,
        ServerControlResponseBody, ServerQuery, ServerQueryKind, ServerQueryResult,
    };
    use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn local_planning_session_seed_is_idempotent_and_queryable() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let mut handler = LocalControlRequestHandler::new(backend, None);

        let first = seed_local_planning_session(
            handler.state(),
            LocalPlanningSessionSeed::nucleus_local_bootstrap(),
        )
        .expect("first seed");
        let second = seed_local_planning_session(
            handler.state(),
            LocalPlanningSessionSeed::nucleus_local_bootstrap(),
        )
        .expect("second seed");

        assert_eq!(first, second);

        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:planning-session:query".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:planning-session".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::PlanningSessions(PlanningSessionsQuery {
                    project_id: ProjectId("project:nucleus-local".to_owned()),
                }),
            }),
        });

        assert!(matches!(
            response.body,
            ServerControlResponseBody::Query(ServerQueryResult::PlanningSessions(projection))
                if projection.sessions.len() == 1
        ));
    }
}
