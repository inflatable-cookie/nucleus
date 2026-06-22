use super::super::*;
use crate::{ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider};

pub(super) fn input(forbidden: bool) -> ProviderLiveReadAdmissionInput {
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

pub(super) fn ready_preflights() -> ProviderLiveReadPreflightSet {
    let admissions = provider_live_read_admission(input(false));
    provider_live_read_preflight(preflight_input(admissions, false))
}

pub(super) fn ready_request_receipts() -> ProviderLiveReadRequestReceiptSet {
    provider_live_read_request_receipt(request_receipt_input(ready_preflights(), false))
}

pub(super) fn preflight_input(
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

pub(super) fn request_receipt_input(
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

pub(super) fn persistence_input(
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
