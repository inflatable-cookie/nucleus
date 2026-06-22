use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ForgeNetworkExecutionOperationFamily,
    ForgePullRequestProvider, ForgeReadIntentProjectionEntry, ForgeReadIntentProjectionFamily,
    ForgeReadIntentProjectionSet, ForgeReadIntentProjectionStatus, ForgeReadIntentQueryResult,
    ForgeReadIntentQuerySourceCounts, ServerControlRequestId, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_provider_read_intent_without_effect_authority() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:provider-read-intent".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::ProviderReadIntent(
            read_intent_result(),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::ProviderReadIntent { result }
            if result.query_id == "forge-read-intent-query"
                && result.source_counts.credential_status_records == 1
                && result.projection.total_count == 1
                && result.projection.entries.len() == 1
                && result.projection.entries[0].family == "pull_request"
                && result.projection.entries[0].status == "ready"
                && result.projection.entries[0].forge_provider == Some("github".to_owned())
                && result.projection.entries[0].operation_family == "pull_request_refresh"
                && !result.provider_network_call_performed
                && !result.credential_resolution_performed
                && !result.raw_provider_payload_retained
    ));
    for forbidden in [
        "access_token",
        "authorization",
        "cookie",
        "raw_request_body",
        "raw_response_body",
        "provider_payload_bytes",
    ] {
        assert!(
            !json.contains(forbidden),
            "provider read-intent DTO should not contain {forbidden}"
        );
    }
}

fn read_intent_result() -> ForgeReadIntentQueryResult {
    let projection = ForgeReadIntentProjectionSet {
        projection_id: "forge-read-intent-projection".to_owned(),
        total_count: 1,
        credential_status_count: 0,
        repository_metadata_count: 0,
        pull_request_count: 1,
        ready_count: 1,
        duplicate_noop_count: 0,
        blocked_count: 0,
        repair_required_count: 0,
        blocker_count: 0,
        evidence_ref_count: 2,
        entries: vec![ForgeReadIntentProjectionEntry {
            intent_id: "intent:pull-request:1".to_owned(),
            source_persisted_refresh_id: "refresh:persisted:1".to_owned(),
            family: ForgeReadIntentProjectionFamily::PullRequest,
            status: ForgeReadIntentProjectionStatus::Ready,
            provider_context_ref: Some("provider-context:1".to_owned()),
            provider_instance_ref: Some("provider-instance:github".to_owned()),
            forge_provider: Some(ForgePullRequestProvider::GitHub),
            remote_repo_ref: Some("remote:origin".to_owned()),
            operation_family: ForgeNetworkExecutionOperationFamily::PullRequestRefresh,
            blocker_count: 0,
            evidence_ref_count: 2,
            duplicate_refresh_detected: false,
            stopped_refresh_recorded: true,
            credential_resolution_performed: false,
            provider_network_call_performed: false,
            provider_effect_executed: false,
            callback_effect_executed: false,
            interruption_effect_executed: false,
            recovery_effect_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        }],
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    };
    let source_counts = ForgeReadIntentQuerySourceCounts {
        credential_status_records: 1,
        repository_metadata_records: 1,
        pull_request_records: 1,
    };

    ForgeReadIntentQueryResult {
        query_id: "forge-read-intent-query".to_owned(),
        projection,
        source_counts,
        control: crate::ForgeReadIntentQueryControlDto {
            dto_id: "forge-read-intent-query-control-dto".to_owned(),
            projection_control: crate::ForgeReadIntentProjectionControlDto {
                dto_id: "forge-read-intent-projection-control-dto".to_owned(),
                projection_id: "forge-read-intent-projection".to_owned(),
                total_count: 1,
                credential_status_count: 0,
                repository_metadata_count: 0,
                pull_request_count: 1,
                ready_count: 1,
                duplicate_noop_count: 0,
                blocked_count: 0,
                repair_required_count: 0,
                blocker_count: 0,
                evidence_ref_count: 2,
                credential_resolution_performed: false,
                provider_network_call_performed: false,
                provider_effect_executed: false,
                callback_effect_executed: false,
                interruption_effect_executed: false,
                recovery_effect_executed: false,
                task_mutation_executed: false,
                raw_provider_payload_retained: false,
            },
            source_counts,
            credential_resolution_performed: false,
            provider_network_call_performed: false,
            provider_effect_executed: false,
            callback_effect_executed: false,
            interruption_effect_executed: false,
            recovery_effect_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        },
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}
