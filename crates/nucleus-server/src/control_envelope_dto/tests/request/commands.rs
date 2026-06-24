use super::*;

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
fn request_envelope_dto_serializes_task_seed_promotion_command() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:promote-seed".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
            id: ServerCommandId("command:dto:promote-seed".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: crate::commands::ServerCommandKind::Task(
                crate::commands::TaskCommand::PromoteSeed(
                    crate::commands::TaskSeedPromotionCommand {
                        project_id: ProjectId("project:dto".to_owned()),
                        seed_id: nucleus_engine::EngineTaskSeedId("seed:dto".to_owned()),
                        expected_seed_revision: Some(RevisionId("rev:seed:dto".to_owned())),
                        destination_task_id: Some(nucleus_tasks::TaskId(
                            "task:command:dto:promote-seed".to_owned(),
                        )),
                    },
                ),
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
            kind: crate::commands::ServerCommandKind::Task(
                crate::commands::TaskCommand::PromoteSeed(command)
            ),
            ..
        }) if command.project_id.0 == "project:dto"
            && command.seed_id.0 == "seed:dto"
            && command.expected_seed_revision == Some(RevisionId("rev:seed:dto".to_owned()))
            && command.destination_task_id == Some(nucleus_tasks::TaskId(
                "task:command:dto:promote-seed".to_owned()
            ))
    ));
}
