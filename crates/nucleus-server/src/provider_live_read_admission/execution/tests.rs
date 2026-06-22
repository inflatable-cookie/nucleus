use super::*;
use crate::{
    provider_live_read_admission::*, ForgeNetworkExecutionOperationFamily,
    ForgePullRequestProvider, ServerStateService,
};
use nucleus_local_store::SqliteBackend;

#[test]
fn stopped_handoff_records_ready_persisted_live_reads() {
    let set = provider_live_read_stopped_handoff(handoff_input(persisted_set(), false));
    let record = &set.records[0];
    let json = serde_json::to_string(record).expect("serialize handoff");

    assert_eq!(
        record.status,
        ProviderLiveReadStoppedHandoffStatus::ReadyForFixtureResponse
    );
    assert_eq!(set.ready_handoff_ids.len(), 1);
    assert_eq!(
        record.credential_lease_ref,
        Some("credential-lease:github:read-only".to_owned())
    );
    assert_eq!(
        record.network_read_authority_ref,
        Some("network-authority:github-read".to_owned())
    );
    assert_eq!(
        record.fixture_client_ref,
        Some("fixture-client:github:read".to_owned())
    );
    assert!(!record.provider_network_call_performed);
    assert!(!record.credential_resolution_performed);
    assert!(!record.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_response_body"));
}

#[test]
fn stopped_handoff_repairs_missing_refs_and_blocks_effect_requests() {
    let mut input = handoff_input(persisted_set(), true);
    input.credential_lease_ref = None;
    input.network_read_authority_ref = None;
    input.fixture_client_ref = None;
    input.sanitization_policy_ref = None;
    input.handoff_evidence_ref = None;

    let set = provider_live_read_stopped_handoff(input);
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ProviderLiveReadStoppedHandoffStatus::RepairRequired
    );
    assert!(record
        .blockers
        .contains(&ProviderLiveReadStoppedHandoffBlocker::MissingCredentialLeaseRef));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadStoppedHandoffBlocker::MissingFixtureClientRef));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadStoppedHandoffBlocker::ProviderNetworkCallRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadStoppedHandoffBlocker::TaskMutationRequested));
    assert!(!record.provider_network_call_performed);
    assert!(!record.task_mutation_executed);
}

#[test]
fn stopped_handoff_blocks_unsupported_capability() {
    let mut input = handoff_input(persisted_set(), false);
    input.capability.supported_operation_families =
        vec![ForgeNetworkExecutionOperationFamily::IssueRefresh];

    let set = provider_live_read_stopped_handoff(input);
    let record = &set.records[0];

    assert_eq!(record.status, ProviderLiveReadStoppedHandoffStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ProviderLiveReadStoppedHandoffBlocker::CapabilityDoesNotSupportOperationFamily));
}

#[test]
fn fixture_response_records_sanitized_ready_response_and_diagnostics() {
    let handoffs = provider_live_read_stopped_handoff(handoff_input(persisted_set(), false));
    let set = provider_live_read_fixture_responses(response_input(handoffs, false, false));
    let diagnostics = provider_live_read_execution_diagnostics_from_responses(set.records.clone());
    let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

    assert_eq!(set.ready_response_ids.len(), 1);
    assert_eq!(
        set.records[0].status,
        ProviderLiveReadFixtureResponseStatus::SanitizedResponseReady
    );
    assert_eq!(diagnostics.response_count, 1);
    assert_eq!(diagnostics.ready_count, 1);
    assert_eq!(diagnostics.blocker_count, 0);
    assert!(!diagnostics.provider_network_call_performed);
    assert!(!diagnostics.credential_resolution_performed);
    assert!(!diagnostics.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_request_body"));
    assert!(!json.contains("raw_response_body"));
}

#[test]
fn fixture_response_records_retryable_error_without_raw_payload() {
    let handoffs = provider_live_read_stopped_handoff(handoff_input(persisted_set(), false));
    let set = provider_live_read_fixture_responses(response_input(handoffs, true, false));
    let diagnostics = provider_live_read_execution_diagnostics_from_responses(set.records.clone());

    assert_eq!(
        set.records[0].status,
        ProviderLiveReadFixtureResponseStatus::RetryableError
    );
    assert_eq!(diagnostics.retryable_error_count, 1);
    assert_eq!(
        set.records[0].provider_error_class_ref,
        Some("provider-error:rate-limited".to_owned())
    );
    assert_eq!(
        set.records[0].retry_hint_ref,
        Some("retry:after-window".to_owned())
    );
    assert!(!set.records[0].provider_network_call_performed);
}

#[test]
fn fixture_response_blocks_unready_handoff_and_effect_requests() {
    let mut handoff_input = handoff_input(persisted_set(), false);
    handoff_input.fixture_client_ref = None;
    let handoffs = provider_live_read_stopped_handoff(handoff_input);
    let set = provider_live_read_fixture_responses(response_input(handoffs, false, true));
    let record = &set.records[0];

    assert_eq!(
        record.status,
        ProviderLiveReadFixtureResponseStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ProviderLiveReadFixtureResponseBlocker::HandoffNotReady));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadFixtureResponseBlocker::ProviderNetworkCallRequested));
    assert!(record
        .blockers
        .contains(&ProviderLiveReadFixtureResponseBlocker::TaskMutationRequested));
    assert!(!record.provider_network_call_performed);
    assert!(!record.task_mutation_executed);
}

