//! Provider-neutral working-copy session planning records.
//!
//! These records describe the session shape Nucleus intends to use. They do
//! not create branches, create worktrees, switch refs, delete directories,
//! merge changes, or call a provider.

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

/// Pre-execution review record for a working-copy session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmWorkingSessionExecutionPrep {
    pub session_id: ScmWorkSessionId,
    pub repository_id: ScmRepositoryRefId,
    pub mode: ScmWorkingCopySessionMode,
    pub guard_checks: Vec<ScmSessionGuardCheck>,
    pub cleanup: ScmSessionCleanupPolicy,
    pub status: ScmWorkingSessionExecutionPrepStatus,
    pub provider_mutation_allowed: bool,
}

impl ScmWorkingSessionExecutionPrep {
    pub fn from_plan(plan: &ScmWorkingCopySessionPlan) -> Self {
        let mut guard_checks = vec![ScmSessionGuardCheck::RuntimeConstraintsKnown];
        match &plan.mode {
            ScmWorkingCopySessionMode::PrimaryTree { .. } => {
                guard_checks.push(ScmSessionGuardCheck::CleanOrRecoverablePrimaryTree);
                guard_checks.push(ScmSessionGuardCheck::TargetRefReviewed);
            }
            ScmWorkingCopySessionMode::IsolatedLocation { location, .. } => {
                guard_checks.push(ScmSessionGuardCheck::IsolatedLocationReviewed(
                    location.clone(),
                ));
                guard_checks.push(ScmSessionGuardCheck::CleanupPolicyReviewed);
            }
            ScmWorkingCopySessionMode::ExternalManaged { .. } => {
                guard_checks.push(ScmSessionGuardCheck::ProviderManagedSurfaceReviewed);
            }
            ScmWorkingCopySessionMode::Unsupported { reason } => {
                return Self {
                    session_id: plan.id.clone(),
                    repository_id: plan.repository_id.clone(),
                    mode: plan.mode.clone(),
                    guard_checks,
                    cleanup: plan.cleanup.clone(),
                    status: ScmWorkingSessionExecutionPrepStatus::Blocked(reason.clone()),
                    provider_mutation_allowed: false,
                };
            }
        }

        let status = if plan
            .runtime_constraints
            .contains(&ScmRuntimeConstraint::Unknown)
        {
            ScmWorkingSessionExecutionPrepStatus::Blocked(
                "runtime constraints must be known before execution".to_owned(),
            )
        } else {
            ScmWorkingSessionExecutionPrepStatus::ReadyForAdmission
        };

        Self {
            session_id: plan.id.clone(),
            repository_id: plan.repository_id.clone(),
            mode: plan.mode.clone(),
            guard_checks,
            cleanup: plan.cleanup.clone(),
            status,
            provider_mutation_allowed: false,
        }
    }
}

/// Guard check that must be reviewed before session execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmSessionGuardCheck {
    RuntimeConstraintsKnown,
    CleanOrRecoverablePrimaryTree,
    TargetRefReviewed,
    IsolatedLocationReviewed(ScmWorkingCopyLocation),
    CleanupPolicyReviewed,
    ProviderManagedSurfaceReviewed,
}

/// Working-session execution prep state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmWorkingSessionExecutionPrepStatus {
    ReadyForAdmission,
    Blocked(String),
}

/// Stable id for a working-session cleanup or repair record.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmSessionRecoveryRecordId(pub String);

/// Cleanup or repair record for interrupted working sessions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmSessionRecoveryRecord {
    pub id: ScmSessionRecoveryRecordId,
    pub session_id: ScmWorkSessionId,
    pub state: ScmSessionRecoveryState,
    pub cleanup: ScmSessionCleanupPolicy,
    pub evidence_refs: Vec<String>,
    pub requires_human_approval: bool,
    pub provider_mutation_allowed: bool,
}

impl ScmSessionRecoveryRecord {
    pub fn cleanup_ready(
        id: ScmSessionRecoveryRecordId,
        plan: &ScmWorkingCopySessionPlan,
        evidence_refs: Vec<String>,
    ) -> Self {
        Self {
            id,
            session_id: plan.id.clone(),
            state: ScmSessionRecoveryState::CleanupReady,
            cleanup: plan.cleanup.clone(),
            evidence_refs,
            requires_human_approval: plan.cleanup.requires_human_approval(),
            provider_mutation_allowed: false,
        }
    }

