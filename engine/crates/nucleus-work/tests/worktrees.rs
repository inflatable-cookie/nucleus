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
    worktrees_with_redactor(home, Redactor::new([], RedactionRules::common()))
}

fn worktrees_with_redactor(home: &Path, redactor: Redactor) -> Worktrees<'static> {
    let settings = SettingsFile::open(home).expect("fixture settings");
    settings
        .save(&EngineSettings {
            enabled: true,
            work_volume: Some(PinnedVolume::detect(home).expect("fixture volume")),
            ..EngineSettings::default()
        })
        .expect("save fixture settings");
    let storage = settings.storage().expect("resolve storage");
    Worktrees::new(&storage, &LocalGit, redactor).expect("work root")
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
fn review_allocation_can_fetch_a_pull_head_missing_from_the_registered_checkout() {
    let home = tempfile::tempdir().expect("scratch");
    let upstream = home.path().join("upstream");
    let checkout = home.path().join("registered");
    repository(&upstream);
    git(
        home.path(),
        &[
            "clone",
            upstream.to_str().expect("path"),
            checkout.to_str().expect("path"),
        ],
    );
    fs::write(upstream.join("README.md"), "existing PR").expect("edit");
    git(&upstream, &["commit", "-am", "Change greeting"]);
    let head = git(&upstream, &["rev-parse", "HEAD"])
        .trim()
        .parse()
        .expect("PR head");
    git(&upstream, &["update-ref", "refs/pull/7/head", "HEAD"]);
    let worktrees = worktrees(home.path());
    let review = worktrees
        .checkout(&checkout, "example/fixture", "review")
        .expect("review checkout");
    assert_eq!(
        review
            .allocate_review(&head, 7)
            .expect("fetch and allocate"),
        Workspace::Clean(head)
    );
}

#[test]
fn successful_status_overflow_is_dirty_and_retained() {
    let home = tempfile::tempdir().unwrap();
    let repo = home.path().join("repository");
    let head = repository(&repo);
    let worktrees = worktrees(home.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "large")
        .unwrap();
    checkout.allocate(&head).unwrap();
    for file in 0..2_000 {
        fs::write(
            checkout
                .path()
                .join(format!("untracked-long-dirty-entry-{file:04}.txt")),
            "",
        )
        .unwrap();
    }
    assert!(git(checkout.path(), &["status", "--porcelain=v1"]).len() > 65_536);
    assert_eq!(checkout.observe().unwrap(), Workspace::Dirty);
    assert_eq!(checkout.retire(&head).unwrap(), Retirement::Retained);
    assert_eq!(fs::read_dir(checkout.path()).unwrap().count(), 2_003);
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
    let local = checkout.path().join("untracked.md");
    fs::write(&local, "keep this local work").expect("create local work");
    assert_eq!(
        checkout.observe().expect("inspect local work"),
        Workspace::Dirty
    );
    assert_eq!(
        checkout.retire(&head).expect("preserve workspace"),
        Retirement::Retained
    );
    assert_eq!(
        fs::read_to_string(&local).expect("file remains"),
        "keep this local work"
    );
    fs::remove_file(local).expect("remove fixture file");

    let ignored = checkout.path().join("local.settings");
    fs::write(&ignored, "discardable output").expect("create ignored output");
    assert_eq!(
        checkout.observe().expect("inspect ignored output"),
        Workspace::Clean(head.clone())
    );
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
    assert!(!ignored.exists());
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
fn a_large_index_is_observed_without_truncating_hidden_flags() {
    let root = tempfile::tempdir().expect("scratch");
    let repo = root.path().join("repository");
    repository(&repo);
    let path = |index| format!("tracked-{index:04}-{}.txt", "x".repeat(80));
    for index in 0..800 {
        fs::write(repo.join(path(index)), "fixture").expect("write fixture");
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "Create a large index"]);
    let head: Head = git(&repo, &["rev-parse", "HEAD"])
        .trim()
        .parse()
        .expect("head");
    assert!(git(&repo, &["ls-files", "-v"]).len() > 64 * 1024);

    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task")
        .expect("checkout");
    for _ in 0..2 {
        assert_eq!(
            checkout.allocate(&head).expect("allocate or adopt"),
            Workspace::Clean(head.clone())
        );
    }
    let last = path(799);
    for (flag, clear) in [
        ("--skip-worktree", "--no-skip-worktree"),
        ("--assume-unchanged", "--no-assume-unchanged"),
    ] {
        git(checkout.path(), &["update-index", flag, "--", &last]);
        assert_eq!(
            checkout.observe().expect("read flagged index"),
            Workspace::Dirty
        );
        git(checkout.path(), &["update-index", clear, "--", &last]);
    }
    assert_eq!(
        checkout.observe().expect("read clean index"),
        Workspace::Clean(head)
    );
    let missing = "f".repeat(40).parse().expect("absent head");
    let error = checkout
        .require_commit(&missing)
        .expect_err("absent commit");
    let WorkError::Git {
        command,
        directory,
        repository,
        source,
        ..
    } = error
    else {
        panic!("expected a Git diagnostic");
    };
    assert!(command.contains("cat-file"));
    assert_eq!(directory, repo);
    assert_eq!(repository, repo);
    assert!(!source.detail().is_empty());
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

#[test]
fn repositories_with_identical_redacted_output_still_have_distinct_identity() {
    let root = tempfile::tempdir().expect("scratch");
    let own = root.path().join("owned-repository");
    let other = root.path().join("foreign-repository");
    let own_head = repository(&own);
    let other_head = repository(&other);
    let secrets = [&own, &other].map(|repo| repo.join(".git").to_string_lossy().into_owned());
    let worktrees = worktrees_with_redactor(
        root.path(),
        Redactor::new(secrets, RedactionRules::exact_only()),
    );
    let checkout = worktrees
        .checkout(&own, "example/fixture", "task-1")
        .expect("checkout");
    fs::create_dir(checkout.path().parent().expect("bucket")).expect("fixture bucket");
    git(
        &other,
        &[
            "worktree",
            "add",
            "-b",
            checkout.branch(),
            checkout.path().to_str().expect("path"),
            other_head.as_str(),
        ],
    );
    assert!(matches!(
        checkout.allocate(&own_head),
        Err(WorkError::WrongCheckout)
    ));
    assert!(matches!(
        checkout.retire(&other_head),
        Err(WorkError::WrongCheckout)
    ));
    assert!(checkout.path().join("README.md").is_file());
}

#[test]
fn a_repository_name_ending_in_space_does_not_adopt_its_siblings_checkout() {
    let root = tempfile::tempdir().expect("scratch");
    let selected = root.path().join("repository ");
    let sibling = root.path().join("repository");
    let selected_head = repository(&selected);
    let sibling_head = repository(&sibling);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&selected, "example/fixture", "task-1")
        .expect("checkout");
    fs::create_dir(checkout.path().parent().expect("bucket")).expect("fixture bucket");
    git(
        &sibling,
        &[
            "worktree",
            "add",
            "-b",
            checkout.branch(),
            checkout.path().to_str().expect("path"),
            sibling_head.as_str(),
        ],
    );
    assert!(matches!(
        checkout.allocate(&selected_head),
        Err(WorkError::WrongCheckout)
    ));
    assert!(matches!(
        checkout.retire(&sibling_head),
        Err(WorkError::WrongCheckout)
    ));
    assert!(checkout.path().join("README.md").is_file());
}
