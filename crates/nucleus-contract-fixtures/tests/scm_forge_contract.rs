use nucleus_scm_forge::{
    CredentialFailureKind, CredentialStatus, ReviewOutcome, ReviewWorkflowStatus, ScmChangeKind,
    ScmConflictKind, ScmConflictResolutionPolicy, ScmTaskLinkKind, ScmWorkflowPrimitive,
    TaskLinkSource, WebhookVerificationFailureKind, WebhookVerificationStatus,
};

use nucleus_contract_fixtures::scm_forge::{
    abandoned_review_workflow, convergence_like_workflow, credential_failure_evidence,
    git_like_workflow, publication_task_link, rejected_webhook_evidence, scm_file_conflict,
    task_semantic_conflict,
};

#[test]
fn scm_workflows_do_not_assume_git_commit_semantics() {
    let git = git_like_workflow();
    assert_eq!(git.local_capture, ScmWorkflowPrimitive::Commit);
    assert_eq!(git.shared_authority, ScmWorkflowPrimitive::Commit);
    assert_eq!(
        git.review_boundary,
        Some(ScmWorkflowPrimitive::Custom("pull-request".to_owned()))
    );

    let convergence = convergence_like_workflow();
    assert_eq!(convergence.local_capture, ScmWorkflowPrimitive::Snapshot);
    assert_eq!(
        convergence.shared_authority,
        ScmWorkflowPrimitive::Publication
    );
    assert_eq!(
        convergence.review_boundary,
        Some(ScmWorkflowPrimitive::Gate)
    );
}

#[test]
fn provider_refs_do_not_replace_task_identity() {
    let link = publication_task_link();
    assert_eq!(link.task_id.0, "task-fixture-sync");
    assert_eq!(link.source, TaskLinkSource::StewardSuggested);

    let ScmTaskLinkKind::Change(change) = link.kind else {
        panic!("fixture should link to a provider-neutral change");
    };

    assert_eq!(change.kind, ScmChangeKind::Publication);
    assert_ne!(link.task_id.0, change.provider_ref.0);
}

#[test]
fn credential_and_webhook_failures_are_sanitized_evidence() {
    let credential = credential_failure_evidence();
    assert_eq!(credential.status, CredentialStatus::Missing);
    assert_eq!(
        credential.failure_kind,
        Some(CredentialFailureKind::Missing)
    );
    assert!(credential.summary.is_some());

    let webhook = rejected_webhook_evidence();
    assert_eq!(webhook.status, WebhookVerificationStatus::Rejected);
    assert_eq!(
        webhook.failure_kind,
        Some(WebhookVerificationFailureKind::InvalidSignature)
    );
    assert!(webhook.summary.is_some());
}

#[test]
fn conflicts_and_abandoned_review_keep_distinct_audit_state() {
    let file_conflict = scm_file_conflict();
    assert_eq!(file_conflict.kind, ScmConflictKind::ScmFileMerge);
    assert_eq!(
        file_conflict.resolution_policy,
        ScmConflictResolutionPolicy::StewardMayPropose
    );

    let task_conflict = task_semantic_conflict();
    assert_eq!(task_conflict.kind, ScmConflictKind::TaskSemantic);
    assert_eq!(
        task_conflict.resolution_policy,
        ScmConflictResolutionPolicy::HumanApprovalRequired
    );

    let review = abandoned_review_workflow();
    assert_eq!(review.status, ReviewWorkflowStatus::Abandoned);
    assert_eq!(
        review.outcome,
        Some(ReviewOutcome::AbandonedWithWorkRetained)
    );
}
