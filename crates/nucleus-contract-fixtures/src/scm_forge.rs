//! SCM/forge fixture profile names.

use nucleus_scm_forge::{
    CredentialFailureKind, CredentialReferenceId, CredentialResolutionBoundary, CredentialStatus,
    CredentialUseEvidence, ReviewMergePolicy, ReviewOutcome, ReviewWorkflow, ReviewWorkflowId,
    ReviewWorkflowStatus, ScmChangeKind, ScmChangeRef, ScmConflictId, ScmConflictKind,
    ScmConflictRecord, ScmConflictResolutionPolicy, ScmConflictStatus, ScmProviderRef,
    ScmRepositoryRefId, ScmTaskLink, ScmTaskLinkKind, ScmWorkSessionId, ScmWorkflowPrimitive,
    ScmWorkflowSemantics, TaskLinkSource, TaskLinkStatus, WebhookEndpointId,
    WebhookVerificationEvidence, WebhookVerificationFailureKind, WebhookVerificationStatus,
};
use nucleus_tasks::TaskId;

/// Provider-neutral SCM/forge fixture scenario.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmForgeFixtureProfile {
    GitLikeWorkflow,
    ConvergenceLikeWorkflow,
    GenericForge,
    CredentialFailure,
    WebhookVerification,
    ConflictAndReview,
}

/// Stable repository id used by provider-neutral SCM/forge fixtures.
pub fn fixture_repository_id() -> ScmRepositoryRefId {
    ScmRepositoryRefId("repo-fixture-main".to_owned())
}

/// Git-like workflow: commit is local capture and shared authority.
pub fn git_like_workflow() -> ScmWorkflowSemantics {
    ScmWorkflowSemantics {
        local_capture: ScmWorkflowPrimitive::Commit,
        shared_authority: ScmWorkflowPrimitive::Commit,
        review_boundary: Some(ScmWorkflowPrimitive::Custom("pull-request".to_owned())),
    }
}

/// Convergence-like workflow: snapshot is local capture; publication is shared authority.
pub fn convergence_like_workflow() -> ScmWorkflowSemantics {
    ScmWorkflowSemantics {
        local_capture: ScmWorkflowPrimitive::Snapshot,
        shared_authority: ScmWorkflowPrimitive::Publication,
        review_boundary: Some(ScmWorkflowPrimitive::Gate),
    }
}

/// Provider-neutral task link to a publication change.
pub fn publication_task_link() -> ScmTaskLink {
    ScmTaskLink {
        task_id: TaskId("task-fixture-sync".to_owned()),
        kind: ScmTaskLinkKind::Change(ScmChangeRef {
            repository_id: fixture_repository_id(),
            kind: ScmChangeKind::Publication,
            provider_ref: ScmProviderRef("convergence-publication-fixture".to_owned()),
            summary: Some("fixture publication".to_owned()),
        }),
        source: TaskLinkSource::StewardSuggested,
        status: TaskLinkStatus::Active,
        note: Some("provider ref is metadata, not task identity".to_owned()),
    }
}

/// Sanitized credential failure evidence.
pub fn credential_failure_evidence() -> CredentialUseEvidence {
    CredentialUseEvidence {
        credential_ref: CredentialReferenceId("credential-fixture-missing".to_owned()),
        boundary: CredentialResolutionBoundary::ServerSecretStore,
        status: CredentialStatus::Missing,
        failure_kind: Some(CredentialFailureKind::Missing),
        summary: Some("credential reference could not be resolved".to_owned()),
    }
}

/// Sanitized webhook rejection evidence.
pub fn rejected_webhook_evidence() -> WebhookVerificationEvidence {
    WebhookVerificationEvidence {
        endpoint_id: WebhookEndpointId("webhook-fixture-main".to_owned()),
        status: WebhookVerificationStatus::Rejected,
        provider_event_ref: None,
        failure_kind: Some(WebhookVerificationFailureKind::InvalidSignature),
        summary: Some("webhook signature rejected".to_owned()),
    }
}

/// SCM file conflict fixture.
pub fn scm_file_conflict() -> ScmConflictRecord {
    ScmConflictRecord {
        id: ScmConflictId("conflict-fixture-file".to_owned()),
        repository_id: fixture_repository_id(),
        work_session_id: Some(ScmWorkSessionId("work-session-fixture".to_owned())),
        kind: ScmConflictKind::ScmFileMerge,
        status: ScmConflictStatus::Detected,
        resolution_policy: ScmConflictResolutionPolicy::StewardMayPropose,
        summary: Some("file merge conflict".to_owned()),
    }
}

/// Semantic task conflict fixture.
pub fn task_semantic_conflict() -> ScmConflictRecord {
    ScmConflictRecord {
        id: ScmConflictId("conflict-fixture-task".to_owned()),
        repository_id: fixture_repository_id(),
        work_session_id: None,
        kind: ScmConflictKind::TaskSemantic,
        status: ScmConflictStatus::HumanApprovalRequired,
        resolution_policy: ScmConflictResolutionPolicy::HumanApprovalRequired,
        summary: Some("semantic task conflict".to_owned()),
    }
}

/// Abandoned review workflow with work retained as audit state.
pub fn abandoned_review_workflow() -> ReviewWorkflow {
    ReviewWorkflow {
        id: ReviewWorkflowId("review-fixture-abandoned".to_owned()),
        repository_id: fixture_repository_id(),
        work_session_id: Some(ScmWorkSessionId("work-session-fixture".to_owned())),
        pull_request: None,
        target_branch: None,
        status: ReviewWorkflowStatus::Abandoned,
        merge_policy: ReviewMergePolicy::ReviewRequestRequired,
        outcome: Some(ReviewOutcome::AbandonedWithWorkRetained),
    }
}
