use std::sync::{Arc, Mutex};

use nucleus_command_policy::{
    CommandEvidence, CommandEvidenceId, CommandExecutionStatus, CommandOutputRetention,
    CommandRequestId,
};
use nucleus_core::RevisionId;
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_server::{
    write_command_evidence, ControlQueryDto, ControlRequestBodyDto, ControlRequestEnvelopeDto,
    LocalCodexChatService, LocalControlRequestHandler, ServerStateService,
    TauriIpcControlCommandAdapter, CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
};

use crate::DesktopState;

#[test]
fn desktop_state_routes_command_history_query_to_typed_dto() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-command-history-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-command-history".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::RuntimeMetadata {
                    query_id: "desktop-query-command-history".to_owned(),
                    action: "list_command_evidence".to_owned(),
                },
            },
        })
        .expect("desktop command history should route through the server adapter");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::CommandEvidenceRecords { records }
            if records.len() == 1
                && records[0].evidence_id == "command:evidence:nucleus-local:bootstrap"
                && records[0].summary == Some("desktop bootstrap command evidence seed".to_owned())
    ));

    let _ = std::fs::remove_file(database_path);
}

#[test]
fn desktop_command_history_uses_sanitized_dto_not_storage_payloads() {
    let database_path = std::env::temp_dir().join(format!(
        "nucleus-desktop-command-history-sanitized-test-{}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&database_path);
    let backend = SqliteBackend::new(database_path.clone());
    let handler = LocalControlRequestHandler::new(backend.clone(), None);
    write_command_evidence(
        handler.state(),
        &CommandEvidence {
            id: CommandEvidenceId("command:evidence:desktop-sanitized".to_owned()),
            request_id: CommandRequestId("command:request:desktop-sanitized".to_owned()),
            status: CommandExecutionStatus::Succeeded,
            exit_status: Some(0),
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("sanitized desktop command summary".to_owned()),
            stdout_artifact_ref: Some("artifact:stdout:desktop".to_owned()),
            stderr_artifact_ref: None,
        },
        RevisionId("rev:desktop-command-history:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write command evidence");
    let state = DesktopState {
        adapter: Arc::new(Mutex::new(TauriIpcControlCommandAdapter::fixture_backed(
            handler,
        ))),
        chat: Arc::new(Mutex::new(LocalCodexChatService::default())),
        server_state: ServerStateService::new(backend),
        startup_error: None,
        task_review_snapshot_store: None,
        terminal: Default::default(),
    };

    let response = state
        .submit_control_envelope(ControlRequestEnvelopeDto {
            protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
            protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
            request_id: "desktop-request-command-history-sanitized".to_owned(),
            client_id: "desktop-client".to_owned(),
            body: ControlRequestBodyDto::Query {
                query: ControlQueryDto::RuntimeMetadata {
                    query_id: "desktop-query-command-history-sanitized".to_owned(),
                    action: "list_command_evidence".to_owned(),
                },
            },
        })
        .expect("desktop command history should route through the server adapter");
    let json = serde_json::to_string(&response).expect("response json");

    assert!(matches!(
        response.body,
        nucleus_server::ControlResponseBodyDto::CommandEvidenceRecords { records }
            if records.len() == 1
                && records[0].evidence_id == "command:evidence:desktop-sanitized"
                && records[0].summary == Some("sanitized desktop command summary".to_owned())
                && records[0].stdout_artifact_ref == Some("artifact:stdout:desktop".to_owned())
    ));
    for forbidden in [
        "raw_stdout",
        "raw_stderr",
        "payload",
        "bytes",
        "revision_id",
        "storage",
        "terminal_stream",
        "environment",
        "credential",
    ] {
        assert!(
            !json.contains(forbidden),
            "desktop command history response should not contain {forbidden}"
        );
    }

    let _ = std::fs::remove_file(database_path);
}
