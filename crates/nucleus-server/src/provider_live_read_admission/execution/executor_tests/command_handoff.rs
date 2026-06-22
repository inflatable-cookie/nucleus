use super::super::*;
use super::support::*;

#[test]
fn command_handoff_records_ready_read_only_descriptor_without_effects() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let handoff = provider_live_read_command_handoff(command_handoff_input(descriptor, false));
    let json = serde_json::to_string(&handoff).expect("serialize handoff");

    assert_eq!(
        handoff.status,
        ProviderLiveReadCommandHandoffStatus::ReadyForReadOnlyCommand
    );
    assert_eq!(handoff.executable, "gh");
    assert_eq!(handoff.argv[0], "repo");
    assert_eq!(
        handoff.command_handoff_ref,
        Some("command-handoff:provider-live-read:gh-repo-view".to_owned())
    );
    assert!(!handoff.provider_network_call_performed);
    assert!(!handoff.provider_write_executed);
    assert!(!handoff.task_mutation_executed);
    assert!(!handoff.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn command_handoff_blocks_provider_write_task_mutation_and_raw_payload_retention() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let handoff = provider_live_read_command_handoff(command_handoff_input(descriptor, true));

    assert_eq!(
        handoff.status,
        ProviderLiveReadCommandHandoffStatus::Blocked
    );
    assert!(handoff
        .blockers
        .contains(&ProviderLiveReadCommandHandoffBlocker::ProviderWriteRequested));
    assert!(handoff
        .blockers
        .contains(&ProviderLiveReadCommandHandoffBlocker::TaskMutationRequested));
    assert!(handoff
        .blockers
        .contains(&ProviderLiveReadCommandHandoffBlocker::RawProviderPayloadRetentionRequested));
    assert!(!handoff.provider_write_executed);
    assert!(!handoff.raw_provider_payload_retained);
}

#[test]
fn command_result_mapping_feeds_sanitized_stdout_into_output_and_receipt_records() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let handoff =
        provider_live_read_command_handoff(command_handoff_input(descriptor.clone(), false));
    let mapping = provider_live_read_command_result_mapping(command_mapping_input(
        request,
        descriptor,
        handoff,
        repository_metadata_json().to_owned(),
        true,
        false,
    ));
    let diagnostics =
        provider_live_read_command_handoff_diagnostics(Vec::new(), vec![mapping.clone()]);
    let json = serde_json::to_string(&mapping).expect("serialize mapping");

    assert_eq!(
        mapping.status,
        ProviderLiveReadCommandResultMappingStatus::MappedSanitizedOutput
    );
    assert_eq!(
        mapping.output.status,
        ProviderLiveReadSanitizedRepositoryMetadataStatus::Sanitized
    );
    assert_eq!(
        mapping.receipt.status,
        ProviderLiveReadServerReceiptStatus::ProviderReadPerformed
    );
    assert!(mapping.provider_network_call_performed);
    assert_eq!(diagnostics.mapped_output_count, 1);
    assert_eq!(diagnostics.provider_network_read_performed_count, 1);
    assert!(!diagnostics.provider_write_executed);
    assert!(!diagnostics.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn command_result_mapping_keeps_parse_errors_sanitized_without_raw_payload_retention() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let handoff =
        provider_live_read_command_handoff(command_handoff_input(descriptor.clone(), false));
    let mapping = provider_live_read_command_result_mapping(command_mapping_input(
        request,
        descriptor,
        handoff,
        "{broken".to_owned(),
        true,
        false,
    ));
    let diagnostics =
        provider_live_read_command_handoff_diagnostics(Vec::new(), vec![mapping.clone()]);
    let json = serde_json::to_string(&mapping).expect("serialize parse mapping");

    assert_eq!(
        mapping.status,
        ProviderLiveReadCommandResultMappingStatus::ParseError
    );
    assert!(mapping
        .blockers
        .contains(&ProviderLiveReadCommandResultMappingBlocker::SanitizedOutputNotReady));
    assert_eq!(diagnostics.parse_error_count, 1);
    assert!(mapping.provider_network_call_performed);
    assert!(!mapping.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn command_result_mapping_blocks_effectful_results() {
    let request = provider_live_read_executor_request(executor_input(false));
    let descriptor = provider_live_read_gh_repo_view_descriptor(&request);
    let handoff =
        provider_live_read_command_handoff(command_handoff_input(descriptor.clone(), false));
    let mapping = provider_live_read_command_result_mapping(command_mapping_input(
        request,
        descriptor,
        handoff,
        repository_metadata_json().to_owned(),
        true,
        true,
    ));
    let diagnostics =
        provider_live_read_command_handoff_diagnostics(Vec::new(), vec![mapping.clone()]);

    assert_eq!(
        mapping.status,
        ProviderLiveReadCommandResultMappingStatus::Blocked
    );
    assert!(mapping
        .blockers
        .contains(&ProviderLiveReadCommandResultMappingBlocker::ProviderWriteExecuted));
    assert!(mapping
        .blockers
        .contains(&ProviderLiveReadCommandResultMappingBlocker::TaskMutationExecuted));
    assert!(mapping
        .blockers
        .contains(&ProviderLiveReadCommandResultMappingBlocker::RawProviderPayloadRetained));
    assert!(diagnostics.provider_write_executed);
    assert!(diagnostics.task_mutation_executed);
    assert!(diagnostics.raw_provider_payload_retained);
}
