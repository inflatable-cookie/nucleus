use super::*;
use crate::control_api::{
    DiagnosticsQuery, ProviderReadIntentQuery, ProviderReadinessOverviewQuery,
    RuntimeMetadataQuery, ServerControlError, ServerControlRequestKind, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQuery, ServerQueryKind, ServerQueryResult,
    ServerStateRecordSet, StateRecordQuery, StateRecordQueryScope,
};
use crate::ids::{ClientId, ServerControlRequestId, ServerQueryId};
use crate::request_handler::LocalControlRequestHandler;
use crate::state::ServerStateDomain;
use crate::tauri_ipc_readiness::TauriIpcCommandShape;
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{
    fixture_record, LocalStoreRecord, LocalStoreRecordPayload, RevisionExpectation, SqliteBackend,
};
use nucleus_projects::{
    encode_project_storage_record, ImportanceBaseline, ImportanceLevel, Project, ProjectActivity,
    ProjectId, ProjectRetention, ProjectStatus,
};

#[derive(Clone, Debug)]
struct ShapeOnlyBoundary {
    boundary: TauriIpcCommandBoundary,
}

impl TauriIpcCommandBoundaryHandler for ShapeOnlyBoundary {
    fn boundary(&self) -> &TauriIpcCommandBoundary {
        &self.boundary
    }

    fn submit_control_request(
        &mut self,
        request: ServerControlRequest,
    ) -> Result<TauriIpcCommandExchange, TauriIpcCommandBoundaryError> {
        let response = ServerControlResponse {
            request_id: request.id.clone(),
            status: ServerControlResponseStatus::Rejected,
            body: ServerControlResponseBody::Error(ServerControlError::Deferred {
                reason: "shape-only Tauri IPC boundary has no runtime".to_owned(),
            }),
        };
        Ok(TauriIpcCommandExchange { request, response })
    }
}

fn encoded_project_record(id: &str, display_name: &str) -> LocalStoreRecord {
    let project = Project {
        id: ProjectId(id.to_owned()),
        display_name: display_name.to_owned(),
        authority_host_ref: "host:embedded-desktop".to_owned(),
        status: ProjectStatus::Active,
        retention: ProjectRetention::Durable,
        importance_baseline: ImportanceBaseline {
            level: ImportanceLevel::Normal,
            notes: None,
        },
        resources: Vec::new(),
        default_working_resource: None,
        management_projection: None,
        task_ids: Vec::new(),
        workspace_layout_refs: Vec::new(),
        activity: ProjectActivity {
            created_at: None,
            last_focused_at: None,
            last_agent_activity_at: None,
            last_task_activity_at: None,
        },
    };

    LocalStoreRecord {
        id: PersistenceRecordId(id.to_owned()),
        domain: PersistenceDomain::Projects,
        kind: PersistenceRecordKind::Project,
        revision_id: RevisionId("rev:1".to_owned()),
        payload: LocalStoreRecordPayload {
            media_type: Some("application/json".to_owned()),
            bytes: encode_project_storage_record(&project).expect("project json"),
        },
    }
}

#[test]
fn schema_only_boundary_names_submit_command_without_tauri_runtime() {
    let boundary = TauriIpcCommandBoundary::schema_only();

    assert_eq!(boundary.posture, TauriIpcCommandBoundaryPosture::SchemaOnly);
    assert!(boundary
        .schema
        .commands
        .contains(&TauriIpcCommandShape::SubmitControlRequest));
}

#[test]
fn boundary_handler_carries_server_control_request_and_response() {
    let mut handler = ShapeOnlyBoundary {
        boundary: TauriIpcCommandBoundary::schema_only(),
    };
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:tauri-ipc:shape".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:tauri-ipc:shape".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListArtifactMetadata),
        }),
    };

    let exchange = handler
        .submit_control_request(request.clone())
        .expect("shape-only exchange");

    assert_eq!(exchange.request, request);
    assert_eq!(exchange.response.request_id, exchange.request.id);
    assert!(matches!(
        exchange.response.body,
        ServerControlResponseBody::Error(ServerControlError::Deferred { .. })
    ));
}

