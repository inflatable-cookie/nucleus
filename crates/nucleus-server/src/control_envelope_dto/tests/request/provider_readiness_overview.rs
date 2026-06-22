use super::*;

#[test]
fn provider_readiness_overview_query_vocabulary_round_trips_overview_action() {
    let request = ServerControlRequest {
        id: ServerControlRequestId("request:dto:provider-readiness-overview".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:dto:provider-readiness-overview".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProviderReadinessOverview(
                ProviderReadinessOverviewQuery::Overview,
            ),
        }),
    };

    let dto = ControlRequestEnvelopeDto::try_from(&request).expect("request dto");
    let json = serde_json::to_string(&dto).expect("json");
    let decoded: ControlRequestEnvelopeDto = serde_json::from_str(&json).expect("decoded dto");
    let restored = ServerControlRequest::try_from(decoded).expect("restored request");

    assert!(json.contains("\"kind\":\"provider_readiness_overview\""));
    assert!(json.contains("\"action\":\"overview\""));
    assert!(matches!(
        restored.kind,
        ServerControlRequestKind::Query(ServerQuery {
            kind: ServerQueryKind::ProviderReadinessOverview(
                ProviderReadinessOverviewQuery::Overview
            ),
            ..
        })
    ));
}

#[test]
fn provider_readiness_overview_query_rejects_unknown_action() {
    let dto = ControlRequestEnvelopeDto {
        protocol_family: CONTROL_API_PROTOCOL_FAMILY.to_owned(),
        protocol_version: CONTROL_API_PROTOCOL_VERSION_V1,
        request_id: "request:dto:provider-readiness-overview:unsupported".to_owned(),
        client_id: "client:desktop".to_owned(),
        body: ControlRequestBodyDto::Query {
            query: ControlQueryDto::ProviderReadinessOverview {
                query_id: "query:dto:provider-readiness-overview:unsupported".to_owned(),
                action: "refresh_live_provider".to_owned(),
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
        .contains("unsupported provider readiness overview"));
}
