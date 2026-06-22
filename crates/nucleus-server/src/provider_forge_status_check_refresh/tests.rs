use super::*;
use crate::{ForgeNetworkExecutionOperationFamily, ForgePullRequestProvider};

#[test]
fn status_check_refresh_records_stopped_provider_contexts() {
    let set = forge_status_check_refresh(input(vec!["provider-context:github:repo".to_owned()]));
    let record = &set.records[0];

    assert!(set.stopped_refresh_recorded);
    assert_eq!(
        record.status,
        ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh
    );
    assert_eq!(
        record.operation_family,
        ForgeNetworkExecutionOperationFamily::StatusCheckRefresh
    );
    assert_eq!(
        record.forge_provider,
        Some(ForgePullRequestProvider::GitHub)
    );
    assert_eq!(
        record.refresh_scope,
        Some(ForgeStatusCheckRefreshScope::ChangeRequestRef(
            "change-request:github:42".to_owned()
        ))
    );
    assert!(!record.credential_resolution_performed);
    assert!(!record.provider_network_call_performed);
    assert!(!record.raw_provider_payload_retained);
}

#[test]
fn status_check_refresh_accepts_commit_and_branch_scopes() {
    let mut commit_input = input(vec!["provider-context:github:repo".to_owned()]);
    commit_input.refresh_scope = Some(ForgeStatusCheckRefreshScope::CommitRef(
        "commit:abc123".to_owned(),
    ));
    let commit_set = forge_status_check_refresh(commit_input);

    let mut branch_input = input(vec!["provider-context:github:repo".to_owned()]);
    branch_input.refresh_scope = Some(ForgeStatusCheckRefreshScope::BranchRef(
        "branch:feature/status".to_owned(),
    ));
    let branch_set = forge_status_check_refresh(branch_input);

    assert_eq!(
        commit_set.records[0].status,
        ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh
    );
    assert_eq!(
        branch_set.records[0].status,
        ForgeStatusCheckRefreshStatus::ReadyForStoppedRefresh
    );
}

#[test]
fn status_check_refresh_blocks_missing_refs() {
    let mut input = input(vec!["".to_owned()]);
    input.provider_instance_ref = None;
    input.forge_provider = None;
    input.remote_repo_ref = None;
    input.refresh_scope = Some(ForgeStatusCheckRefreshScope::CommitRef(String::new()));
    input.credential_status_evidence_ref = None;
    input.repository_metadata_evidence_ref = None;
    input.status_check_refresh_evidence_ref = None;
    input.sanitization_policy_ref = None;

    let set = forge_status_check_refresh(input);
    let record = &set.records[0];

    assert!(!set.stopped_refresh_recorded);
    assert_eq!(set.skipped_provider_context_refs, vec![""]);
    assert_eq!(record.status, ForgeStatusCheckRefreshStatus::RepairRequired);
    assert_eq!(record.blockers.len(), 9);
    assert!(record
        .blockers
        .contains(&ForgeStatusCheckRefreshBlocker::EmptyCommitRef));
}

#[test]
fn status_check_refresh_blocks_live_provider_work() {
    let mut input = input(vec!["provider-context:github:repo".to_owned()]);
    input.credential_material_present = true;
    input.provider_payload_present = true;
    input.raw_provider_payload_retention_requested = true;
    input.real_credential_resolution_requested = true;
    input.provider_network_call_requested = true;
    input.callback_execution_requested = true;
    input.interruption_execution_requested = true;
    input.recovery_execution_requested = true;
    input.task_mutation_requested = true;

    let set = forge_status_check_refresh(input);
    let record = &set.records[0];

    assert_eq!(record.status, ForgeStatusCheckRefreshStatus::Blocked);
    assert!(record
        .blockers
        .contains(&ForgeStatusCheckRefreshBlocker::ProviderNetworkCallRequested));
    assert!(record
        .blockers
        .contains(&ForgeStatusCheckRefreshBlocker::CredentialMaterialPresent));
    assert!(!record.provider_effect_executed);
    assert!(!record.task_mutation_executed);
}

#[test]
fn status_check_refresh_control_dto_serializes_sanitized_counts() {
    let set = forge_status_check_refresh(input(vec![
        "provider-context:github:repo".to_owned(),
        "provider-context:github:repo-two".to_owned(),
    ]));
    let dto = forge_status_check_refresh_control_dto(&set);
    let serialized = serde_json::to_string(&dto).expect("serialize dto");

    assert_eq!(dto.refresh_count, 2);
    assert_eq!(dto.ready_count, 2);
    assert_eq!(dto.blocker_count, 0);
    assert!(dto.stopped_refresh_recorded);
    assert!(!dto.credential_resolution_performed);
    assert!(!dto.provider_network_call_performed);
    assert!(!serialized.contains("access_token"));
    assert!(!serialized.contains("authorization"));
    assert!(!serialized.contains("raw_response_body"));
}

fn input(provider_context_refs: Vec<String>) -> ForgeStatusCheckRefreshInput {
    ForgeStatusCheckRefreshInput {
        provider_context_refs,
        provider_instance_ref: Some("provider-instance:github:main".to_owned()),
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        remote_repo_ref: Some("remote-repo:owner/name".to_owned()),
        refresh_scope: Some(ForgeStatusCheckRefreshScope::ChangeRequestRef(
            "change-request:github:42".to_owned(),
        )),
        credential_status_evidence_ref: Some("evidence:credential-status".to_owned()),
        repository_metadata_evidence_ref: Some("evidence:repo-metadata:persisted".to_owned()),
        status_check_refresh_evidence_ref: Some("evidence:status-check-refresh:planned".to_owned()),
        sanitization_policy_ref: Some("sanitize:status-check-refresh".to_owned()),
        credential_material_present: false,
        provider_payload_present: false,
        raw_provider_payload_retention_requested: false,
        real_credential_resolution_requested: false,
        provider_network_call_requested: false,
        callback_execution_requested: false,
        interruption_execution_requested: false,
        recovery_execution_requested: false,
        task_mutation_requested: false,
    }
}
