//! SCM and forge observations.

use std::time::SystemTime;

use crate::auth::CredentialUseEvidence;
use crate::conflicts::ScmConflictId;
use crate::forge::{ForgeIssueRef, ForgePullRequestRef};
use crate::ids::{
    ForgeAdapterInstanceId, ScmAdapterInstanceId, ScmRepositoryRefId, ScmWorktreeRefId,
};
use crate::reviews::ReviewWorkflowId;
use crate::scm::{ScmBranchRef, ScmChangeRef, ScmCommitRef};
use crate::webhooks::WebhookVerificationEvidence;

/// Stable SCM observation id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmObservationId(pub String);

/// SCM observation emitted by an adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmObservation {
    pub id: ScmObservationId,
    pub adapter_instance_id: ScmAdapterInstanceId,
    pub observed_at: Option<SystemTime>,
    pub dedupe_key: Option<ObservationDedupeKey>,
    pub effect: ObservationEffect,
    pub kind: ScmObservationKind,
}

/// SCM observation kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmObservationKind {
    RepositorySeen(ScmRepositoryRefId),
    WorktreeSeen(ScmWorktreeRefId),
    BranchSeen(ScmBranchRef),
    CommitSeen(ScmCommitRef),
    ChangeSeen(ScmChangeRef),
    ManagementStateChanged,
    CodeChangesPresent,
    SyncConflictDetected,
    ConflictDetected(ScmConflictId),
    ReviewWorkflowChanged(ReviewWorkflowId),
    CredentialUseFailed(CredentialUseEvidence),
}

/// Stable forge observation id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ForgeObservationId(pub String);

/// Forge observation emitted by an adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeObservation {
    pub id: ForgeObservationId,
    pub adapter_instance_id: ForgeAdapterInstanceId,
    pub observed_at: Option<SystemTime>,
    pub refresh_mode: ForgeRefreshMode,
    pub dedupe_key: Option<ObservationDedupeKey>,
    pub effect: ObservationEffect,
    pub kind: ForgeObservationKind,
}

/// How forge state was refreshed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForgeRefreshMode {
    Polling,
    Webhook,
    ManualRefresh,
    Imported,
    Unknown,
}

/// Forge observation kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForgeObservationKind {
    PullRequestSeen(ForgePullRequestRef),
    IssueSeen(ForgeIssueRef),
    CommentSeen,
    ReviewStateChanged,
    ReviewWorkflowChanged(ReviewWorkflowId),
    WebhookReceived,
    WebhookRejected(WebhookVerificationEvidence),
    CredentialUseFailed(CredentialUseEvidence),
    PollCompleted,
}

/// Stable key for later duplicate suppression.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ObservationDedupeKey(pub String);

/// How an observation may affect Nucleus state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObservationEffect {
    Informational,
    UpdatesProjectActivity,
    ProposesTaskLink,
    UpdatesTaskLinkStatus,
    ProposesTaskHistorySummary,
    RequiresHumanReview,
}
