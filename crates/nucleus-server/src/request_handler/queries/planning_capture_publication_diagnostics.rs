use nucleus_local_store::LocalStoreBackend;

use super::LocalControlRequestHandler;
use crate::control_api::{
    PlanningCapturePublicationDiagnosticsQuery, ServerControlError, ServerQueryResult,
};
use crate::{
    planning_capture_publication_stopped_request_diagnostics,
    read_planning_capture_publication_stopped_requests,
};

pub(crate) fn planning_capture_publication_diagnostics_query<B>(
    handler: &LocalControlRequestHandler<B>,
    query: PlanningCapturePublicationDiagnosticsQuery,
) -> Result<ServerQueryResult, ServerControlError>
where
    B: LocalStoreBackend + Clone,
{
    if query.project_id.0.trim().is_empty() {
        return Err(ServerControlError::InvalidRequest {
            reason: "planning capture publication diagnostics requires a project".to_owned(),
        });
    }

    let records =
        read_planning_capture_publication_stopped_requests(&handler.state).map_err(|error| {
            ServerControlError::StorageUnavailable {
                reason: format!("failed to read planning capture publication requests: {error:?}"),
            }
        })?;

    Ok(ServerQueryResult::PlanningCapturePublicationDiagnostics(
        planning_capture_publication_stopped_request_diagnostics(records),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ids::{ClientId, ServerControlRequestId, ServerQueryId},
        request_handler::LocalControlRequestHandler,
        state::ServerStateService,
        PlanningCapturePublicationAdapterFamily, PlanningCapturePublicationAdmissionRecord,
        PlanningCapturePublicationAdmissionStatus, PlanningCapturePublicationOperation,
        PlanningCapturePublicationStoppedRequestInput, ServerControlRequest,
        ServerControlRequestKind, ServerControlResponseBody, ServerControlResponseStatus,
        ServerQuery, ServerQueryKind,
    };
    use nucleus_local_store::SqliteBackend;
    use nucleus_projects::ProjectId;

    #[test]
    fn planning_capture_publication_diagnostics_query_reads_persisted_requests() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let backend = SqliteBackend::new(temp_dir.path().join("db.sqlite"));
        let state = ServerStateService::new(backend.clone());
        crate::persist_planning_capture_publication_stopped_request(
            &state,
            PlanningCapturePublicationStoppedRequestInput {
                admission: admission(),
                existing_request_ids: Vec::new(),
                raw_payload_present: false,
                command_execution_requested: false,
                runner_handoff_requested: false,
                scm_or_snapshot_mutation_requested: false,
                remote_share_requested: false,
                forge_mutation_requested: false,
                provider_write_requested: false,
                projection_import_requested: false,
                task_promotion_requested: false,
                callback_response_requested: false,
                interruption_requested: false,
                recovery_requested: false,
            },
        )
        .expect("persist stopped request");

        let mut handler = LocalControlRequestHandler::new(backend, None);
        let response = handler.handle(ServerControlRequest {
            id: ServerControlRequestId("request:planning-capture-publication".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:planning-capture-publication".to_owned()),
                client_id: ClientId("client:test".to_owned()),
                kind: ServerQueryKind::PlanningCapturePublicationDiagnostics(
                    PlanningCapturePublicationDiagnosticsQuery {
                        project_id: ProjectId("project:nucleus-local".to_owned()),
                    },
                ),
            }),
        });

        let ServerControlResponseBody::Query(
            ServerQueryResult::PlanningCapturePublicationDiagnostics(diagnostics),
        ) = response.body
        else {
            panic!("expected planning capture publication diagnostics");
        };

        assert_eq!(response.status, ServerControlResponseStatus::Complete);
        assert_eq!(diagnostics.request_count, 1);
        assert_eq!(diagnostics.persisted_request_count, 1);
        assert!(!diagnostics.command_execution_permitted);
        assert!(!diagnostics.publish_permitted);
        assert!(!diagnostics.projection_import_permitted);
    }

    fn admission() -> PlanningCapturePublicationAdmissionRecord {
        PlanningCapturePublicationAdmissionRecord {
            admission_id: "admission:1".to_owned(),
            preparation_id: "prep:1".to_owned(),
            plan_item_id: "plan:1".to_owned(),
            task_id: "task:1".to_owned(),
            work_item_id: Some("work:1".to_owned()),
            completion_id: Some("completion:1".to_owned()),
            operator_ref: "operator:tom".to_owned(),
            approval_ref: Some("approval:1".to_owned()),
            evidence_refs: vec!["evidence:planning-write".to_owned()],
            adapter_family: PlanningCapturePublicationAdapterFamily::SnapshotPublicationLike,
            operation: PlanningCapturePublicationOperation::Publish,
            adapter_label: "convergence".to_owned(),
            workflow_label: "planning-management-publication".to_owned(),
            management_file_refs: vec!["nucleus/planning/artifact-1.toml".to_owned()],
            status: PlanningCapturePublicationAdmissionStatus::Admitted,
            blockers: Vec::new(),
            duplicate_admission_detected: false,
            stopped_request_admitted: true,
            commit_permitted: false,
            snapshot_permitted: false,
            publish_permitted: false,
            push_permitted: false,
            forge_share_permitted: false,
            provider_write_permitted: false,
            projection_import_permitted: false,
            task_promotion_permitted: false,
            callback_response_permitted: false,
            interruption_permitted: false,
            recovery_permitted: false,
            raw_payload_retained: false,
        }
    }
}
