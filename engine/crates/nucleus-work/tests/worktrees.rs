use std::{fs, path::Path, process::Command};

use longhorn_git_workspace::{GitCredential, GitFailure, GitPolicy};
use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Head, Workspace};
use nucleus_store::{EngineSettings, PinnedVolume, SettingsFile};
use nucleus_work::{Retirement, WorkError, Worktrees};

struct LocalGit;

impl GitPolicy for LocalGit {
    fn isolate(&self, command: &mut Command) {
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null");
    }

    fn credential(&self, _: &str) -> Result<Option<GitCredential>, GitFailure> {
        Ok(None)
    }

    fn refresh_credential(&self, _: &GitCredential) -> Option<GitCredential> {
        None
    }
}

fn worktrees(home: &Path) -> Worktrees<'static> {
    let settings = SettingsFile::open(home).expect("fixture settings");
    settings
        .save(&EngineSettings {
            enabled: true,
            work_volume: Some(PinnedVolume::detect(home).expect("fixture volume")),
            ..EngineSettings::default()
        })
        .expect("save fixture settings");
    let storage = settings.storage().expect("resolve storage");
    Worktrees::new(
        &storage,
        &LocalGit,
        Redactor::new([], RedactionRules::common()),
    )
    .expect("work root")
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
        ])
        .args(args)
        .output()
        .expect("run Git fixture");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("Git fixture output")
}

fn repository(path: &Path) -> Head {
    fs::create_dir(path).expect("make fixture repository");
    git(path, &["init", "-b", "main"]);
    fs::write(path.join(".gitignore"), "local.settings\n").expect("write ignore fixture");
    fs::write(path.join("README.md"), "fixture").expect("write tracked file");
    git(path, &["add", "."]);
    git(path, &["commit", "-m", "Start the fixture"]);
    git(path, &["rev-parse", "HEAD"])
        .trim()
        .parse()
        .expect("fixture head")
}

#[test]
fn allocation_is_idempotent_and_closeout_only_removes_the_published_clean_checkout() {
    let root = tempfile::tempdir().expect("scratch");
    let repo = root.path().join("repository with spaces");
    let head = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-1")
        .expect("checkout");
    assert_eq!(checkout.branch(), "ns-task-1");
    assert_eq!(checkout.observe().expect("no checkout"), Workspace::Absent);
    assert_eq!(
        checkout.allocate(&head).expect("allocate"),
        Workspace::Clean(head.clone())
    );
    assert_eq!(
        checkout.allocate(&head).expect("verify retry"),
        Workspace::Clean(head.clone())
    );
    for file in ["untracked.md", "local.settings"] {
        let local = checkout.path().join(file);
        fs::write(&local, "keep this local work")
            .expect("create local file after initial inspection");
        assert_eq!(
            checkout.retire(&head).expect("preserve workspace"),
            Retirement::Retained
        );
        assert_eq!(
            fs::read_to_string(&local).expect("file remains"),
            "keep this local work"
        );
        fs::remove_file(local).expect("remove fixture file");
    }
    let different: Head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        .parse()
        .expect("other head");
    assert_eq!(
        checkout
            .retire(&different)
            .expect("preserve an unpublished head"),
        Retirement::Retained
    );
    assert_eq!(
        checkout.retire(&head).expect("remove the clean worktree"),
        Retirement::Removed
    );
    assert_eq!(
        checkout.retire(&head).expect("replay closeout"),
        Retirement::Absent
    );
    assert_eq!(
        checkout
            .allocate(&head)
            .expect("reattach existing branch at the same head"),
        Workspace::Clean(head)
    );
}

#[test]
fn a_different_checkout_is_never_adopted_or_removed() {
    let root = tempfile::tempdir().expect("scratch");
    let repo = root.path().join("repository");
    let head = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-1")
        .expect("checkout");
    fs::create_dir_all(checkout.path().parent().expect("bucket")).expect("worktree bucket");
    repository(checkout.path());
    assert!(matches!(
        checkout.allocate(&head),
        Err(WorkError::WrongCheckout)
    ));
    assert!(matches!(
        checkout.retire(&head),
        Err(WorkError::WrongCheckout)
    ));
    assert_eq!(
        fs::read_to_string(checkout.path().join("README.md")).expect("foreign checkout remains"),
        "fixture"
    );
}

#[test]
fn retirement_keeps_edits_hidden_by_index_flags() {
    let root = tempfile::tempdir().expect("scratch");
    let repo = root.path().join("repository");
    let head = repository(&repo);
    let worktrees = worktrees(root.path());
    for (id, flag) in [
        ("task-1", "--assume-unchanged"),
        ("task-2", "--skip-worktree"),
    ] {
        let checkout = worktrees
            .checkout(&repo, "example/fixture", id)
            .expect("checkout");
        checkout.allocate(&head).expect("allocate");
        git(checkout.path(), &["update-index", flag, "README.md"]);
        let file = checkout.path().join("README.md");
        fs::write(&file, "uncommitted edit").expect("edit tracked file");
        assert_eq!(git(checkout.path(), &["status", "--porcelain"]), "");
        assert_eq!(
            checkout.retire(&head).expect("keep checkout"),
            Retirement::Retained
        );
        assert_eq!(
            fs::read_to_string(file).expect("edit remained"),
            "uncommitted edit"
        );
    }
}

#[test]
fn allocation_never_creates_a_bucket_through_a_replaced_root() {
    let root = tempfile::tempdir().expect("scratch");
    let repo = root.path().join("repository");
    let head = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-1")
        .expect("checkout");
    let work_root = root.path().join("work");
    let wrong_root = root.path().join("unrelated");
    fs::create_dir(&wrong_root).expect("create unrelated root");
    fs::rename(&work_root, root.path().join("work-before-replacement")).expect("move fixture root");
    std::os::unix::fs::symlink(&wrong_root, &work_root)
        .expect("replace root with fixture redirect");
    assert!(checkout.allocate(&head).is_err());
    assert_eq!(
        fs::read_dir(wrong_root)
            .expect("unrelated root untouched")
            .count(),
        0
    );
}
