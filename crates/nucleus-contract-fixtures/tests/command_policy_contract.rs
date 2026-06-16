use nucleus_command_policy::{
    CommandApprovalPolicy, CommandExecutionStatus, CommandOutputRetention, CommandSandboxProfile,
    CommandScope,
};
use nucleus_contract_fixtures::command_policy::{
    artifact_ref_failure_evidence, blocked_by_policy_evidence, destructive_blocked_request,
    management_state_write_request, network_access_request, read_only_inspection_request,
    secret_access_blocked_request, source_code_write_request, summary_only_success_evidence,
    timed_out_evidence,
};

#[test]
fn command_requests_encode_authority_scope_and_approval_policy() {
    let read_only = read_only_inspection_request();
    assert_eq!(read_only.scope, CommandScope::ReadOnlyInspection);
    assert_eq!(read_only.sandbox, CommandSandboxProfile::NoFilesystemWrite);
    assert_eq!(read_only.approval, CommandApprovalPolicy::AutoAllowed);

    let management_write = management_state_write_request();
    assert_eq!(management_write.scope, CommandScope::ManagementStateWrite);
    assert_eq!(
        management_write.approval,
        CommandApprovalPolicy::ApprovalRequiredOnce
    );

    let source_write = source_code_write_request();
    assert_eq!(source_write.scope, CommandScope::SourceCodeWrite);
    assert_eq!(
        source_write.approval,
        CommandApprovalPolicy::ApprovalRequiredEveryTime
    );

    let network = network_access_request();
    assert_eq!(network.scope, CommandScope::NetworkAccess);
    assert_eq!(network.sandbox, CommandSandboxProfile::NetworkAllowed);

    let destructive = destructive_blocked_request();
    assert_eq!(destructive.scope, CommandScope::Destructive);
    assert_eq!(destructive.approval, CommandApprovalPolicy::Denied);

    let secret = secret_access_blocked_request();
    assert_eq!(secret.scope, CommandScope::SecretAccess);
    assert_eq!(secret.approval, CommandApprovalPolicy::Denied);
}

#[test]
fn command_evidence_is_sanitized_and_distinguishes_failure_modes() {
    let success = summary_only_success_evidence();
    assert_eq!(success.status, CommandExecutionStatus::Succeeded);
    assert_eq!(success.retention, CommandOutputRetention::SummaryOnly);
    assert!(success.stdout_artifact_ref.is_none());
    assert!(success.stderr_artifact_ref.is_none());

    let failure = artifact_ref_failure_evidence();
    assert_eq!(failure.status, CommandExecutionStatus::Failed);
    assert_eq!(failure.retention, CommandOutputRetention::ArtifactReference);
    assert!(failure.stdout_artifact_ref.is_some());
    assert!(failure.stderr_artifact_ref.is_some());

    let blocked = blocked_by_policy_evidence();
    let timed_out = timed_out_evidence();
    assert_eq!(blocked.status, CommandExecutionStatus::BlockedByPolicy);
    assert_eq!(timed_out.status, CommandExecutionStatus::TimedOut);
    assert_ne!(blocked.status, timed_out.status);
}
