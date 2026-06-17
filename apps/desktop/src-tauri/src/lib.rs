use std::path::PathBuf;
use std::sync::Mutex;

use nucleus_command_policy::{
    CommandEvidence, CommandEvidenceId, CommandExecutionStatus, CommandOutputRetention,
    CommandRequestId,
};
use nucleus_core::RevisionId;
use nucleus_local_store::{RevisionExpectation, SqliteBackend};
use nucleus_server::{
    seed_local_project, seed_local_task, write_command_evidence, ControlApiCodecError,
    ControlRequestEnvelopeDto, ControlResponseEnvelopeDto, LocalControlRequestHandler,
    LocalProjectSeed, LocalTaskSeed, TauriIpcControlCommandAdapter,
};

struct DesktopState {
    adapter: Mutex<TauriIpcControlCommandAdapter<SqliteBackend>>,
}

impl DesktopState {
    fn new(backend: SqliteBackend) -> Self {
        let handler = LocalControlRequestHandler::new(backend, None);
        seed_local_project(handler.state(), LocalProjectSeed::nucleus_local())
            .expect("local desktop project seed should be writable");
        seed_local_task(handler.state(), LocalTaskSeed::nucleus_local_bootstrap())
            .expect("local desktop task seed should be writable");
        seed_local_command_evidence(handler.state())
            .expect("local desktop command evidence seed should be writable");
        let adapter = TauriIpcControlCommandAdapter::fixture_backed(handler);

        Self {
            adapter: Mutex::new(adapter),
        }
    }

    fn submit_control_envelope(
        &self,
        request: ControlRequestEnvelopeDto,
    ) -> Result<ControlResponseEnvelopeDto, ControlApiCodecError> {
        let mut adapter = self.adapter.lock().map_err(|_| ControlApiCodecError {
            failure: nucleus_server::ControlApiCodecFailure::ServerErrorPayload,
            reason: "desktop command adapter lock is poisoned".to_owned(),
        })?;

        adapter.submit_control_envelope(request)
    }
}

