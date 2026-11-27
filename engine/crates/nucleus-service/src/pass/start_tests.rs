//! A brief task's first checkout against a real origin which is ahead of the
//! registered checkout.

use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, sync::atomic::Ordering};

use nucleus_core::{Entry, Identity};
use nucleus_forge::GitHub;
use nucleus_store::{ProjectSettings, Projects, RepositorySettings};

use super::*;
use crate::tests::{REPOSITORY, create_fixture_commit, fixture, git};

mod merges;

struct Registered {
    _home: tempfile::TempDir,
    service: Service,
    checkout: PathBuf,
    /// Pushes to the bare origin without touching the registered checkout.
    publisher: PathBuf,
    local: Head,
}

fn head(repository: &Path, revision: &str) -> Head {
    git(repository, &["rev-parse", revision])
        .parse()
        .expect("fixture head")
}

/// A registry service whose GitHub origin is served over SSH by a local bare
/// repository, so the engine runs a real fetch.
async fn registered() -> Registered {
    let (home, mut service) = fixture(GitHub::new("unused-fixture").expect("client"));
    let checkout = service.fixture().checkout.clone();
    std::fs::write(checkout.join("tracked"), "committed\n").expect("tracked file");
    git(&checkout, &["add", "tracked"]);
    create_fixture_commit(&checkout, "local base");
    let local = head(&checkout, "HEAD");

    let origin = checkout.with_file_name("origin.git");
    let publisher = checkout.with_file_name("publisher");
    for (source, target, bare) in [(&checkout, &origin, true), (&origin, &publisher, false)] {
        let mut args = vec!["clone", "--quiet"];
        args.extend(bare.then_some("--bare"));
        args.extend([source.to_str().unwrap(), target.to_str().unwrap()]);
        git(&checkout, &args);
    }
    let ssh = checkout.with_file_name("fixture-ssh");
    std::fs::write(
        &ssh,
        format!("#!/bin/sh\nexec git upload-pack '{}'\n", origin.display()),
    )
    .expect("fixture transport");
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o700)).expect("executable");
    git(
        &checkout,
        &["config", "core.sshCommand", ssh.to_str().unwrap()],
    );
    git(&checkout, &["config", "ssh.variant", "simple"]);
    git(
        &checkout,
        &[
            "remote",
            "set-url",
            "origin",
            &format!("git@github.com:{REPOSITORY}.git"),
        ],
    );
    // Work in progress which a start from the published base must not disturb.
    std::fs::write(checkout.join("tracked"), "edited\n").expect("local edit");
    std::fs::write(checkout.join("untracked"), "kept\n").expect("untracked file");

    let host_project = service.fixture().host_project.clone();
    service.project = None;
    service.state.lock().await.settings.projects = Some(Projects {
        projects: BTreeMap::from([(
            "product".into(),
            ProjectSettings {
                planner_claim: None,
                claimed_planner_threads: Vec::new(),
                name: "Synthetic product".into(),
                archived: false,
                repositories: vec![RepositorySettings {
                    origin: REPOSITORY.into(),
                    path: checkout.clone(),
                    base: "main".into(),
                    host_project: Some(host_project),
                    host_project_title: None,
                    planner_threads: Vec::new(),
                }],
            },
        )]),
        ..Projects::default()
    });
    Registered {
        _home: home,
        service,
        checkout,
        publisher,
        local,
    }
}

impl Registered {
    fn publish(&self, message: &str) -> Head {
        create_fixture_commit(&self.publisher, message);
        git(&self.publisher, &["push", "--quiet", "origin", "main"]);
        head(&self.publisher, "HEAD")
    }

