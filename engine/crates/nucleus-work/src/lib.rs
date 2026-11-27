//! Own the default task worktrees beneath the configured work root.

use std::{
    ffi::OsStr,
    fs,
    io::{ErrorKind, Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
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
const TRASH: &str = ".trash";
const TRASH_CHECKOUT: &str = "checkout";
const TRASH_MARKER: &str = ".nucleus-trash";
// Grace window before sweeping a trash entry whose checkout rename has not completed yet.
const TRASH_ORPHAN_GRACE_MS: u64 = 60_000;
static TRASH_SEQUENCE: AtomicU64 = AtomicU64::new(0);
// Git's bounded runner closes stdin. Batch lookup reports absence on stdout
// while a failed Git invocation still carries its own error.
const COMMIT_INFO: &str = r#"alias.nucleus-commit-info=!f() { printf '%s\n' "$1" | git cat-file '--batch-check=%(objecttype)'; }; f"#;
// Keep Git's bounded command runner without collecting one filename per entry.
// `ls-files` quotes embedded newlines. Its records cannot look like the marker
// which confirms that the whole scan completed successfully.
const INDEX_VISIBILITY: &str = concat!(
    r#"alias.nucleus-index-visibility=! { git ls-files -v && "#,
    r#"{ test ! -e .gitmodules || git submodule --quiet foreach --recursive 'git ls-files -v'; } && "#,
    r#"printf '%s\n' 'Nucleus index complete'; } | "#,
    r#"awk '$0 == "Nucleus index complete" { complete = 1; next } "#,
    r#"substr($0, 1, 2) != "H " { hidden = 1 } "#,
    r#"END { if (!complete) exit 1; if (hidden) print "hidden" }'"#,
);

// Reduce potentially thousands of names to one answer. The sentinel requires
// successful Git completion. Porcelain quotes newlines inside file names.
macro_rules! deletions_only_alias {
    ($name:literal, $untracked:literal) => {
        concat!(
            "alias.",
            $name,
            r#"=! { git ls-files -v --stage && "#,
            "git --no-optional-locks status --porcelain=v1 --untracked-files=",
            $untracked,
            r#" --ignore-submodules=none && printf '%s\n' 'Nucleus scan complete'; } | "#,
            r#"awk '$0 == "Nucleus scan complete" { complete=1; next } "#,
            r#"/^H (100644|100755|120000) [0-9a-f]+ 0\t/ { next } "#,
            r#"substr($0,1,3) == " D " { deleted=1; next } { other=1 } "#,
            r#"END { if (!complete) exit 1; if (deleted && !other) print "deletions" }'"#,
        )
    };
}

const DELETIONS_ONLY: &str = deletions_only_alias!("nucleus-deletions-only", "all");
const TRACKED_DELETIONS_ONLY: &str = deletions_only_alias!("nucleus-tracked-deletions-only", "no");

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
    #[error("origin/{base} does not contain the landed commit of prerequisite {prerequisite}")]
    UnlandedPrerequisite { base: String, prerequisite: String },
    #[error("worktree path is not usable with Git")]
    InvalidPath,
    #[error("worktree filesystem operation failed")]
    Filesystem(#[from] std::io::Error),
    #[error("could not prune checkout trash ({0})")]
    TrashPrune(String),
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
    #[error("git fetch")]
    Fetch,
    #[error("the Git checkout operation")]
    Other,
}

/// The commit a satisfied prerequisite recorded when it landed on the base.
#[derive(Debug, Clone)]
pub struct Landing {
    pub prerequisite: String,
    pub commit: Head,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retirement {
    Absent,
    Retained,
    Removed,
}

/// Shared by a blocking call and the caller awaiting it. A caller which stops
/// waiting refuses every later mutation and can tell whether one is running.
#[derive(Debug, Default)]
pub struct Custody(Mutex<Claim>);

#[derive(Debug, Default)]
struct Claim {
    abandoned: bool,
    mutating: u32,
}

/// One admitted mutation, running until this is dropped.
#[derive(Debug)]
pub struct Mutation<'a>(&'a Custody);

impl Custody {
    /// Admit one mutation.
    ///
    /// # Errors
    /// Refuses once the caller has stopped waiting.
    pub fn mutate(&self) -> Result<Mutation<'_>, StorageError> {
        let mut claim = self.claim();
        if claim.abandoned {
            return Err(StorageError::VolumeUnavailable);
        }
        claim.mutating += 1;
        Ok(Mutation(self))
    }

    /// Stop waiting for the call.
    pub fn abandon(&self) {
        self.claim().abandoned = true;
    }

    /// Whether an admitted mutation is still running. Its end is the only proof
    /// that it can no longer take effect.
    #[must_use]
    pub fn mutating(&self) -> bool {
        self.claim().mutating > 0
    }

    fn claim(&self) -> std::sync::MutexGuard<'_, Claim> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for Mutation<'_> {
    fn drop(&mut self) {
        self.0.claim().mutating -= 1;
    }
}

pub struct Worktrees<'a> {
    root: StorageDirectory,
    scratch: StorageDirectory,
    git: Git<'a>,
    custody: Arc<Custody>,
}

pub struct Checkout<'a> {
    worktrees: &'a Worktrees<'a>,
    repository: PathBuf,
    path: PathBuf,
    branch: String,
}