fn seed_local_command_evidence(
    state: &nucleus_server::ServerStateService<SqliteBackend>,
) -> nucleus_local_store::LocalStoreResult<nucleus_local_store::LocalStoreRecord> {
    write_command_evidence(
        state,
        &CommandEvidence {
            id: CommandEvidenceId("command:evidence:nucleus-local:bootstrap".to_owned()),
            request_id: CommandRequestId("command:request:nucleus-local:bootstrap".to_owned()),
            status: CommandExecutionStatus::Succeeded,
            exit_status: Some(0),
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("desktop bootstrap command evidence seed".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        },
        RevisionId("rev:command-evidence:nucleus-local:bootstrap".to_owned()),
        RevisionExpectation::Any,
    )
}

#[tauri::command]
fn submit_control_envelope(
    state: tauri::State<'_, DesktopState>,
    request: ControlRequestEnvelopeDto,
) -> Result<ControlResponseEnvelopeDto, ControlApiCodecError> {
    state.submit_control_envelope(request)
}

pub fn run() {
    tauri::Builder::default()
        .manage(DesktopState::new(SqliteBackend::new(
            desktop_database_path(),
        )))
        .invoke_handler(tauri::generate_handler![submit_control_envelope])
        .run(tauri::generate_context!())
        .expect("failed to run nucleus desktop");
}

fn desktop_database_path() -> PathBuf {
    std::env::temp_dir().join("nucleus-desktop.sqlite")
}

#[cfg(test)]
mod tests {
    use nucleus_server::{
        ControlQueryDto, ControlRequestBodyDto, ControlRequestEnvelopeDto,
        CONTROL_API_PROTOCOL_FAMILY, CONTROL_API_PROTOCOL_VERSION_V1,
    };

    use super::*;

    #[test]
    fn desktop_state_invokes_serialized_control_command() {
        let database_path = std::env::temp_dir().join(format!(
            "nucleus-desktop-test-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&database_path);
        let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

        let response = state
            .submit_control_envelope(ControlRequestEnvelopeDto {
                protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
                protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
                request_id: "desktop-request-1".to_owned(),
                client_id: "desktop-client".to_owned(),
                body: ControlRequestBodyDto::Query {
                    query: ControlQueryDto::RuntimeMetadata {
                        query_id: "desktop-query-1".to_owned(),
                        action: "list_artifact_metadata".to_owned(),
                    },
                },
            })
            .expect("desktop command should route through the server adapter");

        assert_eq!(response.request_id, "desktop-request-1");
        assert_eq!(
            response.status,
            nucleus_server::ControlResponseStatusDto::Complete
        );

        let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn desktop_state_seeds_local_project_for_project_queries() {
        let database_path = std::env::temp_dir().join(format!(
            "nucleus-desktop-project-seed-test-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&database_path);
        let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

        let response = state
            .submit_control_envelope(ControlRequestEnvelopeDto {
                protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
                protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
                request_id: "desktop-request-projects".to_owned(),
                client_id: "desktop-client".to_owned(),
                body: ControlRequestBodyDto::Query {
                    query: ControlQueryDto::State {
                        query_id: "desktop-query-projects".to_owned(),
                        domain: nucleus_server::ControlStateDomainDto::Projects,
                        scope: nucleus_server::ControlQueryScopeDto::List,
                    },
                },
            })
            .expect("desktop project list should route through the server adapter");

        assert!(matches!(
            response.body,
            nucleus_server::ControlResponseBodyDto::ProjectRecords { records }
                if records.len() == 1 && records[0].display_name == "Nucleus Local"
        ));

        let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn desktop_state_seeds_local_task_for_task_queries() {
        let database_path = std::env::temp_dir().join(format!(
            "nucleus-desktop-task-seed-test-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&database_path);
        let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

        let response = state
            .submit_control_envelope(ControlRequestEnvelopeDto {
                protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
                protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
                request_id: "desktop-request-tasks".to_owned(),
                client_id: "desktop-client".to_owned(),
                body: ControlRequestBodyDto::Query {
                    query: ControlQueryDto::State {
                        query_id: "desktop-query-tasks".to_owned(),
                        domain: nucleus_server::ControlStateDomainDto::Tasks,
                        scope: nucleus_server::ControlQueryScopeDto::List,
                    },
                },
            })
            .expect("desktop task list should route through the server adapter");

        assert!(matches!(
            response.body,
            nucleus_server::ControlResponseBodyDto::TaskRecords { records }
                if records.len() == 1
                    && records[0].task_id == "task:nucleus-local:bootstrap"
                    && records[0].project_id == "project:nucleus-local"
        ));

        let _ = std::fs::remove_file(database_path);
    }

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
        let handler =
            LocalControlRequestHandler::new(SqliteBackend::new(database_path.clone()), None);
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
            adapter: Mutex::new(TauriIpcControlCommandAdapter::fixture_backed(handler)),
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

    #[test]
    fn desktop_state_routes_runtime_readiness_query_to_typed_dto() {
        let database_path = std::env::temp_dir().join(format!(
            "nucleus-desktop-runtime-readiness-test-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&database_path);
        let state = DesktopState::new(SqliteBackend::new(database_path.clone()));

        let response = state
            .submit_control_envelope(ControlRequestEnvelopeDto {
                protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
                protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
                request_id: "desktop-request-runtime-readiness".to_owned(),
                client_id: "desktop-client".to_owned(),
                body: ControlRequestBodyDto::Query {
                    query: ControlQueryDto::RuntimeMetadata {
                        query_id: "desktop-query-runtime-readiness".to_owned(),
                        action: "get_local_runtime_readiness".to_owned(),
                    },
                },
            })
            .expect("desktop runtime readiness should route through the server adapter");
        let json = serde_json::to_string(&response).expect("response json");

        assert!(matches!(
            response.body,
            nucleus_server::ControlResponseBodyDto::RuntimeReadinessDiagnostics { records }
                if records.len() == 1
                    && records[0].host_id == "host:local"
                    && records[0].status == "unsupported"
                    && records[0].blockers.iter().any(|blocker| blocker.code == "process_control_backend_unsupported")
        ));
        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "payload",
            "bytes",
            "credential",
            "secret",
            "environment",
        ] {
            assert!(
                !json.contains(forbidden),
                "runtime readiness response should not contain {forbidden}"
            );
        }

        let _ = std::fs::remove_file(database_path);
    }

    #[test]
    fn command_diagnostics_panel_has_no_forbidden_command_controls() {
        let component = include_str!("../../src/lib/CommandDiagnosticsPanel.svelte");

        for forbidden in [
            "buildStartTaskCommand",
            "buildBlockTaskCommand",
            "buildCompleteTaskCommand",
            "buildArchiveTaskCommand",
            "submitControlEnvelope",
            "approve",
            "cancel",
            "retry",
            "download",
            "pty",
            "stream",
        ] {
            assert!(
                !component.to_lowercase().contains(&forbidden.to_lowercase()),
                "command diagnostics panel should not expose {forbidden}"
            );
        }
        assert!(component.contains("queryCommandHistory"));
        assert!(component.contains("No execution controls."));
    }

    #[test]
    fn runtime_readiness_panel_has_no_forbidden_runtime_controls() {
        let component = include_str!("../../src/lib/RuntimeReadinessPanel.svelte");

        for forbidden in [
            "buildStartTaskCommand",
            "buildBlockTaskCommand",
            "buildCompleteTaskCommand",
            "buildArchiveTaskCommand",
            "submitControlEnvelope",
            "approve",
            "cancel",
            "retry",
            "execute",
            "repair runtime",
            "runtime repair",
            "repair control",
            "download",
            "pty",
            "stream",
        ] {
            assert!(
                !component.to_lowercase().contains(&forbidden.to_lowercase()),
                "runtime readiness panel should not expose {forbidden}"
            );
        }
        assert!(component.contains("queryRuntimeReadiness"));
        assert!(component.contains("Read-only diagnostics."));
    }
}
