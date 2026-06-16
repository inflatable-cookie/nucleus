//! SCM and management-state conflict classification types.

use crate::ids::{ScmRepositoryRefId, ScmWorkSessionId};

/// Stable conflict id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ScmConflictId(pub String);

/// Server-owned conflict record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmConflictRecord {
    pub id: ScmConflictId,
    pub repository_id: ScmRepositoryRefId,
    pub work_session_id: Option<ScmWorkSessionId>,
    pub kind: ScmConflictKind,
    pub status: ScmConflictStatus,
    pub resolution_policy: ScmConflictResolutionPolicy,
    pub summary: Option<String>,
}

/// Conflict class.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmConflictKind {
    ScmFileMerge,
    ProjectionSchema,
    ProjectionSemantic,
    TaskSemantic,
    ProjectIdentity,
    RepoMembership,
    ReviewDivergence,
    CredentialOrPermission,
    Custom(String),
}

/// Conflict workflow status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmConflictStatus {
    Detected,
    MechanicalResolutionAvailable,
    HumanApprovalRequired,
    Resolved,
    Abandoned,
    Superseded,
}

/// Who may resolve a conflict.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmConflictResolutionPolicy {
    StewardMayResolveMechanically,
    StewardMayPropose,
    HumanApprovalRequired,
    Unsupported,
}
