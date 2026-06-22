use crate::{
    ControlResponseBodyDto, ControlResponseEnvelopeDto, ForgeNetworkExecutionOperationFamily,
    ForgePullRequestProvider, ForgeReadIntentProjectionFamily, ForgeReadinessOverview,
    ForgeReadinessOverviewStatus, ServerControlRequestId, ServerControlResponse,
    ServerControlResponseBody, ServerControlResponseStatus, ServerQueryResult,
};

#[test]
fn response_envelope_dto_serializes_provider_readiness_overview_without_effect_authority() {
    let response = ServerControlResponse {
        request_id: ServerControlRequestId("request:dto:provider-readiness-overview".to_owned()),
        status: ServerControlResponseStatus::Complete,
        body: ServerControlResponseBody::Query(ServerQueryResult::ProviderReadinessOverview(
            readiness_overview(),
        )),
    };

    let dto = ControlResponseEnvelopeDto::try_from(&response).expect("response dto");
    let json = serde_json::to_string(&dto).expect("json");

    assert!(matches!(
        dto.body,
        ControlResponseBodyDto::ProviderReadinessOverview { overview }
            if overview.overview_id == "forge-readiness-overview"
                && overview.status == "ready"
                && overview.supported_read_families == vec![
                    "credential_status".to_owned(),
                    "repository_metadata".to_owned(),
                    "pull_request".to_owned(),
                    "status_check".to_owned(),
                ]
                && overview.represented_mutating_families == vec![
                    "pull_request_create".to_owned()
                ]
                && overview.forge_providers == vec!["github".to_owned()]
                && overview.blocker_count == 0
                && overview.evidence_ref_count == 3
                && !overview.provider_network_call_performed
                && !overview.credential_resolution_performed
                && !overview.raw_provider_payload_retained
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
            "provider readiness overview DTO should not contain {forbidden}"
        );
    }
}

fn readiness_overview() -> ForgeReadinessOverview {
    ForgeReadinessOverview {
        overview_id: "forge-readiness-overview".to_owned(),
        projection_id: "forge-read-intent-projection".to_owned(),
        project_ref: Some("project:nucleus".to_owned()),
        repo_ref: Some("repo:nucleus".to_owned()),
        authority_host_ref: Some("host:local".to_owned()),
        provider_instance_refs: vec!["provider-instance:github".to_owned()],
        remote_repo_refs: vec!["remote:origin".to_owned()],
        forge_providers: vec![ForgePullRequestProvider::GitHub],
        status: ForgeReadinessOverviewStatus::Ready,
        supported_read_families: vec![
            ForgeReadIntentProjectionFamily::CredentialStatus,
            ForgeReadIntentProjectionFamily::RepositoryMetadata,
            ForgeReadIntentProjectionFamily::PullRequest,
            ForgeReadIntentProjectionFamily::StatusCheck,
        ],
        represented_read_families: vec![
            ForgeReadIntentProjectionFamily::CredentialStatus,
            ForgeReadIntentProjectionFamily::RepositoryMetadata,
            ForgeReadIntentProjectionFamily::PullRequest,
            ForgeReadIntentProjectionFamily::StatusCheck,
        ],
        represented_mutating_families: vec![
            ForgeNetworkExecutionOperationFamily::PullRequestCreate,
        ],
        total_read_intent_count: 3,
        missing_evidence_family_count: 0,
        ready_count: 3,
        blocked_count: 0,
        repair_required_count: 0,
        duplicate_noop_count: 0,
        blocker_count: 0,
        evidence_ref_count: 3,
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
