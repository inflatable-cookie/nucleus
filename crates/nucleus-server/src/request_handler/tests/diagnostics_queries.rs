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
            && snapshot.codex_provider.source_status == "empty"
            && !snapshot.codex_provider.client_can_control_provider
            && !snapshot.codex_provider.client_can_mutate_tasks
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
    let codex = handler.handle(diagnostics_request(DiagnosticsQuery::CodexProvider));

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
    assert!(matches!(
        codex.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CodexProvider(record)
        )) if !record.client_can_control_provider
            && !record.client_can_mutate_tasks
            && record.source_status == "empty"
    ));
}

#[test]
fn handler_reads_task_agent_diagnostics_from_persisted_task_history() {
    let (_temp_dir, mut handler) = handler(None);
    let source = persist_task_agent_source(&handler);

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::TaskAgent));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::TaskAgent(record)
        )) if record.source_status == "records"
            && record.work_units.len() == 1
            && record.work_units[0].last_source_id == source.source_id.0
            && record.work_units[0].summary == source.summary
            && !record.client_can_mutate_work_units
            && !record.provider_execution_available
    ));
}

#[test]
fn handler_reads_codex_live_executor_diagnostics_from_persisted_outcomes() {
    let (_temp_dir, mut handler) = handler(None);
    for outcome in [
        live_executor_outcome(
            "completed",
            crate::CodexAppServerLiveExecutorOutcomeStatus::Completed,
        ),
        live_executor_outcome(
            "failed",
            crate::CodexAppServerLiveExecutorOutcomeStatus::Failed("provider exited".to_owned()),
        ),
        live_executor_outcome(
            "timeout",
            crate::CodexAppServerLiveExecutorOutcomeStatus::TimedOut,
        ),
    ] {
        crate::persist_codex_live_executor_outcome(
            handler.state(),
            crate::CodexAppServerLiveExecutorOutcomePersistenceInput { outcome },
        )
        .expect("persist live executor outcome");
    }

    let response = handler.handle(diagnostics_request(DiagnosticsQuery::CodexProvider));

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::Diagnostics(
            ServerDiagnosticsQueryResult::CodexProvider(record)
        )) if record.source_status == "available"
            && record.live_executor.source_status == "records"
            && record.live_executor.attempts.len() == 3
            && record.live_executor.attempts[0].status == "completed"
            && record.live_executor.attempts[1].status == "failed"
            && record.live_executor.attempts[2].status == "timed_out"
            && !record.client_can_control_provider
            && !record.client_can_mutate_tasks
            && !record.live_executor.client_can_execute_provider_write
            && !record.live_executor.client_can_cancel_provider
            && !record.live_executor.client_can_resume_provider
            && !record.live_executor.client_can_mutate_tasks
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

fn live_executor_outcome(
    suffix: &str,
    status: crate::CodexAppServerLiveExecutorOutcomeStatus,
) -> crate::CodexAppServerLiveExecutorOutcomeRecord {
    crate::codex_live_executor_outcome_record(crate::CodexAppServerLiveExecutorOutcomeInput {
        provider_instance_id: "codex:local-default".to_owned(),
        write_attempt_id: format!("provider-transport-write:handler-{suffix}"),
        receipt_refs: vec![format!("receipt:handler-{suffix}")],
        thread_id: Some(format!("thread:handler-{suffix}")),
        turn_id: Some(format!("turn:handler-{suffix}")),
        final_turn_status: Some(live_executor_status_label(&status)),
        status,
        method_sequence: vec![
            crate::CodexAppServerLiveExecutorMethod::Initialize,
            crate::CodexAppServerLiveExecutorMethod::InitializedNotification,
            crate::CodexAppServerLiveExecutorMethod::ThreadStart,
            crate::CodexAppServerLiveExecutorMethod::TurnStart,
            crate::CodexAppServerLiveExecutorMethod::TurnCompleted,
            crate::CodexAppServerLiveExecutorMethod::Cleanup,
        ],
        notification_count: 1,
        server_request_count: 0,
        cleanup_status: crate::CodexAppServerLiveExecutorCleanupStatus::Completed,
        evidence_refs: vec![format!("evidence:handler-{suffix}")],
        provider_write_executed: true,
    })
}

fn live_executor_status_label(status: &crate::CodexAppServerLiveExecutorOutcomeStatus) -> String {
    match status {
        crate::CodexAppServerLiveExecutorOutcomeStatus::Accepted => "accepted",
        crate::CodexAppServerLiveExecutorOutcomeStatus::Completed => "completed",
        crate::CodexAppServerLiveExecutorOutcomeStatus::Failed(_) => "failed",
        crate::CodexAppServerLiveExecutorOutcomeStatus::TimedOut => "timed_out",
        crate::CodexAppServerLiveExecutorOutcomeStatus::Blocked(_) => "blocked",
        crate::CodexAppServerLiveExecutorOutcomeStatus::CleanupRequired(_) => "cleanup_required",
    }
    .to_owned()
}
