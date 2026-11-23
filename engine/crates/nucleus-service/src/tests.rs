use std::{
    path::Path,
    process::Command as Process,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Json, Router,
    routing::{get, post},
};
use nucleus_core::{
    CallbackCredential, CheckState, Forge, Head, Host, LaunchInputs, Observation, Observed,
    PullRequest, Run, Workspace,
};
use nucleus_hosts::{
    Binding, ReplayAuthorization, RoleProfile, SendOutcome, StopProgress, TaskHost,
};
use nucleus_store::{EngineSettings, PinnedVolume};
use serde_json::{Value, json};
use tokio::net::TcpListener;

use super::*;

const REPOSITORY: &str = "inflatable-cookie/nucleus-fixture";
const PR: &str = "https://github.com/inflatable-cookie/nucleus-fixture/pull/1";

pub(super) fn fixture(forge: GitHub) -> (tempfile::TempDir, Service) {
    let home = tempfile::tempdir().expect("fixture volume directory");
    let root = home.path().canonicalize().expect("portable root");
    let checkout = root.join("repo");
    std::fs::create_dir(&checkout).expect("project");
    git(&checkout, &["init", "-b", "main"]);
    git(
        &checkout,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    );
    git(
        &checkout,
        &[
            "remote",
            "add",
            "origin",
            &format!("https://github.com/{REPOSITORY}.git"),
        ],
    );
    let start = git(&checkout, &["rev-parse", "HEAD"])
        .parse()
        .expect("base head");
    let settings = SettingsFile::open(&root).expect("portable settings");
    settings
        .save(&EngineSettings {
            enabled: true,
            work_volume: Some(PinnedVolume::detect(&root).expect("fixture volume")),
            ..EngineSettings::default()
        })
        .expect("enable fixture");
    let profile = RoleProfile {
        instance_id: "provider".into(),
        model: "fixture".into(),
        runtime_mode: "auto".into(),
    };
    let project = Project {
        repository: REPOSITORY.into(),
        checkout,
        base: "main".into(),
        start,
        host_project: "local-fixture".into(),
        worker: profile.clone(),
        reviewer: profile,
        launch_budget: LaunchBudget {
            slots: 1,
            max_load: f64::MAX,
        },
        agents: Vec::new(),
    };
    let host = T3::new("http://127.0.0.1:9", "unused-fixture-key")
        .expect("no native host for the service fixture");
    let service = Service::open(
        &settings,
        project,
        host,
        forge,
        "127.0.0.1:9".parse().expect("callback"),
        std::env::current_exe().expect("test binary"),
    )
    .expect("scoped service");
    (home, service)
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Process::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("run fixture git");
    assert!(
        output.status.success(),
        "fixture Git: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("fixture Git output")
        .trim_end()
        .into()
}

pub(super) fn reservation(
    id: &str,
    entry: Entry,
    head: &Head,
) -> (Task, CallbackCredential, Observation) {
    let pr = PullRequest {
        url: PR.into(),
        head: head.clone(),
    };
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry,
            origin_thread: None,
        },
        "Synthetic change".into(),
        (entry == Entry::ReviewEntry).then(|| pr.clone()),
    );
    let observation = Observation {
        forge: if entry == Entry::ReviewEntry {
            Observed::Known(Forge::Open {
                pr,
                checks: CheckState::Ready,
            })
        } else {
            Observed::Known(Forge::Absent)
        },
        host: Observed::Unknown,
        workspace: Observed::Known(Workspace::Clean(head.clone())),
    };
    let _ = task.reconcile(&observation);
    let credential = task
        .reserve_launch(
            &observation,
            LaunchInputs {
                thread: format!("thread:{id}"),
                started_at: 1,
                input: "fixture-only wire".into(),
            },
            &[3; 32],
        )
        .expect("reserve exact callback run");
    (task, credential, observation)
}

