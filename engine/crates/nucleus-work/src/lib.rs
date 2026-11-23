//! Own the default task worktrees beneath the configured work root.

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use longhorn_git_workspace::{Git, GitFailure, GitFailureCode, GitPolicy};
use longhorn_redact::Redactor;
use nucleus_core::{Head, InvalidHead, Workspace};
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
    root: PathBuf,
    git: Git<'a>,
}

pub struct Checkout<'a> {
    worktrees: &'a Worktrees<'a>,
    repository: PathBuf,
    path: PathBuf,
    branch: String,
}

impl<'a> Worktrees<'a> {
    /// Bind all checkouts to the configured root and caller's Git policy.
    ///
    /// # Errors
    /// Returns an error if the root cannot be created or resolved.
    pub fn new(
        root: &Path,
        policy: &'a dyn GitPolicy,
        redactor: Redactor,
    ) -> Result<Self, WorkError> {
        fs::create_dir_all(root)?;
        Ok(Self {
            root: root.canonicalize()?,
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
        let bucket = format!("{:x}", Sha256::digest(repository_id.as_bytes()));
        let branch = format!("ns-{task_id}");
        Ok(Checkout {
            worktrees: self,
            repository: repository.canonicalize()?,
            path: self.root.join(bucket).join(&branch),
            branch,
        })
    }
}

impl Checkout<'_> {
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
        let common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
        let checkout_root = self.git(&self.path, &["rev-parse", "--show-toplevel"])?;
        let checkout_common = self.git(&self.path, &common)?;
        let repository_common = self.git(&self.repository, &common)?;
        let branch = self.git(&self.path, &["branch", "--show-current"])?;
        if Path::new(checkout_root.trim_end_matches('\n')) != self.path
            || checkout_common != repository_common
            || branch.trim_end_matches('\n') != self.branch
        {
            return Err(WorkError::WrongCheckout);
        }
        let status = self.git(
            &self.path,
            &[
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--ignored=matching",
                "--ignore-submodules=none",
            ],
        )?;
        if status.is_empty() {
            Ok(Workspace::Clean(
                self.git(&self.path, &["rev-parse", "HEAD"])?
                    .trim_end_matches('\n')
                    .parse()?,
            ))
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
        fs::create_dir_all(parent)?;
        if parent.canonicalize()? != parent {
            return Err(WorkError::WrongCheckout);
        }
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

    /// Remove an idle checkout only if it is still clean at the published head.
    /// The caller establishes that its turn and tools have stopped.
    ///
    /// # Errors
    /// Returns an error if the checkout cannot be verified or Git refuses removal.
    pub fn retire(&self, published: &Head) -> Result<Retirement, WorkError> {
        match self.observe()? {
            Workspace::Absent => Ok(Retirement::Absent),
            Workspace::Clean(head) if &head == published => {
                let path = self.path.to_str().ok_or(WorkError::InvalidPath)?;
                self.git(&self.repository, &["worktree", "remove", "--", path])?;
                Ok(Retirement::Removed)
            }
            Workspace::Clean(_) | Workspace::Dirty => Ok(Retirement::Retained),
        }
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
