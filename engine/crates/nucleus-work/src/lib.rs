//! Own the default task worktrees beneath the configured work root.

use std::{
    fs,
    io::{ErrorKind, Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};

use longhorn_git_workspace::{Git, GitFailure, GitFailureCode, GitPolicy, WorktreeIdentity};
use longhorn_redact::Redactor;
use nucleus_core::{Head, InvalidHead, Workspace};
use nucleus_store::{EngineStorage, StorageDirectory, StorageError};
use rustix::fs::{CWD, Mode, OFlags, RenameFlags, open, renameat_with};
use sha2::{Digest, Sha256};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
// TypeScript gitBulk uses GIT_SLOW_TIMEOUT_MS for linked worktree creation.
const WORKTREE_TIMEOUT: Duration = Duration::from_mins(10);
const QUARANTINE: &str = "quarantine";
const QUARANTINE_MARKER: &str = ".nucleus-quarantine";
const QUARANTINE_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_REF: &str = "--format=%(refname)%00%(objectname)%00%(symref)%00%(worktreepath)";
// Keep Git's bounded command runner without collecting one filename per entry.
// `ls-files` quotes embedded newlines. Its records cannot look like the marker
// which confirms that the whole scan completed successfully.
const INDEX_VISIBILITY: &str = concat!(
    r#"alias.nucleus-index-visibility=! { git ls-files -v && printf '%s\n' 'Nucleus index complete'; } | "#,
    r#"awk '$0 == "Nucleus index complete" { complete = 1; next } "#,
    r#"substr($0, 1, 2) != "H " { hidden = 1 } "#,
    r#"END { if (!complete) exit 1; if (hidden) print "hidden" }'"#,
);

#[derive(Debug, thiserror::Error)]
pub enum WorkError {
    #[error("task ID cannot be used for a worktree name")]
    InvalidTaskId,
    #[error("path is occupied by a different checkout")]
    WrongCheckout,
    #[error("Git has not finished initializing the task checkout")]
    Initializing,
    #[error("the task checkout has no published Git index")]
    MissingIndex,
    #[error("the task checkout is missing")]
    MissingCheckout,
    #[error("a previous quarantine still needs its checkout or branch checked")]
    QuarantinePending,
    #[error("could not rename the checkout into quarantine: {0}")]
    QuarantineMove(#[source] std::io::Error),
    #[error("the task branch already exists at another head")]
    WrongBranchHead,
    #[error("worktree path is not usable with Git")]
    InvalidPath,
    #[error("worktree filesystem operation failed")]
    Filesystem(#[from] std::io::Error),
    #[error("the work volume or layout cannot be verified")]
    Storage(#[from] StorageError),
    #[error("{command} failed in {directory:?} for repository {repository:?}: {source}")]
    Git {
        operation: GitOperation,
        command: String,
        directory: PathBuf,
        repository: PathBuf,
        #[source]
        source: GitFailure,
    },
    #[error("worktree head could not be read")]
    Head(#[from] InvalidHead),
}

#[derive(Debug, Clone, Copy, thiserror::Error)]
pub enum GitOperation {
    #[error("git worktree add")]
    Add,
    #[error("git status")]
    Status,
    #[error("the Git checkout operation")]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retirement {
    Absent,
    Retained,
    Removed,
}

pub struct Worktrees<'a> {
    root: StorageDirectory,
    scratch: StorageDirectory,
    git: Git<'a>,
}

pub struct Checkout<'a> {
    worktrees: &'a Worktrees<'a>,
    repository: PathBuf,
    path: PathBuf,
    branch: String,
}

fn quarantine_stamp(name: &str, directory: &fs::Metadata) -> String {
    format!(
        "nucleus checkout quarantine {name} {}:{}\n",
        directory.dev(),
        directory.ino()
    )
}

fn owns_quarantine(marker: &Path, expected: &str) -> bool {
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let Ok(file) = open(marker, flags, Mode::empty()).map(fs::File::from) else {
        return false;
    };
    let Ok(info) = file.metadata() else {
        return false;
    };
    let mut stamp = Vec::new();
    info.is_file()
        && info.len() == expected.len() as u64
        && file.take(info.len() + 1).read_to_end(&mut stamp).is_ok()
        && stamp == expected.as_bytes()
}

/// Expire owned checkout quarantines after seven days on the configured scratch volume.
///
/// # Errors
/// Returns an error if the root or a verified removal cannot be completed.
pub fn prune_quarantines(scratch: &StorageDirectory, now_ms: u64) -> Result<(), WorkError> {
    let root = scratch.path().join(QUARANTINE);
    if missing(&root)? {
        return Ok(());
    }
    scratch.verify()?;
    let device = scratch.path().metadata()?.dev();
    let root_info = root.symlink_metadata()?;
    if !root_info.is_dir() || root_info.dev() != device {
        return Err(WorkError::WrongCheckout);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        if let Some(name) = name.to_str()
            && let Some((_, at)) = name.rsplit_once('-')
            && let Ok(at) = at.parse::<u64>()
            && now_ms.saturating_sub(at) > QUARANTINE_RETENTION_MS
            && let Ok(info) = entry.metadata()
            && info.is_dir()
            && info.dev() == device
            && owns_quarantine(
                &entry.path().join(QUARANTINE_MARKER),
                &quarantine_stamp(name, &info),
            )
        {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
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
            scratch: storage.scratch().clone(),
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

    /// Observe the owned checkout and any changes that prevent clean removal.
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
        let admin = self.admin_directory(&identity)?;
        if initializing(&admin)? {
            return Err(WorkError::Initializing);
        }
        if missing(&admin.join("index"))? {
            return Err(WorkError::MissingIndex);
        }
        let dirty = self.status_dirty(
            &self.path,
            &["--untracked-files=all", "--ignore-submodules=none"],
        )?;
        // Flags that hide working-tree changes invalidate ordinary status evidence.
        // Git uses S for skip-worktree and lowercase tags for assume-unchanged.
        if !dirty
            && self
                .git_named(
                    &self.path,
                    &["-c", INDEX_VISIBILITY, "nucleus-index-visibility"],
                    "git ls-files -v".into(),
                )?
                .is_empty()
        {
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

    /// Quarantine an interrupted initialization and retire its observed branch tip.
    /// The caller holds the task fence and verifies that no role has been sent.
    ///
    /// # Errors
    /// Returns an error if the registration, initialization marker, index or
    /// branch has changed, or if the original directory cannot be renamed.
    pub fn quarantine_initialization(&self, time_ms: u64) -> Result<(), WorkError> {
        self.worktrees.root.verify()?;
        self.worktrees.scratch.ensure_child(Path::new(QUARANTINE))?;
        let root = self.worktrees.scratch.path().join(QUARANTINE);
        let pending = root.join(format!(".{}.pending", self.branch));
        if !missing(&pending)? {
            return Err(WorkError::QuarantinePending);
        }
        let metadata = self.path.symlink_metadata()?;
        if !metadata.is_dir() || self.path.canonicalize()? != self.path {
            return Err(WorkError::WrongCheckout);
        }
        let identity = self.owned_identity()?;
        let admin = self.admin_directory(&identity)?;
        let backlink = fs::read_to_string(admin.join("gitdir"))?;
        if !initializing(&admin)?
            || !missing(&admin.join("index"))?
            || admin.join(backlink.trim_end_matches('\n')).canonicalize()? != self.path.join(".git")
        {
            return Err(WorkError::WrongCheckout);
        }

        let name = format!("{}-{time_ms}", &self.branch["ns-".len()..]);
        let destination = root.join(&name);
        let mut marker = fs::File::create_new(&pending)?;
        marker.write_all(quarantine_stamp(&name, &metadata).as_bytes())?;
        marker.sync_all()?;
        if let Err(error) =
            renameat_with(CWD, &self.path, CWD, &destination, RenameFlags::NOREPLACE)
        {
            let _ = fs::remove_file(&pending);
            return Err(WorkError::QuarantineMove(error.into()));
        }
        fs::hard_link(&pending, destination.join(QUARANTINE_MARKER))?;
        if !missing(&self.path)? {
            return Err(WorkError::WrongCheckout);
        }
        // The task fence excludes allocation. Git validates the named registration.
        self.remove(&["--force", "--force"])?;
        let branch = format!("refs/heads/{}", self.branch);
        let head = identity.head_oid();
        let found = self.git(&self.repository, &["for-each-ref", QUARANTINE_REF, &branch])?;
        if !found.is_empty() {
            if found != format!("{branch}\0{head}\0\0") {
                return Err(WorkError::WrongBranchHead);
            }
            let delete = ["update-ref", "--no-deref", "-d", &branch, head];
            self.git(&self.repository, &delete)?;
        }
        fs::remove_file(pending)?;
        Ok(())
    }

    /// Check that the registered integration checkout has no tracked changes.
    ///
    /// # Errors
    /// Returns an error if Git cannot inspect the checkout.
    pub fn integration_clean(&self) -> Result<bool, WorkError> {
        Ok(!self.status_dirty(&self.repository, &["--untracked-files=no"])?)
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

    /// Fetch the named PR source and verify its advertised head and local ancestry.
    ///
    /// # Errors
    /// Returns an error when the remote reference or commit history is unavailable.
    pub fn pull_descends_from(
        &self,
        pull: i32,
        recorded: &Head,
        merged: &Head,
    ) -> Result<bool, WorkError> {
        let reference = format!("refs/pull/{pull}/head");
        self.git(
            &self.repository,
            &[
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                "--refmap=",
                "origin",
                &reference,
            ],
        )?;
        let advertised = self.git(
            &self.repository,
            &["ls-remote", "--refs", "origin", &reference],
        )?;
        if advertised.trim_end() != format!("{merged}\t{reference}") {
            return Ok(false);
        }
        // An unrelated history gives a nonempty difference. Git read failures remain errors.
        let difference = self.git(
            &self.repository,
            &[
                "rev-list",
                "-1",
                recorded.as_str(),
                "--not",
                merged.as_str(),
            ],
        )?;
        Ok(difference.is_empty())
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
        self.prepare_retirement(published)?()
    }

    /// Observe cleanliness outside the writer fence. The admitted operation rechecks the
    /// owned branch and exact head immediately before unforced removal.
    ///
    /// # Errors
    /// Returns an error if either observation fails or Git refuses removal.
    pub fn prepare_retirement<'a>(
        &'a self,
        published: &'a Head,
    ) -> Result<impl FnOnce() -> Result<Retirement, WorkError> + 'a, WorkError> {
        let workspace = self.observe()?;
        Ok(move || match workspace {
            Workspace::Absent => Ok(Retirement::Absent),
            Workspace::Clean(head) if &head == published => {
                if self.owned_identity()?.head_oid() != published.as_str() {
                    return Ok(Retirement::Retained);
                }
                self.remove(&[])?;
                Ok(Retirement::Removed)
            }
            Workspace::Clean(_) | Workspace::Dirty => Ok(Retirement::Retained),
        })
    }

    fn remove(&self, flags: &[&str]) -> Result<(), WorkError> {
        let mut args = vec!["worktree", "remove"];
        args.extend_from_slice(flags);
        args.extend(["--", self.path.to_str().ok_or(WorkError::InvalidPath)?]);
        self.git(&self.repository, &args)?;
        Ok(())
    }

    fn owned_identity(&self) -> Result<WorktreeIdentity, WorkError> {
        let checkout = self.git_identity(&self.path)?;
        let repository = self.git_identity(&self.repository)?;
        if checkout.root() != self.path
            || repository.root() != self.repository
            || !checkout.same_repository(&repository)
            || checkout.branch() != Some(self.branch.as_str())
        {
            return Err(WorkError::WrongCheckout);
        }
        Ok(checkout)
    }

    fn admin_directory(&self, identity: &WorktreeIdentity) -> Result<PathBuf, WorkError> {
        let link = fs::read_to_string(self.path.join(".git"))?;
        let directory = link
            .trim_end_matches('\n')
            .strip_prefix("gitdir: ")
            .ok_or(WorkError::WrongCheckout)?;
        let directory = self.path.join(directory).canonicalize()?;
        if directory.parent() != Some(identity.common_dir().join("worktrees").as_path()) {
            return Err(WorkError::WrongCheckout);
        }
        Ok(directory)
    }

    fn status_dirty(&self, directory: &Path, flags: &[&str]) -> Result<bool, WorkError> {
        let mut args = vec!["--no-optional-locks", "status", "--porcelain=v1"];
        args.extend_from_slice(flags);
        match self.git_named(directory, &args, "git status".into()) {
            Ok(status) => Ok(!status.is_empty()),
            // Longhorn reports overflow only after Git succeeds.
            Err(WorkError::Git { source, .. })
                if source.code() == GitFailureCode::OutputTooLarge =>
            {
                Ok(true)
            }
            Err(error) => Err(error),
        }
    }

    fn git_identity(&self, directory: &Path) -> Result<WorktreeIdentity, WorkError> {
        self.worktrees
            .git
            .worktree_identity(directory)
            .map_err(|error| {
                self.git_failure(
                    directory,
                    GitOperation::Other,
                    "git rev-parse / symbolic-ref".into(),
                    error,
                )
            })
    }

    fn git(&self, directory: &Path, args: &[&str]) -> Result<String, WorkError> {
        self.git_named(directory, args, format!("git {args:?}"))
    }

    fn git_named(
        &self,
        directory: &Path,
        args: &[&str],
        command: String,
    ) -> Result<String, WorkError> {
        let (operation, timeout) = match args {
            ["worktree", "add", ..] => (GitOperation::Add, WORKTREE_TIMEOUT),
            ["--no-optional-locks", "status", ..] => (GitOperation::Status, GIT_TIMEOUT),
            _ => (GitOperation::Other, GIT_TIMEOUT),
        };
        self.worktrees
            .git
            .run(directory, args, GitFailureCode::CommandUnavailable, timeout)
            .map_err(|error| self.git_failure(directory, operation, command, error))
    }

    fn git_failure(
        &self,
        directory: &Path,
        operation: GitOperation,
        command: String,
        source: GitFailure,
    ) -> WorkError {
        WorkError::Git {
            operation,
            command,
            directory: directory.into(),
            repository: self.repository.clone(),
            source,
        }
    }
}

fn missing(path: &Path) -> Result<bool, WorkError> {
    match path.symlink_metadata() {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}

fn initializing(admin: &Path) -> Result<bool, WorkError> {
    let lock = admin.join("locked");
    if missing(&lock)? {
        return Ok(false);
    }
    let meta = lock.symlink_metadata()?;
    Ok(meta.is_file()
        && meta.len() <= 13
        && matches!(
            fs::read(&lock)?.as_slice(),
            b"initializing" | b"initializing\n"
        ))
}
