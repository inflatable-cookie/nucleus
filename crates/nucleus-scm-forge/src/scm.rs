//! SCM repository, worktree, branch, commit, and remote refs.

use nucleus_projects::RepoMembershipId;

use crate::ids::{ScmProviderRef, ScmRepositoryRefId, ScmWorkSessionId, ScmWorktreeRefId};

/// SCM provider family.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmProviderKind {
    Git,
    Jujutsu,
    Mercurial,
    Pijul,
    Fossil,
    Custom(String),
}

/// Repository reference from the Nucleus point of view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmRepositoryRef {
    pub id: ScmRepositoryRefId,
    pub provider_kind: ScmProviderKind,
    pub repo_membership_id: Option<RepoMembershipId>,
    pub provider_ref: Option<ScmProviderRef>,
    pub display_name: Option<String>,
    pub default_branch: Option<ScmBranchRef>,
}

/// Local worktree reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmWorktreeRef {
    pub id: ScmWorktreeRefId,
    pub repository_id: ScmRepositoryRefId,
    pub path_hint: Option<String>,
    pub branch: Option<ScmBranchRef>,
    pub dirty_state: ScmWorktreeDirtyState,
}

/// Bounded SCM isolation session for human or agent work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmWorkSession {
    pub id: ScmWorkSessionId,
    pub repository_id: ScmRepositoryRefId,
    pub isolation_mode: ScmWorkIsolationMode,
    pub base_ref: Option<ScmChangeRef>,
    pub branch: Option<ScmBranchRef>,
    pub worktree: Option<ScmWorktreeRef>,
    pub merge_target: Option<ScmBranchRef>,
    pub status: ScmWorkSessionStatus,
    pub runtime_constraints: Vec<ScmRuntimeConstraint>,
}

/// How a work session isolates changes from the main project checkout.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmWorkIsolationMode {
    PrimaryWorktreeBranch,
    PerThreadWorktree,
    ExternalManaged,
    Unsupported,
}

/// Coarse lifecycle state for an SCM work session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmWorkSessionStatus {
    Planned,
    Active,
    ReadyForReview,
    ReviewOpen,
    Merged,
    Abandoned,
    Blocked(String),
}

/// Runtime constraint affecting whether a work session can be run or tested.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmRuntimeConstraint {
    SingleRunnableInstance,
    SharedServiceConflict(String),
    Isolated,
    Unknown,
}

/// Coarse worktree dirty state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmWorktreeDirtyState {
    Unknown,
    Clean,
    ManagementStateOnly,
    CodeChangesPresent,
    Mixed,
}

/// Branch reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmBranchRef {
    pub repository_id: ScmRepositoryRefId,
    pub name: String,
    pub provider_ref: Option<ScmProviderRef>,
}

/// Commit reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmCommitRef {
    pub repository_id: ScmRepositoryRefId,
    pub commit_id: String,
    pub provider_ref: Option<ScmProviderRef>,
    pub summary: Option<String>,
}

/// Provider-neutral change reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmChangeRef {
    pub repository_id: ScmRepositoryRefId,
    pub kind: ScmChangeKind,
    pub provider_ref: ScmProviderRef,
    pub summary: Option<String>,
}

/// Provider-neutral change kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmChangeKind {
    Commit,
    ChangeSet,
    Patch,
    Revision,
    Checkin,
    Custom(String),
}

/// Remote reference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmRemoteRef {
    pub repository_id: ScmRepositoryRefId,
    pub name: String,
    pub url_hint: Option<String>,
    pub provider_ref: Option<ScmProviderRef>,
}
