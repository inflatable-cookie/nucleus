use super::super::*;
use crate::{ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider};

pub(super) fn executor_input(forbidden: bool) -> ProviderLiveReadServerRequestInput {
    let target = provider_live_read_smoke_target(ProviderLiveReadSmokeTargetInput {
        smoke_target_ref: "github:octocat/Hello-World:repository-metadata".to_owned(),
        provider_family_ref: Some("provider-family:github".to_owned()),
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("octocat/Hello-World".to_owned()),
        operation_family: ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh,
        target_refs: vec!["repository:github:octocat/Hello-World".to_owned()],
        local_evidence_refs: vec!["evidence:provider-live-read-smoke".to_owned()],
        smoke_target_evidence_ref: Some("evidence:live-read-smoke-target".to_owned()),
        provider_network_call_requested: false,
        provider_write_requested: false,
        task_mutation_requested: false,
        raw_provider_payload_retention_requested: false,
    });
    let checklist = provider_live_read_smoke_authority_checklist(
        ProviderLiveReadSmokeAuthorityChecklistInput {
            target: target.clone(),
            credential_lease_ref: Some("credential-lease:github:read-only".to_owned()),
            network_read_authority_ref: Some("network-authority:github-read".to_owned()),
            payload_policy_ref: Some("payload-policy:sanitized-summary-only".to_owned()),
            sanitization_policy_ref: Some("sanitize:provider-live-read".to_owned()),
            retention_policy_ref: Some("retention:no-raw-provider-payload".to_owned()),
            operator_approval_ref: Some("approval:operator:live-read-smoke".to_owned()),
            checklist_evidence_ref: Some("evidence:live-read-smoke-checklist".to_owned()),
            credential_material_present: false,
            provider_network_call_requested: false,
            provider_write_requested: false,
            task_mutation_requested: false,
            raw_provider_payload_retention_requested: false,
        },
    );
    let smoke_request = provider_live_read_smoke_request(ProviderLiveReadSmokeRequestInput {
        checklist: checklist.clone(),
        stopped_handoff_ref: Some("handoff:provider-live-read:github:repo-metadata".to_owned()),
        fixture_response_ref: Some("fixture-response:provider-live-read:github:repo".to_owned()),
        smoke_request_evidence_ref: Some("evidence:live-read-smoke-request".to_owned()),
        existing_smoke_request_ids: Vec::new(),
        provider_network_call_requested: false,
        credential_material_present: false,
        provider_write_requested: false,
        task_mutation_requested: false,
        raw_provider_payload_retention_requested: false,
    });

    ProviderLiveReadServerRequestInput {
        smoke_target: target,
        checklist,
        smoke_request,
        executor_authority_ref: Some("executor-authority:provider-live-read:github".to_owned()),
        command_descriptor_ref: Some("command-descriptor:gh-repo-view".to_owned()),
        output_evidence_ref: Some("evidence:provider-live-read-output".to_owned()),
        receipt_evidence_ref: Some("evidence:provider-live-read-receipt".to_owned()),
        existing_executor_request_ids: Vec::new(),
        credential_material_present: forbidden,
        provider_write_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

pub(super) fn receipt_input(
    request: ProviderLiveReadServerRequestRecord,
    descriptor: ProviderLiveReadGhCommandDescriptorRecord,
    output: ProviderLiveReadSanitizedRepositoryMetadataRecord,
    provider_network_call_performed: bool,
    forbidden: bool,
) -> ProviderLiveReadServerReceiptInput {
    ProviderLiveReadServerReceiptInput {
        request,
        descriptor,
        output,
        provider_exit_code: Some(0),
        receipt_evidence_ref: Some("evidence:provider-live-read-server-receipt".to_owned()),
        provider_network_call_performed,
        provider_write_executed: forbidden,
        callback_effect_executed: forbidden,
        interruption_effect_executed: forbidden,
        recovery_effect_executed: forbidden,
        task_mutation_executed: forbidden,
        raw_provider_payload_retained: forbidden,
    }
}

pub(super) fn command_handoff_input(
    descriptor: ProviderLiveReadGhCommandDescriptorRecord,
    forbidden: bool,
) -> ProviderLiveReadCommandHandoffInput {
    ProviderLiveReadCommandHandoffInput {
        descriptor,
        command_handoff_ref: Some("command-handoff:provider-live-read:gh-repo-view".to_owned()),
        working_directory_hint: Some("/tmp/nucleus-provider-live-read".to_owned()),
        timeout_ms: Some(30_000),
        stdout_limit_bytes: Some(16_384),
        stderr_limit_bytes: Some(4_096),
        existing_handoff_ids: Vec::new(),
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

pub(super) fn command_mapping_input(
    request: ProviderLiveReadServerRequestRecord,
    descriptor: ProviderLiveReadGhCommandDescriptorRecord,
    handoff: ProviderLiveReadCommandHandoffRecord,
    command_stdout_json: String,
    command_succeeded: bool,
    forbidden: bool,
) -> ProviderLiveReadCommandResultMappingInput {
    ProviderLiveReadCommandResultMappingInput {
        request,
        descriptor,
        handoff,
        command_stdout_json,
        command_exit_status: if command_succeeded { Some(0) } else { Some(1) },
        command_succeeded,
        receipt_evidence_ref: Some("evidence:provider-live-read-command-receipt".to_owned()),
        provider_write_executed: forbidden,
        callback_effect_executed: forbidden,
        interruption_effect_executed: forbidden,
        recovery_effect_executed: forbidden,
        task_mutation_executed: forbidden,
        raw_provider_payload_retained: forbidden,
    }
}

pub(super) fn repository_metadata_json() -> &'static str {
    r#"{
        "nameWithOwner":"octocat/Hello-World",
        "defaultBranchRef":{"name":"main"},
        "isPrivate":false,
        "visibility":"PUBLIC",
        "url":"https://github.com/octocat/Hello-World",
        "viewerPermission":"ADMIN",
        "pushedAt":"2026-06-22T14:48:36Z",
        "updatedAt":"2026-06-22T14:50:05Z",
        "authorization":"redacted-in-source-fixture",
        "raw_response_body":"redacted-in-source-fixture"
    }"#
}

pub(super) fn assert_sanitized_json(json: &str) {
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_request_body"));
    assert!(!json.contains("raw_response_body"));
}