#[test]
fn fixture_backed_boundary_routes_state_query_through_local_handler() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    let record = fixture_record(
        PersistenceDomain::Projects,
        PersistenceRecordKind::Project,
        "project:tauri-ipc",
        "rev:1",
    );
    handler
        .state()
        .projects()
        .put(record.clone(), RevisionExpectation::MustNotExist)
        .expect("seed project");
    let mut fixture = TauriIpcCommandHandlerFixture::new(handler);

    let exchange = fixture
        .submit_control_request(ServerControlRequest {
            id: ServerControlRequestId("request:tauri-ipc:project-list".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Query(ServerQuery {
                id: ServerQueryId("query:tauri-ipc:project-list".to_owned()),
                client_id: ClientId("client:desktop".to_owned()),
                kind: ServerQueryKind::Project(StateRecordQuery {
                    domain: ServerStateDomain::Projects,
                    scope: StateRecordQueryScope::List,
                }),
            }),
        })
        .expect("fixture exchange");

    assert_eq!(
        fixture.boundary().posture,
        TauriIpcCommandBoundaryPosture::FixtureBacked
    );
    assert_eq!(fixture.exchanges(), &[exchange.clone()]);
    assert_eq!(
        exchange.response.status,
        ServerControlResponseStatus::Complete
    );
    assert!(matches!(
        exchange.response.body,
        ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet { records, .. }
        )) if records == vec![record]
    ));
}

#[test]
fn control_command_adapter_routes_dto_request_to_dto_response() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    let record = encoded_project_record("project:tauri-adapter", "Tauri Adapter");
    handler
        .state()
        .projects()
        .put(record, RevisionExpectation::MustNotExist)
        .expect("seed project");
    let mut adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);
    let request = ControlRequestEnvelopeDto::try_from(&ServerControlRequest {
        id: ServerControlRequestId("request:tauri-adapter:project-list".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:tauri-adapter:project-list".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Project(StateRecordQuery {
                domain: ServerStateDomain::Projects,
                scope: StateRecordQueryScope::List,
            }),
        }),
    })
    .expect("request dto");

    let response = adapter
        .submit_control_envelope(request)
        .expect("response dto");

    assert_eq!(
        adapter.boundary().posture,
        TauriIpcCommandBoundaryPosture::FixtureBacked
    );
    assert_eq!(response.request_id, "request:tauri-adapter:project-list");
    assert!(matches!(
        response.body,
        crate::control_envelope_dto::ControlResponseBodyDto::ProjectRecords { records }
            if records.len() == 1 && records[0].display_name == "Tauri Adapter"
    ));
}

#[test]
fn control_command_adapter_routes_diagnostics_dto_without_ipc_authority() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    let mut adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);
    let request = ControlRequestEnvelopeDto::try_from(&ServerControlRequest {
        id: ServerControlRequestId("request:tauri-adapter:diagnostics".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:tauri-adapter:diagnostics".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::All),
        }),
    })
    .expect("request dto");

    let response = adapter
        .submit_control_envelope(request)
        .expect("response dto");
    let json = serde_json::to_string(&response).expect("response json");

    assert_eq!(
        adapter.boundary().posture,
        TauriIpcCommandBoundaryPosture::FixtureBacked
    );
    assert_eq!(response.request_id, "request:tauri-adapter:diagnostics");
    assert!(matches!(
        response.body,
        crate::control_envelope_dto::ControlResponseBodyDto::Diagnostics {
            result: crate::control_envelope_dto::ControlDiagnosticsResultDto::All(snapshot),
        } if !snapshot.steward.client_can_mutate
            && !snapshot.effigy.client_can_run_effigy
            && !snapshot.management_sync.client_can_mutate_provider
            && !snapshot.scm_session.client_can_mutate_working_copy
    ));
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_stderr"));
    assert!(!json.contains("provider_payload"));
}

