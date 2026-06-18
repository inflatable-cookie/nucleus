use crate::control_api::{
    DiagnosticsQuery, ServerControlRequest, ServerControlRequestKind, ServerQuery, ServerQueryKind,
    StateRecordQuery, StateRecordQueryScope,
};
use crate::control_envelope_dto::*;
use crate::control_serialization_readiness::ControlApiCodecFailure;
use crate::ids::{ServerCommandId, ServerControlRequestId, ServerQueryId};
use crate::{ClientId, ServerStateDomain};
use nucleus_core::RevisionId;
use nucleus_projects::ProjectId;
use nucleus_tasks::{
    AcceptanceCriterion, AgentReadiness, TaskActionType, TaskActivityState, TaskImportance,
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
fn request_envelope_dto_serializes_supported_task_command() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
            id: ServerCommandId("command:dto".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: crate::commands::ServerCommandKind::Task(crate::commands::TaskCommand::Block {
                task_id: nucleus_tasks::TaskId("task:dto".to_owned()),
                reason: "waiting for contract".to_owned(),
                expected_revision: Some(RevisionId("rev:task:2".to_owned())),
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
        ServerControlRequestKind::Command(crate::commands::ServerCommand {
            kind: crate::commands::ServerCommandKind::Task(crate::commands::TaskCommand::Block {
                task_id,
                reason,
                expected_revision: Some(RevisionId(revision)),
            }),
            ..
        }) if task_id.0 == "task:dto"
            && reason == "waiting for contract"
            && revision == "rev:task:2"
    ));
}

#[test]
fn request_envelope_dto_serializes_read_only_command() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:readonly-command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
            id: ServerCommandId("command:dto:readonly".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: crate::commands::ServerCommandKind::ReadOnlyCommand(
                crate::commands::ReadOnlyCommand {
                    project_id: ProjectId("project:dto".to_owned()),
                    execution_host_id: crate::EngineHostId("host:local".to_owned()),
                    executable: "printf".to_owned(),
                    argv: vec!["nucleus".to_owned()],
                    working_directory: std::env::current_dir().expect("current dir"),
                    timeout_ms: 2_000,
                    stdout_limit_bytes: 64,
                    stderr_limit_bytes: 64,
                    command_display: Some("printf nucleus".to_owned()),
                },
            ),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Command(crate::commands::ServerCommand {
            kind: crate::commands::ServerCommandKind::ReadOnlyCommand(command),
            ..
        }) if command.project_id.0 == "project:dto"
            && command.execution_host_id.0 == "host:local"
            && command.executable == "printf"
            && command.argv == vec!["nucleus"]
            && command.timeout_ms == 2_000
            && command.stdout_limit_bytes == 64
    ));
}

#[test]
fn request_envelope_dto_serializes_task_create_command() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:create-command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
            id: ServerCommandId("command:dto:create".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: crate::commands::ServerCommandKind::Task(crate::commands::TaskCommand::Create(
                crate::commands::TaskCreateCommand {
                    project_id: ProjectId("project:dto".to_owned()),
                    title: "Create DTO Task".to_owned(),
                    description: Some("Created through command DTO".to_owned()),
                    acceptance_criteria: vec![AcceptanceCriterion {
                        text: "Create command round-trips".to_owned(),
                        required: true,
                    }],
                    importance: TaskImportance::High,
                    action_type: TaskActionType::Plan,
                    activity: TaskActivityState::Proposed,
                    agent_readiness: AgentReadiness {
                        ready_for_agent: true,
                        required_context_refs: vec![
                            "docs/contracts/005-task-contract.md".to_owned()
                        ],
                        allowed_actions: vec![TaskActionType::Plan],
                        stop_conditions: Vec::new(),
                        validation_commands: vec!["effigy test --plan".to_owned()],
                    },
                },
            )),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Command(crate::commands::ServerCommand {
            kind: crate::commands::ServerCommandKind::Task(crate::commands::TaskCommand::Create(command)),
            ..
        }) if command.project_id.0 == "project:dto"
            && command.title == "Create DTO Task"
            && command.importance == TaskImportance::High
            && command.agent_readiness.ready_for_agent
            && command.agent_readiness.validation_commands == vec!["effigy test --plan"]
    ));
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

#[test]
fn request_envelope_dto_serializes_runtime_readiness_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:runtime-readiness".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:runtime-readiness".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(
                crate::RuntimeMetadataQuery::GetLocalRuntimeReadiness,
            ),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::RuntimeMetadata(
                crate::RuntimeMetadataQuery::GetLocalRuntimeReadiness
            ),
            ..
        })
    ));
}

#[test]
fn request_envelope_dto_serializes_diagnostics_query() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:diagnostics".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:diagnostics".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::All),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"kind\":\"diagnostics\""));
    assert!(json.contains("\"domain\":\"all\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::Diagnostics(DiagnosticsQuery::All),
            ..
        })
    ));
}

#[test]
fn request_envelope_rejects_unknown_diagnostics_domain() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:dto:bad-diagnostics".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::Diagnostics {
                query_id: "query:dto:bad-diagnostics".to_owned(),
                domain: "provider_shell".to_owned(),
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("bad diagnostics domain");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedPayloadShape
    );
}
