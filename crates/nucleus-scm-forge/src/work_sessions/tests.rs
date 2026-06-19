use super::*;
use crate::ids::{ScmProviderRef, ScmRepositoryRefId, ScmWorkSessionId, ScmWorktreeRefId};
use crate::scm::{
    ScmBranchRef, ScmChangeKind, ScmChangeRef, ScmProviderKind, ScmRuntimeConstraint,
    ScmWorkSessionStatus, ScmWorkflowPrimitive, ScmWorktreeDirtyState, ScmWorktreeRef,
};

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