#[test]
fn control_command_adapter_routes_provider_read_intent_without_provider_effects() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    let mut adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);
    let request = ControlRequestEnvelopeDto::try_from(&ServerControlRequest {
        id: ServerControlRequestId("request:tauri-adapter:provider-read-intent".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:tauri-adapter:provider-read-intent".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProviderReadIntent(ProviderReadIntentQuery::Projection),
        }),
    })
    .expect("request dto");

    let response = adapter
        .submit_control_envelope(request)
        .expect("response dto");
    let json = serde_json::to_string(&response).expect("response json");

    assert_eq!(
        adapter.boundary().posture,
        TauriIpcCommandBoundaryPosture::FixtureBacked
    );
    assert_eq!(
        response.request_id,
        "request:tauri-adapter:provider-read-intent"
    );
    assert!(matches!(
        response.body,
        crate::control_envelope_dto::ControlResponseBodyDto::ProviderReadIntent { result }
            if result.projection.total_count == 0
                && !result.no_effects.credential_resolution_performed
                && !result.no_effects.provider_network_call_performed
                && !result.no_effects.provider_effect_executed
                && !result.no_effects.raw_provider_payload_retained
    ));
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_response_body"));
}

#[test]
fn control_command_adapter_routes_provider_readiness_overview_without_provider_effects() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    let mut adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);
    let request = ControlRequestEnvelopeDto::try_from(&ServerControlRequest {
        id: ServerControlRequestId("request:tauri-adapter:provider-readiness-overview".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:tauri-adapter:provider-readiness-overview".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProviderReadinessOverview(
                ProviderReadinessOverviewQuery::Overview,
            ),
        }),
    })
    .expect("request dto");

    let response = adapter
        .submit_control_envelope(request)
        .expect("response dto");
    let json = serde_json::to_string(&response).expect("response json");

    assert_eq!(
        adapter.boundary().posture,
        TauriIpcCommandBoundaryPosture::FixtureBacked
    );
    assert_eq!(
        response.request_id,
        "request:tauri-adapter:provider-readiness-overview"
    );
    assert!(matches!(
        response.body,
        crate::control_envelope_dto::ControlResponseBodyDto::ProviderReadinessOverview { overview }
            if overview.overview_id == "forge-readiness-overview"
                && overview.projection_id == "forge-read-intent-projection"
                && overview.status == "unknown"
                && overview.total_read_intent_count == 0
                && overview.missing_evidence_family_count == 4
                && !overview.no_effects.credential_resolution_performed
                && !overview.no_effects.provider_network_call_performed
                && !overview.no_effects.provider_effect_executed
                && !overview.no_effects.callback_effect_executed
                && !overview.no_effects.interruption_effect_executed
                && !overview.no_effects.recovery_effect_executed
                && !overview.no_effects.task_mutation_executed
                && !overview.no_effects.raw_provider_payload_retained
    ));
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_response_body"));
}

#[test]
fn control_command_adapter_reports_decode_errors_without_server_routing() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("nucleus.sqlite"));
    let handler = LocalControlRequestHandler::new(backend, None);
    let mut adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);
    let request = ControlRequestEnvelopeDto {
        protocol_family: crate::control_serialization_readiness::CONTROL_API_PROTOCOL_FAMILY
            .to_owned(),
        protocol_version: 2,
        request_id: "request:bad-version".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: crate::control_envelope_dto::ControlRequestBodyDto::Query {
            query: crate::control_envelope_dto::ControlQueryDto::RuntimeMetadata {
                query_id: "query:bad-version".to_owned(),
                action: "list_artifact_metadata".to_owned(),
            },
        },
    };

    let error = adapter
        .submit_control_envelope(request)
        .expect_err("decode error");

    assert_eq!(
        error.failure,
        crate::control_serialization_readiness::ControlApiCodecFailure::UnsupportedProtocolVersion
    );
}