// An unreadable registered checkout is an unverified layout, which can return.
fn require_registered(repository: &Path) -> Result<(), WorkError> {
    let found = repository
        .canonicalize()
        .map_err(|_| StorageError::VolumeUnavailable)?;
    if found == repository {
        Ok(())
    } else {
        Err(WorkError::WrongCheckout)
    }
}

fn quarantine_stamp(name: &str, directory: &fs::Metadata) -> String {
    format!(
        "nucleus checkout quarantine {name} {}:{}\n",
        directory.dev(),
        directory.ino()
    )
}

fn trash_stamp(name: &str, entry: &fs::Metadata, checkout: &fs::Metadata) -> String {
    format!(
        "nucleus checkout trash {name} {}:{} {}:{}\n",
        entry.dev(),
        entry.ino(),
        checkout.dev(),
        checkout.ino()
    )
}

fn read_verified_stamp(marker: &Path, max_len: u64) -> Option<Vec<u8>> {
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let file = open(marker, flags, Mode::empty())
        .map(fs::File::from)
        .ok()?;
    let info = file.metadata().ok()?;
    if !info.is_file() || info.len() > max_len {
        return None;
    }
    let mut stamp = Vec::new();
    file.take(max_len + 1).read_to_end(&mut stamp).ok()?;
    (stamp.len() as u64 == info.len()).then_some(stamp)
}

fn owns_quarantine(marker: &Path, expected: &str) -> bool {
    read_verified_stamp(marker, expected.len() as u64)
        .is_some_and(|stamp| stamp == expected.as_bytes())
}

fn verified_trash_stamp(
    marker: &Path,
    name: &str,
    entry: &fs::Metadata,
    checkout: Option<&fs::Metadata>,
) -> Option<Vec<u8>> {
    if let Some(checkout) = checkout {
        let expected = trash_stamp(name, entry, checkout);
        return read_verified_stamp(marker, expected.len() as u64)
            .filter(|stamp| stamp == expected.as_bytes());
    }
    let prefix = format!(
        "nucleus checkout trash {name} {}:{} ",
        entry.dev(),
        entry.ino()
    );
    // Two decimal u64 values, a colon, and a newline.
    let bytes = read_verified_stamp(marker, prefix.len() as u64 + 42)?;
    let text = std::str::from_utf8(&bytes).ok()?;
    let rest = text
        .strip_prefix(&prefix)
        .and_then(|s| s.strip_suffix('\n'))?;
    let (dev, ino) = rest.split_once(':')?;
    dev.parse::<u64>().ok()?;
    ino.parse::<u64>().ok()?;
    Some(bytes)
}

fn trash_timestamp_ms(name: &str) -> Option<u64> {
    let (prefix, _) = name.rsplit_once('-')?;
    let (_, at) = prefix.rsplit_once('-')?;
    at.parse().ok()
}

fn unix_now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
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

/// Remove owned retired checkout trees staged in the work volume's trash directory.
///
/// # Errors
/// Returns an error if the work root cannot be read, or reports all entry
/// failures after attempting the entire scan.
pub fn prune_trash(work: &StorageDirectory, now_ms: u64) -> Result<(), WorkError> {
    let root = work.path().join(TRASH);
    if missing(&root)? {
        return Ok(());
    }
    work.verify()?;
    let device = work.path().metadata()?.dev();
    let root_info = root.symlink_metadata()?;
    if !root_info.is_dir() || root_info.dev() != device {
        return Err(WorkError::WrongCheckout);
    }
    let mut failures = Vec::new();
    for entry in fs::read_dir(&root)? {
        let result = match entry {
            Ok(entry) => prune_trash_entry(&entry, device, now_ms)
                .map_err(|error| format!("{}: {error}", entry.path().display())),
            Err(error) => Err(format!(
                "could not read an entry in {}: {error}",
                root.display()
            )),
        };
        if let Err(detail) = result {
            failures.push(detail);
        }
    }
    if !failures.is_empty() {
        return Err(WorkError::TrashPrune(failures.join(", ")));
    }
    Ok(())
}

