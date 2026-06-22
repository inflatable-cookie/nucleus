use super::*;

#[test]
fn handler_exposes_provider_readiness_overview_without_provider_effects() {
    let (_temp_dir, mut handler) = handler(None);

    let response = handler.handle(ServerControlRequest {
        id: ServerControlRequestId("request:provider-readiness-overview".to_owned()),
        client_id: ClientId("client:desktop".to_owned()),
        kind: ServerControlRequestKind::Query(ServerQuery {
            id: ServerQueryId("query:provider-readiness-overview".to_owned()),
            client_id: ClientId("client:desktop".to_owned()),
            kind: ServerQueryKind::ProviderReadinessOverview(
                ProviderReadinessOverviewQuery::Overview,
            ),
        }),
    });

    assert_eq!(response.status, ServerControlResponseStatus::Complete);
    assert!(matches!(
        response.body,
        ServerControlResponseBody::Query(ServerQueryResult::ProviderReadinessOverview(overview))
            if overview.total_read_intent_count == 0
                && overview.status == crate::ForgeReadinessOverviewStatus::Unknown
                && overview.missing_evidence_family_count == 4
                && !overview.provider_network_call_performed
                && !overview.credential_resolution_performed
                && !overview.raw_provider_payload_retained
    ));
}
