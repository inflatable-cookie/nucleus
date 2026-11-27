use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, atomic::AtomicBool},
};

use longhorn_git_workspace::{GitCredential, GitFailure, GitPolicy};
use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Head, Workspace};
use nucleus_store::{EngineSettings, SettingsFile};
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
    worktrees_with_policy(home, redactor, &LocalGit)
}

fn worktrees_with_policy<'a>(
    home: &Path,
    redactor: Redactor,
    policy: &'a dyn GitPolicy,
) -> Worktrees<'a> {
    let settings = SettingsFile::open(home).expect("fixture settings");
    settings
        .save(&EngineSettings {
            enabled: true,
            ..EngineSettings::default()
        })
        .expect("save fixture settings");
    let storage = settings.storage().expect("resolve storage");
    storage.work().ensure().expect("work root");
    Worktrees::new(&storage, policy, redactor)
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
fn integration_admission_detects_a_moved_ignored_submodule() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("registered");
    let child = root.path().join("child");
    repository(&repo);
    repository(&child);
    git(
        &repo,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "../child",
            "module",
        ],
    );
    git(
        &repo,
        &[
            "config",
            "-f",
            ".gitmodules",
            "submodule.module.ignore",
            "all",
        ],
    );
    git(&repo, &["add", ".gitmodules"]);
    git(&repo, &["commit", "-m", "Pin the ignored submodule"]);
    let work = worktrees(root.path());
    let checkout = work.checkout(&repo, "example/fixture", "report").unwrap();
    assert!(checkout.integration_clean().unwrap());
    git(
        &repo.join("module"),
        &["commit", "--allow-empty", "-m", "Move the checkout"],
    );
    assert!(git(&repo, &["status", "--porcelain"]).is_empty());
    assert!(!checkout.integration_clean().unwrap());
}

#[test]
fn admission_checks_the_index_of_a_nested_submodule() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path();
    for name in ["inner", "outer", "registered"] {
        repository(&root.join(name));
    }
    for (parent, child) in [("outer", "../inner"), ("registered", "../outer")] {
        let repo = root.join(parent);
        git(
            &repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                child,
                "module",
            ],
        );
        git(&repo, &["commit", "-am", "Record submodule"]);
    }
    let repo = root.join("registered");
    git(
        &repo,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "update",
            "--init",
            "--recursive",
        ],
    );
    let trees = worktrees(root);
    let checkout = trees.checkout(&repo, "example/fixture", "report").unwrap();
    let nested = repo.join("module/module");
    for (hide, show) in [
        ("--assume-unchanged", "--no-assume-unchanged"),
        ("--skip-worktree", "--no-skip-worktree"),
    ] {
        assert!(checkout.integration_clean().unwrap());
        git(&nested, &["update-index", hide, "README.md"]);
        fs::write(nested.join("README.md"), "masked change").unwrap();
        assert!(
            git(
                &repo,
                &["status", "--porcelain", "--ignore-submodules=none"]
            )
            .is_empty()
        );
        assert!(!checkout.integration_clean().unwrap());
        git(&nested, &["update-index", show, "README.md"]);
        git(&nested, &["restore", "README.md"]);
    }
    assert!(checkout.integration_clean().unwrap());
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
fn a_partial_quarantine_retry_cannot_adopt_a_changed_branch_tip() {
    let root = tempfile::tempdir().expect("private fixture");
    let repo = root.path().join("repository");
    let old = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "partial")
        .unwrap();
    checkout.allocate(&old).unwrap();
    let admin = std::path::PathBuf::from(
        git(checkout.path(), &["rev-parse", "--absolute-git-dir"]).trim_end_matches('\n'),
    );
    fs::remove_file(admin.join("index")).unwrap();
    fs::write(admin.join("locked"), "initializing").unwrap();
    fs::write(checkout.path().join("draft"), "keep the draft").unwrap();
    git(&repo, &["commit", "--allow-empty", "-m", "New base"]);
    let new: Head = git(&repo, &["rev-parse", "HEAD"]).trim().parse().unwrap();

    let reference = "refs/heads/ns-partial";
    let lock = repo.join(".git").join(format!("{reference}.lock"));
    fs::write(&lock, "").unwrap();
    assert!(matches!(
        checkout.quarantine_initialization(1000),
        Err(WorkError::Git { .. })
    ));
    assert_eq!(checkout.observe().unwrap(), Workspace::Absent);
    assert!(!checkout.path().exists());
    assert!(!admin.exists());

    fs::remove_file(lock).unwrap();
    fs::create_dir(checkout.path()).unwrap();
    fs::write(checkout.path().join("foreign"), "do not remove").unwrap();
    assert!(matches!(
        checkout.quarantine_initialization(1500),
        Err(WorkError::QuarantinePending)
    ));
    assert!(checkout.path().join("foreign").is_file());
    fs::rename(checkout.path(), root.path().join("foreign")).unwrap();
    git(
        &repo,
        &["update-ref", reference, new.as_str(), old.as_str()],
    );
    assert!(matches!(
        checkout.allocate(&old),
        Err(WorkError::WrongBranchHead)
    ));
    assert_eq!(git(&repo, &["rev-parse", reference]).trim(), new.as_str());

    git(
        &repo,
        &["update-ref", reference, old.as_str(), new.as_str()],
    );
    assert_eq!(checkout.allocate(&old).unwrap(), Workspace::Clean(old));
}

