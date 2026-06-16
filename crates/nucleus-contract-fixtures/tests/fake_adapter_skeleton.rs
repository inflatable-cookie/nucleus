use nucleus_command_policy::{CommandExecutionStatus, CommandScope};
use nucleus_contract_fixtures::{FakeCommandPolicyAdapter, FakeForgeAdapter, FakeScmAdapter};
use nucleus_scm_forge::{
    ForgeObservationKind, ObservationEffect, ScmObservationKind, ScmWorkflowPrimitive,
};

#[test]
fn fake_command_policy_adapter_is_scripted_values_only() {
    let adapter = FakeCommandPolicyAdapter::provider_neutral();

    assert!(adapter
        .requests()
        .iter()
        .any(|request| request.scope == CommandScope::ReadOnlyInspection));
    assert!(adapter
        .requests()
        .iter()
        .any(|request| request.scope == CommandScope::SourceCodeWrite));
    assert!(adapter
        .evidence()
        .iter()
        .any(|evidence| evidence.status == CommandExecutionStatus::BlockedByPolicy));
    assert!(adapter
        .evidence()
        .iter()
        .any(|evidence| evidence.status == CommandExecutionStatus::TimedOut));
}

#[test]
fn fake_scm_adapter_separates_git_like_and_convergence_like_workflows() {
    let git = FakeScmAdapter::git_like();
    assert_eq!(git.workflow().local_capture, ScmWorkflowPrimitive::Commit);
    assert_eq!(
        git.workflow().shared_authority,
        ScmWorkflowPrimitive::Commit
    );

    let convergence = FakeScmAdapter::convergence_like();
    assert_eq!(
        convergence.workflow().local_capture,
        ScmWorkflowPrimitive::Snapshot
    );
    assert_eq!(
        convergence.workflow().shared_authority,
        ScmWorkflowPrimitive::Publication
    );
    assert!(convergence.task_links().len() == 1);
}

#[test]
fn fake_scm_adapter_exposes_scripted_observations() {
    let adapter = FakeScmAdapter::convergence_like();

    assert!(adapter
        .observations()
        .iter()
        .any(|observation| matches!(observation.kind, ScmObservationKind::RepositorySeen(_))));
    assert!(adapter
        .observations()
        .iter()
        .any(|observation| matches!(observation.kind, ScmObservationKind::CredentialUseFailed(_))));
    assert!(adapter
        .observations()
        .iter()
        .any(|observation| observation.effect == ObservationEffect::RequiresHumanReview));
}

#[test]
fn fake_forge_adapter_exposes_scripted_observations() {
    let adapter = FakeForgeAdapter::generic();

    assert!(adapter
        .observations()
        .iter()
        .any(|observation| matches!(observation.kind, ForgeObservationKind::PullRequestSeen(_))));
    assert!(adapter
        .observations()
        .iter()
        .any(|observation| matches!(observation.kind, ForgeObservationKind::WebhookRejected(_))));
    assert!(adapter.observations().iter().any(|observation| matches!(
        observation.kind,
        ForgeObservationKind::CredentialUseFailed(_)
    )));
}
