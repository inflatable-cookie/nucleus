mod support;

use super::*;
use crate::ServerStateService;
use nucleus_local_store::SqliteBackend;
use support::*;

#[test]
fn read_intent_query_composes_projection_from_local_store_records() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let db = temp_dir.path().join("nucleus.sqlite");
    let state = ServerStateService::new(SqliteBackend::new(db));
    persist_sources(&state);

    let result = query_forge_read_intent_projection(&state).expect("query projection");

    assert_eq!(result.source_counts.credential_status_records, 1);
    assert_eq!(result.source_counts.repository_metadata_records, 1);
    assert_eq!(result.source_counts.pull_request_records, 1);
    assert_eq!(result.source_counts.status_check_records, 1);
    assert_eq!(result.projection.total_count, 4);
    assert_eq!(result.projection.ready_count, 4);
    assert_eq!(result.projection.status_check_count, 1);
    assert_eq!(result.control.projection_control.total_count, 4);
    assert!(!result.provider_network_call_performed);
    assert!(!result.credential_resolution_performed);
}

#[test]
fn read_intent_query_returns_empty_projection_when_store_has_no_sources() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));

    let result = query_forge_read_intent_projection(&state).expect("query empty projection");

    assert_eq!(result.projection.total_count, 0);
    assert_eq!(result.control.projection_control.total_count, 0);
    assert_eq!(result.source_counts.credential_status_records, 0);
    assert_eq!(result.source_counts.status_check_records, 0);
    assert!(!result.raw_provider_payload_retained);
}

#[test]
fn read_intent_query_control_dto_serializes_sanitized_counts() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    persist_sources(&state);

    let result = query_forge_read_intent_projection(&state).expect("query projection");
    let json = serde_json::to_string(&result.control).expect("serialize control");

    assert_eq!(result.control.projection_control.total_count, 4);
    assert!(!result.control.provider_effect_executed);
    assert!(!result.control.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
}
