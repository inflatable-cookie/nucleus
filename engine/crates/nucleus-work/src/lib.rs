//! Own the default task worktrees beneath the configured work root.

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use longhorn_git_workspace::{Git, GitFailure, GitFailureCode, GitPolicy, WorktreeIdentity};
use longhorn_redact::Redactor;
use nucleus_core::{Head, InvalidHead, Workspace};
use nucleus_store::{EngineStorage, StorageDirectory, StorageError};
use sha2::{Digest, Sha256};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum WorkError {
    #[error("task ID cannot be used for a worktree name")]
    InvalidTaskId,
    #[error("path is occupied by a different checkout")]
    WrongCheckout,
    #[error("the task branch already exists at another head")]
    WrongBranchHead,
    #[error("worktree path is not usable with Git")]
    InvalidPath,
    #[error("worktree filesystem operation failed")]
    Filesystem(#[from] std::io::Error),
    #[error("the work volume or layout cannot be verified")]
    Storage(#[from] StorageError),
    #[error("worktree Git operation failed")]
    Git(#[from] GitFailure),
    #[error("worktree head could not be read")]
    Head(#[from] InvalidHead),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retirement {
    Absent,
    Retained,
    Removed,
}

pub struct Worktrees<'a> {
    root: StorageDirectory,
    git: Git<'a>,
}

pub struct Checkout<'a> {
    worktrees: &'a Worktrees<'a>,
    repository: PathBuf,
    path: PathBuf,
    branch: String,
}

/// Derive the path used for a task checkout without opening the filesystem.
#[must_use]
pub fn checkout_path(root: &Path, repository: &str, task: &str) -> PathBuf {
    let bucket = format!("{:x}", Sha256::digest(repository.as_bytes()));
    root.join(bucket).join(format!("ns-{task}"))
}

impl<'a> Worktrees<'a> {
    /// Bind all checkouts to the configured root and caller's Git policy.
    ///
    /// # Errors
    /// Returns an error if the root cannot be created or resolved.
    pub fn new(
        storage: &EngineStorage,
        policy: &'a dyn GitPolicy,
        redactor: Redactor,
    ) -> Result<Self, WorkError> {
        let root = storage.work().clone();
        root.ensure()?;
        Ok(Self {
            root,
            git: Git::new(policy, redactor),
        })
    }

    /// Resolve a deterministic path and branch for a task without allocating it.
    ///
    /// # Errors
    /// Returns an error if the task ID or repository path cannot be used.
    pub fn checkout(
        &self,
        repository: &Path,
        repository_id: &str,
        task_id: &str,
    ) -> Result<Checkout<'_>, WorkError> {
        if task_id.is_empty()
            || !task_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(WorkError::InvalidTaskId);
        }
        let branch = format!("ns-{task_id}");
        Ok(Checkout {
            worktrees: self,
            repository: repository.canonicalize()?,
            path: checkout_path(self.root.path(), repository_id, task_id),
            branch,
        })
    }
}

