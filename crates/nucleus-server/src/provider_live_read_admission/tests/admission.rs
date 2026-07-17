use super::support::input;
use crate::{
    provider_live_read_admission::*, ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider,
};

#[test]
fn accepts_fixture_preflight_for_read_family() {
    let set = provider_live_read_admission(input(false));
    let record = &set.records[0];

    assert!(set.fixture_preflight_permitted);
    assert_eq!(
        record.status,
        ProviderLiveReadAdmissionStatus::ReadyForFixturePreflight
    );
    assert_eq!(
        record.operation_family,
        ForgeNetworkExecutionOperationFamily::PullRequestRefresh
    );
    assert_eq!(
        record.forge_provider,
        Some(ForgePullRequestProvider::GitHub)
    );
    assert_eq!(record.target_refs, vec!["change-request:github:42"]);
    assert_eq!(record.evidence_refs.len(), 5);
    assert!(!record.no_effects.credential_resolution_performed);
    assert!(!record.no_effects.provider_network_call_performed);
    assert!(!record.no_effects.provider_write_executed);
    assert!(!record.no_effects.task_mutation_executed);
    assert!(!record.no_effects.raw_provider_payload_retained);
}

#[test]
fn repairs_missing_refs() {
    let mut input = input(false);
    input.provider_context_refs = vec![String::new()];
    input.provider_instance_ref = None;
    input.forge_provider = None;
    input.remote_repo_ref = None;
    input.target_refs = Vec::new();
    input.credential_status_evidence_refs = Vec::new();
    input.network_authority_ref = None;
    input.payload_policy_ref = None;
    input.sanitization_policy_ref = None;
    input.admission_evidence_ref = None;

    let set = provider_live_read_admission(input);
    let record = &set.records[0];

    assert!(!set.fixture_preflight_permitted);
    assert_eq!(set.skipped_provider_context_refs, vec![""]);
    assert_eq!(
        record.status,
        ProviderLiveReadAdmissionStatus::RepairRequired
    );
    assert_eq!(record.blockers.len(), 10);
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::MissingNetworkAuthorityRef));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::MissingCredentialStatusEvidenceRef));
}

#[test]
fn rejects_mutating_operation_families_as_unsupported() {
    let mut input = input(false);
    input.operation_family = ForgeNetworkExecutionOperationFamily::PullRequestCreate;

    let set = provider_live_read_admission(input);
    let record = &set.records[0];

    assert_eq!(record.status, ProviderLiveReadAdmissionStatus::Unsupported);
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::MutatingOperationFamily));
    assert!(!record.no_effects.provider_write_executed);
    assert!(!record.no_effects.provider_network_call_performed);
}

#[test]
fn blocks_requested_live_effects_and_material() {
    let set = provider_live_read_admission(input(true));
    let record = &set.records[0];

    assert_eq!(record.status, ProviderLiveReadAdmissionStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::CredentialMaterialPresent));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::ProviderPayloadPresent));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::RawProviderPayloadRetentionRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::RealCredentialResolutionRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::ProviderNetworkCallRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::ProviderWriteRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::CallbackExecutionRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::InterruptionExecutionRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::RecoveryExecutionRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadAdmissionBlocker::TaskMutationRequested));
    assert!(!record.no_effects.credential_resolution_performed);
    assert!(!record.no_effects.provider_network_call_performed);
    assert!(!record.no_effects.provider_write_executed);
    assert!(!record.no_effects.raw_provider_payload_retained);
}

#[test]
fn control_dto_serializes_sanitized_counts() {
    let set = provider_live_read_admission(input(false));
    let dto = provider_live_read_admission_control_dto(&set);
    let json = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(dto.admission_count, 1);
    assert_eq!(dto.ready_count, 1);
    assert_eq!(dto.evidence_ref_count, 5);
    assert!(dto.fixture_preflight_permitted);
    assert!(!dto.no_effects.credential_resolution_performed);
    assert!(!dto.no_effects.provider_network_call_performed);
    assert!(!dto.no_effects.provider_write_executed);
    assert!(!dto.no_effects.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("provider_payload_bytes"));
    assert!(!json.contains("raw_request_body"));
    assert!(!json.contains("raw_response_body"));
}