    async fn seed(&self, id: &str) -> TaskRow {
        let mut task = Task::new(
            Identity {
                id: id.into(),
                reference: id.into(),
                repository: REPOSITORY.into(),
                base: "main".into(),
                entry: Entry::Brief,
                origin_thread: None,
            },
            "Add a synthetic greeting.".into(),
            None,
        );
        let _ = task.reconcile(&Observation {
            host: Observed::Unknown,
            forge: Observed::Known(Forge::Absent),
            workspace: Observed::Known(Workspace::Absent),
        });
        self.service
            .state
            .lock()
            .await
            .store
            .create(&task, &event("admitted"))
            .expect("seed");
        self.service.task(id).await.expect("row")
    }

    /// Land a prerequisite through the same merge audit the engine records.
    async fn landed(&self, id: &str, commit: &Head) {
        let row = self.seed(id).await;
        let forge = Observed::Known(Forge::Merged {
            pr: nucleus_core::PullRequest {
                url: format!("https://github.com/{REPOSITORY}/pull/1"),
                head: commit.clone(),
            },
            commit: commit.clone(),
        });
        let mut done = serde_json::to_value(&row.task).expect("stored task");
        done["phase"] = serde_json::json!("done");
        let done: Task = serde_json::from_value(done).expect("done task");
        let mut audit = event("phase_reconciled");
        crate::presentation::note_merge(&mut audit, &forge);
        self.service.save(&row, done, &audit).await.expect("land");
    }

    async fn dependent(&self, id: &str, prerequisite: &str) -> TaskRow {
        let row = self.seed(id).await;
        self.service
            .state
            .lock()
            .await
            .store
            .edit_dependencies(
                id,
                row.version,
                nucleus_store::DependencyEdit::BeforeDispatch(&[prerequisite.into()]),
                &event("dependencies_changed"),
                &mut |_| false,
            )
            .expect("prerequisite");
        self.service.task(id).await.expect("dependent row")
    }

    async fn allocate(&self, row: &TaskRow) -> Result<Option<Workspace>, ServiceError> {
        let worktrees = self.service.worktrees();
        let checkout = worktrees
            .checkout(&self.checkout, REPOSITORY, &row.task.identity().id)
            .expect("checkout");
        self.service
            .allocate_checkout(&row.task, &checkout, None)
            .await
    }

    fn registered_state(&self) -> [String; 4] {
        [
            git(&self.checkout, &["rev-parse", "refs/heads/main"]),
            git(&self.checkout, &["symbolic-ref", "HEAD"]),
            git(&self.checkout, &["status", "--porcelain"]),
            std::fs::read_to_string(self.checkout.join("tracked")).expect("tracked file"),
        ]
    }

    fn assert_no_task_branch(&self, id: &str) {
        let branch = format!("refs/heads/ns-{id}");
        assert_eq!(git(&self.checkout, &["for-each-ref", &branch]), "");
        let worktrees = self.service.worktrees();
        let checkout = worktrees
            .checkout(&self.checkout, REPOSITORY, id)
            .expect("checkout");
        assert!(!checkout.path().exists());
    }
}

#[tokio::test]
async fn a_new_checkout_starts_at_the_published_tip_and_leaves_the_registered_one_alone() {
    let registered = registered().await;
    let published = registered.publish("published");
    assert_ne!(published, registered.local);
    let before = registered.registered_state();
    let row = registered.seed("first").await;
    assert_eq!(
        registered.allocate(&row).await.expect("allocate"),
        Some(Workspace::Clean(published))
    );
    assert_eq!(registered.registered_state(), before);
    assert_eq!(before[0], registered.local.as_str());
}

#[tokio::test]
async fn a_dependent_starts_with_its_landed_prerequisite() {
    let registered = registered().await;
    let landing = registered.publish("prerequisite");
    let published = registered.publish("later");
    registered.landed("prerequisite", &landing).await;
    let row = registered.dependent("dependent", "prerequisite").await;
    assert_eq!(
        registered.allocate(&row).await.expect("allocate"),
        Some(Workspace::Clean(published.clone()))
    );
    git(
        &registered.checkout,
        &[
            "merge-base",
            "--is-ancestor",
            landing.as_str(),
            published.as_str(),
        ],
    );
}

