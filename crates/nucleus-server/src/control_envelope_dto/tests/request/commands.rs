use super::*;

#[test]
fn request_envelope_dto_round_trips_project_create_and_lifecycle_commands() {
    let commands = [
        crate::commands::ProjectCommand::Create(crate::commands::ProjectCreateCommand {
            display_name: "Empty Project".to_owned(),
            actor_ref: "operator:desktop".to_owned(),
            authority_host_ref: "host:embedded-desktop".to_owned(),
            idempotency_key: "project:create:1".to_owned(),
        }),
        crate::commands::ProjectCommand::Lifecycle(crate::commands::ProjectLifecycleCommand {
            project_id: ProjectId("project:one".to_owned()),
            expected_revision: RevisionId("rev:project:1".to_owned()),
            actor_ref: "operator:desktop".to_owned(),
            authority_host_ref: "host:embedded-desktop".to_owned(),
            idempotency_key: "project:rename:1".to_owned(),
            action: crate::commands::ProjectLifecycleAction::Rename {
                display_name: "Renamed Project".to_owned(),
            },
        }),
    ];

    for (index, project_command) in commands.into_iter().enumerate() {
        let request = ServerControlRequest {
            id: ServerControlRequestId(format!("request:project:{index}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
                id: ServerCommandId(format!("command:project:{index}")),
                client_id: ClientId("client:desktop".to_owned()),
                kind: crate::commands::ServerCommandKind::Project(project_command),
            }),
        };

        let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
        let json = serde_json::to_string(&dto).expect("json");
        let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded");
        let restored = ServerControlRequest::try_from(decoded).expect("restored");

        assert_eq!(restored, request);
        assert!(!json.contains("current_locator"));
        assert!(!json.contains("git_repository"));
    }
}

#[test]
fn request_envelope_dto_round_trips_project_resource_commands() {
    let commands = [
        crate::commands::ProjectResourceAction::Attach {
            locator: std::path::PathBuf::from("/host/project"),
        },
        crate::commands::ProjectResourceAction::Update {
            resource_id: nucleus_projects::ProjectResourceId("resource:one".to_owned()),
            display_name: Some("Source".to_owned()),
            role: Some(nucleus_projects::ProjectResourceRole::Working),
            set_as_default: Some(true),
        },
        crate::commands::ProjectResourceAction::Repair {
            resource_id: nucleus_projects::ProjectResourceId("resource:one".to_owned()),
            locator: std::path::PathBuf::from("/host/moved-project"),
        },
        crate::commands::ProjectResourceAction::Remove {
            resource_id: nucleus_projects::ProjectResourceId("resource:one".to_owned()),
        },
    ];

    for (index, action) in commands.into_iter().enumerate() {
        let request = ServerControlRequest {
            id: ServerControlRequestId(format!("request:resource:{index}")),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
                id: ServerCommandId(format!("command:resource:{index}")),
                client_id: ClientId("client:desktop".to_owned()),
                kind: crate::commands::ServerCommandKind::Project(
                    crate::commands::ProjectCommand::Resource(
                        crate::commands::ProjectResourceCommand {
                            project_id: ProjectId("project:one".to_owned()),
                            expected_revision: RevisionId("rev:project:1".to_owned()),
                            actor_ref: "operator:desktop".to_owned(),
                            authority_host_ref: "host:embedded-desktop".to_owned(),
                            idempotency_key: format!("resource:{index}"),
                            action,
                        },
                    ),
                ),
            }),
        };

        let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
        let json = serde_json::to_string(&dto).expect("json");
        let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded");
        let restored = ServerControlRequest::try_from(decoded).expect("restored");

        assert_eq!(restored, request);
    }
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
fn request_envelope_dto_serializes_goal_create_command_with_existing_tasks() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:goal-create".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
            id: ServerCommandId("command:dto:goal-create".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: crate::commands::ServerCommandKind::Goal(crate::commands::GoalCommand::Create(
                crate::commands::GoalCreateCommand {
                    project_id: ProjectId("project:nucleus-local".to_owned()),
                    title: "Group existing tasks".to_owned(),
                    desired_outcome: "The existing tasks form one runway.".to_owned(),
                    scope: "Task workflow demo".to_owned(),
                    status: nucleus_planning::GoalStatus::Ready,
                    owner_refs: vec!["client:desktop".to_owned()],
                    ordered_task_refs: vec![
                        nucleus_tasks::TaskId("task:one".to_owned()),
                        nucleus_tasks::TaskId("task:two".to_owned()),
                    ],
                    planning_artifact_refs: Vec::new(),
                    provenance_refs: vec!["conversation:test".to_owned()],
                    stop_conditions: vec!["Stop if either task is missing".to_owned()],
                    evidence_refs: Vec::new(),
                    current_next_task_ref: Some(nucleus_tasks::TaskId("task:one".to_owned())),
                    next_action: Some("Start with task one".to_owned()),
                },
            )),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert_eq!(restored, request);
}

#[test]
fn request_envelope_dto_preserves_goal_update_clear_patches() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:goal-update".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
            id: ServerCommandId("command:dto:goal-update".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: crate::commands::ServerCommandKind::Goal(crate::commands::GoalCommand::Update(
                crate::commands::GoalUpdateCommand {
                    goal_id: nucleus_planning::PlanningGoalId("goal:dto".to_owned()),
                    expected_revision: RevisionId("rev:goal:dto".to_owned()),
                    changes: crate::commands::GoalUpdateChanges {
                        current_next_task_ref: Some(None),
                        next_action: Some(None),
                        ..crate::commands::GoalUpdateChanges::default()
                    },
                },
            )),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert_eq!(restored, request);
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

#[test]
fn request_envelope_dto_serializes_memory_proposal_review_command() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:memory-review".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(crate::commands::ServerCommand {
            id: ServerCommandId("command:dto:memory-review".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: crate::commands::ServerCommandKind::MemoryProposalReview(
                crate::MemoryProposalReviewCommand {
                    command_id: "command:dto:memory-review".to_owned(),
                    proposal_id: "memory-proposal:dto".to_owned(),
                    expected_revision: RevisionId("rev:memory-proposal:dto".to_owned()),
                    action: crate::MemoryProposalReviewAction::MarkReviewedForPromotion,
                    reviewer_ref: Some("user:tom".to_owned()),
                    note: Some("Reviewed at the proposal layer only.".to_owned()),
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
            kind: crate::commands::ServerCommandKind::MemoryProposalReview(command),
            ..
        }) if command.proposal_id == "memory-proposal:dto"
            && command.expected_revision == RevisionId("rev:memory-proposal:dto".to_owned())
            && command.action == crate::MemoryProposalReviewAction::MarkReviewedForPromotion
            && command.reviewer_ref == Some("user:tom".to_owned())
    ));
}
