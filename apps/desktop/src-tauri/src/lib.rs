use std::path::PathBuf;
use std::sync::Mutex;

use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    seed_local_project, ControlApiCodecError, ControlRequestEnvelopeDto,
    ControlResponseEnvelopeDto, LocalControlRequestHandler, LocalProjectSeed,
    TauriIpcControlCommandAdapter,
};

struct DesktopState {
    adapter: Mutex<TauriIpcControlCommandAdapter<SqliteBackend>>,
}

impl DesktopState {
    fn new(backend: SqliteBackend) -> Self {
        let handler = LocalControlRequestHandler::new(backend, None);
        seed_local_project(handler.state(), LocalProjectSeed::nucleus_local())
            .expect("local desktop project seed should be writable");
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
}
