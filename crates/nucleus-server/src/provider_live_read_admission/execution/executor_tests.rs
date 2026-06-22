use super::*;
use support::*;

mod command_handoff;
mod support;

#[test]
fn executor_request_derives_from_approved_smoke_request_without_effects() {
    let request = provider_live_read_executor_request(executor_input(false));
    let json = serde_json::to_string(&request).expect("serialize executor request");

    assert_eq!(
        request.status,
        ProviderLiveReadServerRequestStatus::ReadyForCommandDescriptor
    );
    assert_eq!(
        request.operator_approval_ref,
        Some("approval:operator:live-read-smoke".to_owned())
    );
    assert_eq!(
        request.network_read_authority_ref,
        Some("network-authority:github-read".to_owned())
    );
    assert_eq!(
        request.remote_repo_ref,
        Some("octocat/Hello-World".to_owned())
    );
    assert_eq!(
        request.operation_family,
        crate::ForgeNetworkExecutionOperationFamily::RepositoryMetadataRefresh
    );
    assert!(!request.provider_network_call_performed);
    assert!(!request.provider_write_executed);
    assert!(!request.task_mutation_executed);
    assert!(!request.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn executor_request_blocks_forbidden_effects() {
    let request = provider_live_read_executor_request(executor_input(true));

    assert_eq!(request.status, ProviderLiveReadServerRequestStatus::Blocked);
    assert!(request
        .blockers
        .contains(&ProviderLiveReadServerRequestBlocker::CredentialMaterialPresent));
    assert!(request
        .blockers
        .contains(&ProviderLiveReadServerRequestBlocker::ProviderWriteRequested));
    assert!(request
        .blockers
        .contains(&ProviderLiveReadServerRequestBlocker::TaskMutationRequested));
    assert!(request
        .blockers
        .contains(&ProviderLiveReadServerRequestBlocker::RawProviderPayloadRetentionRequested));
    assert!(!request.provider_write_executed);
    assert!(!request.raw_provider_payload_retained);
}

#[test]
fn gh_descriptor_is_field_limited_and_read_only() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let json = serde_json::to_string(&descriptor).expect("serialize descriptor");

    assert_eq!(
        descriptor.status,
        ProviderLiveReadGhCommandDescriptorStatus::ReadyForReadOnlySpawn
    );
    assert_eq!(descriptor.executable, "gh");
    assert_eq!(
        descriptor.args,
        vec![
            "repo",
            "view",
            "octocat/Hello-World",
            "--json",
            "nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt",
        ]
    );
    assert_eq!(descriptor.json_fields.len(), 8);
    assert!(descriptor
        .expected_sanitized_fields
        .contains(&"viewer_permission".to_owned()));
    assert!(!descriptor.provider_write_executed);
    assert!(!descriptor.task_mutation_executed);
    assert_sanitized_json(&json);
}

#[test]
fn sanitized_output_keeps_selected_repository_metadata_only() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let output = provider_live_read_sanitized_repository_metadata_output(
        &descriptor,
        repository_metadata_json(),
    );
    let json = serde_json::to_string(&output).expect("serialize output");

    assert_eq!(
        output.status,
        ProviderLiveReadSanitizedRepositoryMetadataStatus::Sanitized
    );
    assert_eq!(
        output.name_with_owner,
        Some("octocat/Hello-World".to_owned())
    );
    assert_eq!(output.default_branch, Some("main".to_owned()));
    assert_eq!(output.is_private, Some(false));
    assert_eq!(output.visibility, Some("PUBLIC".to_owned()));
    assert_eq!(output.viewer_permission, Some("ADMIN".to_owned()));
    assert_eq!(output.pushed_at, Some("2026-06-22T14:48:36Z".to_owned()));
    assert_eq!(output.updated_at, Some("2026-06-22T14:50:05Z".to_owned()));
    assert!(output.provider_network_call_performed);
    assert!(!output.provider_write_executed);
    assert!(!output.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn parse_errors_are_sanitized_blocker_records() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let output = provider_live_read_sanitized_repository_metadata_output(&descriptor, "{broken");
    let json = serde_json::to_string(&output).expect("serialize parse error");

    assert_eq!(
        output.status,
        ProviderLiveReadSanitizedRepositoryMetadataStatus::ParseError
    );
    assert!(output
        .blockers
        .contains(&ProviderLiveReadRepositoryMetadataParseBlocker::JsonParseFailed));
    assert!(output.name_with_owner.is_none());
    assert!(output.provider_network_call_performed);
    assert!(!output.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn server_receipt_records_performed_read_without_write_effects() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let output = provider_live_read_sanitized_repository_metadata_output(
        &descriptor,
        repository_metadata_json(),
    );
    let receipt = provider_live_read_server_receipt(receipt_input(
        request.clone(),
        descriptor.clone(),
        output.clone(),
        true,
        false,
    ));
    let diagnostics = provider_live_read_server_executor_diagnostics(
        vec![request],
        vec![descriptor],
        vec![output],
        vec![receipt.clone()],
    );
    let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

    assert_eq!(
        receipt.status,
        ProviderLiveReadServerReceiptStatus::ProviderReadPerformed
    );
    assert!(receipt.provider_network_call_performed);
    assert!(!receipt.provider_write_executed);
    assert_eq!(diagnostics.ready_request_count, 1);
    assert_eq!(diagnostics.descriptor_ready_count, 1);
    assert_eq!(diagnostics.sanitized_output_count, 1);
    assert_eq!(diagnostics.parse_error_count, 0);
    assert_eq!(diagnostics.provider_network_read_performed_count, 1);
    assert_eq!(diagnostics.blocker_count, 0);
    assert!(!diagnostics.provider_write_executed);
    assert!(!diagnostics.task_mutation_executed);
    assert!(!diagnostics.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn receipt_blocks_when_read_was_not_performed_or_effects_occurred() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let output = provider_live_read_sanitized_repository_metadata_output(
        &descriptor,
        repository_metadata_json(),
    );
    let receipt =
        provider_live_read_server_receipt(receipt_input(request, descriptor, output, false, true));

    assert_eq!(receipt.status, ProviderLiveReadServerReceiptStatus::Blocked);
    assert!(receipt
        .blockers
        .contains(&ProviderLiveReadServerReceiptBlocker::ProviderNetworkReadNotPerformed));
    assert!(receipt
        .blockers
        .contains(&ProviderLiveReadServerReceiptBlocker::ProviderWriteExecuted));
    assert!(receipt
        .blockers
        .contains(&ProviderLiveReadServerReceiptBlocker::TaskMutationExecuted));
    assert!(receipt
        .blockers
        .contains(&ProviderLiveReadServerReceiptBlocker::RawProviderPayloadRetained));
}
