//! Read-only Git status projection into neutral SCM inspection records.
//!
//! This module does not spawn Git, read the filesystem, mutate refs, or contact
//! remotes. It only records the output shape a command-backed adapter must
//! produce after receiving read-only command evidence from the server runtime.

use crate::ids::{ScmProviderRef, ScmRepositoryRefId, ScmWorktreeRefId};
use crate::scm::{
    ScmBranchRef, ScmChangeKind, ScmChangeRef, ScmProviderKind, ScmWorktreeDirtyState,
};

/// Access mode used to produce an SCM inspection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmInspectionAccess {
    ReadOnly,
}

/// Provider-neutral working copy inspection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmWorkingCopyInspection {
    pub repository_id: ScmRepositoryRefId,
    pub worktree_id: Option<ScmWorktreeRefId>,
    pub provider_kind: ScmProviderKind,
    pub access: ScmInspectionAccess,
    pub head: ScmHeadState,
    pub upstream: ScmUpstreamState,
    pub dirty_state: ScmWorktreeDirtyState,
    pub paths: Vec<ScmPathStatus>,
    pub issues: Vec<ScmWorkingCopyInspectionIssue>,
}

impl ScmWorkingCopyInspection {
    pub fn is_read_only(&self) -> bool {
        self.access == ScmInspectionAccess::ReadOnly
    }
}

/// Provider-neutral current head state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmHeadState {
    Branch(ScmBranchRef),
    Detached(ScmChangeRef),
    Unborn,
    Unknown,
}

/// Provider-neutral upstream/tracking state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmUpstreamState {
    Tracked(ScmBranchRef),
    Missing,
    NotApplicable,
    Unknown,
}

/// Provider-neutral path status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScmPathStatus {
    pub path: String,
    pub original_path: Option<String>,
    pub kind: ScmPathChangeKind,
}

/// Provider-neutral path change kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmPathChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
    Untracked,
    Ignored,
    Conflicted,
    ProviderSpecific(String),
}

/// Non-fatal issue discovered during inspection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ScmWorkingCopyInspectionIssue {
    MissingUpstream,
    DetachedHead,
    UnbornHead,
    ProviderSpecific(String),
}

/// Git status snapshot supplied by a command-backed adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitStatusSnapshot {
    pub repository_id: ScmRepositoryRefId,
    pub worktree_id: Option<ScmWorktreeRefId>,
    pub branch_name: Option<String>,
    pub head_oid: Option<String>,
    pub detached_head: bool,
    pub upstream_name: Option<String>,
    pub entries: Vec<GitStatusEntry>,
}

impl GitStatusSnapshot {
    /// Convert a Git-specific status snapshot into neutral SCM records.
    pub fn into_working_copy_inspection(self) -> ScmWorkingCopyInspection {
        let head = self.git_head_state();
        let upstream = self.git_upstream_state();
        let paths = self
            .entries
            .into_iter()
            .map(GitStatusEntry::into_path_status)
            .collect::<Vec<_>>();
        let dirty_state = if paths.is_empty() {
            ScmWorktreeDirtyState::Clean
        } else {
            ScmWorktreeDirtyState::CodeChangesPresent
        };
        let mut issues = Vec::new();

        if matches!(head, ScmHeadState::Detached(_)) {
            issues.push(ScmWorkingCopyInspectionIssue::DetachedHead);
        }
        if matches!(head, ScmHeadState::Unborn) {
            issues.push(ScmWorkingCopyInspectionIssue::UnbornHead);
        }
        if matches!(upstream, ScmUpstreamState::Missing) {
            issues.push(ScmWorkingCopyInspectionIssue::MissingUpstream);
        }

        ScmWorkingCopyInspection {
            repository_id: self.repository_id,
            worktree_id: self.worktree_id,
            provider_kind: ScmProviderKind::Git,
            access: ScmInspectionAccess::ReadOnly,
            head,
            upstream,
            dirty_state,
            paths,
            issues,
        }
    }

    fn git_head_state(&self) -> ScmHeadState {
        if self.detached_head {
            return self
                .head_oid
                .as_ref()
                .map(|oid| {
                    ScmHeadState::Detached(ScmChangeRef {
                        repository_id: self.repository_id.clone(),
                        kind: ScmChangeKind::Commit,
                        provider_ref: ScmProviderRef(format!("git:commit:{oid}")),
                        summary: None,
                    })
                })
                .unwrap_or(ScmHeadState::Unknown);
        }

        self.branch_name
            .as_ref()
            .map(|name| {
                ScmHeadState::Branch(ScmBranchRef {
                    repository_id: self.repository_id.clone(),
                    name: name.clone(),
                    provider_ref: Some(ScmProviderRef(format!("refs/heads/{name}"))),
                })
            })
            .unwrap_or_else(|| {
                if self.head_oid.is_none() {
                    ScmHeadState::Unborn
                } else {
                    ScmHeadState::Unknown
                }
            })
    }

    fn git_upstream_state(&self) -> ScmUpstreamState {
        if self.detached_head {
            return ScmUpstreamState::NotApplicable;
        }

        match (&self.branch_name, &self.upstream_name) {
            (Some(_), Some(upstream_name)) => ScmUpstreamState::Tracked(ScmBranchRef {
                repository_id: self.repository_id.clone(),
                name: upstream_name.clone(),
                provider_ref: Some(ScmProviderRef(format!("refs/remotes/{upstream_name}"))),
            }),
            (Some(_), None) => ScmUpstreamState::Missing,
            (None, _) => ScmUpstreamState::Unknown,
        }
    }
}

/// One Git path status entry after command evidence has already been parsed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitStatusEntry {
    pub path: String,
    pub original_path: Option<String>,
    pub kind: GitStatusEntryKind,
}

