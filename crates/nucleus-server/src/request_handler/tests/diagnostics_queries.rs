use super::*;

#[test]
fn handler_returns_empty_diagnostics_snapshot_without_mutation() {
    let (_temp_dir, mut handler) = handler(None);
    let response = handler.handle(diagnostics_request(DiagnosticsQuery::All));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::All(snapshot)
        )) if !snapshot.steward.client_can_mutate
            && !snapshot.effigy.client_can_run_effigy
            && !snapshot.management_sync.client_can_mutate_provider
            && !snapshot.scm_session.client_can_mutate_working_copy
            && snapshot.steward.source_status == "empty"
            && snapshot.effigy.source_status == "disabled"
            && snapshot.management_sync.source_status == "empty"
            && snapshot.scm_session.source_status == "empty"
            && snapshot.task_agent.source_status == "empty"
            && !snapshot.task_agent.client_can_mutate_work_units
            && !snapshot.task_agent.provider_execution_available
    ));
}

#[test]
fn handler_routes_each_diagnostics_query_kind() {
    let (_temp_dir, mut handler) = handler(None);

    let steward = handler.handle(diagnostics_request(DiagnosticsQuery::Steward));
    let effigy = handler.handle(diagnostics_request(DiagnosticsQuery::Effigy));
    let sync = handler.handle(diagnostics_request(DiagnosticsQuery::ManagementSync));
    let scm = handler.handle(diagnostics_request(DiagnosticsQuery::ScmSession));
    let task_agent = handler.handle(diagnostics_request(DiagnosticsQuery::TaskAgent));

    assert!(matches!(
        steward.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::Steward(_)
        ))
    ));
    assert!(matches!(
        effigy.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::Effigy(_)
        ))
    ));
    assert!(matches!(
        sync.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ManagementSync(_)
        ))
    ));
    assert!(matches!(
        scm.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::ScmSession(_)
        ))
    ));
    assert!(matches!(
        task_agent.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::TaskAgent(_)
        ))
    ));
}

fn diagnostics_request(query: DiagnosticsQuery) -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId("request:diagnostics".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:diagnostics".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::Diagnostics(query),
        }),
    }
}