#[tokio::test]
async fn a_published_base_behind_a_landing_waits_and_names_the_prerequisite() {
    let registered = registered().await;
    // The recorded landing is neither fetched nor known to the registered store.
    create_fixture_commit(&registered.publisher, "unpublished landing");
    let missing = head(&registered.publisher, "HEAD");
    registered.landed("prerequisite", &missing).await;
    let row = registered.dependent("dependent", "prerequisite").await;
    let reference = registered
        .service
        .task("prerequisite")
        .await
        .expect("prerequisite")
        .reference()
        .into_owned();
    let step = registered.allocate(&row).await.map(|_| Action::Nothing);
    assert_eq!(
        crate::task_wait(&row, &step).0,
        Some(WaitReason::WorkspaceUnknown)
    );
    assert!(crate::workspace_cause(&step).starts_with(&format!(
        "origin/main does not contain the landed commit of prerequisite {reference}."
    )));
    registered.assert_no_task_branch("dependent");

    git(
        &registered.publisher,
        &["push", "--quiet", "origin", "main"],
    );
    assert_eq!(
        registered.allocate(&row).await.expect("retry"),
        Some(Workspace::Clean(missing))
    );
}

#[tokio::test]
async fn a_failed_fetch_waits_without_a_stale_start() {
    let registered = registered().await;
    registered.publish("published");
    git(
        &registered.checkout,
        &["config", "core.sshCommand", "false"],
    );
    let row = registered.seed("offline").await;
    let step = registered.allocate(&row).await.map(|_| Action::Nothing);
    assert!(matches!(
        step,
        Err(ServiceError::Workspace(WorkError::Git {
            operation: nucleus_work::GitOperation::Fetch,
            ..
        }))
    ));
    assert_eq!(
        crate::task_wait(&row, &step).0,
        Some(WaitReason::WorkspaceUnknown)
    );
    assert!(crate::workspace_cause(&step).starts_with("git fetch "));
    registered.assert_no_task_branch("offline");
}

#[tokio::test]
async fn a_fetch_still_running_holds_back_every_start_in_its_repository() {
    let mut registered = registered().await;
    let published = registered.publish("published");
    let scratch = registered.checkout.with_file_name("hung-git");
    std::fs::create_dir(&scratch).expect("Git scratch");
    registered.service.git = crate::project::LocalGit(scratch.clone());
    let gate = crate::project::git_gate::install(scratch);
    gate.only.set("fetch").unwrap();
    gate.holds.store(1, Ordering::SeqCst);
    registered.service.volume.check = Duration::from_secs(3);
    let first = registered.seed("first").await;
    let second = registered.seed("second").await;

    for row in [&first, &second] {
        assert!(matches!(
            registered.allocate(row).await,
            Err(ServiceError::Workspace(WorkError::Storage(
                nucleus_store::StorageError::CallHeld {
                    step: "fetching the published base",
                    ..
                }
            )))
        ));
    }
    // The second task started no fetch beside the abandoned one.
    assert_eq!(gate.entered.load(Ordering::SeqCst), 1);
    registered.assert_no_task_branch("second");

    gate.release();
    tokio::time::timeout(Duration::from_secs(20), async {
        while registered.allocate(&second).await.is_err() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the repository resumes once the fetch returns");
    assert_eq!(
        registered.allocate(&second).await.expect("allocated"),
        Some(Workspace::Clean(published))
    );
}

#[tokio::test]
async fn a_leftover_published_branch_is_adopted_after_the_base_moves() {
    let registered = registered().await;
    let earlier = registered.publish("earlier");
    let row = registered.seed("leftover").await;
    git(&registered.checkout, &["fetch", "--quiet", "origin"]);
    // A failed `git worktree add` leaves its new branch behind.
    git(
        &registered.checkout,
        &["branch", "--no-track", "ns-leftover", earlier.as_str()],
    );
    registered.publish("moved");
    assert_eq!(
        registered.allocate(&row).await.expect("adopt"),
        Some(Workspace::Clean(earlier))
    );
}
