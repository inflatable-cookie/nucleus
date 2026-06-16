//! Server-owned local project seed path.

use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    LocalStoreBackend, LocalStoreError, LocalStoreRecord, LocalStoreRecordPayload,
    LocalStoreResult, RevisionExpectation,
};
use nucleus_projects::{
    encode_project_storage_record, ImportanceBaseline, ImportanceLevel, Project, ProjectActivity,
    ProjectId, ProjectStatus,
};

use crate::state::ServerStateService;

/// Local project seed input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalProjectSeed {
    pub project_id: String,
    pub display_name: String,
    pub importance_level: ImportanceLevel,
}

impl LocalProjectSeed {
    /// Default bootstrap seed for local desktop readiness.
    pub fn nucleus_local() -> Self {
        Self {
            project_id: "project:nucleus-local".to_owned(),
            display_name: "Nucleus Local".to_owned(),
            importance_level: ImportanceLevel::Normal,
        }
    }
}

/// Seed one local project record through server-owned state access.
pub fn seed_local_project<B>(
    state: &ServerStateService<B>,
    seed: LocalProjectSeed,
) -> LocalStoreResult<LocalStoreRecord>
where
    B: LocalStoreBackend,
{
    let record_id = PersistenceRecordId(seed.project_id.clone());
    if let Some(existing) = state.projects().get(&record_id)? {
        return Ok(existing);
    }

    let project = Project {
        id: ProjectId(seed.project_id.clone()),
        display_name: seed.display_name,
        status: ProjectStatus::Active,
        importance_baseline: ImportanceBaseline {
            level: seed.importance_level,
            notes: Some("local seed".to_owned()),
        },
        repos: Vec::new(),
        task_ids: Vec::new(),
        workspace_layout_refs: Vec::new(),
        activity: ProjectActivity {
            created_at: None,
            last_focused_at: None,
            last_agent_activity_at: None,
            last_task_activity_at: None,
        },
    };
    let payload = encode_project_storage_record(&project).map_err(|error| {
        LocalStoreError::InvalidRecord {
            reason: error.reason,
        }
    })?;
    let record = LocalStoreRecord {
        id: record_id,
        domain: PersistenceDomain::Projects,
        kind: PersistenceRecordKind::Project,
        revision_id: RevisionId("rev:seed:1".to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: payload,
        },
    };

    state
        .projects()
        .put(record, RevisionExpectation::MustNotExist)
}

#[cfg(test)]
mod tests {
    use nucleus_local_store::SqliteBackend;

    use super::*;
    use crate::control_api::{
        ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody, ServerQuery,
        ServerQueryKind, ServerQueryResult, StateRecordQuery, StateRecordQueryScope,
    };
    use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
    use crate::request_handler::LocalControlRequestHandler;
    use crate::state::ServerStateDomain;

    #[test]
    fn local_project_seed_is_idempotent_and_queryable() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        let mut handler = LocalControlRequestHandler::new(backend, None);

        let first = seed_local_project(
            handler.state(),
            LocalProjectSeed {
                project_id: "project:seed".to_owned(),
                display_name: "Seed Project".to_owned(),
                importance_level: ImportanceLevel::High,
            },
        )
        .expect("first seed");
        let second = seed_local_project(
            handler.state(),
            LocalProjectSeed {
                project_id: "project:seed".to_owned(),
                display_name: "Changed Name".to_owned(),
                importance_level: ImportanceLevel::Low,
            },
        )
        .expect("second seed");

        assert_eq!(first, second);

        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:seed:list".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:seed:list".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::Project(StateRecordQuery {
                    domain: ServerStateDomain::Projects,
                    scope: StateRecordQueryScope::List,
                }),
            }),
        });

        assert!(matches!(
            response.body,
            ServerControlResponseBody::Query(ServerQueryResult::StateRecords(records))
                if records.records.len() == 1
        ));
    }
}
