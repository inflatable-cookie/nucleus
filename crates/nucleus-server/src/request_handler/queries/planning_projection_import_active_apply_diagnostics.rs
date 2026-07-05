use nucleus_local_store::LocalStoreBackend;

use super::LocalControlRequestHandler;
use crate::control_api::{
    PlanningProjectionImportActiveApplyDiagnosticsQuery, ServerControlError, ServerQueryResult,
};
use crate::{
    planning_projection_import_active_apply_diagnostics,
    read_planning_projection_import_active_apply_admission_records,
};

pub(crate) fn planning_projection_import_active_apply_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: PlanningProjectionImportActiveApplyDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "planning projection import active apply diagnostics requires a project"
                .to_owned(),
        });
    }

    let records = read_planning_projection_import_active_apply_admission_records(&handler.state)
        .map_err(|error| ServerControlError::StorageUnavailable {
            reason: format!("failed to read planning import active apply records: {error:?}"),
        })?;

    Ok(
        ServerQueryResult::PlanningProjectionImportActiveApplyDiagnostics(
            planning_projection_import_active_apply_diagnostics(records),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ids::{ClientId, ServerControlRequestId, ServerQueryId},
        persist_planning_projection_import_active_apply_admission,
        request_handler::LocalControlRequestHandler,
        state::ServerStateService,
        PlanningProjectionImportActiveApplyAdmissionRequest,
        PlanningProjectionImportActiveApplyRevisionExpectationRef,
        PlanningProjectionImportStoppedApplyOperationRecord,
        PlanningProjectionImportStoppedApplyRecord, PlanningProjectionImportStoppedApplyStatus,
        ServerControlRequest, ServerControlRequestKind, ServerControlResponseBody,
        ServerControlResponseStatus, ServerQuery, ServerQueryKind,
    };
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ProjectId;

    #[test]
    fn planning_projection_import_active_apply_diagnostics_query_reads_admissions() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("db.sqlite"));
        let state = ServerStateService::new(backend.clone());
        persist_planning_projection_import_active_apply_admission(&state, request("query"))
            .expect("persist admission");

        let mut handler = LocalControlRequestHandler::new(backend, None);
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:planning-import-active-apply".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:planning-import-active-apply".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::PlanningProjectionImportActiveApplyDiagnostics(
                    PlanningProjectionImportActiveApplyDiagnosticsQuery {
                        project_id: ProjectId("project:nucleus-local".to_owned()),
                    },
                ),
            }),
        });

        let ServerControlResponseBody::Query(
            ServerQueryResult::PlanningProjectionImportActiveApplyDiagnostics(diagnostics),
        ) = response.body
        else {
            panic!("expected planning import active apply diagnostics");
        };

        assert_eq!(response.status, ServerControlResponseStatus::Complete);
        assert_eq!(diagnostics.admission_record_count, 1);
        assert_eq!(diagnostics.admitted_record_count, 1);
        assert_eq!(diagnostics.operation_ref_count, 1);
        assert!(!diagnostics.active_planning_mutation_permitted);
        assert!(!diagnostics.executor_invocation_permitted);
        assert!(!diagnostics.raw_payload_retained);
        assert!(!diagnostics.private_planning_body_exposed);
    }

    fn request(id: &str) -> PlanningProjectionImportActiveApplyAdmissionRequest {
        let stopped_apply_record = stopped_apply_record(id);
        let operation_id = stopped_apply_record.operations[0].operation_id.clone();
        PlanningProjectionImportActiveApplyAdmissionRequest {
            admission_id: format!("admission:{id}"),
            stopped_apply_record: Some(stopped_apply_record),
            existing_admission_ids: Vec::new(),
            operator_ref: Some("operator:tom".to_owned()),
            approval_ref: Some("approval:accepted".to_owned()),
            revision_expectation_refs: vec![
                PlanningProjectionImportActiveApplyRevisionExpectationRef {
                    operation_id,
                    expected_current_revision: "revision:expected".to_owned(),
                },
            ],
            evidence_refs: vec!["approval:accepted".to_owned()],
            active_planning_mutation_requested: false,
            executor_invocation_requested: false,
            task_creation_requested: false,
            task_promotion_requested: false,
            projection_write_requested: false,
            agent_scheduling_requested: false,
            provider_execution_requested: false,
            scm_mutation_requested: false,
            forge_mutation_requested: false,
            semantic_merge_requested: false,
            accepted_memory_mutation_requested: false,
            callback_requested: false,
            interruption_requested: false,
            recovery_requested: false,
            ui_apply_requested: false,
        }
    }

    fn stopped_apply_record(id: &str) -> PlanningProjectionImportStoppedApplyRecord {
        PlanningProjectionImportStoppedApplyRecord {
            stopped_apply_record_id: format!("planning-import-apply-plan:{id}"),
            plan_id: format!("planning-import-apply-plan:{id}"),
            status: PlanningProjectionImportStoppedApplyStatus::Persisted,
            blockers: Vec::new(),
            operations: vec![PlanningProjectionImportStoppedApplyOperationRecord {
                operation_id: format!("operation:{id}"),
                readiness_entry_id: "readiness-entry:artifact".to_owned(),
                admission_record_id: "admission-record:artifact".to_owned(),
                candidate_id: "candidate:artifact".to_owned(),
                file_ref: "nucleus/planning/artifact:roadmap.toml".to_owned(),
                record_id: Some("record:artifact".to_owned()),
                expected_current_revision: Some("revision:expected".to_owned()),
                observed_current_revision: Some("revision:expected".to_owned()),
                status: "planned".to_owned(),
                operation_kind: "apply_planning_artifact".to_owned(),
                summary: "planned: apply planning artifact".to_owned(),
                evidence_refs: vec!["review:accepted".to_owned()],
                blocker_summaries: Vec::new(),
            }],
            planned_operation_count: 1,
            skipped_operation_count: 0,
            blocked_operation_count: 0,
            evidence_ref_count: 1,
            duplicate_plan_detected: false,
            active_planning_mutation_permitted: false,
            task_creation_permitted: false,
            task_promotion_permitted: false,
            projection_write_permitted: false,
            agent_scheduling_permitted: false,
            provider_execution_permitted: false,
            scm_mutation_permitted: false,
            forge_mutation_permitted: false,
            semantic_merge_permitted: false,
            raw_payload_retained: false,
            payload_body_included: false,
            ui_apply_permitted: false,
        }
    }
}
