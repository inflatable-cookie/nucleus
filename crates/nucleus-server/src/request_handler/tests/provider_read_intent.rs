use super::*;

#[test]
fn handler_exposes_provider_read_intent_query_without_provider_effects() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:provider-read-intent".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:provider-read-intent".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProviderReadIntent(ProviderReadIntentQuery::Projection),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::ProviderReadIntent(result))
            if result.projection.total_count == 0
                && !result.provider_network_call_performed
                && !result.credential_resolution_performed
                && !result.raw_provider_payload_retained
    ));
}