impl Checkout<'_> {
    #[must_use]
    pub fn repository(&self) -> &Path {
        &self.repository
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn branch(&self) -> &str {
        &self.branch
    }

    /// Observe the owned checkout, including ignored files that would be lost
    /// if it were removed. An error maps to `Unknown` in the pass loop.
    ///
    /// # Errors
    /// Returns an error if the checkout cannot be inspected or belongs elsewhere.
    pub fn observe(&self) -> Result<Workspace, WorkError> {
        self.worktrees.root.verify()?;
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Workspace::Absent);
            }
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_dir() || self.path.canonicalize()? != self.path {
            return Err(WorkError::WrongCheckout);
        }
        let identity = self.owned_identity()?;
        let status = self.git(
            &self.path,
            &[
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--ignore-submodules=none",
            ],
        )?;
        // Flags that hide working-tree changes invalidate ordinary status evidence.
        // Git uses S for skip-worktree and lowercase tags for assume-unchanged.
        let index = self.git(&self.path, &["ls-files", "-v"])?;
        if status.is_empty() && index.lines().all(|line| line.starts_with("H ")) {
            Ok(Workspace::Clean(identity.head_oid().parse()?))
        } else {
            Ok(Workspace::Dirty)
        }
    }

    /// Allocate the task branch at a known commit. An existing owned checkout
    /// is adopted on retry, including any work in it.
    ///
    /// # Errors
    /// Returns an error if the path is occupied, the branch points elsewhere,
    /// or Git cannot allocate the checkout.
    pub fn allocate(&self, start: &Head) -> Result<Workspace, WorkError> {
        let existing = self.observe()?;
        if existing != Workspace::Absent {
            return Ok(existing);
        }
        let parent = self.path.parent().ok_or(WorkError::InvalidPath)?;
        let bucket = parent
            .strip_prefix(self.worktrees.root.path())
            .map_err(|_| WorkError::WrongCheckout)?;
        self.worktrees.root.ensure_child(bucket)?;
        let path = self.path.to_str().ok_or(WorkError::InvalidPath)?;
        let branch_ref = format!("refs/heads/{}", self.branch);
        let found = self.git(
            &self.repository,
            &["for-each-ref", "--format=%(objectname)", &branch_ref],
        )?;
        let args = if found.is_empty() {
            vec!["worktree", "add", "-b", &self.branch, path, start.as_str()]
        } else if found.trim_end_matches('\n') == start.as_str() {
            vec!["worktree", "add", path, &self.branch]
        } else {
            return Err(WorkError::WrongBranchHead);
        };
        self.git(&self.repository, &args)?;
        self.observe()
    }

    /// Check that the registered integration checkout has no tracked changes.
    ///
    /// # Errors
    /// Returns an error if Git cannot inspect the checkout.
    pub fn integration_clean(&self) -> Result<bool, WorkError> {
        Ok(self
            .git(
                &self.repository,
                &["status", "--porcelain", "--untracked-files=no"],
            )?
            .is_empty())
    }

    /// Prove ancestry using the registered Git object store.
    ///
    /// # Errors
    /// Returns an error if either commit or its history is unreadable.
    pub fn contains(&self, ancestor: &Head, tip: &Head) -> Result<bool, WorkError> {
        let common = self.git(
            &self.repository,
            &["merge-base", ancestor.as_str(), tip.as_str()],
        )?;
        Ok(common.trim() == ancestor.as_str())
    }

    /// Verify that the pinned commit can be checked out locally.
    ///
    /// # Errors
    /// Returns an error if the commit is missing or cannot be read.
    pub fn require_commit(&self, head: &Head) -> Result<(), WorkError> {
        self.git(
            &self.repository,
            &["cat-file", "-e", &format!("{head}^{{commit}}")],
        )?;
        Ok(())
    }

    /// Recover an absent review checkout at an observed PR head. Fetch the
    /// pull ref if its object is not already present locally.
    /// # Errors
    /// Returns an error if the pull ref or exact head is unavailable.
    pub fn allocate_review(&self, head: &Head, pull: i32) -> Result<Workspace, WorkError> {
        self.worktrees.root.verify()?;
        let commit = format!("{}^{{commit}}", head.as_str());
        if self
            .git(&self.repository, &["cat-file", "-e", &commit])
            .is_err()
        {
            let reference = format!("refs/pull/{pull}/head");
            self.git(
                &self.repository,
                &[
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "origin",
                    &reference,
                ],
            )?;
        }
        self.allocate(head)
    }

    /// Remove an idle checkout only if it is still clean at the published head.
    /// The caller establishes that its turn and tools have stopped.
    ///
    /// # Errors
    /// Returns an error if the checkout cannot be verified or Git refuses removal.
    pub fn retire(&self, published: &Head) -> Result<Retirement, WorkError> {
        match self.observe()? {
            Workspace::Absent => Ok(Retirement::Absent),
            Workspace::Clean(head) if &head == published => {
                if self.owned_identity()?.head_oid() != published.as_str() {
                    return Ok(Retirement::Retained);
                }
                let path = self.path.to_str().ok_or(WorkError::InvalidPath)?;
                self.git(&self.repository, &["worktree", "remove", "--", path])?;
                Ok(Retirement::Removed)
            }
            Workspace::Clean(_) | Workspace::Dirty => Ok(Retirement::Retained),
        }
    }

    fn owned_identity(&self) -> Result<WorktreeIdentity, WorkError> {
        let checkout = self.worktrees.git.worktree_identity(&self.path)?;
        let repository = self.worktrees.git.worktree_identity(&self.repository)?;
        if checkout.root() != self.path
            || repository.root() != self.repository
            || !checkout.same_repository(&repository)
            || checkout.branch() != Some(self.branch.as_str())
        {
            return Err(WorkError::WrongCheckout);
        }
        Ok(checkout)
    }

    fn git(&self, directory: &Path, args: &[&str]) -> Result<String, WorkError> {
        Ok(self.worktrees.git.run(
            directory,
            args,
            GitFailureCode::CommandUnavailable,
            GIT_TIMEOUT,
        )?)
    }
}
