//! SCM and forge adapter capabilities.

/// Top-level adapter capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmForgeAdapterCapability {
    Scm(ScmCapability),
    Forge(ForgeCapability),
}

/// SCM capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmCapability {
    InspectRepository,
    InspectWorktree,
    InspectBranches,
    InspectCommits,
    DetectDirtyState,
    PrepareManagementCommit,
    CreateManagementCommit,
    PushManagementCommit,
    OpenReviewBranch,
    StartPrimaryWorktreeSession,
    StartPerThreadWorktreeSession,
    MergeWorkSession,
    AbandonWorkSession,
    UseCredentialReference,
}

/// Forge capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForgeCapability {
    InspectRepository,
    InspectPullRequests,
    InspectIssues,
    InspectComments,
    CreatePullRequest,
    LinkIssue,
    PostComment,
    ReceiveWebhook,
    VerifyWebhook,
    UseCredentialReference,
    PollRefresh,
}