    pub fn repair_required(
        id: ScmSessionRecoveryRecordId,
        plan: &ScmWorkingCopySessionPlan,
        reason: String,
        evidence_refs: Vec<String>,
    ) -> Self {
        Self {
            id,
            session_id: plan.id.clone(),
            state: ScmSessionRecoveryState::RepairRequired(reason),
            cleanup: plan.cleanup.clone(),
            evidence_refs,
            requires_human_approval: true,
            provider_mutation_allowed: false,
        }
    }
}

/// Recovery state for interrupted working sessions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmSessionRecoveryState {
    Abandoned,
    Blocked(String),
    RepairRequired(String),
    CleanupReady,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{ScmProviderRef, ScmWorktreeRefId};
    use crate::scm::{ScmChangeKind, ScmWorktreeDirtyState};

    fn repo_id() -> ScmRepositoryRefId {
        ScmRepositoryRefId("repo:primary".to_owned())
    }

    fn session_id(value: &str) -> ScmWorkSessionId {
        ScmWorkSessionId(value.to_owned())
    }

    fn branch(name: &str) -> ScmBranchRef {
        ScmBranchRef {
            repository_id: repo_id(),
            name: name.to_owned(),
            provider_ref: Some(ScmProviderRef(format!("refs/heads/{name}"))),
        }
    }

    fn change_ref() -> ScmChangeRef {
        ScmChangeRef {
            repository_id: repo_id(),
            kind: ScmChangeKind::Commit,
            provider_ref: ScmProviderRef("git:commit:abc123".to_owned()),
            summary: Some("base".to_owned()),
        }
    }

    #[test]
    fn primary_tree_session_marks_shared_checkout_and_known_test_location() {
        let plan = ScmWorkingCopySessionPlan::primary_tree_session(
            session_id("session:primary"),
            repo_id(),
            ScmProviderKind::Git,
            Some(branch("nucleus/task-123")),
            Some(change_ref()),
            Some(branch("main")),
        );

        assert!(plan.is_primary_tree());
        assert_eq!(plan.status, ScmWorkSessionStatus::Planned);
        assert!(plan
            .runtime_constraints
            .contains(&ScmRuntimeConstraint::SingleRunnableInstance));
        assert_eq!(
            plan.cleanup,
            ScmSessionCleanupPolicy::RestorePrimaryTree {
                require_clean_or_recoverable_state: true,
                retain_unmerged_work: true
            }
        );
        assert_eq!(
            plan.testability.location,
            ScmSessionTestLocation::PrimaryProjectCheckout
        );
        assert!(plan.testability.user_can_test_in_known_directory);
    }

    #[test]
    fn isolated_location_session_records_cleanup_and_testability_tradeoff() {
        let worktree = ScmWorktreeRef {
            id: ScmWorktreeRefId("worktree:task-123".to_owned()),
            repository_id: repo_id(),
            path_hint: Some("../nucleus-task-123".to_owned()),
            branch: Some(branch("nucleus/task-123")),
            dirty_state: ScmWorktreeDirtyState::Clean,
        };
        let plan = ScmWorkingCopySessionPlan::isolated_location_session(
            session_id("session:isolated"),
            repo_id(),
            ScmProviderKind::Git,
            Some(worktree),
            Some(branch("nucleus/task-123")),
            Some(change_ref()),
            Some(branch("main")),
        );

        assert!(plan.is_isolated_location());
        assert!(plan
            .runtime_constraints
            .contains(&ScmRuntimeConstraint::Isolated));
        assert_eq!(
            plan.cleanup,
            ScmSessionCleanupPolicy::RemoveIsolatedLocation {
                retain_unmerged_work: true,
                require_human_approval_before_discard: true
            }
        );
        assert!(!plan.testability.user_can_test_in_known_directory);
        assert!(matches!(
            plan.testability.location,
            ScmSessionTestLocation::IsolatedLocation(ScmWorkingCopyLocation::IsolatedPath(_))
        ));
    }

    #[test]
    fn session_modes_allow_non_git_provider_surfaces() {
        let plan = ScmWorkingCopySessionPlan {
            id: session_id("session:convergence"),
            repository_id: repo_id(),
            provider_kind: ScmProviderKind::Convergence,
            mode: ScmWorkingCopySessionMode::ExternalManaged {
                surface: ScmIsolationSurface::SnapshotScope(ScmWorkflowPrimitive::Snapshot),
            },
            base_change: None,
            intended_target: None,
            cleanup: ScmSessionCleanupPolicy::ProviderManaged,
            testability: ScmSessionTestability {
                location: ScmSessionTestLocation::External,
                user_can_test_in_known_directory: false,
                notes: Some("provider decides the active scope".to_owned()),
            },
            runtime_constraints: vec![ScmRuntimeConstraint::Unknown],
            status: ScmWorkSessionStatus::Planned,
        };

        assert_eq!(plan.provider_kind, ScmProviderKind::Convergence);
        assert!(matches!(
            plan.mode,
            ScmWorkingCopySessionMode::ExternalManaged {
                surface: ScmIsolationSurface::SnapshotScope(ScmWorkflowPrimitive::Snapshot)
            }
        ));
        assert!(!plan.is_primary_tree());
        assert!(!plan.is_isolated_location());
    }

    #[test]
    fn primary_tree_execution_prep_requires_clean_or_recoverable_state_without_mutation() {
        let plan = ScmWorkingCopySessionPlan::primary_tree_session(
            session_id("session:primary:prep"),
            repo_id(),
            ScmProviderKind::Git,
            Some(branch("nucleus/task-123")),
            Some(change_ref()),
            Some(branch("main")),
        );
        let prep = ScmWorkingSessionExecutionPrep::from_plan(&plan);

        assert_eq!(
            prep.status,
            ScmWorkingSessionExecutionPrepStatus::ReadyForAdmission
        );
        assert!(prep
            .guard_checks
            .contains(&ScmSessionGuardCheck::CleanOrRecoverablePrimaryTree));
        assert!(!prep.provider_mutation_allowed);
        assert!(prep.cleanup.requires_human_approval());
    }

    #[test]
    fn isolated_execution_prep_records_location_and_cleanup_review() {
        let worktree = ScmWorktreeRef {
            id: ScmWorktreeRefId("worktree:task-456".to_owned()),
            repository_id: repo_id(),
            path_hint: Some("../nucleus-task-456".to_owned()),
            branch: Some(branch("nucleus/task-456")),
            dirty_state: ScmWorktreeDirtyState::Clean,
        };
        let plan = ScmWorkingCopySessionPlan::isolated_location_session(
            session_id("session:isolated:prep"),
            repo_id(),
            ScmProviderKind::Git,
            Some(worktree),
            Some(branch("nucleus/task-456")),
            Some(change_ref()),
            Some(branch("main")),
        );
        let prep = ScmWorkingSessionExecutionPrep::from_plan(&plan);

        assert_eq!(
            prep.status,
            ScmWorkingSessionExecutionPrepStatus::ReadyForAdmission
        );
        assert!(prep
            .guard_checks
            .iter()
            .any(|check| matches!(check, ScmSessionGuardCheck::IsolatedLocationReviewed(_))));
        assert!(prep
            .guard_checks
            .contains(&ScmSessionGuardCheck::CleanupPolicyReviewed));
        assert!(!prep.provider_mutation_allowed);
    }

    #[test]
    fn execution_prep_blocks_unknown_runtime_constraints() {
        let mut plan = ScmWorkingCopySessionPlan::primary_tree_session(
            session_id("session:blocked:prep"),
            repo_id(),
            ScmProviderKind::Git,
            Some(branch("nucleus/task-789")),
            Some(change_ref()),
            Some(branch("main")),
        );
        plan.runtime_constraints = vec![ScmRuntimeConstraint::Unknown];
        let prep = ScmWorkingSessionExecutionPrep::from_plan(&plan);

        assert!(matches!(
            prep.status,
            ScmWorkingSessionExecutionPrepStatus::Blocked(_)
        ));
        assert!(!prep.provider_mutation_allowed);
    }

    #[test]
    fn recovery_records_keep_cleanup_and_repair_reviewable() {
        let plan = ScmWorkingCopySessionPlan::primary_tree_session(
            session_id("session:recovery"),
            repo_id(),
            ScmProviderKind::Git,
            Some(branch("nucleus/task-recovery")),
            Some(change_ref()),
            Some(branch("main")),
        );
        let cleanup = ScmSessionRecoveryRecord::cleanup_ready(
            ScmSessionRecoveryRecordId("recovery:cleanup".to_owned()),
            &plan,
            vec!["evidence:status-clean".to_owned()],
        );
        let repair = ScmSessionRecoveryRecord::repair_required(
            ScmSessionRecoveryRecordId("recovery:repair".to_owned()),
            &plan,
            "session target ref missing".to_owned(),
            vec!["evidence:missing-ref".to_owned()],
        );

        assert_eq!(cleanup.state, ScmSessionRecoveryState::CleanupReady);
        assert!(cleanup.requires_human_approval);
        assert!(!cleanup.provider_mutation_allowed);
        assert!(matches!(
            repair.state,
            ScmSessionRecoveryState::RepairRequired(_)
        ));
        assert!(repair.requires_human_approval);
        assert!(!repair.provider_mutation_allowed);
    }
}
