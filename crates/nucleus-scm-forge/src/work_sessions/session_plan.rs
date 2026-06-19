use crate::ids::{ScmRepositoryRefId, ScmWorkSessionId};
use crate::scm::{
    ScmBranchRef, ScmChangeRef, ScmProviderKind, ScmRuntimeConstraint, ScmWorkSessionStatus,
    ScmWorkflowPrimitive, ScmWorktreeRef,
};

/// Planned working-copy session for human or agent work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmWorkingCopySessionPlan {
    pub id: ScmWorkSessionId,
    pub repository_id: ScmRepositoryRefId,
    pub provider_kind: ScmProviderKind,
    pub mode: ScmWorkingCopySessionMode,
    pub base_change: Option<ScmChangeRef>,
    pub intended_target: Option<ScmBranchRef>,
    pub cleanup: ScmSessionCleanupPolicy,
    pub testability: ScmSessionTestability,
    pub runtime_constraints: Vec<ScmRuntimeConstraint>,
    pub status: ScmWorkSessionStatus,
}

impl ScmWorkingCopySessionPlan {
    /// Plan work in the primary project checkout.
    pub fn primary_tree_session(
        id: ScmWorkSessionId,
        repository_id: ScmRepositoryRefId,
        provider_kind: ScmProviderKind,
        branch_like_ref: Option<ScmBranchRef>,
        base_change: Option<ScmChangeRef>,
        intended_target: Option<ScmBranchRef>,
    ) -> Self {
        Self {
            id,
            repository_id: repository_id.clone(),
            provider_kind,
            mode: ScmWorkingCopySessionMode::PrimaryTree {
                location: ScmWorkingCopyLocation::PrimaryProjectCheckout,
                branch_like_ref,
                shared_checkout: true,
            },
            base_change,
            intended_target,
            cleanup: ScmSessionCleanupPolicy::RestorePrimaryTree {
                require_clean_or_recoverable_state: true,
                retain_unmerged_work: true,
            },
            testability: ScmSessionTestability {
                location: ScmSessionTestLocation::PrimaryProjectCheckout,
                user_can_test_in_known_directory: true,
                notes: Some("session runs in the main project checkout".to_owned()),
            },
            runtime_constraints: vec![ScmRuntimeConstraint::SingleRunnableInstance],
            status: ScmWorkSessionStatus::Planned,
        }
    }

    /// Plan work in an isolated checkout, worktree, or provider-equivalent
    /// location.
    pub fn isolated_location_session(
        id: ScmWorkSessionId,
        repository_id: ScmRepositoryRefId,
        provider_kind: ScmProviderKind,
        worktree: Option<ScmWorktreeRef>,
        branch_like_ref: Option<ScmBranchRef>,
        base_change: Option<ScmChangeRef>,
        intended_target: Option<ScmBranchRef>,
    ) -> Self {
        let location = worktree
            .as_ref()
            .and_then(|worktree| worktree.path_hint.clone())
            .map(ScmWorkingCopyLocation::IsolatedPath)
            .unwrap_or(ScmWorkingCopyLocation::ProviderManaged);

        Self {
            id,
            repository_id,
            provider_kind,
            mode: ScmWorkingCopySessionMode::IsolatedLocation {
                location: location.clone(),
                worktree,
                branch_like_ref,
            },
            base_change,
            intended_target,
            cleanup: ScmSessionCleanupPolicy::RemoveIsolatedLocation {
                retain_unmerged_work: true,
                require_human_approval_before_discard: true,
            },
            testability: ScmSessionTestability {
                location: ScmSessionTestLocation::IsolatedLocation(location),
                user_can_test_in_known_directory: false,
                notes: Some("session may need separate runtime setup before testing".to_owned()),
            },
            runtime_constraints: vec![ScmRuntimeConstraint::Isolated],
            status: ScmWorkSessionStatus::Planned,
        }
    }

    pub fn is_primary_tree(&self) -> bool {
        matches!(self.mode, ScmWorkingCopySessionMode::PrimaryTree { .. })
    }

    pub fn is_isolated_location(&self) -> bool {
        matches!(
            self.mode,
            ScmWorkingCopySessionMode::IsolatedLocation { .. }
        )
    }
}

/// How the session isolates changes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmWorkingCopySessionMode {
    PrimaryTree {
        location: ScmWorkingCopyLocation,
        branch_like_ref: Option<ScmBranchRef>,
        shared_checkout: bool,
    },
    IsolatedLocation {
        location: ScmWorkingCopyLocation,
        worktree: Option<ScmWorktreeRef>,
        branch_like_ref: Option<ScmBranchRef>,
    },
    ExternalManaged {
        surface: ScmIsolationSurface,
    },
    Unsupported {
        reason: String,
    },
}

/// Local or provider-managed location used by a session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmWorkingCopyLocation {
    PrimaryProjectCheckout,
    IsolatedPath(String),
    ProviderManaged,
    Unknown,
}

/// Provider-neutral isolation surface.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmIsolationSurface {
    BranchLike(ScmWorkflowPrimitive),
    WorktreeLike(ScmWorkflowPrimitive),
    SnapshotScope(ScmWorkflowPrimitive),
    ProviderSpecific(String),
    Unsupported,
}

/// Cleanup policy after a session finishes or is abandoned.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmSessionCleanupPolicy {
    RestorePrimaryTree {
        require_clean_or_recoverable_state: bool,
        retain_unmerged_work: bool,
    },
    RemoveIsolatedLocation {
        retain_unmerged_work: bool,
        require_human_approval_before_discard: bool,
    },
    RetainForManualReview,
    ProviderManaged,
    Unsupported,
}

impl ScmSessionCleanupPolicy {
    pub fn requires_human_approval(&self) -> bool {
        match self {
            Self::RestorePrimaryTree {
                retain_unmerged_work,
                ..
            } => *retain_unmerged_work,
            Self::RemoveIsolatedLocation {
                require_human_approval_before_discard,
                ..
            } => *require_human_approval_before_discard,
            Self::RetainForManualReview => true,
            Self::ProviderManaged => true,
            Self::Unsupported => true,
        }
    }
}

/// User-facing testability properties for a session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmSessionTestability {
    pub location: ScmSessionTestLocation,
    pub user_can_test_in_known_directory: bool,
    pub notes: Option<String>,
}

/// Where a user should expect to test the session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmSessionTestLocation {
    PrimaryProjectCheckout,
    IsolatedLocation(ScmWorkingCopyLocation),
    External,
    Unknown,
}