impl GitStatusEntry {
    fn into_path_status(self) -> ScmPathStatus {
        ScmPathStatus {
            path: self.path,
            original_path: self.original_path,
            kind: match self.kind {
                GitStatusEntryKind::Added => ScmPathChangeKind::Added,
                GitStatusEntryKind::Modified => ScmPathChangeKind::Modified,
                GitStatusEntryKind::Deleted => ScmPathChangeKind::Deleted,
                GitStatusEntryKind::Renamed => ScmPathChangeKind::Renamed,
                GitStatusEntryKind::TypeChanged => ScmPathChangeKind::TypeChanged,
                GitStatusEntryKind::Untracked => ScmPathChangeKind::Untracked,
                GitStatusEntryKind::Ignored => ScmPathChangeKind::Ignored,
                GitStatusEntryKind::Conflicted => ScmPathChangeKind::Conflicted,
                GitStatusEntryKind::ProviderSpecific(value) => {
                    ScmPathChangeKind::ProviderSpecific(value)
                }
            },
        }
    }
}

/// Git-specific path status kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitStatusEntryKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
    Untracked,
    Ignored,
    Conflicted,
    ProviderSpecific(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_id() -> ScmRepositoryRefId {
        ScmRepositoryRefId("repo:primary".to_owned())
    }

    #[test]
    fn git_clean_branch_with_upstream_projects_to_read_only_neutral_inspection() {
        let inspection = GitStatusSnapshot {
            repository_id: repo_id(),
            worktree_id: None,
            branch_name: Some("main".to_owned()),
            head_oid: Some("abc123".to_owned()),
            detached_head: false,
            upstream_name: Some("origin/main".to_owned()),
            entries: Vec::new(),
        }
        .into_working_copy_inspection();

        assert!(inspection.is_read_only());
        assert_eq!(inspection.provider_kind, ScmProviderKind::Git);
        assert_eq!(inspection.dirty_state, ScmWorktreeDirtyState::Clean);
        assert!(matches!(inspection.head, ScmHeadState::Branch(_)));
        assert!(matches!(inspection.upstream, ScmUpstreamState::Tracked(_)));
        assert!(inspection.issues.is_empty());
    }

    #[test]
    fn git_dirty_branch_projects_path_changes_without_mutation() {
        let inspection = GitStatusSnapshot {
            repository_id: repo_id(),
            worktree_id: Some(ScmWorktreeRefId("worktree:primary".to_owned())),
            branch_name: Some("feature/task".to_owned()),
            head_oid: Some("def456".to_owned()),
            detached_head: false,
            upstream_name: Some("origin/feature/task".to_owned()),
            entries: vec![
                GitStatusEntry {
                    path: "src/lib.rs".to_owned(),
                    original_path: None,
                    kind: GitStatusEntryKind::Modified,
                },
                GitStatusEntry {
                    path: "src/new.rs".to_owned(),
                    original_path: None,
                    kind: GitStatusEntryKind::Untracked,
                },
            ],
        }
        .into_working_copy_inspection();

        assert!(inspection.is_read_only());
        assert_eq!(
            inspection.dirty_state,
            ScmWorktreeDirtyState::CodeChangesPresent
        );
        assert_eq!(inspection.paths.len(), 2);
        assert!(inspection
            .paths
            .iter()
            .any(|path| path.kind == ScmPathChangeKind::Untracked));
    }

    #[test]
    fn git_detached_head_uses_provider_neutral_change_ref() {
        let inspection = GitStatusSnapshot {
            repository_id: repo_id(),
            worktree_id: None,
            branch_name: None,
            head_oid: Some("789abc".to_owned()),
            detached_head: true,
            upstream_name: None,
            entries: Vec::new(),
        }
        .into_working_copy_inspection();

        let ScmHeadState::Detached(change_ref) = inspection.head else {
            panic!("expected detached change ref");
        };

        assert_eq!(change_ref.kind, ScmChangeKind::Commit);
        assert_eq!(
            change_ref.provider_ref,
            ScmProviderRef("git:commit:789abc".to_owned())
        );
        assert!(matches!(
            inspection.upstream,
            ScmUpstreamState::NotApplicable
        ));
        assert!(inspection
            .issues
            .contains(&ScmWorkingCopyInspectionIssue::DetachedHead));
    }

    #[test]
    fn git_missing_upstream_is_explicit() {
        let inspection = GitStatusSnapshot {
            repository_id: repo_id(),
            worktree_id: None,
            branch_name: Some("local-only".to_owned()),
            head_oid: Some("abc789".to_owned()),
            detached_head: false,
            upstream_name: None,
            entries: Vec::new(),
        }
        .into_working_copy_inspection();

        assert!(matches!(inspection.upstream, ScmUpstreamState::Missing));
        assert!(inspection
            .issues
            .contains(&ScmWorkingCopyInspectionIssue::MissingUpstream));
    }

    #[test]
    fn neutral_inspection_does_not_require_git_commit_head() {
        let inspection = ScmWorkingCopyInspection {
            repository_id: repo_id(),
            worktree_id: None,
            provider_kind: ScmProviderKind::Convergence,
            access: ScmInspectionAccess::ReadOnly,
            head: ScmHeadState::Unknown,
            upstream: ScmUpstreamState::Unknown,
            dirty_state: ScmWorktreeDirtyState::Unknown,
            paths: Vec::new(),
            issues: Vec::new(),
        };

        assert!(inspection.is_read_only());
        assert_eq!(inspection.provider_kind, ScmProviderKind::Convergence);
        assert!(matches!(inspection.head, ScmHeadState::Unknown));
    }
}