#[test]
fn quarantine_retention_expires_only_old_owned_directories() {
    const DAY: u64 = 24 * 60 * 60 * 1000;
    let home = tempfile::tempdir().expect("private fixture");
    let repo = home.path().join("repository");
    let head = repository(&repo);
    let worktrees = worktrees(home.path());
    let storage = SettingsFile::open(home.path()).unwrap().storage().unwrap();
    let root = storage.scratch().path().join("quarantine");
    for (task, time) in [
        ("expired", 1),
        ("young", 2 * DAY),
        ("replaced", 1),
        ("linked", 1),
        ("pending", 1),
    ] {
        let checkout = worktrees.checkout(&repo, "example/fixture", task).unwrap();
        checkout.allocate(&head).unwrap();
        let admin = git(checkout.path(), &["rev-parse", "--absolute-git-dir"]);
        let admin = Path::new(admin.trim_end_matches('\n'));
        fs::remove_file(admin.join("index")).unwrap();
        fs::write(admin.join("locked"), "initializing").unwrap();
        fs::write(checkout.path().join("draft"), "preserved draft").unwrap();
        if task == "pending" {
            fs::write(repo.join(".git/refs/heads/ns-pending.lock"), "").unwrap();
            assert!(checkout.quarantine_initialization(time).is_err());
        } else {
            checkout.quarantine_initialization(time).unwrap();
        }
    }
    // Recent payload timestamps cannot extend quarantine retention.
    fs::write(root.join("expired-1/recent"), "new filesystem timestamp").unwrap();
    fs::create_dir(root.join("foreign-1")).unwrap();
    fs::write(root.join("foreign-1/.nucleus-quarantine"), "unknown").unwrap();
    let replaced = root.join("replaced-1");
    fs::rename(&replaced, home.path().join("moved-aside")).unwrap();
    fs::create_dir(&replaced).unwrap();
    fs::write(replaced.join("foreign"), "keep").unwrap();
    let linked = root.join("linked-1");
    let target = home.path().join("link-target");
    fs::rename(&linked, &target).unwrap();
    std::os::unix::fs::symlink(&target, &linked).unwrap();

    nucleus_work::prune_quarantines(storage.scratch(), 8 * DAY).unwrap();

    assert!(!root.join("expired-1").exists());
    assert!(root.join(format!("young-{}/draft", 2 * DAY)).is_file());
    assert!(!root.join("pending-1").exists());
    assert!(root.join("foreign-1").is_dir());
    assert!(replaced.join("foreign").is_file());
    assert!(linked.is_symlink());
    assert!(target.join("draft").is_file());
}

#[test]
fn retirement_preserves_a_head_changed_during_preparation() {
    struct AdvanceHead(std::sync::atomic::AtomicBool);
    impl GitPolicy for AdvanceHead {
        fn isolate(&self, command: &mut Command) {
            LocalGit.isolate(command);
            if command
                .get_args()
                .any(|arg| arg == "nucleus-index-visibility")
                && self.0.swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                let directory = command.get_args().nth(1).unwrap();
                git(
                    Path::new(directory),
                    &["commit", "--allow-empty", "-m", "new work"],
                );
            }
        }

        fn credential(&self, remote: &str) -> Result<Option<GitCredential>, GitFailure> {
            LocalGit.credential(remote)
        }

        fn refresh_credential(&self, rejected: &GitCredential) -> Option<GitCredential> {
            LocalGit.refresh_credential(rejected)
        }
    }
    let root = tempfile::tempdir().expect("scratch");
    let repo = root.path().join("repository");
    let head = repository(&repo);
    let policy = AdvanceHead(false.into());
    let work = worktrees_with_policy(
        root.path(),
        Redactor::new([], RedactionRules::common()),
        &policy,
    );
    let checkout = work.checkout(&repo, "example/fixture", "task-1").unwrap();
    checkout.allocate(&head).unwrap();
    policy.0.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(checkout.retire(&head).unwrap(), Retirement::Retained);
    assert!(checkout.path().is_dir());
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

