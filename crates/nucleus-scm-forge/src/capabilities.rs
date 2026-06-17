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
    InspectWorkingCopy,
    InspectIsolationRefs,
    InspectCapturedChanges,
    DetectDirtyState,
    PrepareManagementCapture,
    CreateManagementCapture,
    ShareManagementCapture,
    OpenReviewBoundary,
    StartPrimaryWorkingCopySession,
    StartIsolatedWorkingCopySession,
    IntegrateWorkSession,
    AbandonWorkSession,
    UseCredentialReference,
    ClassifyConflicts,
    ProposeMechanicalConflictResolution,
}

impl ScmCapability {
    /// Baseline metadata-only profile for Git-like adapters.
    pub fn git_like_profile() -> Vec<Self> {
        vec![
            Self::InspectRepository,
            Self::InspectWorkingCopy,
            Self::InspectIsolationRefs,
            Self::InspectCapturedChanges,
            Self::DetectDirtyState,
            Self::PrepareManagementCapture,
            Self::CreateManagementCapture,
            Self::ShareManagementCapture,
            Self::OpenReviewBoundary,
            Self::StartPrimaryWorkingCopySession,
            Self::StartIsolatedWorkingCopySession,
            Self::IntegrateWorkSession,
            Self::AbandonWorkSession,
            Self::UseCredentialReference,
            Self::ClassifyConflicts,
            Self::ProposeMechanicalConflictResolution,
        ]
    }

    /// Baseline metadata-only profile for Convergence-like adapters.
    pub fn convergence_like_profile() -> Vec<Self> {
        vec![
            Self::InspectRepository,
            Self::InspectWorkingCopy,
            Self::InspectIsolationRefs,
            Self::InspectCapturedChanges,
            Self::DetectDirtyState,
            Self::PrepareManagementCapture,
            Self::CreateManagementCapture,
            Self::ShareManagementCapture,
            Self::OpenReviewBoundary,
            Self::IntegrateWorkSession,
            Self::AbandonWorkSession,
            Self::UseCredentialReference,
            Self::ClassifyConflicts,
            Self::ProposeMechanicalConflictResolution,
        ]
    }
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
    OpenReviewWorkflow,
    InspectReviewWorkflow,
    PollRefresh,
}

#[cfg(test)]
mod tests {
    use super::ScmCapability;

    #[test]
    fn git_like_profile_keeps_explicit_working_copy_sessions() {
        let profile = ScmCapability::git_like_profile();

        assert!(profile.contains(&ScmCapability::CreateManagementCapture));
        assert!(profile.contains(&ScmCapability::ShareManagementCapture));
        assert!(profile.contains(&ScmCapability::StartPrimaryWorkingCopySession));
        assert!(profile.contains(&ScmCapability::StartIsolatedWorkingCopySession));
    }

    #[test]
    fn convergence_like_profile_does_not_require_git_worktree_sessions() {
        let profile = ScmCapability::convergence_like_profile();

        assert!(profile.contains(&ScmCapability::CreateManagementCapture));
        assert!(profile.contains(&ScmCapability::ShareManagementCapture));
        assert!(profile.contains(&ScmCapability::OpenReviewBoundary));
        assert!(!profile.contains(&ScmCapability::StartPrimaryWorkingCopySession));
        assert!(!profile.contains(&ScmCapability::StartIsolatedWorkingCopySession));
    }
}