fn prune_trash_entry(entry: &fs::DirEntry, device: u64, now_ms: u64) -> std::io::Result<()> {
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
        return Ok(());
    };
    let Some(at) = trash_timestamp_ms(name) else {
        return Ok(());
    };
    let entry_path = entry.path();
    let entry_info = match entry_path.symlink_metadata() {
        Ok(info) if info.is_dir() && info.dev() == device => info,
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let checkout = entry_path.join(TRASH_CHECKOUT);
    let checkout_info = match checkout.symlink_metadata() {
        Ok(info) if info.is_dir() && info.dev() == device => Some(info),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Ok(_) => return Ok(()),
        Err(error) => return Err(error),
    };
    // Avoid racing with an in-progress move into a newly created trash entry.
    if checkout_info.is_none() && now_ms.saturating_sub(at) < TRASH_ORPHAN_GRACE_MS {
        return Ok(());
    }
    let marker = entry_path.join(TRASH_MARKER);
    let Some(stamp) = verified_trash_stamp(&marker, name, &entry_info, checkout_info.as_ref())
    else {
        return Ok(());
    };
    if checkout_info.is_some() {
        fs::remove_dir_all(&checkout)?;
    }
    for child in fs::read_dir(&entry_path)? {
        if child?.file_name() != TRASH_MARKER {
            return Err(ErrorKind::DirectoryNotEmpty.into());
        }
    }
    fs::remove_file(&marker)?;
    if let Err(error) = fs::remove_dir(&entry_path)
        && error.kind() != ErrorKind::NotFound
    {
        // Preserve proof for the next pass if the final rmdir fails.
        if entry_path.symlink_metadata().is_ok_and(|info| {
            info.is_dir() && info.dev() == entry_info.dev() && info.ino() == entry_info.ino()
        }) && let Err(restore) =
            fs::File::create_new(&marker).and_then(|mut file| file.write_all(&stamp))
        {
            return Err(std::io::Error::other(format!(
                "{error}. Could not restore the trash marker: {restore}"
            )));
        }
        return Err(error);
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
    /// Bind all checkouts to the configured root and caller's Git policy. This
    /// touches nothing: each operation verifies the root, which only an
    /// allocation recreates.
    #[must_use]
    pub fn new(storage: &EngineStorage, policy: &'a dyn GitPolicy, redactor: Redactor) -> Self {
        Self {
            root: storage.work().clone(),
            scratch: storage.scratch().clone(),
            git: Git::new(policy, redactor),
            custody: Arc::default(),
        }
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
        self.registered(&repository.canonicalize()?, repository_id, task_id)
    }

    /// [`Worktrees::checkout`] without reading the filesystem. The registered
    /// path must already be canonical, which an owned job checks before it acts.
    ///
    /// # Errors
    /// Returns an error if the task ID cannot be used.
    pub fn registered(
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
            repository: repository.into(),
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

    /// The task this checkout belongs to.
    #[must_use]
    pub fn task(&self) -> &str {
        &self.branch["ns-".len()..]
    }

    /// Own this checkout for a blocking executor. The caller abandons the
    /// `Custody` when it stops waiting, which refuses every mutation still
    /// ahead. A failure with the work root or registered checkout unavailable
    /// reports the volume, whatever the operation saw.
    pub fn job<P, T, F>(
        &self,
        policy: P,
        redactor: Redactor,
        operation: F,
    ) -> impl FnOnce(Arc<Custody>) -> Result<T, WorkError> + Send + 'static + use<P, T, F>
    where
        P: GitPolicy + Send + 'static,
        F: FnOnce(&Checkout<'_>) -> Result<T, WorkError> + Send + 'static,
    {
        let root = self.worktrees.root.clone();
        let scratch = self.worktrees.scratch.clone();
        let repository = self.repository.clone();
        let path = self.path.clone();
        let branch = self.branch.clone();
        move |custody| {
            let worktrees = Worktrees {
                root,
                scratch,
                git: Git::new(&policy, redactor),
                custody,
            };
            let checkout = Checkout {
                worktrees: &worktrees,
                repository,
                path,
                branch,
            };
            let result =
                require_registered(&checkout.repository).and_then(|()| operation(&checkout));
            if result.is_err() {
                worktrees.root.verify()?;
                require_registered(&checkout.repository)?;
            }
            result
        }
    }

    /// Fetch `origin`'s base into the registered object store and choose the
    /// start of a task checkout. Only the remote-tracking ref moves. The local
    /// base branch and the registered working tree are left alone.
    ///
    /// A task branch left by an earlier allocation keeps its own head when that
    /// head is already published and holds every landing. Otherwise the start is
    /// the published tip, which must hold them.
    ///
    /// # Errors
    /// Returns an error if the fetch fails, history cannot be read, or the
    /// start lacks a landed prerequisite.
    pub fn published_start(&self, base: &str, landings: &[Landing]) -> Result<Head, WorkError> {
        let tracking = format!("refs/remotes/origin/{base}");
        {
            let _step = self.admit()?;
            self.git(
                &self.repository,
                &[
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "--no-recurse-submodules",
                    "origin",
                    &format!("+refs/heads/{base}:{tracking}"),
                ],
            )?;
        }
        let published: Head = self
            .git(
                &self.repository,
                &["rev-parse", "--verify", &format!("{tracking}^{{commit}}")],
            )?
            .trim_end()
            .parse()?;
        if let Some(head) = self.branch_head()?
            && self.contains(&head, &published)?
            && self.unlanded(landings, &head)?.is_none()
        {
            return Ok(head);
        }
        match self.unlanded(landings, &published)? {
            None => Ok(published),
            Some(landing) => Err(WorkError::UnlandedPrerequisite {
                base: base.into(),
                prerequisite: landing.prerequisite.clone(),
            }),
        }
    }

    fn unlanded<'l>(
        &self,
        landings: &'l [Landing],
        start: &Head,
    ) -> Result<Option<&'l Landing>, WorkError> {
        for landing in landings {
            if !self.has_commit(&landing.commit)? || !self.contains(&landing.commit, start)? {
                return Ok(Some(landing));
            }
        }
        Ok(None)
    }

    fn has_commit(&self, head: &Head) -> Result<bool, WorkError> {
        let revision = format!("{head}^{{commit}}");
        let command = format!("git cat-file --batch-check for {head}");
        let kind = self.git_named(
            &self.repository,
            &["-c", COMMIT_INFO, "nucleus-commit-info", &revision],
            command.clone(),
        )?;
        match kind.as_str() {
            "commit" => Ok(true),
            missing if missing.ends_with(" missing") => Ok(false),
            _ => Err(self.git_failure(
                &self.repository,
                GitOperation::Other,
                command,
                GitFailure::Unavailable {
                    code: GitFailureCode::CommandUnavailable,
                    detail: "Git returned an unexpected object lookup result".into(),
                },
            )),
        }
    }

    fn branch_head(&self) -> Result<Option<Head>, WorkError> {
        let branch = format!("refs/heads/{}", self.branch);
        let found = self.git(
            &self.repository,
            &["for-each-ref", "--format=%(objectname)", &branch],
        )?;
        let found = found.trim_end_matches('\n');
        Ok((!found.is_empty()).then(|| found.parse()).transpose()?)
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
                self.worktrees.root.verify()?;
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
        if !dirty && self.index_visible(&self.path)? {
            Ok(Workspace::Clean(identity.head_oid().parse()?))
        } else {
            Ok(Workspace::Dirty)
        }
    }

    /// Observe the owned checkout for retirement, including an interrupted removal
    /// whose `.git` link was unlinked while its prunable Git registration remains.
    ///
    /// # Errors
    /// Returns an error if the checkout cannot be verified or belongs elsewhere.
    pub fn observe_for_retirement(&self) -> Result<Workspace, WorkError> {
        self.worktrees.root.verify()?;
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.worktrees.root.verify()?;
                return Ok(Workspace::Absent);
            }
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_dir() || self.path.canonicalize()? != self.path {
            return Err(WorkError::WrongCheckout);
        }
        if !missing(&self.path.join(".git"))? {
            return self.observe();
        }
        let Some((admin, head)) = self.prunable_identity()? else {
            return self.observe();
        };
        let dirty = self.status_dirty_with_git_dir(
            &self.path,
            Some(&admin),
            &["--untracked-files=all", "--ignore-submodules=none"],
        )?;
        if !dirty && self.index_visible_with_git_dir(&self.path, Some(&admin))? {
            Ok(Workspace::Clean(head))
        } else {
            Ok(Workspace::Dirty)
        }
    }

    /// Check whether an absent checkout still holds an owned prunable Git registration.
    ///
    /// # Errors
    /// Returns an error if the repository or registration cannot be verified.
    pub fn has_prunable_registration(&self) -> Result<bool, WorkError> {
        self.worktrees.root.verify()?;
        if !missing(&self.path)? {
            return Ok(false);
        }
        Ok(self.prunable_identity()?.is_some())
    }

    /// Remove an owned prunable Git registration after verifying the checkout directory is absent.
    ///
    /// # Errors
    /// Returns an error if the registration cannot be verified, is locked, or cannot be removed.
    pub fn retire_prunable_registration(&self) -> Result<Retirement, WorkError> {
        self.worktrees.root.verify()?;
        if !missing(&self.path)? {
            return Err(WorkError::WrongCheckout);
        }
        let Some((admin, _)) = self.prunable_identity()? else {
            return Ok(Retirement::Absent);
        };
        self.require_unlocked(&admin)?;
        let _step = self.admit()?;
        self.remove(&["--force"])?;
        Ok(Retirement::Removed)
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
        if let Some((admin, _)) = self.prunable_identity()? {
            self.require_unlocked(&admin)?;
            let _step = self.admit()?;
            self.remove(&["--force"])?;
        }
        let parent = self.path.parent().ok_or(WorkError::InvalidPath)?;
        let bucket = parent
            .strip_prefix(self.worktrees.root.path())
            .map_err(|_| WorkError::WrongCheckout)?;
        {
            let _step = self.admit()?;
            self.worktrees.root.ensure_child(bucket)?;
        }
        let path = self.path.to_str().ok_or(WorkError::InvalidPath)?;
        let args = match self.branch_head()? {
            None => vec!["worktree", "add", "-b", &self.branch, path, start.as_str()],
            Some(head) if head == *start => vec!["worktree", "add", path, &self.branch],
            Some(_) => return Err(WorkError::WrongBranchHead),
        };
        {
            let _step = self.admit()?;
            self.git(&self.repository, &args)?;
        }
        self.observe()
    }

    /// Quarantine an interrupted initialization and retire its observed branch tip.
    /// The caller holds the task fence and verifies that no role has been sent.
    ///
    /// # Errors
    /// Returns an error if the registration, initialization marker, index or
    /// branch has changed, or if the original directory cannot be renamed.
    pub fn quarantine_initialization(&self, time_ms: u64) -> Result<(), WorkError> {
        {
            let _step = self.admit()?;
            self.worktrees.scratch.ensure_child(Path::new(QUARANTINE))?;
        }
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
        {
            let _step = self.admit()?;
            let mut marker = fs::File::create_new(&pending)?;
            marker.write_all(quarantine_stamp(&name, &metadata).as_bytes())?;
            marker.sync_all()?;
        }
        let moved = self.admit().and_then(|_step| {
            renameat_with(CWD, &self.path, CWD, &destination, RenameFlags::NOREPLACE)
                .map_err(|error| WorkError::QuarantineMove(error.into()))
        });
        if let Err(error) = moved {
            // Nothing moved, so only this attempt's unused marker is removed.
            let _ = fs::remove_file(&pending);
            return Err(error);
        }
        // Past the move, a refused step leaves the marker for the owner to check.
        {
            let _step = self.admit()?;
            fs::hard_link(&pending, destination.join(QUARANTINE_MARKER))?;
        }
        if !missing(&self.path)? {
            return Err(WorkError::WrongCheckout);
        }
        {
            // The task fence excludes allocation. Git validates the named registration.
            let _step = self.admit()?;
            self.remove(&["--force", "--force"])?;
        }
        let branch = format!("refs/heads/{}", self.branch);
        let head = identity.head_oid();
        let found = self.git(&self.repository, &["for-each-ref", QUARANTINE_REF, &branch])?;
        if !found.is_empty() {
            if found != format!("{branch}\0{head}\0\0") {
                return Err(WorkError::WrongBranchHead);
            }
            let delete = ["update-ref", "--no-deref", "-d", &branch, head];
            let _step = self.admit()?;
            self.git(&self.repository, &delete)?;
        }
        let _step = self.admit()?;
        fs::remove_file(pending)?;
        Ok(())
    }

    /// Check that the registered integration checkout has no tracked changes.
    ///
    /// # Errors
    /// Returns an error if Git cannot inspect the checkout.
    pub fn integration_clean(&self) -> Result<bool, WorkError> {
        Ok(!self.status_dirty(
            &self.repository,
            &["--untracked-files=no", "--ignore-submodules=none"],
        )? && self.index_visible(&self.repository)?)
    }

    fn index_visible(&self, root: &Path) -> Result<bool, WorkError> {
        self.index_visible_with_git_dir(root, None)
    }

    fn index_visible_with_git_dir(
        &self,
        root: &Path,
        admin: Option<&Path>,
    ) -> Result<bool, WorkError> {
        let mut args = Vec::new();
        if let Some(admin) = admin {
            args.extend([
                "--git-dir",
                admin.to_str().ok_or(WorkError::InvalidPath)?,
                "--work-tree",
                root.to_str().ok_or(WorkError::InvalidPath)?,
            ]);
        }
        args.extend(["-c", INDEX_VISIBILITY, "nucleus-index-visibility"]);
        Ok(self
            .git_named(root, &args, "git ls-files -v".into())?
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
            let _step = self.admit()?;
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

    /// Return the exact head only for a checkout containing solely unstaged
    /// tracked deletions. The caller still needs independent publication evidence.
    ///
    /// # Errors
    /// Returns a Git or custody error if the state cannot be verified.
    pub fn deletion_only_head(&self) -> Result<Option<Head>, WorkError> {
        if !missing(&self.path.join(".git"))? {
            if self.git_named(
                &self.path,
                &["-c", DELETIONS_ONLY, "nucleus-deletions-only"],
                "git status for tracked deletions".into(),
            )? != "deletions"
            {
                return Ok(None);
            }
            return Ok(Some(self.owned_identity()?.head_oid().parse()?));
        }
        let Some((admin, head)) = self.prunable_identity()? else {
            return Err(WorkError::WrongCheckout);
        };
        let admin_str = admin.to_str().ok_or(WorkError::InvalidPath)?;
        let path_str = self.path.to_str().ok_or(WorkError::InvalidPath)?;
        if self.git_named(
            &self.path,
            &[
                "--git-dir",
                admin_str,
                "--work-tree",
                path_str,
                "-c",
                DELETIONS_ONLY,
                "nucleus-deletions-only",
            ],
            "git status for tracked deletions".into(),
        )? == "deletions"
        {
            return Ok(Some(head));
        }
        if missing(&self.path.join(".gitignore"))?
            && self.git_named(
                &self.path,
                &[
                    "--git-dir",
                    admin_str,
                    "--work-tree",
                    path_str,
                    "-c",
                    TRACKED_DELETIONS_ONLY,
                    "nucleus-tracked-deletions-only",
                ],
                "git status for tracked deletions".into(),
            )? == "deletions"
            && !self.untracked_with_head_gitignore(&admin)?
        {
            return Ok(Some(head));
        }
        Ok(None)
    }

    fn untracked_with_head_gitignore(&self, admin: &Path) -> Result<bool, WorkError> {
        let admin_str = admin.to_str().ok_or(WorkError::InvalidPath)?;
        let path_str = self.path.to_str().ok_or(WorkError::InvalidPath)?;
        let ignore = match self.git(
            &self.repository,
            &["--git-dir", admin_str, "cat-file", "-p", "HEAD:.gitignore"],
        ) {
            Ok(ignore) => ignore,
            Err(WorkError::Git {
                source: GitFailure::Refused { .. } | GitFailure::Unavailable { .. },
                ..
            }) => return Ok(true),
            Err(error) => return Err(error),
        };
        self.worktrees.scratch.ensure()?;
        let mut temp = tempfile::NamedTempFile::new_in(self.worktrees.scratch.path())?;
        temp.write_all(ignore.as_bytes())?;
        temp.flush()?;
        let exclude = temp.path().to_str().ok_or(WorkError::InvalidPath)?;
        match self.git_named(
            &self.path,
            &[
                "--git-dir",
                admin_str,
                "--work-tree",
                path_str,
                "ls-files",
                "--others",
                "--exclude-standard",
                "--exclude-from",
                exclude,
            ],
            "git ls-files --others".into(),
        ) {
            Ok(output) => Ok(!output.is_empty()),
            Err(WorkError::Git { source, .. })
                if source.code() == GitFailureCode::OutputTooLarge =>
            {
                Ok(true)
            }
            Err(error) => Err(error),
        }
    }

    /// Remove an idle checkout only if it is still clean at the published head.
    /// The caller establishes that its turn and tools have stopped.
    ///
    /// # Errors
    /// Returns an error if the checkout cannot be verified or Git refuses removal.
    pub fn retire(&self, published: &Head) -> Result<Retirement, WorkError> {
        self.finish_retirement(self.observe_for_retirement()?, published)
    }

    /// Finish a retirement after the caller's final admission, rechecking
    /// ownership and the exact head observed by `observe_for_retirement`.
    ///
    /// # Errors
    /// Returns an error if the recheck fails or Git refuses removal.
    pub fn finish_retirement(
        &self,
        initial: Workspace,
        published: &Head,
    ) -> Result<Retirement, WorkError> {
        match initial {
            Workspace::Absent => self.retire_prunable_registration(),
            Workspace::Clean(head) if head == *published => match self.observe_for_retirement()? {
                Workspace::Absent => self.retire_prunable_registration(),
                Workspace::Clean(current) if current == *published => {
                    self.retire_to_trash(published)
                }
                Workspace::Clean(_) | Workspace::Dirty => Ok(Retirement::Retained),
            },
            Workspace::Dirty => {
                if missing(&self.path)? {
                    return self.retire_prunable_registration();
                }
                if self.deletion_only_head()?.as_ref() != Some(published) {
                    return Ok(Retirement::Retained);
                }
                self.retire_to_trash(published)
            }
            Workspace::Clean(_) => Ok(Retirement::Retained),
        }
    }

    fn retire_to_trash(&self, published: &Head) -> Result<Retirement, WorkError> {
        let (admin, head) = self.verified_admin_for_retirement()?;
        if head != *published {
            return Ok(Retirement::Retained);
        }
        self.require_unlocked(&admin)?;
        {
            let _step = self.admit()?;
            self.worktrees.root.ensure_child(Path::new(TRASH))?;
        }
        let device = self.worktrees.root.path().metadata()?.dev();
        let trash_root = self.worktrees.root.path().join(TRASH);
        let trash_info = trash_root.symlink_metadata()?;
        if !trash_info.is_dir() || trash_info.dev() != device {
            return Err(WorkError::WrongCheckout);
        }
        let checkout_info = self.path.symlink_metadata()?;
        if !checkout_info.is_dir()
            || checkout_info.dev() != device
            || self.path.canonicalize()? != self.path
        {
            return Err(WorkError::WrongCheckout);
        }

        let staging = self.admit()?;
        let stamp_ms = unix_now_ms();
        let mut entry;
        let mut name;
        loop {
            let seq = TRASH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            name = format!("{}-{stamp_ms}-{seq}", &self.branch["ns-".len()..]);
            entry = trash_root.join(&name);
            match fs::create_dir(&entry) {
                Ok(()) => break,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        let result = (|| -> Result<(), WorkError> {
            let entry_info = entry.symlink_metadata()?;
            let mut marker = fs::File::create_new(entry.join(TRASH_MARKER))?;
            marker.write_all(trash_stamp(&name, &entry_info, &checkout_info).as_bytes())?;
            marker.sync_all()?;
            drop(staging);
            let _step = self.admit()?;
            renameat_with(
                CWD,
                &self.path,
                CWD,
                entry.join(TRASH_CHECKOUT),
                RenameFlags::NOREPLACE,
            )
            .map_err(std::io::Error::from)?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(entry.join(TRASH_MARKER));
            let _ = fs::remove_dir(&entry);
            return Err(error);
        }
        if !missing(&self.path)? {
            return Err(WorkError::WrongCheckout);
        }
        // A refusal here leaves a prunable registration, which the next pass retires.
        let _step = self.admit()?;
        self.remove(&["--force"])?;
        Ok(Retirement::Removed)
    }

    fn verified_admin_for_retirement(&self) -> Result<(PathBuf, Head), WorkError> {
        if !missing(&self.path.join(".git"))? {
            let identity = self.owned_identity()?;
            let admin = self.admin_directory(&identity)?;
            return Ok((admin, identity.head_oid().parse()?));
        }
        self.prunable_identity()?.ok_or(WorkError::WrongCheckout)
    }

    // Asked before each mutation: the work root still verifies and the caller
    // still waits. The guard lasts as long as that one step.
    fn admit(&self) -> Result<Mutation<'_>, WorkError> {
        self.worktrees.root.verify()?;
        Ok(self.worktrees.custody.mutate()?)
    }

    fn require_unlocked(&self, admin: &Path) -> Result<(), WorkError> {
        if initializing(admin)? {
            return Err(WorkError::Initializing);
        }
        if !missing(&admin.join("locked"))? {
            return Err(self.git_failure(
                &self.repository,
                GitOperation::Other,
                "git worktree remove".into(),
                GitFailure::Refused {
                    code: GitFailureCode::RepositoryUnavailable,
                    detail: "worktree is locked".into(),
                },
            ));
        }
        Ok(())
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

    fn prunable_identity(&self) -> Result<Option<(PathBuf, Head)>, WorkError> {
        let repository = self.git_identity(&self.repository)?;
        if repository.root() != self.repository {
            return Err(WorkError::WrongCheckout);
        }
        let Some(admin) = self.find_worktree_admin(&repository)? else {
            return Ok(None);
        };
        if initializing(&admin)? {
            return Err(WorkError::Initializing);
        }
        if missing(&admin.join("index"))? {
            return Err(WorkError::MissingIndex);
        }
        let commondir = read_small_regular_file(&admin.join("commondir"))?;
        let resolved_common = admin
            .join(commondir.trim_end_matches('\n'))
            .canonicalize()?;
        if resolved_common != repository.common_dir() {
            return Err(WorkError::WrongCheckout);
        }
        if let Some(expected_fs) = repository.common_dir_filesystem_id() {
            let meta = resolved_common.metadata()?;
            if (meta.dev(), meta.ino()) != (expected_fs.device, expected_fs.inode) {
                return Err(WorkError::WrongCheckout);
            }
        }
        let dir = if missing(&self.path)? {
            &self.repository
        } else {
            &self.path
        };
        let admin_str = admin.to_str().ok_or(WorkError::InvalidPath)?;
        let branch = match self.git(
            dir,
            &[
                "--git-dir",
                admin_str,
                "symbolic-ref",
                "--quiet",
                "--short",
                "HEAD",
            ],
        ) {
            Ok(branch) => branch,
            Err(WorkError::Git {
                source: GitFailure::Refused { .. },
                ..
            }) => return Err(WorkError::WrongCheckout),
            Err(error) => return Err(error),
        };
        if branch.trim_end_matches('\n') != self.branch {
            return Err(WorkError::WrongCheckout);
        }
        let head = self.git(
            dir,
            &["--git-dir", admin_str, "rev-parse", "--verify", "HEAD"],
        )?;
        Ok(Some((admin, head.trim_end_matches('\n').parse()?)))
    }

    fn find_worktree_admin(
        &self,
        repository: &WorktreeIdentity,
    ) -> Result<Option<PathBuf>, WorkError> {
        let worktrees_dir = repository.common_dir().join("worktrees");
        if missing(&worktrees_dir)? {
            return Ok(None);
        }
        let worktrees_meta = worktrees_dir.symlink_metadata()?;
        if !worktrees_meta.is_dir() || worktrees_dir.canonicalize()? != worktrees_dir {
            return Err(WorkError::WrongCheckout);
        }
        let path_absent = missing(&self.path)?;
        for entry in fs::read_dir(&worktrees_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let candidate = entry.path();
            let gitdir_path = candidate.join("gitdir");
            if missing(&gitdir_path)? {
                continue;
            }
            let Ok(backlink) = read_small_regular_file(&gitdir_path) else {
                continue;
            };
            let target = candidate.join(backlink.trim_end_matches('\n'));
            if target.file_name() != Some(OsStr::new(".git")) {
                continue;
            }
            let Some(parent) = target.parent() else {
                continue;
            };
            let matches = if path_absent {
                parent == self.path
                    || (parent.file_name() == self.path.file_name()
                        && parent
                            .parent()
                            .and_then(|bucket| bucket.canonicalize().ok())
                            .as_deref()
                            == self.path.parent())
            } else {
                parent.canonicalize().ok().as_deref() == Some(self.path.as_path())
            };
            if matches {
                return Ok(Some(candidate));
            }
        }
        Ok(None)
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
        self.status_dirty_with_git_dir(directory, None, flags)
    }

    fn status_dirty_with_git_dir(
        &self,
        directory: &Path,
        admin: Option<&Path>,
        flags: &[&str],
    ) -> Result<bool, WorkError> {
        let mut args = Vec::new();
        if let Some(admin) = admin {
            args.extend([
                "--git-dir",
                admin.to_str().ok_or(WorkError::InvalidPath)?,
                "--work-tree",
                directory.to_str().ok_or(WorkError::InvalidPath)?,
            ]);
        }
        args.extend(["--no-optional-locks", "status", "--porcelain=v1"]);
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
            ["fetch", ..] => (GitOperation::Fetch, GIT_TIMEOUT),
            ["worktree", "add", ..] => (GitOperation::Add, WORKTREE_TIMEOUT),
            ["--no-optional-locks", "status", ..]
            | [
                "--git-dir",
                _,
                "--work-tree",
                _,
                "--no-optional-locks",
                "status",
                ..,
            ] => (GitOperation::Status, GIT_TIMEOUT),
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

fn read_small_regular_file(path: &Path) -> Result<String, WorkError> {
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let file = open(path, flags, Mode::empty())
        .map(fs::File::from)
        .map_err(std::io::Error::from)?;
    let info = file.metadata()?;
    if !info.is_file() || info.len() > 8192 {
        return Err(WorkError::WrongCheckout);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(info.len()).unwrap_or(0));
    file.take(8193).read_to_end(&mut bytes)?;
    if bytes.len() > 8192 {
        return Err(WorkError::WrongCheckout);
    }
    String::from_utf8(bytes).map_err(|_| WorkError::WrongCheckout)
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