#[test]
fn retire_only_tracked_deletions_at_the_published_head() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    repository(&repo);
    fs::create_dir(repo.join("tracked")).unwrap();
    for i in 0..1401 {
        fs::write(repo.join(format!("tracked/{i}")), "published").unwrap();
    }
    fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
    git(&repo, &["add", "tracked", ".gitignore"]);
    git(&repo, &["commit", "-qm", "Publish tracked inputs"]);
    let published: Head = git(&repo, &["rev-parse", "HEAD"]).trim().parse().unwrap();
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-retired")
        .unwrap();
    checkout.allocate(&published).unwrap();
    fs::remove_dir_all(checkout.path().join("tracked")).unwrap();
    fs::create_dir(checkout.path().join("node_modules")).unwrap();
    fs::write(checkout.path().join("node_modules/dependency"), "generated").unwrap();
    let draft = checkout.path().join("draft");
    fs::write(&draft, "keep").unwrap();
    assert_eq!(checkout.retire(&published).unwrap(), Retirement::Retained);
    git(checkout.path(), &["add", "draft"]);
    assert_eq!(checkout.retire(&published).unwrap(), Retirement::Retained);
    assert_eq!(fs::read_to_string(&draft).unwrap(), "keep");
    git(checkout.path(), &["rm", "-f", "--", "draft"]);
    assert_eq!(checkout.retire(&published).unwrap(), Retirement::Removed);
    assert!(!checkout.path().exists());
}

#[test]
fn a_clean_head_moved_after_preparation_remains_in_custody() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let published = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-moved")
        .unwrap();
    checkout.allocate(&published).unwrap();
    let observed = checkout.observe_for_retirement().unwrap();
    git(
        checkout.path(),
        &["commit", "--allow-empty", "-m", "Unpublished"],
    );
    assert_eq!(
        checkout.finish_retirement(observed, &published).unwrap(),
        Retirement::Retained
    );
    assert!(checkout.path().is_dir());
}

#[test]
fn retire_stages_same_volume_trash_removes_git_registration_and_prunes_only_owned_trash() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    repository(&repo);
    fs::write(repo.join(".gitignore"), "local.settings\nnode_modules/\n").unwrap();
    git(&repo, &["add", ".gitignore"]);
    git(&repo, &["commit", "-m", "Ignore node_modules"]);
    let head: Head = git(&repo, &["rev-parse", "HEAD"]).trim().parse().unwrap();
    let worktrees = worktrees(root.path());
    let storage = SettingsFile::open(root.path()).unwrap().storage().unwrap();
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-trash")
        .unwrap();
    let sibling = worktrees
        .checkout(&repo, "example/fixture", "task-sibling")
        .unwrap();
    checkout.allocate(&head).unwrap();
    sibling.allocate(&head).unwrap();
    let deps = checkout.path().join("node_modules/pkg");
    fs::create_dir_all(&deps).unwrap();
    fs::write(deps.join("index.js"), "module.exports = 1;").unwrap();
    fs::write(checkout.path().join("local.settings"), "ignored").unwrap();

    assert_eq!(checkout.retire(&head).unwrap(), Retirement::Removed);
    assert!(!checkout.path().exists());
    assert_eq!(checkout.observe().unwrap(), Workspace::Absent);
    assert!(!checkout.has_prunable_registration().unwrap());

    let listed = git(&repo, &["worktree", "list", "--porcelain"]);
    assert!(!listed.contains("ns-task-trash"));
    assert!(listed.contains("ns-task-sibling"));

    let trash_root = storage.work().path().join(".trash");
    assert!(trash_root.is_dir());
    let entries: Vec<_> = fs::read_dir(&trash_root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0]
            .join("checkout/node_modules/pkg/index.js")
            .is_file()
    );

    // Foreign, symlinked, and replaced entries in .trash must stay untouched.
    let foreign = trash_root.join("foreign-1-1");
    fs::create_dir(&foreign).unwrap();
    fs::write(foreign.join(".nucleus-trash"), "unknown").unwrap();
    fs::write(foreign.join("keep"), "foreign").unwrap();

    let symlink_target = root.path().join("outside");
    fs::create_dir(&symlink_target).unwrap();
    fs::write(symlink_target.join("keep"), "target").unwrap();
    let linked = trash_root.join("linked-1-1");
    std::os::unix::fs::symlink(&symlink_target, &linked).unwrap();

    nucleus_work::prune_trash(storage.work(), u64::MAX).unwrap();
    assert!(!entries[0].exists());
    assert!(foreign.join("keep").is_file());
    assert!(linked.is_symlink());
    assert!(symlink_target.join("keep").is_file());
}

