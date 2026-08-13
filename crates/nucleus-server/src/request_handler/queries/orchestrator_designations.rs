use nucleus_local_store::LocalStoreBackend;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{
    OrchestratorDesignationView, OrchestratorDesignationsQuery, ServerControlError,
    ServerQueryResult,
};

pub(super) fn orchestrator_designations_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: OrchestratorDesignationsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut views = Vec::new();
    for record in handler
        .state()
        .orchestrator_designations()
        .list()
        .map_err(storage_error)?
    {
        let designation = nucleus_engine::decode_orchestrator_designation(&record.payload.bytes)
            .map_err(|error| ServerControlError::InvalidRequest {
                reason: format!("designation storage payload is invalid: {error:?}"),
            })?;
        if designation.project_id != query.project_id.0 {
            continue;
        }
        if let Some(provider_instance) = query.provider_instance.as_deref() {
            if designation.orchestrator_provider_instance != provider_instance {
                continue;
            }
        }
        views.push(OrchestratorDesignationView {
            designation,
            revision_id: record.revision_id.0.clone(),
        });
    }
    views.sort_by(|left, right| right.designation.designation_id.cmp(&left.designation.designation_id));
    Ok(ServerQueryResult::OrchestratorDesignations(views))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::{
        PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId,
    };
    use nucleus_engine::{
        encode_orchestrator_designation, EngineDelegationAction, EngineOrchestratorDesignation,
        EngineOrchestratorDesignationStatus,
    };
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_projects::ProjectId;

    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn designations_query_returns_views_scoped_to_project_and_instance() {
        let (_temp_dir, handler) = handler();
        persist_designation(
            &handler,
            "designation:project:1:codex:local-default",
            "project:1",
            "codex:local-default",
            EngineOrchestratorDesignationStatus::Active,
        );
        persist_designation(
            &handler,
            "designation:project:1:other:local",
            "project:1",
            "other:local",
            EngineOrchestratorDesignationStatus::Revoked,
        );
        persist_designation(
            &handler,
            "designation:project:2:codex:local-default",
            "project:2",
            "codex:local-default",
            EngineOrchestratorDesignationStatus::Active,
        );

        let result = orchestrator_designations_query(
            &handler,
            OrchestratorDesignationsQuery {
                project_id: ProjectId("project:1".to_owned()),
                provider_instance: None,
            },
        )
        .expect("query");
        let ServerQueryResult::OrchestratorDesignations(views) = result else {
            panic!("expected designations result");
        };
        assert_eq!(views.len(), 2);
        assert_eq!(
            views[0].designation.designation_id,
            "designation:project:1:other:local"
        );
        assert_eq!(views[0].revision_id, "rev:designation:fixture:1");
        assert_eq!(
            views[1].designation.designation_id,
            "designation:project:1:codex:local-default"
        );
        assert_eq!(views[1].designation.allowed_actions, vec![
            EngineDelegationAction::Delegate,
            EngineDelegationAction::RunStatus
        ]);

        let scoped = orchestrator_designations_query(
            &handler,
            OrchestratorDesignationsQuery {
                project_id: ProjectId("project:1".to_owned()),
                provider_instance: Some("codex:local-default".to_owned()),
            },
        )
        .expect("scoped query");
        let ServerQueryResult::OrchestratorDesignations(views) = scoped else {
            panic!("expected designations result");
        };
        assert_eq!(views.len(), 1);
        assert_eq!(
            views[0].designation.designation_id,
            "designation:project:1:codex:local-default"
        );
    }

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        (temp_dir, LocalControlRequestHandler::new(backend, None))
    }

    fn persist_designation(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        designation_id: &str,
        project_id: &str,
        instance: &str,
        status: EngineOrchestratorDesignationStatus,
    ) {
        let designation = EngineOrchestratorDesignation {
            designation_id: designation_id.to_owned(),
            project_id: project_id.to_owned(),
            orchestrator_provider_instance: instance.to_owned(),
            allowed_worker_provider_instances: Some(vec![instance.to_owned()]),
            allowed_worker_models: None,
            concurrent_run_budget: 1,
            per_run_token_budget: None,
            per_run_time_budget_seconds: None,
            allowed_actions: vec![
                EngineDelegationAction::Delegate,
                EngineDelegationAction::RunStatus,
            ],
            steering_permitted: false,
            status,
            created_at: 1,
            updated_at: 1,
        };
        let payload = encode_orchestrator_designation(&designation).expect("encode");
        let record = LocalStoreRecord {
            id: PersistenceRecordId(designation_id.to_owned()),
            domain: PersistenceDomain::OrchestratorDesignations,
            kind: PersistenceRecordKind::OrchestratorDesignation,
            revision_id: RevisionId("rev:designation:fixture:1".to_owned()),
            payload: LocalStoreRecordPayload {
                media_type: Some("application/json".to_owned()),
                bytes: payload,
            },
        };
        handler
            .state()
            .orchestrator_designations()
            .put(record, RevisionExpectation::MustNotExist)
            .expect("persist designation");
    }
}