pub(super) async fn forge_fixture(
    head: &Head,
) -> (GitHub, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let reads = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&reads);
    let pull = json!({
        "number":1, "html_url":PR, "merged":false, "state":"open", "merge_commit_sha":null,
        "head":{"ref":"ns-reviewer", "sha":head, "repo":{"full_name":REPOSITORY}},
        "base":{"ref":"main", "sha":head, "repo":{"full_name":REPOSITORY}},
    });
    let checks = json!({"data":{"repository":{"pullRequest":{
        "headRefOid":head, "baseRefName":"main", "isDraft":false, "state":"OPEN",
        "mergeable":"MERGEABLE", "mergeStateStatus":"CLEAN", "reviewDecision":null,
        "statusCheckRollup":{"state":"SUCCESS"},
    }}}});
    let server = Router::new()
        .route(
            &format!("/repos/{REPOSITORY}/pulls/1"),
            get(move || async move {
                counter.fetch_add(1, Ordering::Relaxed);
                Json(pull)
            }),
        )
        .route("/graphql", post(move || async move { Json(checks) }));
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("fixture endpoint");
    let client = GitHub::loopback_fixture(listener.local_addr().expect("local address"))
        .expect("fixture forge");
    let server = tokio::spawn(async {
        axum::serve(listener, server)
            .await
            .expect("fixture forge server");
    });
    (client, reads, server)
}

pub(super) struct Due(pub(super) AtomicUsize);

impl TaskHost for Due {
    fn prepare_launch(
        &self,
        _: nucleus_hosts::LaunchRequest<'_>,
    ) -> Result<LaunchInputs, HostError> {
        unreachable!("no new reservation in the replay fixture")
    }

    async fn observe_retained(&self, _: &Binding, _: &str) -> Result<Host, HostError> {
        unreachable!("only replay gate is exercised")
    }
    async fn observe_run(&self, _: &Run, _: u64) -> Result<Host, HostError> {
        unreachable!("only revoked runs are exercised")
    }

    async fn authorize_send(&self, _: &Run) -> Result<ReplayAuthorization, HostError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err(HostError::Uncertain)
    }

    async fn send(&self, _: &Run, _: ReplayAuthorization) -> Result<SendOutcome, HostError> {
        unreachable!("fixture probes the decision before the send marker")
    }

    async fn stop(&self, _: &Run, _: u64, _: bool) -> Result<StopProgress, HostError> {
        Ok(StopProgress::ReplayDue)
    }
}

#[tokio::test]
async fn a_move_during_the_forge_read_prevents_stale_launch() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let source = {
        let (entered, release) = (Arc::clone(&entered), Arc::clone(&release));
        Router::new().route(
            &format!("/repos/{REPOSITORY}/pulls"),
            get(move || async move {
                entered.notify_one();
                release.notified().await;
                Json(Vec::<Value>::new())
            }),
        )
    };
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("fixture forge");
    let forge =
        GitHub::loopback_fixture(listener.local_addr().expect("forge address")).expect("client");
    let server = tokio::spawn(async move {
        axum::serve(listener, source).await.expect("server");
    });
    let (_home, service) = fixture(forge);
    let id = "stale-read";
    let mut task = Task::new(
        Identity {
            id: id.into(),
            reference: id.into(),
            repository: REPOSITORY.into(),
            base: "main".into(),
            entry: Entry::Brief,
            origin_thread: None,
        },
        "Synthetic task".into(),
        None,
    );
    let observation = Observation {
        host: Observed::Unknown,
        forge: Observed::Unknown,
        workspace: Observed::Unknown,
    };
    let _ = task.reconcile(&observation);
    service
        .state
        .lock()
        .await
        .store
        .create(&task, &event("fixture"))
        .expect("seed");
    let stale = service.task(id).await.expect("old version");
    service
        .checked_project
        .set(())
        .expect("fixture project verified");

    let (result, moved) = tokio::join!(service.pass(), async {
        entered.notified().await;
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            service.command(
                id,
                &Authority::Operator {
                    actor: "fixture".into(),
                },
                Command::Move(nucleus_core::Phase::Queued),
            ),
        )
        .await;
        release.notify_one();
        outcome
            .expect("the command is independent of the pending read")
            .expect("move")
    },);
    let results = result.expect("pass outcome");
    assert!(matches!(
        results.as_slice(),
        [PassOutcome { task, result: Err(ServiceError::Store(StoreError::StaleTask)) }] if task == id
    ));
    assert_eq!(moved.version, stale.version + 1);
    assert_eq!(service.task(id).await.expect("current row"), moved);
    assert_eq!(
        service.state.lock().await.schedule.ready(Instant::now()),
        [id]
    );
    let worktrees = service.worktrees().expect("worktree root");
    let checkout = worktrees
        .checkout(&service.project.checkout, REPOSITORY, id)
        .expect("checkout");
    assert_eq!(
        checkout.observe().expect("worktree state"),
        Workspace::Absent
    );
    server.abort();
}
