//! SCM and forge review workflow types.

use crate::forge::ForgePullRequestRef;
use crate::ids::{ScmRepositoryRefId, ScmWorkSessionId};
use crate::scm::ScmBranchRef;

/// Stable review workflow id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ReviewWorkflowId(pub String);

/// Server-owned review workflow record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewWorkflow {
    pub id: ReviewWorkflowId,
    pub repository_id: ScmRepositoryRefId,
    pub work_session_id: Option<ScmWorkSessionId>,
    pub pull_request: Option<ForgePullRequestRef>,
    pub target_branch: Option<ScmBranchRef>,
    pub status: ReviewWorkflowStatus,
    pub merge_policy: ReviewMergePolicy,
    pub outcome: Option<ReviewOutcome>,
}

/// Review workflow status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReviewWorkflowStatus {
    Draft,
    Open,
    ChangesRequested,
    Approved,
    ReadyToMerge,
    Merged,
    Rejected,
    Abandoned,
    Blocked,
}

/// Merge policy for a review workflow.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReviewMergePolicy {
    DirectMergeAllowed,
    DirectAuthorityUpdateAllowed,
    ReviewRequestRequired,
    HumanApprovalRequired,
    Unsupported,
}

/// Review workflow outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReviewOutcome {
    Merged,
    Superseded,
    Rejected,
    AbandonedWithWorkRetained,
}
