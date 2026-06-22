use super::support::{input, preflight_input};
use crate::provider_live_read_admission::*;

#[test]
fn accepts_ready_admission() {
    let admissions = provider_live_read_admission(input(false));
    let set = provider_live_read_preflight(preflight_input(admissions, false));
    let preflight = &set.preflights[0];

    assert!(set.fixture_request_planning_permitted);
    assert_eq!(
        preflight.status,
        ProviderLiveReadPreflightStatus::ReadyForRequestReceiptPlanning
    );
    assert_eq!(
        preflight.endpoint_ref,
        Some("endpoint:github:pull-request-read".to_owned())
    );
    assert_eq!(preflight.evidence_refs.len(), 8);
    assert!(!preflight.credential_resolution_performed);
    assert!(!preflight.provider_network_call_performed);
    assert!(!preflight.provider_write_executed);
    assert!(!preflight.task_mutation_executed);
    assert!(!preflight.raw_provider_payload_retained);
}

#[test]
fn blocks_non_ready_admission() {
    let mut admission_input = input(false);
    admission_input.provider_context_refs = vec![String::new()];
    let admissions = provider_live_read_admission(admission_input);

    let set = provider_live_read_preflight(preflight_input(admissions, false));
    let preflight = &set.preflights[0];

    assert!(!set.fixture_request_planning_permitted);
    assert_eq!(preflight.status, ProviderLiveReadPreflightStatus::Blocked);
    assert!(preflight
        .blockers
        .contains(&ProviderLiveReadPreflightBlocker::AdmissionNotReady));
    assert!(!preflight.provider_network_call_performed);
}

#[test]
fn repairs_missing_refs() {
    let admissions = provider_live_read_admission(input(false));
    let mut input = preflight_input(admissions, false);
    input.endpoint_ref = None;
    input.idempotency_ref = None;
    input.preflight_evidence_ref = None;

    let set = provider_live_read_preflight(input);
    let preflight = &set.preflights[0];

    assert_eq!(
        preflight.status,
        ProviderLiveReadPreflightStatus::RepairRequired
    );
    assert!(preflight
        .blockers
        .contains(&ProviderLiveReadPreflightBlocker::MissingEndpointRef));
    assert!(preflight
        .blockers
        .contains(&ProviderLiveReadPreflightBlocker::MissingIdempotencyRef));
    assert!(preflight
        .blockers
        .contains(&ProviderLiveReadPreflightBlocker::MissingPreflightEvidenceRef));
}

#[test]
fn blocks_effect_requests() {
    let admissions = provider_live_read_admission(input(false));
    let set = provider_live_read_preflight(preflight_input(admissions, true));
    let preflight = &set.preflights[0];

    assert_eq!(preflight.status, ProviderLiveReadPreflightStatus::Blocked);
    assert!(preflight
        .blockers
        .contains(&ProviderLiveReadPreflightBlocker::ProviderNetworkCallRequested));
    assert!(preflight
        .blockers
        .contains(&ProviderLiveReadPreflightBlocker::ProviderWriteRequested));
    assert!(preflight
        .blockers
        .contains(&ProviderLiveReadPreflightBlocker::CredentialMaterialPresent));
    assert!(!preflight.provider_network_call_performed);
    assert!(!preflight.provider_write_executed);
}
