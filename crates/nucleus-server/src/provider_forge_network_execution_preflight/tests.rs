use super::*;
use crate::{
    ForgeNetworkCredentialKind, ForgeNetworkCredentialResolutionBoundary,
    ForgeNetworkCredentialStatus, ForgeNetworkExecutionAdmissionRecord,
    ForgeNetworkExecutionAdmissionSet, ForgeNetworkExecutionAdmissionStatus,
    ForgeNetworkExecutionCredentialRef, ForgeNetworkExecutionOperationFamily,
    ForgePullRequestProvider, ForgePullRequestTextSource,
};

#[test]
fn forge_network_execution_preflight_accepts_stopped_execution_request() {
    let set = forge_network_execution_preflight(input(false));
    let preflight = &set.preflights[0];

    assert_eq!(
        preflight.status,
        ForgeNetworkExecutionPreflightStatus::ReadyForStoppedExecutionRequest
    );
    assert!(preflight.stopped_execution_request_permitted);
    assert_eq!(
        preflight.provider_context_ref.as_deref(),
        Some("provider-context:github:repo")
    );
    assert_eq!(
        preflight.provider_response_evidence_ref.as_deref(),
        Some("provider-response-evidence:planned")
    );
    assert!(!preflight.credential_resolution_performed);
    assert!(!preflight.provider_network_call_performed);
    assert!(!preflight.forge_effect_executed);
    assert!(!preflight.task_mutation_executed);
    assert!(!preflight.raw_provider_payload_retained);
}

#[test]
fn forge_network_execution_preflight_blocks_missing_evidence_and_authority_refs() {
    let mut input = input(false);
    input.provider_context_ref = None;
    input.target_provider_ref = None;
    input.credential_use_evidence_ref = None;
    input.preflight_evidence_ref = None;
    input.provider_response_evidence_ref = None;
    input.admissions.admissions[0].network_authority_ref = None;
    input.admissions.admissions[0].operator_approval_ref = None;
    input.admissions.admissions[0].idempotency_key = None;

    let set = forge_network_execution_preflight(input);
    let preflight = &set.preflights[0];

    assert_eq!(
        preflight.status,
        ForgeNetworkExecutionPreflightStatus::RepairRequired
    );
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::MissingProviderContextRef));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::MissingTargetProviderRef));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::MissingCredentialUseEvidenceRef));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::MissingPreflightEvidenceRef));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::MissingProviderResponseEvidenceRef));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::MissingNetworkAuthorityRef));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::MissingOperatorApprovalRef));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::MissingIdempotencyKey));
}

#[test]
fn forge_network_execution_preflight_blocks_real_effects() {
    let set = forge_network_execution_preflight(input(true));
    let preflight = &set.preflights[0];

    assert_eq!(
        preflight.status,
        ForgeNetworkExecutionPreflightStatus::Blocked
    );
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::RealCredentialResolutionRequested));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::ProviderNetworkCallRequested));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::RawProviderPayloadRetentionRequested));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::CallbackExecutionRequested));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::RecoveryExecutionRequested));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::TaskMutationRequested));
}

#[test]
fn forge_network_execution_preflight_blocks_non_ready_admissions_and_deferred_families() {
    let mut input = input(false);
    input.admissions.admissions[0].status = ForgeNetworkExecutionAdmissionStatus::Blocked;
    input.admissions.admissions[0].stopped_preflight_permitted = false;
    input.admissions.admissions[0].operation_family = ForgeNetworkExecutionOperationFamily::Merge;

    let set = forge_network_execution_preflight(input);
    let preflight = &set.preflights[0];

    assert_eq!(
        preflight.status,
        ForgeNetworkExecutionPreflightStatus::RepairRequired
    );
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::AdmissionNotReady));
    assert!(preflight
        .blockers
        .contains(&ForgeNetworkExecutionPreflightBlocker::DeferredOperationFamily));
}

#[test]
fn forge_network_execution_preflight_control_dto_serializes_sanitized_counts() {
    let set = forge_network_execution_preflight(input(false));
    let dto = forge_network_execution_preflight_control_dto(&set);
    let json = serde_json::to_string(&dto).expect("serialize dto");
    let decoded: ForgeNetworkExecutionPreflightControlDto =
        serde_json::from_str(&json).expect("deserialize dto");

    assert_eq!(decoded, dto);
    assert_eq!(decoded.ready_count, 1);
    assert_eq!(decoded.preflight_count, 1);
    assert!(decoded.stopped_execution_request_permitted);
    assert!(!decoded.provider_network_call_performed);
    assert!(!decoded.credential_resolution_performed);
    assert!(!decoded.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("response_body"));
}

fn input(forbidden: bool) -> ForgeNetworkExecutionPreflightInput {
    ForgeNetworkExecutionPreflightInput {
        admissions: admission_set(),
        provider_context_ref: Some("provider-context:github:repo".to_owned()),
        target_provider_ref: Some("provider-target:pull-request:new".to_owned()),
        credential_use_evidence_ref: Some("credential-use-evidence:planned".to_owned()),
        preflight_evidence_ref: Some("preflight-evidence:forge-network".to_owned()),
        provider_response_evidence_ref: Some("provider-response-evidence:planned".to_owned()),
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

fn admission_set() -> ForgeNetworkExecutionAdmissionSet {
    ForgeNetworkExecutionAdmissionSet {
        admission_set_id: "admission-set:1".to_owned(),
        admissions: vec![admission()],
        skipped_request_adapter_ids: Vec::new(),
        stopped_preflight_permitted: true,
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

fn admission() -> ForgeNetworkExecutionAdmissionRecord {
    ForgeNetworkExecutionAdmissionRecord {
        admission_id: "forge-network-admission:1".to_owned(),
        request_adapter_id: "request-adapter:1".to_owned(),
        upstream_admission_id: "upstream-admission:1".to_owned(),
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
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_target: None,
        base_branch: Some("main".to_owned()),
        head_branch: Some("feature/task".to_owned()),
        title_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        body_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        status: ForgeNetworkExecutionAdmissionStatus::ReadyForStoppedPreflight,
        blockers: Vec::new(),
        stopped_preflight_permitted: true,
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
