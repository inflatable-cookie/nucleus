use super::*;

#[test]
fn provider_live_read_smoke_evidence_query_round_trips_diagnostics_action() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:provider-live-read-smoke-evidence".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:provider-live-read-smoke-evidence".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProviderLiveReadSmokeEvidence(
                ProviderLiveReadSmokeEvidenceQuery::Diagnostics,
            ),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"kind\":\"provider_live_read_smoke_evidence\""));
    assert!(json.contains("\"action\":\"diagnostics\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::ProviderLiveReadSmokeEvidence(
                ProviderLiveReadSmokeEvidenceQuery::Diagnostics
            ),
            ..
        })
    ));
}

#[test]
fn provider_live_read_smoke_evidence_query_rejects_execute_action() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:dto:provider-live-read-smoke-evidence:unsupported".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::ProviderLiveReadSmokeEvidence {
                query_id: "query:dto:provider-live-read-smoke-evidence:unsupported".to_owned(),
                action: "execute_live_provider_read".to_owned(),
            },
        },
    };

    let error = ServerControlRequest::try_from(dto).expect_err("unsupported action");

    assert_eq!(
        error.failure,
        ControlApiCodecFailure::UnsupportedPayloadShape
    );
    assert!(error
        .reason
        .contains("unsupported provider live-read smoke evidence"));
}
