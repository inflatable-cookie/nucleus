use super::*;

#[test]
fn handler_executes_task_transition_command_and_reads_back_task_dto() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:1".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Seed Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Start(TaskTransitionCommand {
                task_id: TaskId("task:1".to_owned()),
                expected_revision: None,
            })),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Accepted);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Command(ServerCommandReceipt {
            status: ServerCommandReceiptStatus::AcceptedForStateMutation,
            ..
        })
    ));
    let events = handler.state().event_journal().list().expect("events");
    assert_eq!(events.len(), 1);
    let event_store_record = decode_orchestration_event_store_record(&events[0].payload.bytes)
        .expect("decode event record");
    assert_eq!(
        event_store_record.stream_ref.0,
        "stream:command-admission:task:1"
    );
    let event = event_store_record.into_payload();
    assert_eq!(event.kind, OrchestrationEventKind::CommandAdmitted);
    assert_eq!(event.command_id.0, "command:start-task");
    assert_eq!(event.family, OrchestrationCommandFamily::Task);
    assert_eq!(event.target_ref.as_deref(), Some("task:1"));
    let projection =
        rebuild_command_admission_projection(handler.state()).expect("command projection");
    assert_eq!(projection.admitted_total, 1);
    assert_eq!(projection.task_commands, 1);

    let query_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:task-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:tasks".to_owned()),
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
            if records.len() == 1 && records[0].activity == "active"
    ));
}

#[test]
fn handler_projects_task_timeline_from_command_events() {
    let (_temp_dir, mut handler) = handler(None);
    seed_local_task(
        handler.state(),
        LocalTaskSeed {
            task_id: "task:timeline".to_owned(),
            project_id: "project:nucleus-local".to_owned(),
            title: "Timeline Task".to_owned(),
            action_type: nucleus_tasks::TaskActionType::Plan,
            importance: nucleus_tasks::TaskImportance::Normal,
        },
    )
    .expect("seed task");

    let command_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:timeline-command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:start-timeline-task".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::Task(TaskCommand::Start(TaskTransitionCommand {
                task_id: TaskId("task:timeline".to_owned()),
                expected_revision: None,
            })),
        }),
    });
    assert_eq!(
        command_response.status,
        ServerControlResponseStatus::Accepted
    );

    let timeline_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:timeline-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:task-timeline".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::TaskTimeline(TaskTimelineQuery {
                task_id: TaskId("task:timeline".to_owned()),
            }),
        }),
    });

    assert_eq!(
        timeline_response.status,
        ServerControlResponseStatus::Complete
    );
    assert!(matches!(
        timeline_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::TaskTimeline(projection))
            if projection.task_id.0 == "task:timeline"
                && projection.entries.len() == 1
                && projection.entries[0].source_command_id == "command:start-timeline-task"
                && projection.entries[0].source_event_id == "event:command:start-timeline-task:admitted"
    ));
}
