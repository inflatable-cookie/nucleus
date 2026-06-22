use crate::{
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef,
    ForgeNetworkExecutionOperationFamily, ForgeNetworkExecutionReceiptStatus,
    ForgeNetworkExecutionRequestReceiptRecord, ForgeNetworkExecutionRequestReceiptSet,
    ForgeNetworkExecutionRequestReceiptStatus, ForgePullRequestProvider,
};

use super::super::{
    ForgeNetworkExecutionOutcomePersistenceInput, ForgeNetworkExecutionOutcomePersistenceRecord,
    ForgeNetworkExecutionOutcomePersistenceStatus, ForgeNetworkExecutionOutcomeStatus,
};

pub fn input(
    request_receipts: ForgeNetworkExecutionRequestReceiptSet,
    requested_status: ForgeNetworkExecutionOutcomeStatus,
    forbidden: bool,
) -> ForgeNetworkExecutionOutcomePersistenceInput {
    ForgeNetworkExecutionOutcomePersistenceInput {
        request_receipts,
        requested_status,
        inspected_ref_count: 3,
        evidence_refs: vec![
            "provider-response-evidence:planned".to_owned(),
            "credential-use-evidence:planned".to_owned(),
        ],
        existing_outcome_ids: Vec::new(),
        raw_request_body_present: forbidden,
        raw_response_body_present: forbidden,
        raw_headers_present: forbidden,
        credential_material_present: forbidden,
        provider_payload_present: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

pub fn request_receipt_set(
    request_receipts: Vec<ForgeNetworkExecutionRequestReceiptRecord>,
) -> ForgeNetworkExecutionRequestReceiptSet {
    ForgeNetworkExecutionRequestReceiptSet {
        request_receipt_set_id: "request-receipt-set:1".to_owned(),
        request_receipts,
        skipped_preflight_ids: Vec::new(),
        stopped_request_recorded: true,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn request_receipt(
    id: &str,
    status: ForgeNetworkExecutionRequestReceiptStatus,
) -> ForgeNetworkExecutionRequestReceiptRecord {
    ForgeNetworkExecutionRequestReceiptRecord {
        execution_request_id: format!("execution-request:{id}"),
        receipt_id: format!("runtime-receipt:{id}"),
        preflight_id: format!("preflight:{id}"),
        admission_id: format!("admission:{id}"),
        request_id: format!("request:{id}"),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operation_family: ForgeNetworkExecutionOperationFamily::PullRequestCreate,
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        credential_ref: Some(credential_ref()),
        network_authority_ref: Some("network-authority:github-api".to_owned()),
        operator_approval_ref: Some("operator-approval:1".to_owned()),
        idempotency_key: Some(format!("idem:{id}")),
        retry_policy_ref: Some("retry-policy:forge-default".to_owned()),
        recovery_policy_ref: Some("recovery-policy:forge-default".to_owned()),
        sanitization_policy_ref: Some("sanitization-policy:provider-response".to_owned()),
        provider_context_ref: Some("provider-context:github:repo".to_owned()),
        target_provider_ref: Some("provider-target:pull-request:new".to_owned()),
        credential_use_evidence_ref: Some("credential-use-evidence:planned".to_owned()),
        preflight_evidence_ref: Some("preflight-evidence:forge-network".to_owned()),
        provider_response_evidence_ref: Some("provider-response-evidence:planned".to_owned()),
        execution_request_evidence_ref: Some("execution-request-evidence:planned".to_owned()),
        runtime_receipt_ref: Some(format!("runtime-receipt:{id}")),
        retry_of_receipt_ref: None,
        recovery_classification_ref: Some("recovery-classification:not-needed".to_owned()),
        status,
        receipt_status: ForgeNetworkExecutionReceiptStatus::AcceptedStopped,
        blockers: Vec::new(),
        stopped_request_recorded: true,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

pub fn persisted(
    id: &str,
    outcome_status: ForgeNetworkExecutionOutcomeStatus,
) -> ForgeNetworkExecutionOutcomePersistenceRecord {
    ForgeNetworkExecutionOutcomePersistenceRecord {
        persisted_outcome_id: format!("outcome:{id}"),
        execution_request_id: format!("execution-request:{id}"),
        receipt_id: format!("runtime-receipt:{id}"),
        preflight_id: format!("preflight:{id}"),
        admission_id: format!("admission:{id}"),
        request_id: format!("request:{id}"),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operation_family: ForgeNetworkExecutionOperationFamily::PullRequestCreate,
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        credential_ref: Some(credential_ref()),
        network_authority_ref: Some("network-authority:github-api".to_owned()),
        operator_approval_ref: Some("operator-approval:1".to_owned()),
        idempotency_key: Some(format!("idem:{id}")),
        retry_policy_ref: Some("retry-policy:forge-default".to_owned()),
        recovery_policy_ref: Some("recovery-policy:forge-default".to_owned()),
        sanitization_policy_ref: Some("sanitization-policy:provider-response".to_owned()),
        provider_context_ref: Some("provider-context:github:repo".to_owned()),
        target_provider_ref: Some("provider-target:pull-request:new".to_owned()),
        credential_use_evidence_ref: Some("credential-use-evidence:planned".to_owned()),
        preflight_evidence_ref: Some("preflight-evidence:forge-network".to_owned()),
        provider_response_evidence_ref: Some("provider-response-evidence:planned".to_owned()),
        execution_request_evidence_ref: Some("execution-request-evidence:planned".to_owned()),
        runtime_receipt_ref: Some(format!("runtime-receipt:{id}")),
        retry_of_receipt_ref: None,
        recovery_classification_ref: Some("recovery-classification:not-needed".to_owned()),
        request_receipt_status: ready(),
        request_receipt_blockers: Vec::new(),
        receipt_status: ForgeNetworkExecutionReceiptStatus::AcceptedStopped,
        outcome_status,
        persistence_status: ForgeNetworkExecutionOutcomePersistenceStatus::Persisted,
        persistence_blockers: Vec::new(),
        duplicate_outcome_detected: false,
        inspected_ref_count: 3,
        evidence_refs: vec!["evidence:1".to_owned()],
        stopped_request_recorded: true,
        credential_resolution_performed: false,
        provider_network_call_performed: false,
        forge_effect_executed: false,
        provider_effect_executed: false,
        callback_effect_executed: false,
        interruption_effect_executed: false,
        recovery_effect_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn credential_ref() -> ForgeNetworkExecutionCredentialRef {
    ForgeNetworkExecutionCredentialRef {
        credential_ref_id: "credential:github-app:1".to_owned(),
        credential_kind: ForgeNetworkCredentialKind::ForgeAppInstallation,
        resolution_boundary: ForgeNetworkCredentialResolutionBoundary::HostCredentialProvider,
        status: ForgeNetworkCredentialStatus::Ready,
        allowed_operation_families: vec![ForgeNetworkExecutionOperationFamily::PullRequestCreate],
    }
}

pub fn ready() -> ForgeNetworkExecutionRequestReceiptStatus {
    ForgeNetworkExecutionRequestReceiptStatus::StoppedRequestRecorded
}

pub fn blocked() -> ForgeNetworkExecutionRequestReceiptStatus {
    ForgeNetworkExecutionRequestReceiptStatus::Blocked
}

pub fn repair_required() -> ForgeNetworkExecutionRequestReceiptStatus {
    ForgeNetworkExecutionRequestReceiptStatus::RepairRequired
}

pub fn stopped() -> ForgeNetworkExecutionOutcomeStatus {
    ForgeNetworkExecutionOutcomeStatus::StoppedRecorded
}

pub fn failed() -> ForgeNetworkExecutionOutcomeStatus {
    ForgeNetworkExecutionOutcomeStatus::Failed
}

pub fn failed_status() -> ForgeNetworkExecutionOutcomeStatus {
    ForgeNetworkExecutionOutcomeStatus::Failed
}

pub fn blocked_status() -> ForgeNetworkExecutionOutcomeStatus {
    ForgeNetworkExecutionOutcomeStatus::Blocked
}

pub fn repair_status() -> ForgeNetworkExecutionOutcomeStatus {
    ForgeNetworkExecutionOutcomeStatus::RepairRequired
}

pub fn duplicate_status() -> ForgeNetworkExecutionOutcomeStatus {
    ForgeNetworkExecutionOutcomeStatus::DuplicateNoop
}
