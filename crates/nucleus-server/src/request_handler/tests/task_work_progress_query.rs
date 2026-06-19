use super::*;

#[test]
fn handler_lists_task_work_progress_without_client_mutation_authority() {
    let (_temp_dir, mut handler) = handler(None);
    persist_task_agent_source(&handler);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:task-work-progress-query".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:task-work-progress".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListTaskWorkProgress),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::TaskWorkProgress(ref records))
            if records.len() == 1
                && records[0].work_item_id == "work:item:1"
                && records[0].runtime == "running"
    ));

    let dto = crate::control_envelope_dto::ControlResponseEnvelopeDto::try_from(&response)
        .expect("task work progress dto");
    assert!(matches!(
        dto.body,
        crate::control_envelope_dto::ControlResponseBodyDto::TaskWorkProgressRecords {
            records,
            client_can_mutate: false,
            provider_execution_available: false,
        } if records.len() == 1 && records[0].summary == "work unit running from persisted task history"
    ));
}
