use super::*;
use crate::commands::ReadOnlyCommand;

fn read_only_command(executable: &str, argv: Vec<&str>) -> ReadOnlyCommand {
    ReadOnlyCommand {
        project_id: nucleus_projects::ProjectId("project:nucleus-local".to_owned()),
        execution_host_id: crate::EngineHostId("host:local".to_owned()),
        executable: executable.to_owned(),
        argv: argv.into_iter().map(str::to_owned).collect(),
        working_directory: std::env::current_dir().expect("current dir"),
        timeout_ms: 2_000,
        stdout_limit_bytes: 16,
        stderr_limit_bytes: 16,
        command_display: Some("read-only handler command".to_owned()),
    }
}

#[test]
fn handler_executes_read_only_command_and_persists_sanitized_evidence() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:readonly-command".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:readonly-control".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::ReadOnlyCommand(read_only_command(
                "printf",
                vec!["nucleus-readonly-handler"],
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::ReadOnlyCommand(result)
            if result.status == nucleus_command_policy::CommandExecutionStatus::Succeeded
                && result.exit_status == Some(0)
                && result.stdout_captured_bytes == 16
                && result.rejection.is_none()
    ));

    let records = handler
        .state()
        .command_evidence()
        .list()
        .expect("list evidence");
    let json = String::from_utf8(records[0].payload.bytes.clone()).expect("json");

    assert_eq!(records.len(), 1);
    assert!(!json.contains("nucleus-readonly-handler"));
    assert!(!json.contains("raw_stdout"));

    let receipts = handler
        .state()
        .runtime_effects()
        .list()
        .expect("list receipts");
    let receipt_json = String::from_utf8(receipts[0].payload.bytes.clone()).expect("receipt json");
    assert_eq!(receipts.len(), 1);
    assert!(receipt_json.contains("command_execution"));
    assert!(receipt_json.contains("completed"));
    assert!(!receipt_json.contains("nucleus-readonly-handler"));
    assert!(!receipt_json.contains("raw_stdout"));

    let receipt_response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:runtime-receipts".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:runtime-receipts".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::RuntimeMetadata(RuntimeMetadataQuery::ListRuntimeReceipts),
        }),
    });
    assert!(matches!(
        receipt_response.body,
        ServerControlResponseBody::Query(ServerQueryResult::RuntimeReceipts(records))
            if records.len() == 1
                && records[0].receipt_id.0 == "receipt:command:readonly-control:read-only-command"
    ));
}

#[test]
fn handler_rejects_read_only_shell_passthrough_without_raw_output() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:readonly-shell".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Command(ServerCommand {
            id: ServerCommandId("command:readonly-shell".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerCommandKind::ReadOnlyCommand(read_only_command(
                "/bin/sh",
                vec!["-c", "echo should-not-run"],
            )),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Rejected);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::ReadOnlyCommand(result)
            if result.status == nucleus_command_policy::CommandExecutionStatus::BlockedByPolicy
                && result.rejection.is_some()
    ));
}
