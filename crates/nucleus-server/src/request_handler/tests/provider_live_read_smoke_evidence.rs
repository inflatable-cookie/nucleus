use nucleus_local_store::SqliteBackend;

use crate::{
    persist_provider_live_read_approved_smoke_evidence_records,
    provider_live_read_smoke_evidence_query::approved_provider_live_read_smoke_evidence_fixture,
    ClientId, LocalControlRequestHandler, ProviderLiveReadApprovedSmokeEvidencePersistenceInput,
    ProviderLiveReadSmokeEvidenceQuery, ServerControlRequest, ServerControlRequestId,
    ServerControlRequestKind, ServerControlResponseBody, ServerControlResponseStatus, ServerQuery,
    ServerQueryId, ServerQueryKind, ServerQueryResult,
};

#[test]
fn provider_live_read_smoke_evidence_query_reports_empty_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("db.sqlite"));
    let mut handler = LocalControlRequestHandler::new(backend, None);

    let response = handler.handle(request());

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    match response.body {
        ServerControlResponseBody::Query(
            ServerQueryResult::ProviderLiveReadSmokeEvidenceDiagnostics(diagnostics),
        ) => {
            assert_eq!(diagnostics.evidence_count, 0);
            assert_eq!(diagnostics.promoted_count, 0);
            assert!(!diagnostics.provider_write_executed);
            assert!(!diagnostics.raw_provider_payload_retained);
        }
        body => panic!("unexpected response body: {body:?}"),
    }
}

#[test]
fn provider_live_read_smoke_evidence_query_reports_persisted_state() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let backend = SqliteBackend::new(temp_dir.path().join("db.sqlite"));
    let mut handler = LocalControlRequestHandler::new(backend, None);
    persist_provider_live_read_approved_smoke_evidence_records(
        handler.state(),
        ProviderLiveReadApprovedSmokeEvidencePersistenceInput {
            evidence_records: vec![approved_provider_live_read_smoke_evidence_fixture()],
            persistence_evidence_refs: vec![
                "evidence:provider-live-read-approved-smoke-evidence-persistence".to_owned(),
            ],
            existing_persisted_evidence_ids: Vec::new(),
            provider_write_executed: false,
            callback_effect_executed: false,
            interruption_effect_executed: false,
            recovery_effect_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        },
    )
    .expect("persist evidence");

    let response = handler.handle(request());

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    match response.body {
        ServerControlResponseBody::Query(
            ServerQueryResult::ProviderLiveReadSmokeEvidenceDiagnostics(diagnostics),
        ) => {
            assert_eq!(diagnostics.evidence_count, 1);
            assert_eq!(diagnostics.promoted_count, 1);
            assert_eq!(diagnostics.provider_network_read_performed_count, 1);
            assert!(!diagnostics.provider_write_executed);
            assert!(!diagnostics.raw_provider_payload_retained);
        }
        body => panic!("unexpected response body: {body:?}"),
    }
}

fn request() -> ServerControlRequest {
    ServerControlRequest {
        id: ServerControlRequestId("request:provider-live-read-smoke-evidence".to_owned()),
        client_id: ClientId("client:test".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:provider-live-read-smoke-evidence".to_owned()),
            client_id: ClientId("client:test".to_owned()),
            kind: ServerQueryKind::ProviderLiveReadSmokeEvidence(
                ProviderLiveReadSmokeEvidenceQuery::Diagnostics,
            ),
        }),
    }
}