fn persisted_set() -> ProviderLiveReadPersistenceSet {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state = ServerStateService::new(SqliteBackend::new(temp_dir.path().join("db.sqlite")));
    persist_provider_live_read_records(&state, persistence_input(request_receipts(), false))
        .expect("persist live-read plan")
}

fn request_receipts() -> ProviderLiveReadRequestReceiptSet {
    let admissions = provider_live_read_admission(admission_input(false));
    let preflights = provider_live_read_preflight(preflight_input(admissions, false));
    provider_live_read_request_receipt(request_receipt_input(preflights, false))
}

fn handoff_input(
    persisted_live_reads: ProviderLiveReadPersistenceSet,
    forbidden: bool,
) -> ProviderLiveReadStoppedHandoffInput {
    ProviderLiveReadStoppedHandoffInput {
        persisted_live_reads,
        capability: capability(),
        credential_lease_ref: Some("credential-lease:github:read-only".to_owned()),
        network_read_authority_ref: Some("network-authority:github-read".to_owned()),
        fixture_client_ref: Some("fixture-client:github:read".to_owned()),
        sanitization_policy_ref: Some("sanitize:provider-live-read".to_owned()),
        handoff_evidence_ref: Some("evidence:live-read-handoff".to_owned()),
        existing_handoff_ids: Vec::new(),
        credential_material_present: forbidden,
        provider_payload_present: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn response_input(
    handoffs: ProviderLiveReadStoppedHandoffSet,
    error: bool,
    forbidden: bool,
) -> ProviderLiveReadFixtureResponseInput {
    ProviderLiveReadFixtureResponseInput {
        handoffs,
        response_summary_ref: Some("summary:github:pr-refresh".to_owned()),
        response_evidence_ref: Some("evidence:live-read-response".to_owned()),
        provider_status_class_ref: if error {
            None
        } else {
            Some("provider-status:2xx".to_owned())
        },
        provider_error_class_ref: if error {
            Some("provider-error:rate-limited".to_owned())
        } else {
            None
        },
        retry_hint_ref: if error {
            Some("retry:after-window".to_owned())
        } else {
            None
        },
        rate_limit_ref: Some("rate-limit:remaining-window".to_owned()),
        cancellation_ref: Some("cancel:provider-live-read".to_owned()),
        existing_response_ids: Vec::new(),
        credential_material_present: forbidden,
        provider_payload_present: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn capability() -> ProviderLiveReadCapabilityRecord {
    ProviderLiveReadCapabilityRecord {
        capability_ref: "capability:github:live-read-fixture".to_owned(),
        provider_family_ref: "provider-family:github".to_owned(),
        supported_operation_families: vec![
            ForgeNetworkExecutionOperationFamily::PullRequestRefresh,
            ForgeNetworkExecutionOperationFamily::StatusCheckRefresh,
        ],
        supports_conditional_requests: true,
        supports_rate_limit_metadata: true,
        supports_cancellation: true,
        provider_specific_limits_ref: Some("provider-limits:github:fixture".to_owned()),
        credential_lease_required: true,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        raw_provider_payload_retained: false,
    }
}

fn admission_input(forbidden: bool) -> ProviderLiveReadAdmissionInput {
    ProviderLiveReadAdmissionInput {
        provider_context_refs: vec!["provider-context:github:repo".to_owned()],
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/name".to_owned()),
        operation_family: ForgeNetworkExecutionOperationFamily::PullRequestRefresh,
        target_refs: vec!["change-request:github:42".to_owned()],
        credential_status_evidence_refs: vec!["evidence:credential-status".to_owned()],
        network_authority_ref: Some("network-authority:github-read".to_owned()),
        payload_policy_ref: Some("payload-policy:sanitized-summary-only".to_owned()),
        sanitization_policy_ref: Some("sanitize:provider-live-read".to_owned()),
        admission_evidence_ref: Some("evidence:provider-live-read-admission".to_owned()),
        credential_material_present: forbidden,
        provider_payload_present: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn preflight_input(
    admissions: ProviderLiveReadAdmissionSet,
    forbidden: bool,
) -> ProviderLiveReadPreflightInput {
    ProviderLiveReadPreflightInput {
        admissions,
        endpoint_ref: Some("endpoint:github:pull-request-read".to_owned()),
        idempotency_ref: Some("idempotency:provider-live-read:github:pr:42".to_owned()),
        preflight_evidence_ref: Some("evidence:provider-live-read-preflight".to_owned()),
        credential_material_present: forbidden,
        provider_payload_present: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn request_receipt_input(
    preflights: ProviderLiveReadPreflightSet,
    forbidden: bool,
) -> ProviderLiveReadRequestReceiptInput {
    ProviderLiveReadRequestReceiptInput {
        preflights,
        request_ref: Some("provider-live-read-request:github:pull-request".to_owned()),
        planned_receipt_ref: Some("provider-live-read-receipt:github:pull-request".to_owned()),
        request_evidence_ref: Some("evidence:provider-live-read-request".to_owned()),
        existing_execution_request_ids: Vec::new(),
        credential_material_present: forbidden,
        provider_payload_present: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn persistence_input(
    request_receipts: ProviderLiveReadRequestReceiptSet,
    forbidden: bool,
) -> ProviderLiveReadPersistenceInput {
    ProviderLiveReadPersistenceInput {
        request_receipts,
        persistence_evidence_refs: vec!["evidence:provider-live-read-persistence".to_owned()],
        existing_persisted_live_read_ids: Vec::new(),
        credential_material_present: forbidden,
        provider_payload_present: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}
