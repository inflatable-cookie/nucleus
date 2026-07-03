use nucleus_local_store::LocalStoreBackend;

use super::LocalControlRequestHandler;
use crate::control_api::{
    PlanningProjectionImportApplyDiagnosticsQuery, ServerControlError, ServerQueryResult,
};
use crate::{
    planning_projection_import_apply_diagnostics,
    read_planning_projection_import_stopped_apply_records,
};

pub(crate) fn planning_projection_import_apply_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: PlanningProjectionImportApplyDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "planning projection import apply diagnostics requires a project".to_owned(),
        });
    }

    let records =
        read_planning_projection_import_stopped_apply_records(&handler.state).map_err(|error| {
            ServerControlError::StorageUnavailable {
                reason: format!("failed to read planning import stopped apply records: {error:?}"),
            }
        })?;

    Ok(ServerQueryResult::PlanningProjectionImportApplyDiagnostics(
        planning_projection_import_apply_diagnostics(records),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ids::{ClientId, ServerControlRequestId, ServerQueryId},
        persist_planning_projection_import_stopped_apply,
        request_handler::LocalControlRequestHandler,
        state::ServerStateService,
        PlanningProjectionImportApplyPersistenceInput,
        PlanningProjectionImportDryRunApplyOperation,
        PlanningProjectionImportDryRunApplyOperationKind,
        PlanningProjectionImportDryRunApplyOperationStatus,
        PlanningProjectionImportDryRunApplyPlan, ServerControlRequest, ServerControlRequestKind,
        ServerControlResponseBody, ServerControlResponseStatus, ServerQuery, ServerQueryKind,
    };
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ProjectId;

    #[test]
    fn planning_projection_import_apply_diagnostics_query_reads_persisted_apply_records() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("db.sqlite"));
        let state = ServerStateService::new(backend.clone());
        persist_planning_projection_import_stopped_apply(
            &state,
            PlanningProjectionImportApplyPersistenceInput {
                plan: plan(),
                raw_payload_present: false,
                active_planning_mutation_requested: false,
                task_creation_requested: false,
                task_promotion_requested: false,
                projection_write_requested: false,
                agent_scheduling_requested: false,
                provider_execution_requested: false,
                scm_mutation_requested: false,
                forge_mutation_requested: false,
                semantic_merge_requested: false,
                ui_apply_requested: false,
            },
        )
        .expect("persist stopped apply");

        let mut handler = LocalControlRequestHandler::new(backend, None);
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:planning-import-apply".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:planning-import-apply".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::PlanningProjectionImportApplyDiagnostics(
                    PlanningProjectionImportApplyDiagnosticsQuery {
                        project_id: ProjectId("project:nucleus-local".to_owned()),
                    },
                ),
            }),
        });

        let ServerControlResponseBody::Query(
            ServerQueryResult::PlanningProjectionImportApplyDiagnostics(diagnostics),
        ) = response.body
        else {
            panic!("expected planning import apply diagnostics");
        };

        assert_eq!(response.status, ServerControlResponseStatus::Complete);
        assert_eq!(diagnostics.stopped_apply_record_count, 1);
        assert_eq!(diagnostics.persisted_apply_record_count, 1);
        assert_eq!(diagnostics.ready_count, 1);
        assert!(!diagnostics.active_planning_mutation_permitted);
        assert!(!diagnostics.raw_payload_retained);
        assert!(!diagnostics.private_planning_body_exposed);
    }

    fn plan() -> PlanningProjectionImportDryRunApplyPlan {
        PlanningProjectionImportDryRunApplyPlan {
            plan_id: "planning-import-apply-plan:query".to_owned(),
            operations: vec![PlanningProjectionImportDryRunApplyOperation {
                operation_id: "operation:query".to_owned(),
                readiness_entry_id: "readiness-entry:query".to_owned(),
                admission_record_id: "admission-record:query".to_owned(),
                candidate_id: "candidate:query".to_owned(),
                file_ref: "nucleus/planning/artifact:query.toml".to_owned(),
                record_id: Some("record:query".to_owned()),
                expected_current_revision: Some("revision:expected".to_owned()),
                observed_current_revision: Some("revision:expected".to_owned()),
                status: PlanningProjectionImportDryRunApplyOperationStatus::Planned,
                operation_kind:
                    PlanningProjectionImportDryRunApplyOperationKind::ApplyPlanningArtifact,
                summary:
                    "planned: apply planning artifact from nucleus/planning/artifact:query.toml"
                        .to_owned(),
                evidence_refs: vec![
                    "management-file-ref:nucleus/planning/artifact:query.toml".to_owned(),
                    "review:accepted".to_owned(),
                ],
                blockers: Vec::new(),
                active_planning_mutation_permitted: false,
                task_creation_permitted: false,
                task_promotion_permitted: false,
                projection_write_permitted: false,
                agent_scheduling_permitted: false,
                provider_execution_permitted: false,
                scm_mutation_permitted: false,
                forge_mutation_permitted: false,
                ui_apply_permitted: false,
            }],
            planned_operation_count: 1,
            skipped_operation_count: 0,
            blocked_operation_count: 0,
            active_planning_mutation_performed: false,
            task_creation_performed: false,
            task_promotion_performed: false,
            projection_write_performed: false,
            agent_scheduling_performed: false,
            provider_execution_performed: false,
            scm_mutation_performed: false,
            forge_mutation_performed: false,
            semantic_merge_performed: false,
            raw_payload_retained: false,
            payload_body_included: false,
            ui_apply_triggered: false,
        }
    }
}