#[test]
fn retire_recovers_interrupted_cleanup_without_dot_git_file_and_preserves_unpublished_work() {
    for delete_gitignore in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        repository(&repo);
        fs::create_dir(repo.join("tracked")).unwrap();
        for i in 0..1401 {
            fs::write(repo.join(format!("tracked/{i}")), "published").unwrap();
        }
        fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        git(&repo, &["add", "tracked", ".gitignore"]);
        git(&repo, &["commit", "-qm", "Publish large tracked tree"]);
        let published: Head = git(&repo, &["rev-parse", "HEAD"]).trim().parse().unwrap();

        let worktrees = worktrees(root.path());
        let storage = SettingsFile::open(root.path()).unwrap().storage().unwrap();
        let checkout = worktrees
            .checkout(&repo, "example/fixture", "task-1155")
            .unwrap();
        let sibling = worktrees
            .checkout(&repo, "example/fixture", "task-sibling")
            .unwrap();
        checkout.allocate(&published).unwrap();
        sibling.allocate(&published).unwrap();

        // Leave sibling prunable to confirm recovery never runs repository-wide prune.
        let sibling_admin = PathBuf::from(
            git(sibling.path(), &["rev-parse", "--absolute-git-dir"]).trim_end_matches('\n'),
        );
        fs::rename(sibling.path(), root.path().join("sibling-moved")).unwrap();

        fs::create_dir_all(checkout.path().join("node_modules/pkg")).unwrap();
        fs::write(checkout.path().join("node_modules/pkg/index.js"), "dep").unwrap();
        fs::remove_dir_all(checkout.path().join("tracked")).unwrap();
        fs::remove_file(checkout.path().join(".git")).unwrap();
        if delete_gitignore {
            fs::remove_file(checkout.path().join(".gitignore")).unwrap();
        }

        // Active observation still refuses a checkout missing .git.
        assert!(checkout.observe().is_err());
        assert!(checkout.allocate(&published).is_err());

        // Unpublished work must still block retirement even with .git missing.
        let draft = checkout.path().join("draft.md");
        fs::write(&draft, "unpublished draft").unwrap();
        assert_eq!(checkout.deletion_only_head().unwrap(), None);
        assert_eq!(checkout.retire(&published).unwrap(), Retirement::Retained);
        assert_eq!(fs::read_to_string(&draft).unwrap(), "unpublished draft");
        fs::remove_file(&draft).unwrap();

        let readme = checkout.path().join("README.md");
        fs::write(&readme, "modified tracked file").unwrap();
        assert_eq!(checkout.deletion_only_head().unwrap(), None);
        assert_eq!(checkout.retire(&published).unwrap(), Retirement::Retained);
        assert_eq!(
            fs::read_to_string(&readme).unwrap(),
            "modified tracked file"
        );
        fs::remove_file(&readme).unwrap();

        let other: Head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".parse().unwrap();
        assert_eq!(
            checkout.deletion_only_head().unwrap(),
            Some(published.clone())
        );
        assert_eq!(checkout.retire(&other).unwrap(), Retirement::Retained);
        assert!(checkout.path().is_dir());

        assert_eq!(checkout.retire(&published).unwrap(), Retirement::Removed);
        assert!(!checkout.path().exists());
        assert!(sibling_admin.is_dir());
        let listed = git(&repo, &["worktree", "list", "--porcelain"]);
        assert!(!listed.contains("ns-task-1155"));
        assert!(listed.contains("ns-task-sibling"));

        nucleus_work::prune_trash(storage.work(), u64::MAX).unwrap();
    }
}

