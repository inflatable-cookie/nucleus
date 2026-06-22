use super::*;
use crate::{
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionCredentialRef,
    ForgeNetworkExecutionOperationFamily, ForgeNetworkExecutionPreflightRecord,
    ForgeNetworkExecutionPreflightSet, ForgeNetworkExecutionPreflightStatus,
    ForgePullRequestProvider,
};

#[test]
fn forge_network_execution_request_receipt_records_stopped_request() {
    let set = forge_network_execution_request_receipt(input(false));
    let record = &set.request_receipts[0];

    assert_eq!(
        record.status,
        ForgeNetworkExecutionRequestReceiptStatus::StoppedRequestRecorded
    );
    assert_eq!(
        record.receipt_status,
        ForgeNetworkExecutionReceiptStatus::AcceptedStopped
    );
    assert!(record.stopped_request_recorded);
    assert_eq!(
        record.execution_request_evidence_ref.as_deref(),
        Some("execution-request-evidence:planned")
    );
    assert_eq!(
        record.runtime_receipt_ref.as_deref(),
        Some("runtime-receipt:forge-network:1")
    );
    assert_eq!(
        record.provider_response_evidence_ref.as_deref(),
        Some("provider-response-evidence:planned")
    );
    assert!(!record.credential_resolution_performed);
    assert!(!record.provider_network_call_performed);
    assert!(!record.forge_effect_executed);
    assert!(!record.task_mutation_executed);
    assert!(!record.raw_provider_payload_retained);
}

#[test]
fn forge_network_execution_request_receipt_blocks_missing_receipt_and_evidence_refs() {
    let mut input = input(false);
    input.execution_request_evidence_ref = None;
    input.runtime_receipt_ref = None;
    input.preflights.preflights[0].provider_response_evidence_ref = None;
    input.preflights.preflights[0].credential_use_evidence_ref = None;
    input.preflights.preflights[0].idempotency_key = None;

    let set = forge_network_execution_request_receipt(input);
    let record = &set.request_receipts[0];

    assert_eq!(
        record.status,
        ForgeNetworkExecutionRequestReceiptStatus::RepairRequired
    );
    assert_eq!(
        record.receipt_status,
        ForgeNetworkExecutionReceiptStatus::RepairRequired
    );
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::MissingExecutionRequestEvidenceRef));
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::MissingRuntimeReceiptRef));
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::MissingProviderResponseEvidenceRef));
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::MissingCredentialUseEvidenceRef));
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::MissingIdempotencyKey));
}

#[test]
fn forge_network_execution_request_receipt_blocks_real_effects() {
    let set = forge_network_execution_request_receipt(input(true));
    let record = &set.request_receipts[0];

    assert_eq!(
        record.status,
        ForgeNetworkExecutionRequestReceiptStatus::Blocked
    );
    assert_eq!(
        record.receipt_status,
        ForgeNetworkExecutionReceiptStatus::Blocked
    );
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::RealCredentialResolutionRequested));
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::ProviderNetworkCallRequested));
    assert!(record.blockers.contains(
        &ForgeNetworkExecutionRequestReceiptBlocker::RawProviderPayloadRetentionRequested
    ));
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::CallbackExecutionRequested));
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::RecoveryExecutionRequested));
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::TaskMutationRequested));
}

#[test]
fn forge_network_execution_request_receipt_requires_recovery_classification_for_retry() {
    let mut input = input(false);
    input.retry_of_receipt_ref = Some("runtime-receipt:prior".to_owned());
    input.recovery_classification_ref = None;

    let set = forge_network_execution_request_receipt(input);
    let record = &set.request_receipts[0];

    assert_eq!(
        record.status,
        ForgeNetworkExecutionRequestReceiptStatus::RepairRequired
    );
    assert_eq!(
        record.retry_of_receipt_ref.as_deref(),
        Some("runtime-receipt:prior")
    );
    assert!(record
        .blockers
        .contains(&ForgeNetworkExecutionRequestReceiptBlocker::MissingRecoveryClassificationRef));
}

#[test]
fn forge_network_execution_request_receipt_control_dto_serializes_sanitized_counts() {
    let set = forge_network_execution_request_receipt(input(false));
    let dto = forge_network_execution_request_receipt_control_dto(&set);
    let json = serde_json::to_string(&dto).expect("serialize dto");
    let decoded: ForgeNetworkExecutionRequestReceiptControlDto =
        serde_json::from_str(&json).expect("deserialize dto");

    assert_eq!(decoded, dto);
    assert_eq!(decoded.recorded_count, 1);
    assert!(decoded.stopped_request_recorded);
    assert!(!decoded.provider_network_call_performed);
    assert!(!decoded.credential_resolution_performed);
    assert!(!decoded.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("response_body"));
}

fn input(forbidden: bool) -> ForgeNetworkExecutionRequestReceiptInput {
    ForgeNetworkExecutionRequestReceiptInput {
        preflights: preflight_set(),
        execution_request_evidence_ref: Some("execution-request-evidence:planned".to_owned()),
        runtime_receipt_ref: Some("runtime-receipt:forge-network:1".to_owned()),
        retry_of_receipt_ref: None,
        recovery_classification_ref: Some("recovery-classification:not-needed".to_owned()),
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn preflight_set() -> ForgeNetworkExecutionPreflightSet {
    ForgeNetworkExecutionPreflightSet {
        preflight_set_id: "preflight-set:1".to_owned(),
        preflights: vec![preflight()],
        skipped_admission_ids: Vec::new(),
        stopped_execution_request_permitted: true,
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

fn preflight() -> ForgeNetworkExecutionPreflightRecord {
    ForgeNetworkExecutionPreflightRecord {
        preflight_id: "preflight:1".to_owned(),
        admission_id: "admission:1".to_owned(),
        request_adapter_id: "request-adapter:1".to_owned(),
        request_id: "request:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operation_family: ForgeNetworkExecutionOperationFamily::PullRequestCreate,
        credential_ref: Some(credential_ref()),
        network_authority_ref: Some("network-authority:github-api".to_owned()),
        operator_approval_ref: Some("operator-approval:1".to_owned()),
        idempotency_key: Some("idem:project:repo:pr-create:1".to_owned()),
        retry_policy_ref: Some("retry-policy:forge-default".to_owned()),
        recovery_policy_ref: Some("recovery-policy:forge-default".to_owned()),
        sanitization_policy_ref: Some("sanitization-policy:provider-response".to_owned()),
        provider_context_ref: Some("provider-context:github:repo".to_owned()),
        target_provider_ref: Some("provider-target:pull-request:new".to_owned()),
        credential_use_evidence_ref: Some("credential-use-evidence:planned".to_owned()),
        preflight_evidence_ref: Some("preflight-evidence:forge-network".to_owned()),
        provider_response_evidence_ref: Some("provider-response-evidence:planned".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_target: None,
        base_branch: Some("main".to_owned()),
        head_branch: Some("feature/task".to_owned()),
        title_source: None,
        body_source: None,
        status: ForgeNetworkExecutionPreflightStatus::ReadyForStoppedExecutionRequest,
        blockers: Vec::new(),
        stopped_execution_request_permitted: true,
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
