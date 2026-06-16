//! Task links to SCM and forge objects.

use nucleus_tasks::TaskId;

use crate::forge::{ForgeCommentRef, ForgeIssueRef, ForgePullRequestRef};
use crate::scm::{ScmBranchRef, ScmChangeRef, ScmCommitRef};

/// Link from a task to an SCM object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmTaskLink {
    pub task_id: TaskId,
    pub kind: ScmTaskLinkKind,
    pub source: TaskLinkSource,
    pub status: TaskLinkStatus,
    pub note: Option<String>,
}

/// SCM task link kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmTaskLinkKind {
    Branch(ScmBranchRef),
    Commit(ScmCommitRef),
    Change(ScmChangeRef),
}

/// Link from a task to a forge object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForgeTaskLink {
    pub task_id: TaskId,
    pub kind: ForgeTaskLinkKind,
    pub source: TaskLinkSource,
    pub status: TaskLinkStatus,
    pub note: Option<String>,
}

/// Forge task link kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForgeTaskLinkKind {
    PullRequest(ForgePullRequestRef),
    Issue(ForgeIssueRef),
    Comment(ForgeCommentRef),
}

/// Source that created or proposed a task link.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskLinkSource {
    UserAuthored,
    AdapterObserved,
    StewardSuggested,
    Imported,
    Custom(String),
}

/// Link freshness from the server's point of view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskLinkStatus {
    Active,
    Stale,
    Missing,
    Superseded,
    Unknown,
}
