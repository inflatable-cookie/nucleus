use nucleus_engine::{decode_run_storage_record, EngineRunFleetProjection};
use nucleus_local_store::LocalStoreBackend;

use super::{storage_error, LocalControlRequestHandler};
use crate::control_api::{OrchestrationRunsQuery, ServerControlError, ServerQueryResult};

pub(super) fn orchestration_runs_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: OrchestrationRunsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    let mut runs = Vec::new();
    for record in handler
        .state()
        .orchestration_runs()
        .list()
        .map_err(storage_error)?
    {
        runs.push(
            decode_run_storage_record(&record.payload.bytes).map_err(|error| {
                ServerControlError::StorageUnavailable {
                    reason: format!("orchestration run decode failed: {}", error.reason),
                }
            })?,
        );
    }

    Ok(ServerQueryResult::OrchestrationRuns(
        EngineRunFleetProjection::for_project(query.project_id, &runs),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_core::{PersistenceDomain, PersistenceRecordId, RevisionId};
    use nucleus_engine::{
        encode_run_storage_record, EngineRunBudgetEnvelope, EngineRunCloseout, EngineRunId,
        EngineRunLifecycleState, EngineRunObjective, EngineRunStorageRecord,
        EngineRunTransitionRecord,
    };
    use nucleus_local_store::{
        LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
    };
    use nucleus_projects::ProjectId;

    use crate::request_handler::LocalControlRequestHandler;

    #[test]
    fn orchestration_runs_query_returns_fleet_projection_shape() {
        let (_temp_dir, handler) = handler();
        persist_run(&handler, "run:accepted", "project:1", EngineRunLifecycleState::Accepted, 10);
        persist_run(&handler, "run:running", "project:1", EngineRunLifecycleState::Running, 30);
        persist_run(&handler, "run:other", "project:2", EngineRunLifecycleState::Proposed, 99);

        let result = orchestration_runs_query(
            &handler,
            OrchestrationRunsQuery {
                project_id: ProjectId("project:1".to_owned()),
            },
        )
        .expect("fleet query");

        let ServerQueryResult::OrchestrationRuns(projection) = result else {
            panic!("expected orchestration runs projection");
        };
        let ids: Vec<&str> = projection.runs.iter().map(|run| run.run_id.as_str()).collect();
        assert_eq!(ids, vec!["run:running", "run:accepted"]);
        assert_eq!(projection.state_counts.len(), 2);
        assert_eq!(projection.runs[0].provider_instance, "provider:run:running");
        assert_eq!(projection.runs[1].has_closeout, false);
    }

    fn handler() -> (tempfile::TempDir, LocalControlRequestHandler<SqliteBackend>) {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
        (temp_dir, LocalControlRequestHandler::new(backend, None))
    }

    fn persist_run(
        handler: &LocalControlRequestHandler<SqliteBackend>,
        run_id: &str,
        project_id: &str,
        state: EngineRunLifecycleState,
        updated_at: u64,
    ) {
        let storage = EngineRunStorageRecord {
            run_id: EngineRunId(run_id.to_owned()),
            project_id: project_id.to_owned(),
            objective: EngineRunObjective {
                scope: "scope".to_owned(),
                acceptance: Vec::new(),
                stop_conditions: Vec::new(),
            },
            worktree_ref: None,
            base_ref: None,
            provider_instance: format!("provider:{run_id}"),
            provider_model: "model".to_owned(),
            orchestrator_designation: None,
            operation_id: None,
            conversation_id: None,
            state,
            budget: EngineRunBudgetEnvelope::default(),
            closeout: if state == EngineRunLifecycleState::Delivered {
                Some(EngineRunCloseout {
                    summary: "done".to_owned(),
                    evidence_refs: Vec::new(),
                    diff_ref: None,
                })
            } else {
                None
            },
            transitions: vec![EngineRunTransitionRecord {
                command_id: format!("command:{run_id}"),
                from: None,
                to: state,
                at: updated_at,
            }],
            created_at: 1,
            updated_at,
        };
        let payload = encode_run_storage_record(&storage).expect("encode");
        handler
            .state()
            .orchestration_runs()
            .put(
                LocalStoreRecord {
                    id: PersistenceRecordId(run_id.to_owned()),
                    domain: PersistenceDomain::OrchestrationRuns,
                    kind: nucleus_core::PersistenceRecordKind::OrchestrationRun,
                    revision_id: RevisionId(format!("rev:{run_id}")),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: payload,
                    },
                },
                RevisionExpectation::MustNotExist,
            )
            .expect("persist run");
    }
}
