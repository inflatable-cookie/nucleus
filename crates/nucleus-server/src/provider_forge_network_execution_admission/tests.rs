use crate::provider_no_effects::{ForgeScmNoEffects};
use super::*;
use crate::{
    ForgePullRequestProvider, ForgePullRequestRunnerRequestAdapterRecord,
    ForgePullRequestRunnerRequestAdapterSet, ForgePullRequestRunnerRequestAdapterStatus,
    ForgePullRequestTextSource,
};

#[test]
fn forge_network_execution_admission_accepts_stopped_preflight() {
    let set = forge_network_execution_admission(input(false));
    let admission = &set.admissions[0];

    assert_eq!(
        admission.status,
        ForgeNetworkExecutionAdmissionStatus::ReadyForStoppedPreflight
    );
    assert!(admission.stopped_preflight_permitted);
    assert!(set.stopped_preflight_permitted);
    assert_eq!(
        admission.operation_family,
        ForgeNetworkExecutionOperationFamily::PullRequestCreate
    );
    assert_eq!(
        admission.credential_ref.as_ref().map(|credential| {
            (
                credential.credential_ref_id.as_str(),
                &credential.credential_kind,
                &credential.status,
            )
        }),
        Some((
            "credential:github-app:1",
            &ForgeNetworkCredentialKind::ForgeAppInstallation,
            &ForgeNetworkCredentialStatus::Ready,
        ))
    );
    assert!(!admission.provider_network_call_performed);
    assert!(!admission.credential_resolution_performed);
    assert!(!admission.forge_effect_executed);
    assert!(!admission.task_mutation_executed);
    assert!(!admission.raw_provider_payload_retained);
}

#[test]
fn forge_network_execution_admission_blocks_missing_refs() {
    let mut input = input(false);
    input.credential_ref = None;
    input.network_authority_ref = None;
    input.operator_approval_ref = None;
    input.idempotency_key = None;

    let set = forge_network_execution_admission(input);
    let admission = &set.admissions[0];

    assert_eq!(
        admission.status,
        ForgeNetworkExecutionAdmissionStatus::RepairRequired
    );
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::MissingCredentialRef));
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::MissingNetworkAuthorityRef));
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::MissingOperatorApprovalRef));
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::MissingIdempotencyKey));
}

#[test]
fn forge_network_execution_admission_blocks_deferred_operations_and_real_effects() {
    let mut input = input(true);
    input.operation_family = ForgeNetworkExecutionOperationFamily::Merge;
    input
        .credential_ref
        .as_mut()
        .expect("credential ref")
        .allowed_operation_families = Vec::new();

    let set = forge_network_execution_admission(input);
    let admission = &set.admissions[0];

    assert_eq!(
        admission.status,
        ForgeNetworkExecutionAdmissionStatus::Blocked
    );
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::DeferredOperationFamily));
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::ProviderNetworkCallRequested));
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::RealCredentialResolutionRequested));
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::RawProviderPayloadRetentionRequested));
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::TaskMutationRequested));
    assert!(!admission.provider_network_call_performed);
    assert!(!admission.raw_provider_payload_retained);
}

#[test]
fn forge_network_execution_admission_blocks_unready_credentials() {
    let mut input = input(false);
    let credential = input.credential_ref.as_mut().expect("credential ref");
    credential.status = ForgeNetworkCredentialStatus::RequiresUserAction;
    credential.allowed_operation_families =
        vec![ForgeNetworkExecutionOperationFamily::CommentCreate];

    let set = forge_network_execution_admission(input);
    let admission = &set.admissions[0];

    assert_eq!(
        admission.status,
        ForgeNetworkExecutionAdmissionStatus::RepairRequired
    );
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::CredentialNotReady));
    assert!(admission
        .blockers
        .contains(&ForgeNetworkExecutionAdmissionBlocker::CredentialOperationNotAllowed));
}

#[test]
fn forge_network_execution_admission_serializes_without_secret_or_payload_fields() {
    let set = forge_network_execution_admission(input(false));
    let json = serde_json::to_string(&set).expect("serialize admission set");
    let decoded: ForgeNetworkExecutionAdmissionSet =
        serde_json::from_str(&json).expect("deserialize admission set");

    assert_eq!(decoded, set);
    assert!(json.contains("credential_ref_id"));
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("response_body"));
}

fn input(forbidden: bool) -> ForgeNetworkExecutionAdmissionInput {
    ForgeNetworkExecutionAdmissionInput {
        request_set: request_set(),
        operation_family: ForgeNetworkExecutionOperationFamily::PullRequestCreate,
        credential_ref: Some(credential_ref()),
        network_authority_ref: Some("network-authority:github-api".to_owned()),
        operator_approval_ref: Some("operator-approval:1".to_owned()),
        idempotency_key: Some("idem:project:repo:pr-create:1".to_owned()),
        retry_policy_ref: Some("retry-policy:forge-default".to_owned()),
        recovery_policy_ref: Some("recovery-policy:forge-default".to_owned()),
        sanitization_policy_ref: Some("sanitization-policy:provider-response".to_owned()),
        raw_provider_payload_retention_requested: forbidden,
        real_credential_resolution_requested: forbidden,
        provider_network_call_requested: forbidden,
        callback_execution_requested: forbidden,
        interruption_execution_requested: forbidden,
        recovery_execution_requested: forbidden,
        task_mutation_requested: forbidden,
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

fn request_set() -> ForgePullRequestRunnerRequestAdapterSet {
    ForgePullRequestRunnerRequestAdapterSet {
        request_set_id: "request-set:1".to_owned(),
        requests: vec![request()],
        skipped_authority_ids: Vec::new(),
        provider_request_prepared: true,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

fn request() -> ForgePullRequestRunnerRequestAdapterRecord {
    ForgePullRequestRunnerRequestAdapterRecord {
        request_adapter_id: "request-adapter:1".to_owned(),
        authority_id: "authority:1".to_owned(),
        preflight_id: "preflight:1".to_owned(),
        admission_id: "upstream-admission:1".to_owned(),
        pr_evidence_id: "pr-evidence:1".to_owned(),
        pr_descriptor_id: "pr-descriptor:1".to_owned(),
        push_preflight_id: "push-preflight:1".to_owned(),
        request_id: "request:1".to_owned(),
        upstream_authority_id: "upstream-authority:1".to_owned(),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operator_confirmation_ref: Some("operator-confirmation:1".to_owned()),
        remote_target: None,
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        base_branch: Some("main".to_owned()),
        head_branch: Some("feature/task".to_owned()),
        title_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        body_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        status: ForgePullRequestRunnerRequestAdapterStatus::Ready,
        blockers: Vec::new(),
        provider_request_prepared: true,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}
