use super::*;

#[test]
fn handler_executes_task_create_command_and_reads_back_task_dto() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_project(handler.state(), LocalProjectSeed::nucleus_local()).expect("seed project");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:create-task".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:create-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Create(
                crate::commands::TaskCreateCommand {
                    project_id: nucleus_projects::ProjectId("project:nucleus-local".to_owned()),
                    title: "Create task through handler".to_owned(),
                    description: Some("Write a task record through server authority.".to_owned()),
                    acceptance_criteria: vec![nucleus_tasks::AcceptanceCriterion {
                        text: "Task appears in read-after-write DTO".to_owned(),
                        required: true,
                    }],
                    importance: nucleus_tasks::TaskImportance::High,
                    action_type: nucleus_tasks::TaskActionType::Plan,
                    activity: nucleus_tasks::TaskActivityState::Proposed,
                    agent_readiness: nucleus_tasks::AgentReadiness {
                        ready_for_agent: true,
                        required_context_refs: vec![
                            "docs/contracts/005-task-contract.md".to_owned()
                        ],
                        allowed_actions: vec![nucleus_tasks::TaskActionType::Plan],
                        stop_conditions: Vec::new(),
                        validation_commands: vec!["effigy test --plan".to_owned()],
                    },
                },
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:created-task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:created-tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].task_id == "task:command:create-task"
                && records[0].title == "Create task through handler"
                && records[0].importance == "high"
                && records[0].agent_ready
    ));
}

#[test]
fn handler_executes_task_update_command_with_revision_check() {
    let (_temp_dir, mut handler) = handler(None);
    let seeded = seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:update".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Seed Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:update-task".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:update-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Update(
                crate::commands::TaskUpdateCommand {
                    task_id: TaskId("task:update".to_owned()),
                    expected_revision: Some(seeded.revision_id.clone()),
                    changes: crate::commands::TaskUpdateChanges {
                        title: Some("Updated Task".to_owned()),
                        importance: Some(nucleus_tasks::TaskImportance::Critical),
                        activity: Some(nucleus_tasks::TaskActivityState::Ready),
                        ..Default::default()
                    },
                },
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:updated-task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:updated-tasks".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Task(StateRecordQuery {
                domain: ServerStateDomain::Tasks,
                scope: StateRecordQueryScope::List,
            }),
        }),
    });
    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&query_response)
        .expect("task dto response");

    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskRecords { records }
            if records.len() == 1
                && records[0].title == "Updated Task"
                && records[0].importance == "critical"
                && records[0].activity == "ready"
    ));
}
