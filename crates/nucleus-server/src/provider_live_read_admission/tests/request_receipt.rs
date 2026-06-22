use super::support::{input, preflight_input, ready_preflights, request_receipt_input};
use crate::provider_live_read_admission::*;

#[test]
fn records_planned_request_without_execution() {
    let preflights = ready_preflights();
    let set = provider_live_read_request_receipt(request_receipt_input(preflights, false));
    let record = &set.records[0];

    assert!(set.planned_request_recorded);
    assert_eq!(
        record.status,
        ProviderLiveReadRequestReceiptStatus::PlannedRequestRecorded
    );
    assert_eq!(
        record.request_ref,
        Some("provider-live-read-request:github:pull-request".to_owned())
    );
    assert_eq!(
        record.planned_receipt_ref,
        Some("provider-live-read-receipt:github:pull-request".to_owned())
    );
    assert_eq!(record.evidence_refs.len(), 11);
    assert!(!record.provider_network_call_performed);
    assert!(!record.provider_write_executed);
    assert!(!record.raw_provider_payload_retained);
}

#[test]
fn represents_duplicate_noop() {
    let preflights = ready_preflights();
    let existing_id = format!(
        "provider-live-read-request:{}",
        preflights.preflights[0].preflight_id
    );
    let mut input = request_receipt_input(preflights, false);
    input.existing_execution_request_ids = vec![existing_id];

    let set = provider_live_read_request_receipt(input);
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ProviderLiveReadRequestReceiptStatus::DuplicateNoop
    );
    assert!(record.duplicate_request_detected);
    assert!(record.blockers.is_empty());
    assert!(!record.planned_request_recorded);
}

#[test]
fn blocks_non_ready_preflight_and_effects() {
    let admissions = provider_live_read_admission(input(false));
    let preflights = provider_live_read_preflight(preflight_input(admissions, true));
    let set = provider_live_read_request_receipt(request_receipt_input(preflights, true));
    let record = &set.records[0];

    assert_eq!(record.status, ProviderLiveReadRequestReceiptStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ProviderLiveReadRequestReceiptBlocker::PreflightNotReady));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadRequestReceiptBlocker::ProviderNetworkCallRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadRequestReceiptBlocker::TaskMutationRequested));
    assert!(!record.provider_network_call_performed);
    assert!(!record.task_mutation_executed);
}

#[test]
fn repairs_missing_request_refs() {
    let preflights = ready_preflights();
    let mut input = request_receipt_input(preflights, false);
    input.request_ref = None;
    input.planned_receipt_ref = None;
    input.request_evidence_ref = None;

    let set = provider_live_read_request_receipt(input);
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ProviderLiveReadRequestReceiptStatus::RepairRequired
    );
    assert!(record
        .blockers
        .contains(&ProviderLiveReadRequestReceiptBlocker::MissingRequestRef));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadRequestReceiptBlocker::MissingPlannedReceiptRef));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadRequestReceiptBlocker::MissingRequestEvidenceRef));
}