#[test]
fn retire_missing_dot_git_keeps_hidden_index_edits_and_foreign_directories() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let published = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-hidden")
        .unwrap();
    checkout.allocate(&published).unwrap();
    git(
        checkout.path(),
        &["update-index", "--skip-worktree", "README.md"],
    );
    let readme = checkout.path().join("README.md");
    fs::write(&readme, "hidden edit").unwrap();
    fs::remove_file(checkout.path().join(".git")).unwrap();

    assert_eq!(checkout.observe_for_retirement().unwrap(), Workspace::Dirty);
    assert_eq!(checkout.deletion_only_head().unwrap(), None);
    assert_eq!(checkout.retire(&published).unwrap(), Retirement::Retained);
    assert_eq!(fs::read_to_string(&readme).unwrap(), "hidden edit");

    let foreign = worktrees
        .checkout(&repo, "example/fixture", "task-foreign")
        .unwrap();
    fs::create_dir_all(foreign.path()).unwrap();
    fs::write(foreign.path().join("keep"), "foreign").unwrap();
    assert!(foreign.observe_for_retirement().is_err());
    assert!(foreign.retire(&published).is_err());
    assert_eq!(
        fs::read_to_string(foreign.path().join("keep")).unwrap(),
        "foreign"
    );
}

#[test]
fn prunable_registration_after_directory_move_cleans_up_on_retire_and_allocate() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let head = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-prunable")
        .unwrap();
    checkout.allocate(&head).unwrap();

    // Simulate interruption after renaming the directory away before removing Git registration.
    fs::rename(checkout.path(), root.path().join("moved-away")).unwrap();
    assert!(checkout.has_prunable_registration().unwrap());
    assert_eq!(checkout.retire(&head).unwrap(), Retirement::Removed);
    assert!(!checkout.has_prunable_registration().unwrap());
    assert_eq!(checkout.retire(&head).unwrap(), Retirement::Absent);

    checkout.allocate(&head).unwrap();
    fs::rename(checkout.path(), root.path().join("moved-again")).unwrap();
    assert!(checkout.has_prunable_registration().unwrap());
    assert_eq!(checkout.allocate(&head).unwrap(), Workspace::Clean(head));
}

#[test]
fn retire_refuses_locked_worktree_without_moving_directory() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let head = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-locked")
        .unwrap();
    checkout.allocate(&head).unwrap();
    let admin = PathBuf::from(
        git(checkout.path(), &["rev-parse", "--absolute-git-dir"]).trim_end_matches('\n'),
    );
    fs::write(admin.join("locked"), "manual lock").unwrap();

    assert!(checkout.retire(&head).is_err());
    assert!(checkout.path().is_dir());
    assert!(checkout.path().join("README.md").is_file());
}

#[test]
fn an_abandoned_job_removes_nothing() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let head = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-abandoned")
        .unwrap();
    checkout.allocate(&head).unwrap();
    let observed = checkout.observe_for_retirement().unwrap();
    let redactor = Redactor::new([], RedactionRules::common());
    let published = head.clone();
    let job = checkout.job(LocalGit, redactor, move |checkout| {
        checkout.finish_retirement(observed, &published)
    });

    // The caller stopped waiting before the call reached its rename.
    let abandoned = Arc::new(AtomicBool::new(true));
    assert!(matches!(job(abandoned), Err(WorkError::Storage(_))));
    assert!(checkout.path().join(".git").is_file());
    assert_eq!(checkout.retire(&head).unwrap(), Retirement::Removed);
}

#[test]
fn a_missing_work_root_is_unavailable_rather_than_an_absent_checkout() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let head = repository(&repo);
    let worktrees = worktrees(root.path());
    let checkout = worktrees
        .checkout(&repo, "example/fixture", "task-outage")
        .unwrap();
    checkout.allocate(&head).unwrap();
    let work = checkout.path().ancestors().nth(2).unwrap().to_owned();
    let away = root.path().join("work-away");
    fs::rename(&work, &away).unwrap();

    assert!(matches!(checkout.observe(), Err(WorkError::Storage(_))));
    assert!(matches!(
        checkout.allocate(&head),
        Err(WorkError::Storage(_))
    ));
    assert!(matches!(checkout.retire(&head), Err(WorkError::Storage(_))));
    assert!(!work.exists());

    fs::rename(&away, &work).unwrap();
    assert_eq!(checkout.observe().unwrap(), Workspace::Clean(head));
}
