use nucleus_local_store::SqliteBackend;
use nucleus_server::{
    ControlQueryDto, ControlRequestBodyDto, ControlRequestEnvelopeDto, CONTROL_API_PROTOCOL_FAMILY,
    CONTROL_API_PROTOCOL_VERSION_V1,
};

use crate::DesktopState;

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
