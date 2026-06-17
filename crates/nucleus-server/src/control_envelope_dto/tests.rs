use super::*;
use crate::control_api::{
    ServerControlError, ServerControlResponse, ServerControlResponseBody,
    ServerControlResponseStatus, ServerQueryResult, ServerStateRecordSet, StateRecordQuery,
    StateRecordQueryScope,
};
use crate::control_serialization_readiness::ControlApiCodecFailure;
use crate::ids::{ServerControlRequestId, ServerQueryId};
use nucleus_core::{PersistenceDomain, PersistenceRecordId, PersistenceRecordKind, RevisionId};
use nucleus_local_store::{LocalStoreRecord, LocalStoreRecordPayload};
use nucleus_projects::{
    encode_project_storage_record, ImportanceBaseline, ImportanceLevel, Project, ProjectActivity,
    ProjectId, ProjectStatus,
};
use nucleus_tasks::{
    encode_task_storage_record, AcceptanceCriterion, AgentReadiness, AssignmentState, NeglectLevel,
    NeglectSignal, Task, TaskActionType, TaskActivityState, TaskId, TaskImportance, TaskTimestamps,
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
fn response_envelope_dto_serializes_task_records() {
    let task = Task {
        id: TaskId("task:dto".to_owned()),
        project_id: ProjectId("project:dto".to_owned()),
        title: "DTO Task".to_owned(),
        description: Some("Display task records".to_owned()),
        acceptance_criteria: vec![AcceptanceCriterion {
            text: "Task appears in typed response".to_owned(),
            required: true,
        }],
        importance: TaskImportance::Critical,
        neglect: NeglectSignal {
            level: NeglectLevel::Fresh,
            last_addressed_at: None,
            note: None,
        },
        action_type: TaskActionType::Check,
        assignment: AssignmentState::Human("tom".to_owned()),
        activity: TaskActivityState::Active,
        agent_readiness: AgentReadiness {
            ready_for_agent: false,
            required_context_refs: Vec::new(),
            allowed_actions: vec![TaskActionType::Check],
            stop_conditions: Vec::new(),
            validation_commands: Vec::new(),
        },
        assignment_plan: None,
        assignment_snapshot: None,
        history: Vec::new(),
        model_preferences: None,
        timestamps: TaskTimestamps {
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
        },
    };
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:task-response".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::StateRecords(
            ServerStateRecordSet {
                domain: ServerStateDomain::Tasks,
                records: vec![LocalStoreRecord {
                    id: PersistenceRecordId("task:dto".to_owned()),
                    domain: PersistenceDomain::Tasks,
                    kind: PersistenceRecordKind::Task,
                    revision_id: RevisionId("rev:task:1".to_owned()),
                    payload: LocalStoreRecordPayload {
                        media_type: Some("application/json".to_owned()),
                        bytes: encode_task_storage_record(&task).expect("task json"),
                    },
                }],
            },
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlResponseEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");

    assert!(matches!(
        decoded.body,
        ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].task_id == "task:dto"
                && records[0].project_id == "project:dto"
                && records[0].title == "DTO Task"
                && records[0].importance == "critical"
                && records[0].action_type == "check"
                && records[0].activity == "active"
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
