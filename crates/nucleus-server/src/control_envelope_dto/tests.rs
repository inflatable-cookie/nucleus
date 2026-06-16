use super::*;
use crate::control_api::{ServerControlResponse, StateRecordQuery, StateRecordQueryScope};
use crate::control_serialization_readiness::ControlApiCodecFailure;
use crate::ids::{ServerControlRequestId, ServerQueryId};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload};
use nucleus_projects::{
    encode_project_storage_record, ImportanceBaseline, ImportanceLevel, Project, ProjectActivity,
    ProjectId, ProjectStatus,
};

#[test]
fn request_envelope_dto_serializes_supported_state_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:1".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:1".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Project(StateRecordQuery {
                domain: ServerStateDomain::Projects,
                scope: StateRecordQueryScope::List,
            }),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert_eq!(dto.protocol_family, CONTROL_API_PROTOCOL_FAMILY);
    assert_eq!(dto.protocol_version, CONTROL_API_PROTOCOL_VERSION_V1);
    assert_eq!(restored.id, request.id);
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Project(StateRecordQuery {
                scope: StateRecordQueryScope::List,
                ..
            }),
            ..
        })
    ));
}

#[test]
fn request_envelope_rejects_unsupported_command_payload() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
            id: crate::ids::ServerCommandId("command:dto".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: crate::commands::ServerCommandKind::Task(crate::commands::TaskCommand::Start(
                nucleus_tasks::TaskId("task:dto".to_owned()),
            )),
        }),
    };

    let error = ControlRequestEnvelopeDto::try_from(&request).expect_err("unsupported");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedPayloadShape
    );
}

#[test]
fn response_envelope_dto_serializes_status_error_and_state_records() {
    let project = Project {
        id: ProjectId("project:dto".to_owned()),
        display_name: "DTO Project".to_owned(),
        status: ProjectStatus::Active,
        importance_baseline: ImportanceBaseline {
            level: ImportanceLevel::High,
            notes: None,
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
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:response".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet {
                domain: ServerStateDomain::Projects,
                records: vec![LocalStoreRecord {
                    id: PersistenceRecordId("project:dto".to_owned()),
                    domain: PersistenceDomain::Projects,
                    kind: PersistenceRecordKind::Project,
                    revision_id: RevisionId("rev:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: encode_project_storage_record(&project).expect("project json"),
                    },
                }],
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert_eq!(decoded.status, ControlResponseStatusDto::Complete);
    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::ProjectRecords { records } if records.len() == 1
    ));
}

#[test]
fn response_error_shape_is_explicit() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:error".to_owned()),
        status: ServerControlResponseStatus::Rejected,
        body: ServerControlResponseBody::Error(ServerControlError::Deferred {
            reason: "not wired".to_owned(),
        }),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");

    assert_eq!(dto.status, ControlResponseStatusDto::Rejected);
    assert_eq!(
        dto.body,
        ControlResponseBodyDto::Error {
            kind: "deferred".to_owned(),
            reason: "not wired".to_owned(),
        }
    );
}

#[test]
fn request_envelope_rejects_unsupported_version() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: 2,
        request_id: "request:dto:bad-version".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::RuntimeMetadata {
                query_id: "query:dto".to_owned(),
                action: "list_artifact_metadata".to_owned(),
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("bad version");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedProtocolVersion
    );
}
