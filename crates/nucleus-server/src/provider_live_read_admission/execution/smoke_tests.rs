use super::*;
use crate::{ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider};

#[test]
fn smoke_target_selects_concrete_read_only_candidate_without_effects() {
    let target = provider_live_read_smoke_target(target_input(false));
    let json = serde_json::to_string(&target).expect("serialize target");

    assert_eq!(target.status, ProviderLiveReadSmokeTargetStatus::Selected);
    assert_eq!(
        target.operation_family,
        ForgeNetworkExecutionOperationFamily::PullRequestRefresh
    );
    assert_eq!(target.target_refs, vec!["change-request:github:42"]);
    assert_eq!(target.evidence_refs.len(), 2);
    assert!(!target.provider_network_call_performed);
    assert!(!target.credential_resolution_performed);
    assert!(!target.provider_write_executed);
    assert!(!target.raw_provider_payload_retained);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_response_body"));
}

#[test]
fn smoke_target_blocks_mutating_or_effect_requested_candidates() {
    let mut input = target_input(true);
    input.operation_family = ForgeNetworkExecutionOperationFamily::PullRequestCreate;

    let target = provider_live_read_smoke_target(input);

    assert_eq!(target.status, ProviderLiveReadSmokeTargetStatus::Blocked);
    assert!(target
        .blockers
        .contains(&ProviderLiveReadSmokeTargetBlocker::MutatingOperationFamily));
    assert!(target
        .blockers
        .contains(&ProviderLiveReadSmokeTargetBlocker::ProviderNetworkCallRequested));
    assert!(target
        .blockers
        .contains(&ProviderLiveReadSmokeTargetBlocker::ProviderWriteRequested));
    assert!(!target.provider_network_call_performed);
}

#[test]
fn authority_checklist_requires_operator_approval_before_ready() {
    let checklist = provider_live_read_smoke_authority_checklist(checklist_input(None, false));

    assert_eq!(
        checklist.status,
        ProviderLiveReadSmokeAuthorityChecklistStatus::ApprovalRequired
    );
    assert!(checklist
        .blockers
        .contains(&ProviderLiveReadSmokeAuthorityChecklistBlocker::MissingOperatorApprovalRef));
    assert!(!checklist.provider_network_call_performed);
    assert!(!checklist.credential_resolution_performed);
}

#[test]
fn smoke_request_remains_approval_required_without_approval_ref() {
    let checklist = provider_live_read_smoke_authority_checklist(checklist_input(None, false));
    let request = provider_live_read_smoke_request(request_input(checklist, false));

    assert_eq!(
        request.status,
        ProviderLiveReadSmokeRequestStatus::ApprovalRequired
    );
    assert!(request
        .blockers
        .contains(&ProviderLiveReadSmokeRequestBlocker::MissingOperatorApprovalRef));
    assert!(request
        .blockers
        .contains(&ProviderLiveReadSmokeRequestBlocker::ChecklistNotReady));
    assert!(!request.provider_network_call_performed);
    assert!(!request.raw_provider_payload_retained);
}

#[test]
fn smoke_request_with_approval_is_stopped_pending_explicit_execution() {
    let checklist = provider_live_read_smoke_authority_checklist(checklist_input(
        Some("approval:operator:live-read-smoke".to_owned()),
        false,
    ));
    let request = provider_live_read_smoke_request(request_input(checklist, false));
    let json = serde_json::to_string(&request).expect("serialize request");

    assert_eq!(
        request.status,
        ProviderLiveReadSmokeRequestStatus::StoppedPendingExplicitExecution
    );
    assert!(request.blockers.is_empty());
    assert_eq!(
        request.stopped_handoff_ref,
        Some("handoff:provider-live-read:github:pr".to_owned())
    );
    assert!(!request.provider_network_call_performed);
    assert!(!request.credential_resolution_performed);
    assert!(!request.provider_write_executed);
    assert!(!request.task_mutation_executed);
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_request_body"));
    assert!(!json.contains("raw_response_body"));
}

#[test]
fn smoke_request_blocks_effect_requests_even_with_approval_metadata() {
    let checklist = provider_live_read_smoke_authority_checklist(checklist_input(
        Some("approval:operator:live-read-smoke".to_owned()),
        false,
    ));
    let request = provider_live_read_smoke_request(request_input(checklist, true));

    assert_eq!(request.status, ProviderLiveReadSmokeRequestStatus::Blocked);
    assert!(request
        .blockers
        .contains(&ProviderLiveReadSmokeRequestBlocker::ProviderNetworkCallRequested));
    assert!(request
        .blockers
        .contains(&ProviderLiveReadSmokeRequestBlocker::CredentialMaterialPresent));
    assert!(request
        .blockers
        .contains(&ProviderLiveReadSmokeRequestBlocker::TaskMutationRequested));
    assert!(!request.provider_network_call_performed);
    assert!(!request.task_mutation_executed);
}

fn target_input(forbidden: bool) -> ProviderLiveReadSmokeTargetInput {
    ProviderLiveReadSmokeTargetInput {
        smoke_target_ref: "github:owner/repo:pr:42".to_owned(),
        provider_family_ref: Some("provider-family:github".to_owned()),
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/repo".to_owned()),
        operation_family: ForgeNetworkExecutionOperationFamily::PullRequestRefresh,
        target_refs: vec!["change-request:github:42".to_owned()],
        local_evidence_refs: vec!["evidence:provider-readiness-overview".to_owned()],
        smoke_target_evidence_ref: Some("evidence:live-read-smoke-target".to_owned()),
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

fn checklist_input(
    operator_approval_ref: Option<String>,
    forbidden: bool,
) -> ProviderLiveReadSmokeAuthorityChecklistInput {
    ProviderLiveReadSmokeAuthorityChecklistInput {
        target: provider_live_read_smoke_target(target_input(false)),
        credential_lease_ref: Some("credential-lease:github:read-only".to_owned()),
        network_read_authority_ref: Some("network-authority:github-read".to_owned()),
        payload_policy_ref: Some("payload-policy:sanitized-summary-only".to_owned()),
        sanitization_policy_ref: Some("sanitize:provider-live-read".to_owned()),
        retention_policy_ref: Some("retention:no-raw-provider-payload".to_owned()),
        operator_approval_ref,
        checklist_evidence_ref: Some("evidence:live-read-smoke-checklist".to_owned()),
        credential_material_present: forbidden,
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

fn request_input(
    checklist: ProviderLiveReadSmokeAuthorityChecklistRecord,
    forbidden: bool,
) -> ProviderLiveReadSmokeRequestInput {
    ProviderLiveReadSmokeRequestInput {
        checklist,
        stopped_handoff_ref: Some("handoff:provider-live-read:github:pr".to_owned()),
        fixture_response_ref: Some("fixture-response:provider-live-read:github:pr".to_owned()),
        smoke_request_evidence_ref: Some("evidence:live-read-smoke-request".to_owned()),
        existing_smoke_request_ids: Vec::new(),
        provider_network_call_requested: forbidden,
        credential_material_present: forbidden,
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}
